import type {
  CanonicalIncident,
  CanonicalMatchState,
  MatchEngineContext,
  MatchEngineLifecycle,
  MatchEngineParticipant,
  MatchEnginePhase,
  MatchEnginePressure,
  MatchEngineProvenance,
  MatchEngineReplayResult,
  MatchEngineScore,
  SemanticFrame,
  SimulationCue,
  SupportedFact,
  TxlineMatchEngineRecord,
} from './types';

const INCIDENT_ACTIONS = new Set([
  'free_kick', 'shot', 'goal', 'yellow_card', 'red_card', 'substitution',
  'injury', 'throw_in', 'corner', 'goal_kick', 'additional_time', 'var', 'var_end',
]);
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

function incidentAction(action: string): string {
  return action === 'var_end' ? 'var' : action;
}

function statusPhase(statusId: number | undefined): MatchEnginePhase | undefined {
  switch (statusId) {
    case 1: return 'pre_match';
    case 2: return 'first_half_ready';
    case 3: return 'half_time';
    case 4: return 'second_half_ready';
    case 5: return 'full_time_pending';
    default: return undefined;
  }
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
  const normalizedAction = incidentAction(record.Action);
  const key = `${record.FixtureId}:${normalizedAction}:${record.Id}`;
  const previous = state.incidents[key];
  const data = {
    ...(previous?.data ?? {}),
    ...(record.Data && typeof record.Data === 'object' ? record.Data : {}),
  };
  const actor = participant(record.Participant) ?? participant(data.Participant) ?? previous?.participant;
  const playerId = typeof data.PlayerId === 'number' ? data.PlayerId : undefined;
  const score = scoreFrom(record, previous?.score ?? state.confirmedScore) ?? previous?.score;
  const comparable = {
    key,
    fixtureId: record.FixtureId,
    action: normalizedAction,
    sourceId: record.Id,
    lifecycle: previous?.lifecycle === 'confirmed' && record.Confirmed !== true
      ? 'confirmed' as const
      : lifecycleFor(record, record.Confirmed === undefined),
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
      const selected = stable(previous) <= stable(record) ? previous : record;
      bySequence.set(record.Seq, selected);
      warnings.push(`Conflicting duplicate for fixture ${record.FixtureId}, Seq ${record.Seq}; selected deterministic canonical payload.`);
    }
  }
  return {
    ledger: [...bySequence.values()].sort((left, right) => left.Seq - right.Seq),
    ignoredDuplicateCount,
    warnings,
  };
}

function recomputePlayers(state: CanonicalMatchState, context: MatchEngineContext) {
  const active: Record<string, Set<number>> = { '1': new Set(), '2': new Set() };
  for (const player of Object.values(context.players ?? {})) {
    if (player.starter) active[String(player.participant)]?.add(player.normativeId);
  }
  const discipline: CanonicalMatchState['disciplineByPlayerId'] = {};
  const incidents = Object.values(state.incidents).sort((a, b) =>
    a.firstSeenSeq - b.firstSeenSeq || a.lastUpdatedSeq - b.lastUpdatedSeq);
  for (const incident of incidents) {
    if (incident.lifecycle !== 'confirmed') continue;
    if (incident.action === 'substitution') {
      const owner = incident.participant;
      const incoming = incident.data.PlayerInId;
      const outgoing = incident.data.PlayerOutId;
      if (owner && typeof incoming === 'number' && typeof outgoing === 'number') {
        const team = active[String(owner)];
        if (team?.has(outgoing)) {
          team.delete(outgoing);
          team.add(incoming);
        } else {
          state.integrityWarnings.push(`Substitution ${incident.key} references inactive outgoing player ${outgoing}.`);
        }
      }
    }
    if ((incident.action === 'yellow_card' || incident.action === 'red_card') && incident.player) {
      const id = String(incident.player.normativeId);
      const entry = discipline[id] ?? { yellowCards: 0, redCards: 0, sourceIncidentKeys: [] };
      if (incident.action === 'yellow_card') entry.yellowCards += 1;
      else {
        entry.redCards += 1;
        active[String(incident.player.participant)]?.delete(incident.player.normativeId);
      }
      entry.sourceIncidentKeys.push(incident.key);
      discipline[id] = entry;
    }
  }
  state.activePlayerIdsByParticipant = Object.fromEntries(
    Object.entries(active).map(([key, ids]) => [key, [...ids].sort((a, b) => a - b)]),
  );
  state.disciplineByPlayerId = discipline;
}

function cueKindFor(incident: CanonicalIncident): SimulationCue['kind'] {
  switch (incident.action) {
    case 'free_kick': case 'corner': case 'throw_in': case 'goal_kick': return 'set_piece';
    case 'shot': return incident.lifecycle === 'confirmed' ? 'shot_outcome' : 'shot_attempt';
    case 'goal': return incident.lifecycle === 'confirmed' ? 'goal_confirmed' : 'goal_pending';
    case 'yellow_card': case 'red_card': return 'card';
    case 'substitution': return 'substitution';
    case 'injury': return 'injury';
    case 'additional_time': return 'additional_time';
    case 'var': return 'var';
    default: return 'incident';
  }
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
    phase: context.phase ?? 'pre_match',
    confirmedScore: { ...context.confirmedScore },
    possibleEvents: {},
    activePlayerIdsByParticipant: {},
    disciplineByPlayerId: {},
    incidents: {},
    supportedFacts: {},
    simulationCues: {},
    integrityWarnings: [...normalized.warnings],
  };
  recomputePlayers(state, context);
  const frames: SemanticFrame[] = [];

  for (const record of normalized.ledger) {
    state.lastAppliedSeq = record.Seq;
    state.stateRevision += 1;
    if (typeof record.Clock?.Seconds === 'number' && record.Action !== 'clock_adjustment') {
      state.lastMeaningfulElapsedSeconds = Math.max(
        state.lastMeaningfulElapsedSeconds ?? 0,
        record.Clock.Seconds,
      );
      if (state.phase === 'first_half' || state.phase === 'second_half') {
        state.lastPlayingElapsedSeconds = Math.max(state.lastPlayingElapsedSeconds ?? 0, record.Clock.Seconds);
      }
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
    const actor = participant(record.Participant) ?? participant(record.Data?.Participant);
    const sourceSeqs = [record.Seq];

    const directStatus = record.Action === 'status'
      ? statusPhase(typeof record.Data?.StatusId === 'number' ? record.Data.StatusId : record.StatusId)
      : undefined;
    let nextPhase = directStatus;
    if (record.Action === 'kickoff' && record.Confirmed === true) {
      if (state.phase === 'first_half_ready') nextPhase = 'first_half';
      if (state.phase === 'second_half_ready') nextPhase = 'second_half';
    }
    if (record.Action === 'game_finalised') nextPhase = 'finalised';
    if (nextPhase && nextPhase !== state.phase) {
      state.phase = nextPhase;
      if (state.liveClock) state.liveClock = { ...state.liveClock, phase: nextPhase };
      const phaseFact = emitFact(state, frame, {
        id: `fact:${context.fixtureId}:phase`, kind: 'phase', lifecycle: 'observed', basis: 'direct',
        value: { phase: nextPhase, statusId: record.StatusId ?? record.Data?.StatusId },
        occurrenceSeconds: record.Clock?.Seconds, sourceSeqs, provenance: provenance(record),
      });
      emitCue(state, frame, {
        id: `cue:${context.fixtureId}:phase`, kind: 'phase_change', updateMode: 'state_replace',
        lifecycle: 'observed', basis: 'direct', value: { phase: nextPhase },
        occurrenceSeconds: record.Clock?.Seconds, sourceSeqs, factIds: [phaseFact.id],
      });
    }
    if (record.Clock && (record.Action === 'clock_adjustment' || typeof record.Clock.Seconds === 'number')) {
      const previousClock = state.liveClock;
      const regressesWithinPhase = record.Action !== 'clock_adjustment'
        && previousClock?.phase === state.phase
        && typeof previousClock.seconds === 'number'
        && typeof record.Clock.Seconds === 'number'
        && record.Clock.Seconds < previousClock.seconds;
      if (!regressesWithinPhase) {
        state.liveClock = {
          phase: state.phase,
          running: record.Clock.Running === true,
          seconds: record.Clock.Seconds,
          seq: record.Seq,
        };
      } else {
        const revisionKey = `${record.FixtureId}:${incidentAction(record.Action)}:${record.Id}`;
        const isDiscardRevision = record.Action === 'action_discarded'
          && Object.values(state.incidents).some((incident) => String(incident.sourceId) === String(record.Id));
        if (!state.incidents[revisionKey] && !isDiscardRevision) {
          state.integrityWarnings.push(`Clock regression at Seq ${record.Seq} ignored outside clock_adjustment.`);
        }
      }
    }

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
      if (possible) {
        const scope = actor ? String(actor) : 'global';
        state.possibleEvents[scope] = {
          ...(state.possibleEvents[scope] ?? {}),
          ...possible,
        };
        const fact = emitFact(state, frame, {
          id: `fact:${context.fixtureId}:possible:${scope}`,
          kind: 'possible_event',
          lifecycle: 'observed',
          basis: 'direct',
          participant: actor,
          teamId: teamIdFor(context, actor),
          value: { ...state.possibleEvents[scope] },
          occurrenceSeconds: record.Clock?.Seconds,
          sourceSeqs,
          provenance: provenance(record),
        });
        emitCue(state, frame, {
          id: `cue:${context.fixtureId}:possible:${scope}`,
          kind: 'possible_event',
          updateMode: 'state_replace',
          lifecycle: 'observed',
          basis: 'direct',
          participant: actor,
          teamId: teamIdFor(context, actor),
          value: { ...state.possibleEvents[scope] },
          occurrenceSeconds: record.Clock?.Seconds,
          sourceSeqs,
          factIds: [fact.id],
        });
      }
    }

    if (record.Action === 'action_discarded') {
      const candidates = Object.values(state.incidents).filter(
        (incident) => String(incident.sourceId) === String(record.Id) && incident.lifecycle !== 'retracted',
      );
      if (candidates.length === 1) {
        const incident = candidates[0];
        if (incident.lifecycle === 'confirmed') {
          state.integrityWarnings.push(
            `Discard ${record.Seq} ignored for confirmed incident ${incident.key}.`,
          );
          frames.push(frame);
          continue;
        }
        incident.lifecycle = 'retracted';
        incident.revision += 1;
        incident.lastUpdatedSeq = record.Seq;
        incident.sourceSeqs.push(record.Seq);
        const fact = emitFact(state, frame, {
          id: `fact:${incident.key}`, kind: 'incident', lifecycle: 'retracted', basis: 'direct',
          participant: incident.participant, teamId: incident.teamId, player: incident.player,
          value: { action: incident.action, sourceId: incident.sourceId, ...incident.data },
          occurrenceSeconds: incident.occurrenceSeconds, sourceSeqs: [...incident.sourceSeqs], provenance: provenance(record),
        });
        emitCue(state, frame, {
          id: `cue:${incident.key}`, kind: 'incident_retracted', updateMode: 'incident_upsert',
          lifecycle: 'retracted', basis: 'direct', participant: incident.participant, teamId: incident.teamId,
          value: { action: incident.action, sourceId: incident.sourceId }, occurrenceSeconds: incident.occurrenceSeconds,
          sourceSeqs: [...incident.sourceSeqs], factIds: [fact.id],
        });
        recomputePlayers(state, context);
      } else {
        state.integrityWarnings.push(`Discard ${record.Seq} could not resolve unique incident Id ${record.Id}.`);
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

      const cueKind = cueKindFor(incident);
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
        const candidateScore = incident.score;
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
      recomputePlayers(state, context);
    }

    if (record.Action === 'game_finalised') {
      const finalScore = scoreFrom(record, state.confirmedScore) ?? { ...state.confirmedScore };
      if (stable(finalScore) !== stable(state.confirmedScore)) {
        state.integrityWarnings.push(`Final score ${stable(finalScore)} differs from confirmed score ${stable(state.confirmedScore)}.`);
      }
      state.finalScore = { ...finalScore };
      state.provisionalScore = undefined;
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
