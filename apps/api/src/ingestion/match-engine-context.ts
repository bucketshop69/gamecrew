import type {
  MatchEngineContext,
  MatchEngineParticipant,
  MatchEnginePlayer,
  TxlineFixture,
  TxlineScore,
} from '@gamecrew/core';

interface RawLineupPlayer {
  fixturePlayerId?: number;
  statusId?: number;
  positionId?: number;
  unitId?: number;
  rosterNumber?: string;
  starter?: boolean;
  starred?: boolean;
  player?: {
    id?: string;
    normativeId?: number;
    preferredName?: string;
  };
}

interface RawLineupTeam {
  normativeId?: number;
  preferredName?: string;
  lineups?: RawLineupPlayer[];
}

export function buildMatchEngineContext(
  fixture: TxlineFixture,
  scores: readonly TxlineScore[],
  options: { mode?: 'complete' | 'snapshot' } = {},
): MatchEngineContext {
  const participant1 = fixture.Participant1Id;
  const participant2 = fixture.Participant2Id;
  const players: Record<string, MatchEnginePlayer> = {};
  const lineupRecord = [...scores]
    .sort((left, right) => (right.Seq ?? right.seq ?? -1) - (left.Seq ?? left.seq ?? -1))
    .find((score) => (score.Action ?? score.action) === 'lineups') as
      (TxlineScore & { Lineups?: RawLineupTeam[] }) | undefined;
  const participant1Name = resolveParticipantName(
    fixture.Participant1,
    participant1,
    lineupRecord?.Lineups,
  );
  const participant2Name = resolveParticipantName(
    fixture.Participant2,
    participant2,
    lineupRecord?.Lineups,
  );

  for (const team of lineupRecord?.Lineups ?? []) {
    const participant = team.normativeId === participant1 ? 1
      : team.normativeId === participant2 ? 2
        : undefined;
    if (!participant) continue;
    const teamId = participant === 1 ? participant1 : participant2;
    for (const lineup of team.lineups ?? []) {
      const source = lineup.player;
      if (typeof source?.normativeId !== 'number') continue;
      players[String(source.normativeId)] = {
        normativeId: source.normativeId,
        participant: participant as MatchEngineParticipant,
        teamId,
        sourcePreferredName: source.preferredName ?? `Player ${source.normativeId}`,
        displayName: source.preferredName,
        fixturePlayerId: lineup.fixturePlayerId,
        sourceId: source.id,
        starter: lineup.starter,
        positionId: lineup.positionId,
        statusId: lineup.statusId,
        unitId: lineup.unitId,
        rosterNumber: lineup.rosterNumber,
        starred: lineup.starred,
      };
    }
  }

  const snapshotState = deriveSnapshotState(scores);
  const mode = options.mode ?? 'complete';

  return {
    fixtureId: fixture.FixtureId,
    participants: [
      {
        participant: 1,
        teamId: participant1,
        name: participant1Name,
        isHome: fixture.Participant1IsHome,
      },
      {
        participant: 2,
        teamId: participant2,
        name: participant2Name,
        isHome: !fixture.Participant1IsHome,
      },
    ],
    confirmedScore: mode === 'snapshot' ? snapshotState.confirmedScore : { participant1: 0, participant2: 0 },
    players,
    phase: mode === 'snapshot' ? snapshotState.phase : 'pre_match',
    ...(mode === 'snapshot' && snapshotState.sequenceBefore !== undefined
      ? { sequenceBefore: snapshotState.sequenceBefore }
      : {}),
  };
}

function resolveParticipantName(
  fixtureName: string,
  teamId: number,
  lineups: readonly RawLineupTeam[] | undefined,
): string {
  if (!/^Participant\s+\d+$/i.test(fixtureName.trim())) return fixtureName;
  const lineupName = lineups?.find((team) => team.normativeId === teamId)?.preferredName?.trim();
  return lineupName || fixtureName;
}

export function applySnapshotBaseline(
  context: MatchEngineContext,
  scores: readonly TxlineScore[],
): MatchEngineContext {
  const snapshot = deriveSnapshotState(scores);
  return {
    ...context,
    confirmedScore: snapshot.confirmedScore,
    phase: snapshot.phase,
    ...(snapshot.sequenceBefore === undefined ? {} : { sequenceBefore: snapshot.sequenceBefore }),
  };
}

export function clearSnapshotBaseline(context: MatchEngineContext): MatchEngineContext {
  const { sequenceBefore: _sequenceBefore, ...completeContext } = context;
  return {
    ...completeContext,
    confirmedScore: { participant1: 0, participant2: 0 },
    phase: 'pre_match',
  };
}

function deriveSnapshotState(scores: readonly TxlineScore[]) {
  const ordered = [...scores].sort((left, right) => (right.Seq ?? right.seq ?? -1) - (left.Seq ?? left.seq ?? -1));
  const scoreRecord = ordered.find((score) => {
    const rawScore = (score as TxlineScore & { Score?: unknown }).Score;
    return rawScore && typeof rawScore === 'object';
  }) as (TxlineScore & { Score?: Record<string, { Total?: { Goals?: number } }> }) | undefined;
  const statusRecord = ordered.find((score) => (score.Action ?? score.action) === 'status');
  const statusId = statusRecord?.StatusId ?? (statusRecord?.Data as { StatusId?: number } | undefined)?.StatusId;
  const hasFinalisation = ordered.some((score) => (score.Action ?? score.action) === 'game_finalised');
  const running = ordered.find((score) => score.Clock)?.Clock?.Running === true;
  return {
    confirmedScore: {
      participant1: scoreRecord?.Score?.Participant1?.Total?.Goals ?? 0,
      participant2: scoreRecord?.Score?.Participant2?.Total?.Goals ?? 0,
    },
    phase: hasFinalisation ? 'finalised' as const
      : statusId === 5 ? 'full_time_pending' as const
        : statusId === 4 ? (running ? 'second_half' as const : 'second_half_ready' as const)
          : statusId === 3 ? 'half_time' as const
            : statusId === 2 ? (running ? 'first_half' as const : 'first_half_ready' as const)
              : 'pre_match' as const,
    sequenceBefore: ordered[0]?.Seq ?? ordered[0]?.seq,
  };
}
