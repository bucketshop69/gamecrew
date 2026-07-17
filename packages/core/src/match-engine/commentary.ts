import type {
  CommentaryBeat,
  CommentaryBeatKind,
  CommentaryBeatPlanningOptions,
  CommentaryRestartContext,
  MatchEnginePhase,
  MatchEngineParticipant,
  SemanticFrame,
  SimulationCue,
} from './types';

export const COMMENTARY_PLAN_VERSION = 3;

// Beat identity follows source evidence, not a transport projection generation.
// Keep 0 as the identity-schema segment so existing generation-0 persisted
// entries retain their ids when the match engine is rebuilt under v2.
const COMMENTARY_BEAT_ID_VERSION = 0;

const routineKinds = new Set<SimulationCue['kind']>([
  'set_piece',
  'possession_change',
  'possession_pressure',
  'shot_attempt',
  'shot_outcome',
  'card',
  'substitution',
  'injury',
  'additional_time',
  'var',
  'restart',
]);

interface IncidentRevisionPlan {
  anchorFrameId: string;
  cue: SimulationCue;
  evidenceFrames: SemanticFrame[];
}

interface PlannedFrame {
  frame: SemanticFrame;
  evidenceFrames: SemanticFrame[];
  cues: SimulationCue[];
  kind: CommentaryBeatKind;
  participant?: MatchEngineParticipant;
  teamId?: number | string;
  phase?: MatchEnginePhase;
  restartContext?: CommentaryRestartContext;
}

/**
 * Plans narration from a complete, ordered projection generation. Frames with
 * no supporter-facing meaning are omitted; incident lifecycle revisions are
 * collapsed so enrichment cannot create a duplicate beat. Every returned
 * beat is immediate; retrospective pressure summaries are deliberately left
 * to a separate presentation layer so they cannot delay or double-count play.
 */
export function planCommentaryBeats(
  inputFrames: readonly SemanticFrame[],
  options: CommentaryBeatPlanningOptions,
): readonly CommentaryBeat[] {
  if (!Number.isSafeInteger(options.projectionGeneration) || options.projectionGeneration < 0) {
    throw new TypeError('Commentary projection generation must be a non-negative integer.');
  }

  const frames = [...inputFrames].sort(compareFrames);
  const planned = collapseRepeatedPossessionPressure(addNarrativeContext(selectPlannedFrames(frames)));
  return planned.map((candidate) => buildBeat([candidate], candidate.kind, options));
}

function selectPlannedFrames(frames: readonly SemanticFrame[]): PlannedFrame[] {
  const incidentPlans = planIncidentRevisions(frames);

  return frames.flatMap((frame) => {
    const cues = uniqueById(frame.simulationCues.flatMap((cue) => {
      if (cue.kind === 'score_commit') return [];
      if (isGoalRetraction(cue)) return [cue];
      if (cue.updateMode !== 'incident_upsert') return isCommentaryCue(cue) ? [cue] : [];
      const plan = incidentPlans.get(cue.id);
      return plan?.anchorFrameId === frame.id ? [plan.cue] : [];
    }));
    if (cues.length === 0) return [];

    const scoreCues = cues.some((cue) => cue.kind === 'goal_confirmed')
      ? frame.simulationCues.filter((cue) => cue.kind === 'score_commit' && isCommentaryCue(cue))
      : [];
    const phaseValue = frame.facts.find((fact) => fact.kind === 'phase')?.value.phase
      ?? frame.simulationCues.find((cue) => cue.kind === 'phase_change')?.value.phase;

    return cues.map((cue) => {
      const selectedCues = cue.kind === 'goal_confirmed'
        ? [cue, ...scoreCues]
        : [cue];
      const evidenceFrames = cue.kind === 'goal_confirmed'
        ? uniqueFrames([frame, ...(incidentPlans.get(cue.id)?.evidenceFrames ?? [])])
        : [frame];
      const isMajor = cue.kind === 'goal_confirmed'
        || isGoalRetraction(cue)
        || (cue.kind === 'card' && cue.value.action === 'red_card')
        || isMajorPhaseCue(cue);

      return {
        frame,
        evidenceFrames,
        cues: selectedCues,
        kind: isMajor ? 'major' : 'routine',
        participant: cue.participant,
        teamId: cue.teamId,
        ...(isMatchEnginePhase(phaseValue) ? { phase: phaseValue } : {}),
      };
    });
  });
}

function collapseRepeatedPossessionPressure(planned: readonly PlannedFrame[]): PlannedFrame[] {
  const result: PlannedFrame[] = [];
  let previousKey: string | undefined;

  for (const candidate of planned) {
    const isPressureOnly = candidate.cues.length === 1
      && candidate.cues[0]?.kind === 'possession_pressure';
    if (!isPressureOnly) {
      previousKey = undefined;
      result.push(candidate);
      continue;
    }

    const cue = candidate.cues[0]!;
    const owner = cue.teamId ?? cue.participant;
    const zone = cue.probableZone ?? cue.pressure;
    const key = owner === undefined ? undefined : `${String(owner)}:${zone ?? 'neutral'}`;
    if (key !== undefined && key === previousKey) continue;
    previousKey = key;
    result.push(candidate);
  }
  return result;
}

function planIncidentRevisions(frames: readonly SemanticFrame[]): Map<string, IncidentRevisionPlan> {
  const revisions = new Map<string, Array<{ frame: SemanticFrame; cue: SimulationCue }>>();

  for (const frame of frames) {
    for (const cue of frame.simulationCues) {
      if (cue.updateMode !== 'incident_upsert' || cue.kind === 'incident_retracted') continue;
      const entries = revisions.get(cue.id) ?? [];
      entries.push({ frame, cue });
      revisions.set(cue.id, entries);
    }
  }

  const plans = new Map<string, IncidentRevisionPlan>();
  for (const [cueId, entries] of revisions) {
    const admitted = entries.filter(({ cue }) => isCommentaryCue(cue));
    const confirmed = admitted.filter(({ cue }) => cue.lifecycle === 'confirmed');
    const observed = admitted.filter(({ cue }) => cue.lifecycle === 'observed');
    const selectedLifecycle = confirmed.length > 0 ? confirmed : observed;
    const anchor = selectedLifecycle[0];
    const latest = selectedLifecycle.at(-1);
    if (!anchor || !latest) continue;
    plans.set(cueId, {
      anchorFrameId: anchor.frame.id,
      cue: latest.cue,
      evidenceFrames: entries.map(({ frame }) => frame),
    });
  }
  return plans;
}

function addNarrativeContext(planned: readonly PlannedFrame[]): PlannedFrame[] {
  const result: PlannedFrame[] = [];
  let matchStarted = false;
  let goalAwaitingRestart = false;

  for (const candidate of planned) {
    const hasRestart = candidate.cues.some((cue) => cue.kind === 'restart');
    let restartContext: CommentaryRestartContext | undefined;
    if (hasRestart) {
      restartContext = candidate.phase === 'second_half' || candidate.phase === 'second_half_ready'
        ? 'second_half'
        : !matchStarted
          ? 'initial'
          : goalAwaitingRestart
            ? 'after_goal'
            : 'restart';
      matchStarted = true;
      goalAwaitingRestart = false;
    }
    if (candidate.cues.some((cue) => cue.kind === 'goal_confirmed')) {
      goalAwaitingRestart = true;
    }
    result.push({ ...candidate, ...(restartContext ? { restartContext } : {}) });
  }
  return result;
}

function isMatchEnginePhase(value: unknown): value is MatchEnginePhase {
  return typeof value === 'string' && [
    'pre_match', 'first_half_ready', 'first_half', 'half_time',
    'second_half_ready', 'second_half', 'full_time_pending', 'finalised',
  ].includes(value);
}

function isCommentaryCue(cue: SimulationCue): boolean {
  if (cue.kind === 'goal_confirmed') return cue.lifecycle === 'confirmed';
  if (cue.kind === 'score_commit') return cue.lifecycle === 'confirmed';
  if (isGoalRetraction(cue)) return true;
  if (cue.kind === 'phase_change') {
    return isMajorPhaseCue(cue)
      && (cue.lifecycle === 'confirmed' || cue.lifecycle === 'observed');
  }
  if (!routineKinds.has(cue.kind)) return false;
  if (cue.updateMode === 'incident_upsert') {
    return cue.lifecycle === 'confirmed' || cue.lifecycle === 'observed';
  }
  return cue.lifecycle === 'confirmed' || cue.lifecycle === 'observed';
}

function isGoalRetraction(cue: SimulationCue): boolean {
  return cue.kind === 'incident_retracted' && cue.value.action === 'goal';
}

function isMajorPhaseCue(cue: SimulationCue): boolean {
  return cue.kind === 'phase_change'
    && (cue.value.phase === 'half_time' || cue.value.phase === 'finalised');
}

function buildBeat(
  frames: readonly PlannedFrame[],
  kind: CommentaryBeatKind,
  options: CommentaryBeatPlanningOptions,
): CommentaryBeat {
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  const cues = uniqueById(frames.flatMap((item) => item.cues));
  const cueFactIds = new Set(cues.flatMap((cue) => cue.factIds));
  const evidenceFrames = uniqueFrames(frames.flatMap((item) => item.evidenceFrames));
  const facts = uniqueById(evidenceFrames.flatMap((frame) => frame.facts)
    .filter((fact) => cueFactIds.has(fact.id)));
  const sources = evidenceFrames.map((frame) => {
    const frameCues = frame.simulationCues.filter((cue) => cues.some((selected) => selected.id === cue.id));
    const factIds = [...new Set(frameCues.flatMap((cue) => cue.factIds))];
    return {
      frameId: frame.id,
      seq: frame.seq,
      cueIds: frameCues.map((cue) => cue.id),
      cues: frameCues.map((cue) => ({
        cueId: cue.id,
        action: typeof cue.value.action === 'string' ? cue.value.action : cue.kind,
      })),
      factIds,
    };
  });
  const sourceFrameIds = sources.map((source) => source.frameId);
  const participant = first.participant;
  const teamId = first.teamId;
  const teamName = options.teams?.find((team) =>
    (teamId !== undefined && String(team.teamId) === String(teamId))
      || (participant !== undefined && team.participant === participant))?.name;

  return {
    id: [
      first.frame.fixtureId,
      'commentary',
      COMMENTARY_BEAT_ID_VERSION,
      kind,
      first.frame.seq,
      last.frame.seq,
      commentaryCueKey(cues),
    ].join(':'),
    fixtureId: first.frame.fixtureId,
    plannerVersion: COMMENTARY_PLAN_VERSION,
    projectionGeneration: options.projectionGeneration,
    kind,
    mustCover: kind === 'major',
    fromSeq: first.frame.seq,
    toSeq: last.frame.seq,
    matchClockSeconds: first.frame.matchClockSeconds,
    participant,
    teamId,
    ...(first.restartContext ? { restartContext: first.restartContext } : {}),
    sourceFrameIds,
    sources,
    factIds: facts.map((fact) => fact.id),
    cueIds: cues.map((cue) => cue.id),
    facts,
    simulationCues: cues,
    fallbackCommentary: fallbackFor(kind, cues, teamName, first.restartContext),
  };
}

function commentaryCueKey(cues: readonly SimulationCue[]): string {
  return [...cues]
    .map((cue) => cue.id)
    .sort()
    .map((cueId) => encodeURIComponent(cueId))
    .join('+');
}

function fallbackFor(
  kind: CommentaryBeatKind,
  cues: readonly SimulationCue[],
  teamName?: string,
  restartContext?: CommentaryRestartContext,
): string {
  const subject = teamName ?? 'One side';
  const goal = cues.find((cue) => cue.kind === 'goal_confirmed');
  if (goal) {
    const rawScorer = goal.player?.displayName ?? goal.player?.sourcePreferredName;
    const scorer = rawScorer ? displayPlayerName(rawScorer) : undefined;
    const score = cues.find((cue) => cue.kind === 'score_commit')?.value;
    const scoreText = typeof score?.participant1 === 'number' && typeof score?.participant2 === 'number'
      ? ` ${score.participant1}-${score.participant2}.`
      : '';
    return scorer
      ? `${scorer} scores for ${subject}.${scoreText}`
      : `Goal for ${subject}.${scoreText}`;
  }
  if (cues.some(isGoalRetraction)) return 'The goal is ruled out.';

  const phase = cues.find((cue) => cue.kind === 'phase_change')?.value.phase;
  if (phase === 'half_time') return 'The first half comes to an end.';
  if (phase === 'finalised') return 'The match is over.';

  const card = cues.find((cue) => cue.kind === 'card');
  if (card) {
    const rawPlayer = card.player?.displayName ?? card.player?.sourcePreferredName;
    const player = rawPlayer ? displayPlayerName(rawPlayer) : undefined;
    const cardName = card.value.action === 'red_card' ? 'red card' : 'yellow card';
    return player ? `${player} is shown a ${cardName} for ${subject}.` : `${subject} receive a ${cardName}.`;
  }
  if (cues.some((cue) => cue.kind === 'substitution')) return `${subject} make a substitution.`;
  if (cues.some((cue) => cue.kind === 'injury')) return `Play is stopped for an injury involving ${subject}.`;
  if (cues.some((cue) => cue.kind === 'var')) return 'The incident is being checked by VAR.';
  if (cues.some((cue) => cue.kind === 'additional_time')) return 'Additional time has been indicated.';
  if (cues.some((cue) => cue.kind === 'restart')) {
    if (restartContext === 'initial') {
      return teamName ? `${teamName} get the match underway.` : 'The match gets underway.';
    }
    if (restartContext === 'second_half') {
      return teamName ? `${teamName} get the second half underway.` : 'The second half gets underway.';
    }
    if (restartContext === 'after_goal') {
      return teamName ? `${teamName} restart play after the goal.` : 'Play restarts after the goal.';
    }
    return teamName ? `${teamName} restart play.` : 'Play restarts.';
  }

  if (kind === 'pressure') {
    const corners = cues.filter((cue) => cue.kind === 'set_piece' && cue.value.action === 'corner').length;
    const efforts = cues.filter((cue) => cue.kind === 'shot_attempt' || cue.kind === 'shot_outcome').length;
    const details = [countPhrase(corners, 'corner'), countPhrase(efforts, 'effort')]
      .filter((detail): detail is string => detail !== undefined);
    return details.length > 0
      ? `${subject} keep the pressure on, with ${joinCounts(details)}.`
      : `${subject} are building pressure.`;
  }

  const setPiece = cues.find((cue) => cue.kind === 'set_piece');
  if (setPiece?.value.action === 'corner') return `${subject} win a corner.`;
  if (setPiece?.value.action === 'free_kick') return `${subject} win a free kick.`;
  if (setPiece?.value.action === 'penalty') return `${subject} are awarded a penalty.`;
  if (setPiece?.value.action === 'throw_in') return `Throw-in to ${subject}.`;
  if (setPiece?.value.action === 'goal_kick') return `${subject} take the goal kick.`;
  if (cues.some((cue) => cue.kind === 'shot_attempt')) return `${subject} have a shot.`;
  if (cues.some((cue) => cue.kind === 'shot_outcome')) return `${subject} have an effort.`;
  if (cues.some((cue) => cue.kind === 'possession_change')) return `${subject} take possession.`;

  const possession = cues.find((cue) => cue.kind === 'possession_pressure');
  if (possession?.pressure === 'safe') return `${subject} keep the ball in a safe area.`;
  if (possession?.pressure === 'neutral') return `${subject} retain possession.`;
  if (possession?.pressure === 'danger') return `${subject} advance into a dangerous area.`;
  if (possession?.pressure === 'high_danger') return `${subject} threaten the goal.`;
  if (possession) return `${subject} move onto the attack.`;
  return 'A meaningful passage of play develops.';
}

function countPhrase(count: number, singular: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function joinCounts(counts: readonly string[]): string {
  return counts.length === 2 ? `${counts[0]} and ${counts[1]}` : counts[0] ?? '';
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function uniqueFrames(frames: readonly SemanticFrame[]): SemanticFrame[] {
  return [...new Map(frames.map((frame) => [frame.id, frame])).values()].sort(compareFrames);
}

function compareFrames(left: SemanticFrame, right: SemanticFrame): number {
  return left.seq - right.seq || left.id.localeCompare(right.id);
}

/**
 * Source player names arrive in reversed CRM-style form, e.g.
 * "Quinones Quinones, Julian Andres" (note the duplicated surname) or
 * "Mbappe Lottin, Kylian". Reorder to natural "Firstname Surname" display
 * form and dedupe an exactly-repeated adjacent surname token. Names without
 * a comma, or with a single token, pass through unchanged.
 *
 * NOTE: this is duplicated from apps/api/src/match-pulse-llm.ts
 * (displayPlayerName) because that file cannot share an export with this
 * one without touching reserved index/export wiring. Keep both in sync.
 */
function displayPlayerName(rawName: string): string {
  const trimmed = rawName.trim();
  const commaIndex = trimmed.indexOf(',');
  if (commaIndex === -1) return dedupeAdjacentTokens(trimmed);

  const surnamePart = trimmed.slice(0, commaIndex).trim();
  const givenPart = trimmed.slice(commaIndex + 1).trim();
  if (!surnamePart || !givenPart) return dedupeAdjacentTokens(trimmed.replace(/,/g, ' ').replace(/\s+/g, ' ').trim());

  const surname = dedupeAdjacentTokens(surnamePart);
  return `${givenPart} ${surname}`.replace(/\s+/g, ' ').trim();
}

function dedupeAdjacentTokens(value: string): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  const deduped: string[] = [];
  for (const token of tokens) {
    if (deduped.length > 0 && deduped[deduped.length - 1]!.toLowerCase() === token.toLowerCase()) continue;
    deduped.push(token);
  }
  return deduped.join(' ');
}
