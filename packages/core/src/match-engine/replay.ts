import type {
  CanonicalIncident,
  CanonicalMatchState,
  MatchEngineContext,
  MatchEngineLifecycle,
  MatchEngineParticipant,
  MatchEnginePressure,
  MatchEngineProvenance,
  MatchEngineReplayResult,
  MatchEngineScore,
  SemanticFrame,
  SimulationCue,
  SupportedFact,
  TxlineMatchEngineRecord,
} from './types';

const INCIDENT_ACTIONS = new Set(['free_kick', 'shot', 'goal']);
const PRESSURE_BY_ACTION: Record<string, MatchEnginePressure> = {
  safe_possession: 'safe',
  attack_possession: 'attack',
  danger_possession: 'danger',
  high_danger_possession: 'high_danger',
};

function participant(value: unknown): MatchEngineParticipant | undefined {
  return value === 1 || value === 2 ? value : undefined;
}

function teamIdFor(context: MatchEngineContext, value?: MatchEngineParticipant) {
  return context.participants.find((team) => team.participant === value)?.teamId;
}

function lifecycleFor(record: TxlineMatchEngineRecord, stateSignal = false): MatchEngineLifecycle {
  if (record.Confirmed === true) return 'confirmed';
  if (record.Confirmed === false) return 'provisional';
  if (stateSignal) return 'observed';
  return 'unresolved';
}

function pressureFrom(
  record: TxlineMatchEngineRecord,
): MatchEnginePressure | undefined {
  const actionPressure = PRESSURE_BY_ACTION[record.Action];
  if (actionPressure) return actionPressure;
  switch (record.PossessionType) {
    case 'SafePossession': return 'safe';
    case 'AttackPossession': return 'attack';
    case 'DangerPossession': return 'danger';
    case 'HighDangerPossession': return 'high_danger';
    default: return undefined;
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function scoreFrom(record: TxlineMatchEngineRecord, fallback: MatchEngineScore): MatchEngineScore | undefined {
  const score = record.Score as {
    Participant1?: { Total?: { Goals?: unknown } };
    Participant2?: { Total?: { Goals?: unknown } };
  } | undefined;
  const first = score?.Participant1?.Total?.Goals;
  const second = score?.Participant2?.Total?.Goals;
  if (typeof first !== 'number' && typeof second !== 'number') return undefined;
  return {
    participant1: typeof first === 'number' ? first : fallback.participant1,
    participant2: typeof second === 'number' ? second : fallback.participant2,
  };
}

function provenance(record: TxlineMatchEngineRecord): MatchEngineProvenance {
  return {
    fixtureId: record.FixtureId,
    action: record.Action,
    sourceId: record.Id,
    seq: record.Seq,
  };
}

function factRevision(previous: SupportedFact | undefined, candidate: Omit<SupportedFact, 'revision'>): number {
  if (!previous) return 1;
  const { revision: _oldRevision, ...oldComparable } = previous;
  return stable(oldComparable) === stable(candidate) ? previous.revision : previous.revision + 1;
}

function cueRevision(previous: SimulationCue | undefined, candidate: Omit<SimulationCue, 'revision'>): number {
  if (!previous) return 1;
  const { revision: _oldRevision, ...oldComparable } = previous;
  return stable(oldComparable) === stable(candidate) ? previous.revision : previous.revision + 1;
}

function emitFact(
  state: CanonicalMatchState,
  frame: SemanticFrame,
  candidate: Omit<SupportedFact, 'revision'>,
): SupportedFact {
  const revision = factRevision(state.supportedFacts[candidate.id], candidate);
  const fact = { ...candidate, revision };
  state.supportedFacts[fact.id] = fact;
  frame.facts.push(fact);
  return fact;
}

function emitCue(
  state: CanonicalMatchState,
  frame: SemanticFrame,
  candidate: Omit<SimulationCue, 'revision'>,
): SimulationCue {
  const revision = cueRevision(state.simulationCues[candidate.id], candidate);
  const cue = { ...candidate, revision };
  state.simulationCues[cue.id] = cue;
  frame.simulationCues.push(cue);
  return cue;
}

function canonicalIncident(
  state: CanonicalMatchState,
  context: MatchEngineContext,
  record: TxlineMatchEngineRecord,
): CanonicalIncident {
  const key = `${record.FixtureId}:${record.Action}:${record.Id}`;
  const previous = state.incidents[key];
  const actor = participant(record.Participant) ?? previous?.participant;
  const data = {
    ...(previous?.data ?? {}),
    ...(record.Data && typeof record.Data === 'object' ? record.Data : {}),
  };
  const playerId = typeof data.PlayerId === 'number' ? data.PlayerId : undefined;
  const score = scoreFrom(record, previous?.score ?? state.confirmedScore) ?? previous?.score;
  const comparable = {
    key,
    fixtureId: record.FixtureId,
    action: record.Action,
    sourceId: record.Id,
    lifecycle: lifecycleFor(record),
    basis: 'direct' as const,
    sourceSeqs: [...(previous?.sourceSeqs ?? []), record.Seq],
    firstSeenSeq: previous?.firstSeenSeq ?? record.Seq,
    lastUpdatedSeq: record.Seq,
    occurrenceSeconds: record.Clock?.Seconds ?? previous?.occurrenceSeconds,
    participant: actor,
    teamId: teamIdFor(context, actor),
    data,
    player: playerId === undefined ? previous?.player : context.players?.[String(playerId)],
    score,
  };
  const revision = previous ? previous.revision + 1 : 1;
  const incident: CanonicalIncident = { ...comparable, revision };
  state.incidents[key] = incident;
  return incident;
}

function possibleEventData(record: TxlineMatchEngineRecord): Record<string, boolean> | undefined {
  if (!record.Data || typeof record.Data !== 'object') return undefined;
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record.Data)) {
    if (typeof value === 'boolean') result[key.toLowerCase()] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeLedger(records: readonly TxlineMatchEngineRecord[], context: MatchEngineContext) {
  const bySequence = new Map<number, TxlineMatchEngineRecord>();
  const warnings: string[] = [];
  let ignoredDuplicateCount = 0;
  for (const record of records) {
    if (String(record.FixtureId) !== String(context.fixtureId)) {
      warnings.push(`Ignored Seq ${record.Seq}: fixture ${record.FixtureId} does not match ${context.fixtureId}.`);
      continue;
    }
    const previous = bySequence.get(record.Seq);
    if (!previous) {
      bySequence.set(record.Seq, record);
      continue;
    }
    ignoredDuplicateCount += 1;
    if (stable(previous) !== stable(record)) {
      warnings.push(`Conflicting duplicate for fixture ${record.FixtureId}, Seq ${record.Seq}; kept first record.`);
    }
  }
  return {
    ledger: [...bySequence.values()].sort((left, right) => left.Seq - right.Seq),
    ignoredDuplicateCount,
    warnings,
  };
}

export function replayMatchEngine(
  records: readonly TxlineMatchEngineRecord[],
  context: MatchEngineContext,
): MatchEngineReplayResult {
  const normalized = normalizeLedger(records, context);
  const state: CanonicalMatchState = {
    fixtureId: context.fixtureId,
    lastAppliedSeq: context.sequenceBefore ?? -1,
    stateRevision: 0,
    confirmedScore: { ...context.confirmedScore },
    possibleEvents: {},
    incidents: {},
    supportedFacts: {},
    simulationCues: {},
    integrityWarnings: [...normalized.warnings],
  };
  const frames: SemanticFrame[] = [];

  for (const record of normalized.ledger) {
    state.lastAppliedSeq = record.Seq;
    state.stateRevision += 1;
    if (typeof record.Clock?.Seconds === 'number') {
      state.lastMeaningfulElapsedSeconds = Math.max(
        state.lastMeaningfulElapsedSeconds ?? 0,
        record.Clock.Seconds,
      );
    }
    const frame: SemanticFrame = {
      id: `${context.fixtureId}:${record.Seq}`,
      fixtureId: context.fixtureId,
      seq: record.Seq,
      stateRevision: state.stateRevision,
      sourceTimestamp: record.Ts,
      matchClockSeconds: record.Clock?.Seconds,
      facts: [],
      simulationCues: [],
    };
    const actor = participant(record.Participant);
    const sourceSeqs = [record.Seq];

    if (record.Possession !== undefined || PRESSURE_BY_ACTION[record.Action]) {
      const owner = participant(record.Possession) ?? actor;
      if (owner) {
        const previousPossession = state.possession;
        const ownerChanged = previousPossession?.participant !== owner;
        const observedPressure = pressureFrom(record);
        const pressure = observedPressure ?? (ownerChanged ? undefined : previousPossession?.pressure);
        const probableZone = observedPressure ?? (ownerChanged ? undefined : previousPossession?.probableZone);
        state.possession = {
          participant: owner,
          teamId: teamIdFor(context, owner),
          pressure,
          probableZone,
          basis: probableZone ? 'derived_probable' : 'direct',
          seq: record.Seq,
        };
        if (ownerChanged || observedPressure || record.Action === 'possession') {
          const fact = emitFact(state, frame, {
            id: `fact:${context.fixtureId}:possession`,
            kind: 'possession',
            lifecycle: 'observed',
            basis: 'direct',
            participant: owner,
            teamId: teamIdFor(context, owner),
            value: {
              owner,
              ...(observedPressure ? { pressure: observedPressure } : {}),
            },
            occurrenceSeconds: record.Clock?.Seconds,
            sourceSeqs,
            provenance: provenance(record),
          });
          emitCue(state, frame, {
            id: `cue:${context.fixtureId}:possession`,
            kind: observedPressure ? 'possession_pressure' : 'possession_change',
            updateMode: 'state_replace',
            lifecycle: 'observed',
            basis: observedPressure ? 'derived_probable' : 'direct',
            participant: owner,
            teamId: teamIdFor(context, owner),
            pressure: observedPressure,
            probableZone: observedPressure,
            value: { owner },
            occurrenceSeconds: record.Clock?.Seconds,
            sourceSeqs,
            factIds: [fact.id],
            ...(observedPressure
              ? {
                  derivation: {
                    ruleId: 'txline-possession-pressure-to-probable-zone',
                    ruleVersion: 1,
                    inputFactIds: [fact.id],
                  },
                }
              : {}),
          });
        }
      }
    }

    if (record.Action === 'possible') {
      const possible = possibleEventData(record);
      if (actor && possible) {
        state.possibleEvents[String(actor)] = {
          ...(state.possibleEvents[String(actor)] ?? {}),
          ...possible,
        };
        const fact = emitFact(state, frame, {
          id: `fact:${context.fixtureId}:possible:${actor}`,
          kind: 'possible_event',
          lifecycle: 'observed',
          basis: 'direct',
          participant: actor,
          teamId: teamIdFor(context, actor),
          value: { ...state.possibleEvents[String(actor)] },
          occurrenceSeconds: record.Clock?.Seconds,
          sourceSeqs,
          provenance: provenance(record),
        });
        emitCue(state, frame, {
          id: `cue:${context.fixtureId}:possible:${actor}`,
          kind: 'possible_event',
          updateMode: 'state_replace',
          lifecycle: 'observed',
          basis: 'direct',
          participant: actor,
          teamId: teamIdFor(context, actor),
          value: { ...state.possibleEvents[String(actor)] },
          occurrenceSeconds: record.Clock?.Seconds,
          sourceSeqs,
          factIds: [fact.id],
        });
      }
    }

    if (INCIDENT_ACTIONS.has(record.Action)) {
      const incident = canonicalIncident(state, context, record);
      const factId = `fact:${incident.key}`;
      const fact = emitFact(state, frame, {
        id: factId,
        kind: 'incident',
        lifecycle: incident.lifecycle,
        basis: 'direct',
        participant: incident.participant,
        teamId: incident.teamId,
        player: incident.player,
        value: { action: incident.action, sourceId: incident.sourceId, ...incident.data },
        occurrenceSeconds: incident.occurrenceSeconds,
        sourceSeqs: [...incident.sourceSeqs],
        provenance: provenance(record),
      });

      let cueKind: SimulationCue['kind'];
      if (record.Action === 'free_kick') cueKind = 'set_piece';
      else if (record.Action === 'shot') cueKind = record.Confirmed === true ? 'shot_outcome' : 'shot_attempt';
      else cueKind = record.Confirmed === true ? 'goal_confirmed' : 'goal_pending';
      emitCue(state, frame, {
        id: `cue:${incident.key}`,
        kind: cueKind,
        updateMode: 'incident_upsert',
        lifecycle: incident.lifecycle,
        basis: 'direct',
        participant: incident.participant,
        teamId: incident.teamId,
        player: incident.player,
        value: { action: incident.action, sourceId: incident.sourceId, ...incident.data },
        occurrenceSeconds: incident.occurrenceSeconds,
        sourceSeqs: [...incident.sourceSeqs],
        factIds: [fact.id],
      });

      if (record.Action === 'goal') {
        const candidateScore = scoreFrom(record, state.confirmedScore);
        if (record.Confirmed === false && candidateScore) state.provisionalScore = candidateScore;
        if (record.Confirmed === true && candidateScore) {
          const scoreChanged = stable(state.confirmedScore) !== stable(candidateScore);
          state.confirmedScore = candidateScore;
          state.provisionalScore = undefined;
          if (scoreChanged) {
            const scoreFact = emitFact(state, frame, {
              id: `fact:${context.fixtureId}:score`,
              kind: 'score',
              lifecycle: 'confirmed',
              basis: 'direct',
              participant: incident.participant,
              teamId: incident.teamId,
              value: { ...candidateScore },
              occurrenceSeconds: incident.occurrenceSeconds,
              sourceSeqs: [...incident.sourceSeqs],
              provenance: provenance(record),
            });
            emitCue(state, frame, {
              id: `cue:${context.fixtureId}:score`,
              kind: 'score_commit',
              updateMode: 'state_replace',
              lifecycle: 'confirmed',
              basis: 'direct',
              participant: incident.participant,
              teamId: incident.teamId,
              value: { ...candidateScore },
              occurrenceSeconds: incident.occurrenceSeconds,
              sourceSeqs: [...incident.sourceSeqs],
              factIds: [scoreFact.id],
            });
          }
        }
        if (incident.player && record.Confirmed === true) {
          emitCue(state, frame, {
            id: `cue:${incident.key}:player`,
            kind: 'player_highlight',
            updateMode: 'incident_upsert',
            lifecycle: 'confirmed',
            basis: 'direct',
            participant: incident.participant,
            teamId: incident.teamId,
            player: incident.player,
            value: { sourceId: incident.sourceId },
            occurrenceSeconds: incident.occurrenceSeconds,
            sourceSeqs: [...incident.sourceSeqs],
            factIds: [fact.id],
          });
        }
      }
    }

    if (record.Action === 'kickoff') {
      const restarting = participant(record.Kickoff?.Team) ?? participant(record.Possession);
      const fact = emitFact(state, frame, {
        id: `fact:${context.fixtureId}:restart`,
        kind: 'restart',
        lifecycle: lifecycleFor(record, true),
        basis: 'direct',
        participant: restarting,
        teamId: teamIdFor(context, restarting),
        value: { kind: 'kickoff' },
        occurrenceSeconds: record.Clock?.Seconds,
        sourceSeqs,
        provenance: provenance(record),
      });
      emitCue(state, frame, {
        id: `cue:${context.fixtureId}:restart`,
        kind: 'restart',
        updateMode: 'state_replace',
        lifecycle: lifecycleFor(record, true),
        basis: 'direct',
        participant: restarting,
        teamId: teamIdFor(context, restarting),
        value: { kind: 'kickoff' },
        occurrenceSeconds: record.Clock?.Seconds,
        sourceSeqs,
        factIds: [fact.id],
      });
    }

    frames.push(frame);
  }

  return {
    ledger: normalized.ledger,
    ignoredDuplicateCount: normalized.ignoredDuplicateCount,
    state,
    frames,
  };
}
