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

const DEFAULT_PRESSURE_WINDOW_SECONDS = 90;

const routineKinds = new Set<SimulationCue['kind']>([
  'set_piece',
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

interface PlannedFrame {
  frame: SemanticFrame;
  evidenceFrames: SemanticFrame[];
  cues: SimulationCue[];
  kind: CommentaryBeatKind;
  participant?: MatchEngineParticipant;
  teamId?: number | string;
  pressureEligible: boolean;
  phase?: MatchEnginePhase;
  restartContext?: CommentaryRestartContext;
}

/**
 * Plans narration from a complete, ordered projection generation. Frames with
 * no supporter-facing meaning are omitted; confirmed incident revisions are
 * collapsed so enrichment cannot create a duplicate beat.
 */
export function planCommentaryBeats(
  inputFrames: readonly SemanticFrame[],
  options: CommentaryBeatPlanningOptions,
): readonly CommentaryBeat[] {
  if (!Number.isSafeInteger(options.projectionGeneration) || options.projectionGeneration < 0) {
    throw new TypeError('Commentary projection generation must be a non-negative integer.');
  }

  const frames = [...inputFrames].sort(compareFrames);
  const planned = addNarrativeContext(selectPlannedFrames(frames));
  const beats: CommentaryBeat[] = [];
  let pressureCluster: PlannedFrame[] = [];

  const flushPressure = () => {
    if (pressureCluster.length === 0) return;
    beats.push(buildBeat(
      pressureCluster,
      pressureCluster.length > 1 ? 'pressure' : pressureCluster[0]!.kind,
      options,
    ));
    pressureCluster = [];
  };

  for (const candidate of planned) {
    if (candidate.kind === 'major') {
      flushPressure();
      beats.push(buildBeat([candidate], 'major', options));
      continue;
    }

    if (!candidate.pressureEligible) {
      flushPressure();
      beats.push(buildBeat([candidate], candidate.kind, options));
      continue;
    }

    const anchor = pressureCluster[0];
    if (anchor && !canJoinPressure(anchor, candidate, options.pressureWindowSeconds)) {
      flushPressure();
    }
    pressureCluster.push(candidate);
  }

  flushPressure();
  return beats;
}

function selectPlannedFrames(frames: readonly SemanticFrame[]): PlannedFrame[] {
  const earliestConfirmedIncidentFrame = new Map<string, string>();
  const latestConfirmedIncidentCue = new Map<string, SimulationCue>();
  const confirmedIncidentFrames = new Map<string, SemanticFrame[]>();

  for (const frame of frames) {
    for (const cue of frame.simulationCues) {
      if (cue.updateMode !== 'incident_upsert' || cue.lifecycle !== 'confirmed') continue;
      if (!earliestConfirmedIncidentFrame.has(cue.id)) earliestConfirmedIncidentFrame.set(cue.id, frame.id);
      latestConfirmedIncidentCue.set(cue.id, cue);
      const evidence = confirmedIncidentFrames.get(cue.id) ?? [];
      evidence.push(frame);
      confirmedIncidentFrames.set(cue.id, evidence);
    }
  }

  return frames.flatMap((frame) => {
    const cues = frame.simulationCues
      .filter(isCommentaryCue)
      .filter((cue) => cue.updateMode !== 'incident_upsert'
        || cue.lifecycle !== 'confirmed'
        || earliestConfirmedIncidentFrame.get(cue.id) === frame.id)
      .map((cue) => latestConfirmedIncidentCue.get(cue.id) ?? cue);
    const goal = cues.find((cue) => cue.kind === 'goal_confirmed');
    const phase = cues.find(isMajorPhaseCue);
    const redCard = cues.find((cue) => cue.kind === 'card' && cue.value.action === 'red_card');
    const majorCue = goal ?? redCard ?? phase;
    const selectedCues = majorCue
      ? cues.filter((cue) => cue === majorCue || cue.kind === 'score_commit')
      : cues;
    if (selectedCues.length === 0) return [];

    const anchor = majorCue ?? selectedCues[0]!;
    const evidenceFrames = uniqueFrames([
      frame,
      ...selectedCues.flatMap((cue) => confirmedIncidentFrames.get(cue.id) ?? []),
    ]);
    const phaseValue = frame.facts.find((fact) => fact.kind === 'phase')?.value.phase
      ?? frame.simulationCues.find((cue) => cue.kind === 'phase_change')?.value.phase;
    return [{
      frame,
      evidenceFrames,
      cues: selectedCues,
      kind: majorCue ? 'major' : 'routine',
      participant: anchor.participant,
      teamId: anchor.teamId,
      pressureEligible: !majorCue && selectedCues.some(isPressureCue),
      ...(isMatchEnginePhase(phaseValue) ? { phase: phaseValue } : {}),
    }];
  });
}

function addNarrativeContext(planned: readonly PlannedFrame[]): PlannedFrame[] {
  const result: PlannedFrame[] = [];
  let matchStarted = false;
  let goalAwaitingRestart = false;
  let latestGoalOccurrence = Number.NEGATIVE_INFINITY;

  for (const candidate of planned) {
    if (
      candidate.phase === 'half_time'
      || candidate.phase === 'second_half_ready'
      || candidate.phase === 'second_half'
    ) latestGoalOccurrence = Number.NEGATIVE_INFINITY;
    const occurrence = Math.min(...candidate.cues.map((cue) => cue.occurrenceSeconds)
      .filter((value): value is number => typeof value === 'number'));
    const effectiveOccurrence = Number.isFinite(occurrence)
      ? occurrence
      : candidate.frame.matchClockSeconds;
    // A late confirmation may enrich an old incident after a goal/restart has
    // already been narrated. It remains in engine truth, but not the live feed.
    if (
      candidate.kind === 'routine'
      && candidate.cues.some((cue) => cue.updateMode === 'incident_upsert')
      && typeof effectiveOccurrence === 'number'
      && effectiveOccurrence < latestGoalOccurrence
    ) continue;

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
      if (typeof effectiveOccurrence === 'number') {
        latestGoalOccurrence = Math.max(latestGoalOccurrence, effectiveOccurrence);
      }
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
  if (cue.kind === 'phase_change') return isMajorPhaseCue(cue);
  if (!routineKinds.has(cue.kind)) return false;
  if (cue.kind === 'possession_pressure') {
    return cue.pressure === 'attack' || cue.pressure === 'danger' || cue.pressure === 'high_danger';
  }
  if (cue.kind === 'set_piece' && (cue.value.action === 'throw_in' || cue.value.action === 'goal_kick')) {
    return false;
  }
  if (cue.updateMode === 'incident_upsert') return cue.lifecycle === 'confirmed';
  return cue.lifecycle === 'confirmed' || cue.lifecycle === 'observed';
}

function isMajorPhaseCue(cue: SimulationCue): boolean {
  return cue.kind === 'phase_change'
    && (cue.value.phase === 'half_time' || cue.value.phase === 'finalised');
}

function isPressureCue(cue: SimulationCue): boolean {
  if (cue.kind === 'possession_pressure' || cue.kind === 'shot_attempt' || cue.kind === 'shot_outcome') return true;
  return cue.kind === 'set_piece' && (cue.value.action === 'corner' || cue.value.action === 'free_kick');
}

function canJoinPressure(
  anchor: PlannedFrame,
  candidate: PlannedFrame,
  configuredWindow = DEFAULT_PRESSURE_WINDOW_SECONDS,
): boolean {
  const previousOwner = anchor.teamId ?? anchor.participant;
  const candidateOwner = candidate.teamId ?? candidate.participant;
  if (
    previousOwner === undefined
    || candidateOwner === undefined
    || String(previousOwner) !== String(candidateOwner)
  ) {
    return false;
  }
  const previousClock = anchor.frame.matchClockSeconds;
  const candidateClock = candidate.frame.matchClockSeconds;
  if (typeof previousClock === 'number' && typeof candidateClock === 'number') {
    return candidateClock >= previousClock && candidateClock - previousClock <= configuredWindow;
  }
  return candidate.frame.seq - anchor.frame.seq <= 3;
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
    id: [first.frame.fixtureId, 'commentary', options.projectionGeneration, first.frame.seq, last.frame.seq].join(':'),
    fixtureId: first.frame.fixtureId,
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

function fallbackFor(
  kind: CommentaryBeatKind,
  cues: readonly SimulationCue[],
  teamName?: string,
  restartContext?: CommentaryRestartContext,
): string {
  const subject = teamName ?? 'One side';
  const goal = cues.find((cue) => cue.kind === 'goal_confirmed');
  if (goal) {
    const scorer = goal.player?.displayName ?? goal.player?.sourcePreferredName;
    const score = cues.find((cue) => cue.kind === 'score_commit')?.value;
    const scoreText = typeof score?.participant1 === 'number' && typeof score?.participant2 === 'number'
      ? ` It is ${score.participant1}-${score.participant2}.`
      : '';
    return scorer ? `Goal for ${subject}, scored by ${scorer}.${scoreText}` : `Goal for ${subject}.${scoreText}`;
  }

  const phase = cues.find((cue) => cue.kind === 'phase_change')?.value.phase;
  if (phase === 'half_time') return 'The first half comes to an end.';
  if (phase === 'finalised') return 'The match is over.';

  const card = cues.find((cue) => cue.kind === 'card');
  if (card) {
    const player = card.player?.displayName ?? card.player?.sourcePreferredName;
    const cardName = card.value.action === 'red_card' ? 'red card' : 'yellow card';
    return player ? `${player} is shown a ${cardName}.` : `${subject} receive a ${cardName}.`;
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
  if (cues.some((cue) => cue.kind === 'shot_attempt' || cue.kind === 'shot_outcome')) return `${subject} have an effort.`;
  if (cues.some((cue) => cue.kind === 'possession_pressure')) return `${subject} move onto the attack.`;
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
