import type {
  MatchPulseEventClock,
  MatchPulseIntensity,
  MatchPulseMoment,
  MatchPulseMomentConfidence,
  MatchPulseMomentGeneration,
  MatchPulseMomentType,
  MatchPulseSourceEventRef,
} from '../match';
import type { TxlineMatchPulseSourceContext, TxlineMatchPulseSourceEvent } from './types';

export type TxlineMatchPulseValidationSeverity = 'error' | 'warning';

export type TxlineMatchPulseValidationIssueCode =
  | 'empty_copy'
  | 'fixture_mismatch'
  | 'missing_source'
  | 'source_not_found'
  | 'team_mismatch'
  | 'score_mismatch'
  | 'clock_mismatch'
  | 'type_mismatch'
  | 'unsupported_claim'
  | 'invalid_generation'
  | 'invalid_confidence'
  | 'invalid_intensity';

export interface TxlineMatchPulseValidationIssue {
  code: TxlineMatchPulseValidationIssueCode;
  severity: TxlineMatchPulseValidationSeverity;
  field?: string;
  message: string;
}

export interface TxlineMatchPulseValidationReport {
  inputId?: string;
  outputId: string;
  valid: boolean;
  fallbackUsed: boolean;
  issues: readonly TxlineMatchPulseValidationIssue[];
}

export interface TxlineMatchPulseValidationResult {
  moment: MatchPulseMoment;
  report: TxlineMatchPulseValidationReport;
}

export interface TxlineMatchPulseValidationBatchResult {
  moments: readonly MatchPulseMoment[];
  reports: readonly TxlineMatchPulseValidationReport[];
}

export interface TxlineMatchPulseValidationOptions {
  fallbackMoment?: MatchPulseMoment;
}

export const txlineMatchPulseLlmMomentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'fixtureId',
    'period',
    'clock',
    'type',
    'sourceEvents',
    'title',
    'body',
    'intensity',
    'momentumSide',
    'confidence',
    'generation',
    'fallbackTitle',
  ],
  properties: {
    id: { type: 'string' },
    fixtureId: { type: 'string' },
    period: { type: 'string' },
    clock: { type: 'object' },
    sortTimestamp: { type: 'string' },
    sortSeq: { type: 'number' },
    type: { type: 'string' },
    team: { type: 'object' },
    opponent: { type: 'object' },
    scoreAtMoment: { type: 'object' },
    sourceEvents: { type: 'array', minItems: 1 },
    title: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1 },
    intensity: { type: 'string' },
    momentumSide: { type: 'string' },
    confidence: { type: 'string' },
    generation: { type: 'string', const: 'llm' },
    fallbackTitle: { type: 'string', minLength: 1 },
    fallbackBody: { type: 'string' },
    voiceLine: { type: 'string' },
    boardHint: { type: 'object' },
  },
} as const;

const validTypes = new Set<MatchPulseMomentType>([
  'goal',
  'card',
  'shot',
  'set_piece',
  'corner',
  'free_kick',
  'throw_in',
  'penalty',
  'danger',
  'pressure',
  'substitution',
  'injury',
  'var',
  'phase_change',
  'momentum',
  'tactical',
  'commentary',
  'system',
  'fallback',
]);

const validIntensities = new Set<MatchPulseIntensity>(['quiet', 'building', 'danger', 'major']);
const validConfidence = new Set<MatchPulseMomentConfidence>(['verified', 'source_backed', 'inferred', 'low']);
const validGenerations = new Set<MatchPulseMomentGeneration>(['raw', 'rule_based', 'llm']);

const factualTypeActions: Partial<Record<MatchPulseMomentType, readonly string[]>> = {
  goal: ['goal'],
  card: ['yellow_card', 'red_card'],
  shot: ['shot'],
  corner: ['corner'],
  free_kick: ['free_kick'],
  throw_in: ['throw_in'],
  penalty: ['penalty', 'penalty_outcome'],
  danger: ['danger_possession', 'high_danger_possession'],
  pressure: ['corner', 'danger_possession', 'free_kick', 'high_danger_possession', 'shot'],
  substitution: ['substitution'],
  injury: ['injury'],
  var: ['var', 'var_end'],
  phase_change: ['game_finalised', 'halftime_finalised', 'kickoff'],
  system: ['score_adjustment'],
};

const unsupportedClaimPatterns: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /\b(bet|betting|bookmaker|odds|moneyline|parlay|spread|wager)\b/i,
    message: 'Betting language is not allowed in Match Pulse copy.',
  },
  {
    pattern: /\b\d-\d-\d(?:-\d)?\b/,
    message: 'Formation claims are unsupported by TxLINE source events.',
  },
  {
    pattern: /\b(striker|forward|winger|midfielder|defender|keeper|goalkeeper|captain)\b/i,
    message: 'Player or role claims are unsupported by TxLINE source events.',
  },
  {
    pattern: /\bball\s+(is|was|moves|moved|travels|traveled|sits|sat|rolls|rolled)\b/i,
    message: 'Video-like ball-location claims are unsupported by TxLINE source events.',
  },
];

export function validateTxlineMatchPulseMoment(
  context: TxlineMatchPulseSourceContext,
  candidate: MatchPulseMoment,
  options: TxlineMatchPulseValidationOptions = {},
): TxlineMatchPulseValidationResult {
  const sourceEvents = getCandidateSourceEvents(context, candidate.sourceEvents);
  const issues = validateCandidate(context, candidate, sourceEvents, options.fallbackMoment);
  const valid = issues.every((issue) => issue.severity !== 'error');
  const moment = valid
    ? patchSnapshotOwnedFields(candidate, sourceEvents)
    : buildDeterministicFallbackMoment(context, options.fallbackMoment ?? candidate, sourceEvents, issues);

  return {
    moment,
    report: {
      inputId: candidate.id,
      outputId: moment.id,
      valid,
      fallbackUsed: !valid,
      issues,
    },
  };
}

export function validateTxlineMatchPulseMoments(
  context: TxlineMatchPulseSourceContext,
  candidates: readonly MatchPulseMoment[],
  fallbackMoments: readonly MatchPulseMoment[] = candidates,
): TxlineMatchPulseValidationBatchResult {
  const fallbackById = new Map(fallbackMoments.map((moment) => [moment.id, moment]));
  const results = candidates.map((candidate, index) =>
    validateTxlineMatchPulseMoment(context, candidate, {
      fallbackMoment: fallbackById.get(candidate.id) ?? fallbackMoments[index],
    }),
  );

  return {
    moments: results.map((result) => result.moment),
    reports: results.map((result) => result.report),
  };
}

function validateCandidate(
  context: TxlineMatchPulseSourceContext,
  candidate: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
  fallbackMoment?: MatchPulseMoment,
): readonly TxlineMatchPulseValidationIssue[] {
  const issues: TxlineMatchPulseValidationIssue[] = [];
  addFixtureIssues(issues, context, candidate);
  addSourceIssues(issues, candidate, sourceEvents);
  addCopyIssues(issues, candidate);
  addEnumIssues(issues, candidate);
  addFallbackMomentIssues(issues, candidate, fallbackMoment);

  if (sourceEvents.length > 0) {
    addTeamIssues(issues, candidate, sourceEvents);
    addScoreIssues(issues, candidate, sourceEvents);
    addClockIssues(issues, candidate, sourceEvents);
    addTypeIssues(issues, candidate, sourceEvents);
  }

  return issues;
}

function addFallbackMomentIssues(
  issues: TxlineMatchPulseValidationIssue[],
  candidate: MatchPulseMoment,
  fallbackMoment: MatchPulseMoment | undefined,
): void {
  if (!fallbackMoment || candidate.type === fallbackMoment.type) {
    return;
  }

  issues.push({
    code: 'type_mismatch',
    severity: 'error',
    field: 'type',
    message: `LLM moment type ${candidate.type} does not match admitted fallback type ${fallbackMoment.type}.`,
  });
}

function addFixtureIssues(
  issues: TxlineMatchPulseValidationIssue[],
  context: TxlineMatchPulseSourceContext,
  candidate: MatchPulseMoment,
): void {
  if (candidate.fixtureId !== context.fixture.fixtureId) {
    issues.push({
      code: 'fixture_mismatch',
      severity: 'error',
      field: 'fixtureId',
      message: `Moment fixture ${candidate.fixtureId} does not match source fixture ${context.fixture.fixtureId}.`,
    });
  }
}

function addSourceIssues(
  issues: TxlineMatchPulseValidationIssue[],
  candidate: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
): void {
  if (candidate.sourceEvents.length === 0) {
    issues.push({
      code: 'missing_source',
      severity: 'error',
      field: 'sourceEvents',
      message: 'Moment has no source events.',
    });
    return;
  }

  const missingIds = candidate.sourceEvents.filter((source) => !source.id && typeof source.seq !== 'number');
  if (missingIds.length > 0) {
    issues.push({
      code: 'missing_source',
      severity: 'error',
      field: 'sourceEvents',
      message: 'Moment source events must include a TxLINE id or sequence.',
    });
  }

  if (sourceEvents.length !== candidate.sourceEvents.length) {
    issues.push({
      code: 'source_not_found',
      severity: 'error',
      field: 'sourceEvents',
      message: 'One or more moment source events were not found in TxLINE source context.',
    });
  }
}

function addCopyIssues(issues: TxlineMatchPulseValidationIssue[], candidate: MatchPulseMoment): void {
  if (!candidate.title.trim() || !candidate.body.trim()) {
    issues.push({
      code: 'empty_copy',
      severity: 'error',
      field: !candidate.title.trim() ? 'title' : 'body',
      message: 'Moment title and body must not be empty.',
    });
  }

  const copy = [candidate.title, candidate.body, candidate.voiceLine].filter(Boolean).join(' ');
  for (const unsupported of unsupportedClaimPatterns) {
    if (unsupported.pattern.test(copy)) {
      issues.push({
        code: 'unsupported_claim',
        severity: 'error',
        field: 'copy',
        message: unsupported.message,
      });
    }
  }
}

function addEnumIssues(issues: TxlineMatchPulseValidationIssue[], candidate: MatchPulseMoment): void {
  if (!validTypes.has(candidate.type)) {
    issues.push({
      code: 'type_mismatch',
      severity: 'error',
      field: 'type',
      message: `Unsupported moment type: ${candidate.type}.`,
    });
  }

  if (!validIntensities.has(candidate.intensity)) {
    issues.push({
      code: 'invalid_intensity',
      severity: 'error',
      field: 'intensity',
      message: `Unsupported intensity: ${candidate.intensity}.`,
    });
  }

  if (!validConfidence.has(candidate.confidence)) {
    issues.push({
      code: 'invalid_confidence',
      severity: 'error',
      field: 'confidence',
      message: `Unsupported confidence: ${candidate.confidence}.`,
    });
  }

  if (!validGenerations.has(candidate.generation)) {
    issues.push({
      code: 'invalid_generation',
      severity: 'error',
      field: 'generation',
      message: `Unsupported generation mode: ${candidate.generation}.`,
    });
  }
}

function addTeamIssues(
  issues: TxlineMatchPulseValidationIssue[],
  candidate: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
): void {
  if (!candidate.team) {
    return;
  }

  const matched = sourceEvents.some((event) =>
    event.team?.id === candidate.team?.id &&
    event.team?.name === candidate.team?.name &&
    (!candidate.team?.side || event.team?.side === candidate.team.side),
  );
  if (!matched) {
    issues.push({
      code: 'team_mismatch',
      severity: 'error',
      field: 'team',
      message: 'Moment team is not supported by its source events.',
    });
  }
}

function addScoreIssues(
  issues: TxlineMatchPulseValidationIssue[],
  candidate: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
): void {
  if (!candidate.scoreAtMoment) {
    return;
  }

  const scoreAtMoment = candidate.scoreAtMoment;
  const matched = sourceEvents.some((event) =>
    event.score?.home === scoreAtMoment.home &&
    event.score?.away === scoreAtMoment.away,
  );
  if (!matched) {
    issues.push({
      code: 'score_mismatch',
      severity: 'error',
      field: 'scoreAtMoment',
      message: 'Moment score is not supported by its source events.',
    });
  }
}

function addClockIssues(
  issues: TxlineMatchPulseValidationIssue[],
  candidate: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
): void {
  const matched = sourceEvents.some((event) => clocksMatch(candidate.clock, event.clock));
  if (!matched) {
    issues.push({
      code: 'clock_mismatch',
      severity: 'warning',
      field: 'clock',
      message: 'Moment clock is not supported by its source events.',
    });
  }
}

function addTypeIssues(
  issues: TxlineMatchPulseValidationIssue[],
  candidate: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
): void {
  const allowedActions = factualTypeActions[candidate.type];
  if (!allowedActions) {
    return;
  }

  const matched = sourceEvents.some((event) => {
    const action = event.normalizedAction ?? event.rawAction;
    return Boolean(action && allowedActions.includes(action));
  });
  if (!matched) {
    issues.push({
      code: 'type_mismatch',
      severity: 'error',
      field: 'type',
      message: `Moment type ${candidate.type} is not supported by its source actions.`,
    });
  }
}

function getCandidateSourceEvents(
  context: TxlineMatchPulseSourceContext,
  sourceRefs: readonly MatchPulseSourceEventRef[],
): readonly TxlineMatchPulseSourceEvent[] {
  return sourceRefs
    .map((sourceRef) => findSourceEvent(context, sourceRef))
    .filter((event): event is TxlineMatchPulseSourceEvent => Boolean(event));
}

function findSourceEvent(
  context: TxlineMatchPulseSourceContext,
  sourceRef: MatchPulseSourceEventRef,
): TxlineMatchPulseSourceEvent | undefined {
  if (sourceRef.fixtureId && sourceRef.fixtureId !== context.fixture.fixtureId) {
    return undefined;
  }

  const candidates = context.sourceEvents.filter((event) => {
    if (sourceRef.kind && sourceRef.kind !== event.sourceRef.kind) {
      return false;
    }

    const idMatches = sourceRef.id && event.sourceRef.id === sourceRef.id;
    const seqMatches = typeof sourceRef.seq === 'number' && event.sourceRef.seq === sourceRef.seq;
    const actionMatches = !sourceRef.action ||
      sourceRef.action === event.rawAction ||
      sourceRef.action === event.normalizedAction;

    return Boolean(actionMatches && (idMatches || seqMatches));
  });

  return candidates.sort((left, right) => getSourceRefMatchRank(right, sourceRef) - getSourceRefMatchRank(left, sourceRef))[0];
}

function getSourceRefMatchRank(event: TxlineMatchPulseSourceEvent, sourceRef: MatchPulseSourceEventRef): number {
  let rank = 0;
  if (sourceRef.updatedAt && event.updatedAt === sourceRef.updatedAt) {
    rank += 8;
  }

  if (sourceRef.confirmed === event.confirmed) {
    rank += 4;
  }

  if (sourceRef.teamId && event.team?.id === sourceRef.teamId) {
    rank += 2;
  }

  if (event.score) {
    rank += 1;
  }

  return rank;
}

function patchSnapshotOwnedFields(
  candidate: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
): MatchPulseMoment {
  const anchor = getAnchorSourceEvent(sourceEvents);
  const scoreSource = [...sourceEvents].reverse().find((event) => event.score);
  return {
    ...candidate,
    clock: anchor?.clock ?? candidate.clock,
    scoreAtMoment: scoreSource?.score ?? candidate.scoreAtMoment,
    sourceEvents: sourceEvents.map((event) => event.sourceRef),
  };
}

function buildDeterministicFallbackMoment(
  context: TxlineMatchPulseSourceContext,
  fallbackSeed: MatchPulseMoment,
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
  issues: readonly TxlineMatchPulseValidationIssue[],
): MatchPulseMoment {
  const safeSourceEvents = sourceEvents.length > 0 ? sourceEvents : getCandidateSourceEvents(context, fallbackSeed.sourceEvents);
  const anchor = getAnchorSourceEvent(safeSourceEvents);
  const latest = safeSourceEvents[safeSourceEvents.length - 1] ?? anchor;
  const scoreSource = [...safeSourceEvents].reverse().find((event) => event.score);
  const title = fallbackSeed.fallbackTitle || fallbackSeed.title || 'Match update';
  const body = fallbackSeed.fallbackBody ||
    fallbackSeed.body ||
    getFallbackBody(title, anchor?.clock, scoreSource?.score);

  return {
    ...fallbackSeed,
    id: fallbackSeed.id || `${context.fixture.fixtureId}-fallback-${anchor?.seq ?? 'unknown'}`,
    fixtureId: context.fixture.fixtureId,
    period: fallbackSeed.period ?? context.phase,
    clock: anchor?.clock ?? fallbackSeed.clock,
    sortTimestamp: latest?.updatedAt ?? fallbackSeed.sortTimestamp,
    sortSeq: latest?.seq ?? fallbackSeed.sortSeq,
    scoreAtMoment: scoreSource?.score ?? fallbackSeed.scoreAtMoment,
    sourceEvents: safeSourceEvents.length > 0
      ? safeSourceEvents.map((event) => event.sourceRef)
      : fallbackSeed.sourceEvents,
    title,
    body,
    confidence: issues.some((issue) => issue.code === 'source_not_found' || issue.code === 'missing_source')
      ? 'low'
      : fallbackSeed.confidence === 'verified'
        ? 'source_backed'
        : fallbackSeed.confidence,
    generation: 'rule_based',
    fallbackTitle: title,
    fallbackBody: body,
    voiceLine: undefined,
  };
}

function getAnchorSourceEvent(
  sourceEvents: readonly TxlineMatchPulseSourceEvent[],
): TxlineMatchPulseSourceEvent | undefined {
  return [...sourceEvents].sort((left, right) =>
    left.seq - right.seq ||
    (left.clockSeconds ?? -1) - (right.clockSeconds ?? -1),
  )[0];
}

function getFallbackBody(
  title: string,
  clock: MatchPulseEventClock | undefined,
  score: { home: number; away: number } | undefined,
): string {
  const clockText = clock?.label ? ` at ${clock.label}` : '';
  const scoreText = score ? ` Score: ${score.home}-${score.away}.` : '';
  return `${title}${clockText}.${scoreText}`.trim();
}

function clocksMatch(left: MatchPulseEventClock, right: MatchPulseEventClock): boolean {
  if (typeof left.seconds === 'number' && typeof right.seconds === 'number') {
    return left.seconds === right.seconds;
  }

  if (typeof left.minute === 'number' && typeof right.minute === 'number') {
    return left.minute === right.minute;
  }

  return left.label === right.label;
}
