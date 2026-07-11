import type {
  MatchPulseCommentaryEntry,
  MatchPhase,
  MatchPulseEventClock,
  MatchPulseBoardHint,
  MatchPulseIntensity,
  MatchPulseMoment,
  MatchPulseMomentConfidence,
  MatchPulseMomentTeamRef,
  MatchPulseMomentType,
  MatchPulseMomentumSide,
  MatchPulseSourceEventRef,
} from '../match';
import type { TxlineMatchPulseSourceContext, TxlineMatchPulseSourceEvent } from './types';

export interface TxlineMatchPulseAdmissionOptions {
  pressureWindowSeconds?: number;
  pressureMinimumEvents?: number;
}

export interface TxlineMatchPulseCommentaryOptions {
  pressureWindowSeconds?: number;
  quietWindowSeconds?: number;
}

const defaultAdmissionOptions = {
  pressureWindowSeconds: 90,
  pressureMinimumEvents: 3,
} satisfies Required<TxlineMatchPulseAdmissionOptions>;

const defaultCommentaryOptions = {
  pressureWindowSeconds: 90,
  quietWindowSeconds: 30,
} satisfies Required<TxlineMatchPulseCommentaryOptions>;

const sourcePriority = {
  snapshot: 3,
  update: 2,
  history: 1,
} as const;

const mustShowActions = new Set([
  'goal',
  'yellow_card',
  'red_card',
  'var',
  'penalty',
  'penalty_outcome',
  'score_adjustment',
  'game_finalised',
  'halftime_finalised',
]);

const pressureActions = new Set([
  'corner',
  'danger_possession',
  'high_danger_possession',
  'free_kick',
  'shot',
]);

const supportOnlyActions = new Set([
  'throw_in',
]);

const hiddenActions = new Set([
  'action_amend',
  'action_discarded',
  'clock_adjustment',
  'comment',
  'connected',
  'coverage_update',
  'disconnected',
  'jersey',
  'kickoff_team',
  'lineups',
  'pitch',
  'players_on_the_pitch',
  'players_warming_up',
  'standby',
  'status',
  'unreliable_corners',
  'unreliable_yellow_cards',
  'venue',
  'weather',
]);

export function admitTxlineMatchPulseMoments(
  context: TxlineMatchPulseSourceContext,
  options: TxlineMatchPulseAdmissionOptions = {},
): readonly MatchPulseMoment[] {
  const config = {
    ...defaultAdmissionOptions,
    ...options,
  };
  const admittedEvents = getConfirmedAdmittedSourceEvents(context.sourceEvents);
  const mustShowMoments = admittedEvents
    .filter(isMustShowEvent)
    .map((event) => buildSingleEventMoment(context, event));
  const pressureMoments = buildPressureMoments(
    context,
    admittedEvents.filter((event) => !isMustShowEvent(event)),
    config,
  );

  return [...mustShowMoments, ...pressureMoments].sort(compareMoments);
}

export function buildTxlineMatchPulseCommentaryEntries(
  context: TxlineMatchPulseSourceContext,
  options: TxlineMatchPulseCommentaryOptions = {},
): readonly MatchPulseCommentaryEntry[] {
  const config = {
    ...defaultCommentaryOptions,
    ...options,
  };
  const sourceEvents = getConfirmedAdmittedSourceEvents(context.sourceEvents);
  const entries: MatchPulseCommentaryEntry[] = [];
  let batch: TxlineMatchPulseSourceEvent[] = [];

  const flushBatch = () => {
    const entry = buildCommentaryEntry(context, batch);
    if (entry) {
      entries.push(entry);
    }

    batch = [];
  };

  for (const event of sourceEvents) {
    if (isMustShowEvent(event)) {
      flushBatch();
      entries.push(buildCommentaryEntry(context, [event], { mustCover: true })!);
      continue;
    }

    if (shouldStartNewCommentaryBatch(batch, event, config)) {
      flushBatch();
    }

    batch.push(event);
  }

  flushBatch();
  return entries.sort(compareCommentaryEntries);
}

function shouldStartNewCommentaryBatch(
  batch: readonly TxlineMatchPulseSourceEvent[],
  event: TxlineMatchPulseSourceEvent,
  options: Required<TxlineMatchPulseCommentaryOptions>,
): boolean {
  if (batch.length === 0) {
    return false;
  }

  const anchor = batch[0];
  const previous = batch[batch.length - 1];
  if (!anchor || !previous) {
    return false;
  }

  if (isPressureEvent(event) || batch.some(isPressureEvent)) {
    return !canJoinPressureCluster(anchor, previous, event, options.pressureWindowSeconds);
  }

  if (previous.team?.id && event.team?.id && previous.team.id !== event.team.id) {
    return true;
  }

  if (typeof anchor.clockSeconds === 'number' && typeof event.clockSeconds === 'number') {
    return event.clockSeconds - anchor.clockSeconds > options.quietWindowSeconds;
  }

  return event.seq - previous.seq > 1;
}

function buildCommentaryEntry(
  context: TxlineMatchPulseSourceContext,
  batch: readonly TxlineMatchPulseSourceEvent[],
  options: { mustCover?: boolean } = {},
): MatchPulseCommentaryEntry | undefined {
  const sourceEvents = batch.filter((event) => !isHiddenEvent(event));
  if (sourceEvents.length === 0) {
    return undefined;
  }

  const meaningfulEvents = sourceEvents.filter((event) => !isSupportOnlyEvent(event));
  if (!options.mustCover && meaningfulEvents.length === 0 && sourceEvents.length < 2) {
    return undefined;
  }

  const commentaryEvents = meaningfulEvents.length > 0 ? sourceEvents : sourceEvents;
  const pressureEvents = commentaryEvents.filter(isPressureEvent);
  const anchor = pressureEvents[0] ?? meaningfulEvents[0] ?? commentaryEvents[0];
  const latest = commentaryEvents[commentaryEvents.length - 1] ?? anchor;
  const action = getCommentaryAction(anchor, pressureEvents);
  const team = getMomentTeam(anchor);
  const fallbackCommentary = getFallbackCommentary(anchor, commentaryEvents, pressureEvents, action, team);

  return {
    id: getCommentaryEntryId(context, commentaryEvents),
    fixtureId: context.fixture.fixtureId,
    batchId: getCommentaryBatchId(context, commentaryEvents),
    fromSeq: Math.min(...commentaryEvents.map((event) => event.seq)),
    toSeq: Math.max(...commentaryEvents.map((event) => event.seq)),
    period: getMomentPeriod(context, latest),
    clock: anchor.clock,
    sortTimestamp: latest.updatedAt ?? anchor.updatedAt,
    sortSeq: latest.seq,
    kind: getMomentType(action),
    team,
    opponent: getOpponentTeam(context, team),
    scoreAtMoment: latest.score ?? anchor.score,
    sourceEvents: commentaryEvents.map((event) => event.sourceRef),
    commentary: fallbackCommentary,
    intensity: getCommentaryIntensity(action, commentaryEvents, pressureEvents),
    momentumSide: getMomentumSide(anchor),
    confidence: getMomentConfidence(commentaryEvents),
    generation: 'rule_based',
    fallbackCommentary,
    enrichmentStatus: 'pending',
    boardHint: getBoardHint(anchor, commentaryEvents),
  };
}

function getCommentaryAction(
  anchor: TxlineMatchPulseSourceEvent,
  pressureEvents: readonly TxlineMatchPulseSourceEvent[],
): string {
  if (pressureEvents.length >= 2) {
    return 'pressure';
  }

  return anchor.normalizedAction ?? anchor.rawAction ?? 'commentary';
}

function getFallbackCommentary(
  anchor: TxlineMatchPulseSourceEvent,
  batch: readonly TxlineMatchPulseSourceEvent[],
  pressureEvents: readonly TxlineMatchPulseSourceEvent[],
  action: string,
  team?: MatchPulseMomentTeamRef,
): string {
  if (pressureEvents.length >= 2) {
    const counts = getPressureCounts(pressureEvents);
    return team
      ? `${team.name} are building pressure around ${anchor.clock.label}, with ${formatPressureCounts(counts)}.`
      : `Pressure is building around ${anchor.clock.label}.`;
  }

  if (batch.length > 1 && batch.every(isSupportOnlyEvent)) {
    return team
      ? `${team.name} keep play moving around ${anchor.clock.label}.`
      : `Play keeps moving around ${anchor.clock.label}.`;
  }

  const title = getSingleEventTitle(anchor, action);
  return getSingleEventBody(anchor, action, title, team);
}

function getCommentaryEntryId(
  context: TxlineMatchPulseSourceContext,
  events: readonly TxlineMatchPulseSourceEvent[],
): string {
  return `${getCommentaryBatchId(context, events)}-entry`;
}

function getCommentaryBatchId(
  context: TxlineMatchPulseSourceContext,
  events: readonly TxlineMatchPulseSourceEvent[],
): string {
  const first = events[0];
  const last = events[events.length - 1] ?? first;
  const sourceIds = events
    .map((event) => event.sourceRef.id ?? event.seq)
    .join('.');
  return [
    context.fixture.fixtureId,
    'commentary',
    first?.source ?? 'source',
    first?.seq ?? 'start',
    last?.seq ?? 'end',
    sourceIds,
  ].join('-');
}

function getOpponentTeam(
  context: TxlineMatchPulseSourceContext,
  team?: MatchPulseMomentTeamRef,
): MatchPulseMomentTeamRef | undefined {
  if (!team?.side) {
    return undefined;
  }

  const opponent = team.side === 'home' ? context.awayTeam : context.homeTeam;
  return {
    id: opponent.id,
    name: opponent.name,
    shortName: opponent.shortName,
    side: team.side === 'home' ? 'away' : 'home',
  };
}

function getCommentaryIntensity(
  action: string,
  events: readonly TxlineMatchPulseSourceEvent[],
  pressureEvents: readonly TxlineMatchPulseSourceEvent[],
): MatchPulseIntensity {
  if (action === 'pressure') {
    return getPressureIntensity(pressureEvents);
  }

  return events.reduce<MatchPulseIntensity>(
    (current, event) => getIntensityRank(event.intensity) > getIntensityRank(current) ? event.intensity : current,
    getMomentIntensity(action, 'quiet'),
  );
}

function getIntensityRank(intensity: MatchPulseIntensity): number {
  if (intensity === 'major') {
    return 4;
  }

  if (intensity === 'danger') {
    return 3;
  }

  if (intensity === 'building') {
    return 2;
  }

  return 1;
}

function dedupeSourceEvents(
  events: readonly TxlineMatchPulseSourceEvent[],
): readonly TxlineMatchPulseSourceEvent[] {
  const deduped = new Map<string, TxlineMatchPulseSourceEvent>();

  for (const event of events) {
    const key = getDedupeKey(event);
    const existing = deduped.get(key);
    if (!existing || shouldReplaceEvent(existing, event)) {
      deduped.set(key, event);
    }
  }

  return [...deduped.values()];
}

function getConfirmedAdmittedSourceEvents(
  events: readonly TxlineMatchPulseSourceEvent[],
): readonly TxlineMatchPulseSourceEvent[] {
  return dedupeSourceEvents(events)
    .filter(isConfirmedSourceEvent)
    .filter((event) => !isHiddenEvent(event))
    .sort(compareEvents);
}

function isConfirmedSourceEvent(event: TxlineMatchPulseSourceEvent): boolean {
  return event.confirmed === true;
}

function getDedupeKey(event: TxlineMatchPulseSourceEvent): string {
  const action = event.normalizedAction ?? event.rawAction ?? 'unknown';
  const score = event.score ? `${event.score.home}-${event.score.away}` : 'no-score';
  return [
    event.sourceRef.id ?? 'no-id',
    action,
    event.clockSeconds ?? 'no-clock',
    event.participant ?? 'no-participant',
    score,
  ].join(':');
}

function shouldReplaceEvent(existing: TxlineMatchPulseSourceEvent, candidate: TxlineMatchPulseSourceEvent): boolean {
  if (existing.confirmed !== true && candidate.confirmed === true) {
    return true;
  }

  if (existing.confirmed === true && candidate.confirmed !== true) {
    return false;
  }

  if (sourcePriority[candidate.source] !== sourcePriority[existing.source]) {
    return sourcePriority[candidate.source] > sourcePriority[existing.source];
  }

  return candidate.seq > existing.seq;
}

function isHiddenEvent(event: TxlineMatchPulseSourceEvent): boolean {
  const action = event.normalizedAction ?? event.rawAction;
  return !action || hiddenActions.has(action);
}

function isMustShowEvent(event: TxlineMatchPulseSourceEvent): boolean {
  const action = event.normalizedAction ?? event.rawAction;
  return Boolean(action && mustShowActions.has(action));
}

function isPressureEvent(event: TxlineMatchPulseSourceEvent): boolean {
  const action = event.normalizedAction ?? event.rawAction;
  return Boolean(action && pressureActions.has(normalizeActionName(action)));
}

function isSupportOnlyEvent(event: TxlineMatchPulseSourceEvent): boolean {
  const action = event.normalizedAction ?? event.rawAction;
  return Boolean(action && supportOnlyActions.has(normalizeActionName(action)));
}

function buildPressureMoments(
  context: TxlineMatchPulseSourceContext,
  events: readonly TxlineMatchPulseSourceEvent[],
  options: Required<TxlineMatchPulseAdmissionOptions>,
): readonly MatchPulseMoment[] {
  const candidates = events.filter((event) => isPressureEvent(event) || isSupportOnlyEvent(event));
  const moments: MatchPulseMoment[] = [];
  let cluster: TxlineMatchPulseSourceEvent[] = [];

  const flush = () => {
    if (cluster.length === 0) {
      return;
    }

    const pressureEvents = cluster.filter(isPressureEvent);
    if (pressureEvents.length >= options.pressureMinimumEvents) {
      moments.push(buildPressureMoment(context, cluster, pressureEvents));
    } else if (pressureEvents.length === 1 && !isLowValueIsolatedEvent(pressureEvents[0])) {
      moments.push(buildSingleEventMoment(context, pressureEvents[0]));
    }

    cluster = [];
  };

  for (const event of candidates.sort(compareEvents)) {
    const previous = cluster[cluster.length - 1];
    const anchor = cluster[0];
    if (!previous || !anchor || canJoinPressureCluster(anchor, previous, event, options.pressureWindowSeconds)) {
      cluster.push(event);
      continue;
    }

    flush();
    cluster.push(event);
  }

  flush();
  return moments;
}

function canJoinPressureCluster(
  anchor: TxlineMatchPulseSourceEvent,
  previous: TxlineMatchPulseSourceEvent,
  event: TxlineMatchPulseSourceEvent,
  windowSeconds: number,
): boolean {
  if (previous.team?.id !== event.team?.id) {
    return false;
  }

  if (typeof previous.clockSeconds !== 'number' || typeof event.clockSeconds !== 'number') {
    return previous.clock.label === event.clock.label;
  }

  if (typeof anchor.clockSeconds !== 'number') {
    return event.clockSeconds - previous.clockSeconds <= windowSeconds;
  }

  return event.clockSeconds - anchor.clockSeconds <= windowSeconds;
}

function isLowValueIsolatedEvent(event: TxlineMatchPulseSourceEvent): boolean {
  const action = event.normalizedAction ?? event.rawAction;
  return action === 'throw_in';
}

function buildSingleEventMoment(
  context: TxlineMatchPulseSourceContext,
  event: TxlineMatchPulseSourceEvent,
): MatchPulseMoment {
  const action = event.normalizedAction ?? event.rawAction ?? 'fallback';
  const team = getMomentTeam(event);
  const title = getSingleEventTitle(event, action);
  const body = getSingleEventBody(event, action, title, team);

  return {
    id: getMomentId(context, 'event', [event]),
    fixtureId: context.fixture.fixtureId,
    period: getMomentPeriod(context, event),
    clock: event.clock,
    sortTimestamp: event.updatedAt,
    sortSeq: event.seq,
    type: getMomentType(action),
    team,
    scoreAtMoment: event.score,
    sourceEvents: [event.sourceRef],
    title,
    body,
    intensity: getMomentIntensity(action, event.intensity),
    momentumSide: getMomentumSide(event),
    confidence: getMomentConfidence([event]),
    generation: 'rule_based',
    fallbackTitle: title,
    fallbackBody: body,
    boardHint: getBoardHint(event),
  };
}

function buildPressureMoment(
  context: TxlineMatchPulseSourceContext,
  cluster: readonly TxlineMatchPulseSourceEvent[],
  pressureEvents: readonly TxlineMatchPulseSourceEvent[],
): MatchPulseMoment {
  const anchor = pressureEvents[0];
  const latest = pressureEvents[pressureEvents.length - 1];
  const team = getMomentTeam(anchor);
  const counts = getPressureCounts(pressureEvents);
  const title = team ? `${team.name} pile on pressure` : 'Pressure is building';
  const body = team
    ? `${team.name} generate ${formatPressureCounts(counts)} around ${anchor.clock.label}.`
    : `Pressure sequence around ${anchor.clock.label}.`;

  return {
    id: getMomentId(context, 'pressure', pressureEvents),
    fixtureId: context.fixture.fixtureId,
    period: getMomentPeriod(context, latest),
    clock: anchor.clock,
    sortTimestamp: latest.updatedAt ?? anchor.updatedAt,
    sortSeq: latest.seq,
    type: 'pressure',
    team,
    scoreAtMoment: latest.score ?? anchor.score,
    sourceEvents: cluster.map((event) => event.sourceRef),
    title,
    body,
    intensity: getPressureIntensity(pressureEvents),
    momentumSide: getMomentumSide(anchor),
    confidence: getMomentConfidence(pressureEvents),
    generation: 'rule_based',
    fallbackTitle: title,
    fallbackBody: body,
    boardHint: getBoardHint(anchor, pressureEvents),
  };
}

function getMomentId(
  context: TxlineMatchPulseSourceContext,
  kind: string,
  events: readonly TxlineMatchPulseSourceEvent[],
): string {
  const first = events[0];
  const last = events[events.length - 1] ?? first;
  return [
    context.fixture.fixtureId,
    kind,
    first?.team?.side ?? 'neutral',
    first?.clockSeconds ?? first?.seq ?? 'start',
    last?.seq ?? 'end',
  ].join('-');
}

function getMomentPeriod(context: TxlineMatchPulseSourceContext, event: TxlineMatchPulseSourceEvent): MatchPhase {
  if (typeof event.clock.minute !== 'number') {
    return context.phase;
  }

  if (event.clock.minute <= 45) {
    return 'first_half';
  }

  if (event.clock.minute <= 90) {
    return 'second_half';
  }

  return 'extra_time';
}

function getMomentTeam(event: TxlineMatchPulseSourceEvent): MatchPulseMomentTeamRef | undefined {
  if (!event.team) {
    return undefined;
  }

  return {
    id: event.team.id,
    name: event.team.name,
    shortName: event.team.shortName,
    side: event.team.side,
  };
}

function getMomentType(action: string): MatchPulseMomentType {
  action = normalizeActionName(action);
  if (action === 'goal') {
    return 'goal';
  }

  if (action === 'yellow_card' || action === 'red_card') {
    return 'card';
  }

  if (action === 'shot') {
    return 'shot';
  }

  if (action === 'corner') {
    return 'corner';
  }

  if (action === 'free_kick') {
    return 'free_kick';
  }

  if (action === 'throw_in') {
    return 'throw_in';
  }

  if (action === 'danger_possession' || action === 'high_danger_possession') {
    return 'danger';
  }

  if (action === 'pressure') {
    return 'pressure';
  }

  if (action === 'var') {
    return 'var';
  }

  if (action === 'injury') {
    return 'injury';
  }

  if (action === 'substitution') {
    return 'substitution';
  }

  if (action === 'game_finalised' || action === 'halftime_finalised') {
    return 'phase_change';
  }

  if (action === 'penalty' || action === 'penalty_outcome') {
    return 'penalty';
  }

  if (action === 'score_adjustment') {
    return 'system';
  }

  return 'fallback';
}

function getSingleEventTitle(event: TxlineMatchPulseSourceEvent, action: string): string {
  action = normalizeActionName(action);
  const teamName = event.team?.name;
  if (action === 'goal') {
    return teamName ? `${teamName} score` : 'Goal';
  }

  if (action === 'red_card') {
    return teamName ? `${teamName} shown red` : 'Red card';
  }

  if (action === 'yellow_card') {
    return teamName ? `${teamName} booked` : 'Yellow card';
  }

  if (action === 'game_finalised') {
    return 'Full time';
  }

  if (action === 'score_adjustment') {
    return 'Score updated';
  }

  if (action === 'shot') {
    return teamName ? `${teamName} shot` : 'Shot';
  }

  if (action === 'corner') {
    return teamName ? `${teamName} corner` : 'Corner';
  }

  if (action === 'danger_possession' || action === 'high_danger_possession') {
    return teamName ? `${teamName} threaten` : 'Dangerous attack';
  }

  return event.label ?? action.replace(/_/g, ' ');
}

function getSingleEventBody(
  event: TxlineMatchPulseSourceEvent,
  action: string,
  title: string,
  team?: MatchPulseMomentTeamRef,
): string {
  action = normalizeActionName(action);
  if (action === 'score_adjustment' && event.score) {
    return `Score updated to ${event.score.home}-${event.score.away}.`;
  }

  if (team) {
    return `${team.name} ${getSingleEventBodyVerb(action)} at ${event.clock.label}.`;
  }

  return `${title} at ${event.clock.label}.`;
}

function getSingleEventBodyVerb(action: string): string {
  if (action === 'goal') {
    return 'score';
  }

  if (action === 'shot') {
    return 'have a shot';
  }

  if (action === 'corner') {
    return 'win a corner';
  }

  if (action === 'free_kick') {
    return 'win a free kick';
  }

  if (action === 'yellow_card') {
    return 'are booked';
  }

  if (action === 'red_card') {
    return 'are shown red';
  }

  return 'register an event';
}

function getPressureCounts(events: readonly TxlineMatchPulseSourceEvent[]): Record<string, number> {
  return events.reduce<Record<string, number>>((counts, event) => {
    const action = normalizeActionName(event.normalizedAction ?? event.rawAction ?? 'event');
    counts[action] = (counts[action] ?? 0) + 1;
    return counts;
  }, {});
}

function formatPressureCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  if (counts.high_danger_possession || counts.danger_possession) {
    const total = (counts.high_danger_possession ?? 0) + (counts.danger_possession ?? 0);
    parts.push(`${total} dangerous spell${total === 1 ? '' : 's'}`);
  }

  if (counts.shot) {
    parts.push(`${counts.shot} shot${counts.shot === 1 ? '' : 's'}`);
  }

  if (counts.corner) {
    parts.push(`${counts.corner} corner${counts.corner === 1 ? '' : 's'}`);
  }

  if (counts.free_kick) {
    parts.push(`${counts.free_kick} free kick${counts.free_kick === 1 ? '' : 's'}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'repeated pressure';
}

function getPressureIntensity(events: readonly TxlineMatchPulseSourceEvent[]): MatchPulseIntensity {
  if (events.some((event) => normalizeActionName(event.normalizedAction ?? event.rawAction) === 'high_danger_possession')) {
    return 'danger';
  }

  if (events.some((event) => {
    const action = normalizeActionName(event.normalizedAction ?? event.rawAction);
    return action === 'shot' || action === 'corner';
  })) {
    return 'danger';
  }

  return 'building';
}

function getMomentIntensity(action: string, fallback: MatchPulseIntensity): MatchPulseIntensity {
  action = normalizeActionName(action);
  if (action === 'goal' || action === 'red_card' || action === 'penalty' || action === 'penalty_outcome') {
    return 'major';
  }

  return fallback;
}

function getMomentConfidence(events: readonly TxlineMatchPulseSourceEvent[]): MatchPulseMomentConfidence {
  if (events.some((event) => event.confirmed === true)) {
    return 'verified';
  }

  return 'source_backed';
}

function getMomentumSide(event: TxlineMatchPulseSourceEvent): MatchPulseMomentumSide {
  if (event.team?.side === 'home' || event.team?.side === 'away') {
    return event.team.side;
  }

  return 'unknown';
}

function getBoardHint(
  event: TxlineMatchPulseSourceEvent,
  events: readonly TxlineMatchPulseSourceEvent[] = [event],
): MatchPulseBoardHint {
  const hasCornerOrFreeKick = events.some((candidate) =>
    normalizeActionName(candidate.normalizedAction ?? candidate.rawAction) === 'corner' ||
    normalizeActionName(candidate.normalizedAction ?? candidate.rawAction) === 'free_kick',
  );
  const hasHighDanger = events.some((candidate) =>
    normalizeActionName(candidate.normalizedAction ?? candidate.rawAction) === 'high_danger_possession',
  );
  const hasDanger = hasHighDanger || events.some((candidate) =>
    normalizeActionName(candidate.normalizedAction ?? candidate.rawAction) === 'danger_possession',
  );

  return {
    side: getMomentumSide(event),
    teamId: event.team?.id,
    zone: hasDanger || hasCornerOrFreeKick ? 'attacking_third' : 'unknown',
    pressure: hasHighDanger ? 'high_danger' : hasDanger ? 'danger' : 'building',
    ballState: hasCornerOrFreeKick ? 'set_piece' : 'open_play',
    direction: event.team?.side === 'home'
      ? 'home_to_away'
      : event.team?.side === 'away'
        ? 'away_to_home'
        : 'unknown',
  };
}

function compareEvents(left: TxlineMatchPulseSourceEvent, right: TxlineMatchPulseSourceEvent): number {
  return (
    left.seq - right.seq ||
    (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
    (left.clockSeconds ?? -1) - (right.clockSeconds ?? -1)
  );
}

function normalizeActionName(action: string | undefined): string {
  return (action ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function compareMoments(left: MatchPulseMoment, right: MatchPulseMoment): number {
  return (
    (left.sortSeq ?? 0) - (right.sortSeq ?? 0) ||
    (Date.parse(left.sortTimestamp ?? '') || 0) - (Date.parse(right.sortTimestamp ?? '') || 0) ||
    getClockSeconds(left.clock) - getClockSeconds(right.clock)
  );
}

function compareCommentaryEntries(
  left: MatchPulseCommentaryEntry,
  right: MatchPulseCommentaryEntry,
): number {
  return (
    (left.sortSeq ?? 0) - (right.sortSeq ?? 0) ||
    (Date.parse(left.sortTimestamp ?? '') || 0) - (Date.parse(right.sortTimestamp ?? '') || 0) ||
    getClockSeconds(left.clock) - getClockSeconds(right.clock)
  );
}

function getClockSeconds(clock: MatchPulseEventClock): number {
  return typeof clock.seconds === 'number' ? clock.seconds : -1;
}
