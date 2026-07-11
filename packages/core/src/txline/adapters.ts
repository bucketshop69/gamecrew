import { sampleTxlineMatches } from '../sample-data';
import type { GameCrewMatch, MatchPulseEvent } from '../match';
import { TxlineApiClient } from './client';
import { applyMatchQuery, mapTxlineFixtureToGameCrewMatch } from './match-mapper';
import { mapTxlineScoresToMatchPulseEvents, normalizePulseAction } from './pulse';
import type { TxlineMatchAdapter, TxlineMatchQuery } from './types';

export class SampleTxlineMatchAdapter implements TxlineMatchAdapter {
  constructor(private readonly matches: readonly GameCrewMatch[] = sampleTxlineMatches) {}

  async listMatches(query: TxlineMatchQuery = {}): Promise<readonly GameCrewMatch[]> {
    return applyMatchQuery(this.matches, query);
  }

  async listMatchPulse(fixtureId: string | number): Promise<readonly MatchPulseEvent[]> {
    const match = this.matches.find((candidate) => candidate.txline.fixtureId === String(fixtureId));
    if (!match?.pulse) {
      return [];
    }

    return [
      {
        id: `${match.txline.fixtureId}-latest-pulse`,
        fixtureId: String(fixtureId),
        seq: 0,
        action: normalizePulseAction(match.pulse.action) ?? 'kickoff',
        label: match.pulse.label,
        intensity: match.pulse.intensity,
        clock: {
          minute: match.clock.minute,
          label: match.clock.minute ? `${match.clock.minute}'` : match.clock.label,
        },
        teamId: match.pulse.teamId,
        confirmed: match.pulse.verified,
        updatedAt: match.pulse.updatedAt,
      },
    ];
  }
}

export class LiveTxlineMatchAdapter implements TxlineMatchAdapter {
  constructor(private readonly client: TxlineApiClient) {}

  async listMatches(query: TxlineMatchQuery = {}): Promise<readonly GameCrewMatch[]> {
    const { jwt } = await this.client.startGuestSession();
    const fixtures = await this.client.listFixtures(jwt);
    const sortedFixtures = [...fixtures].sort((left, right) => left.StartTime - right.StartTime);
    const scoreResults = await Promise.allSettled(
      sortedFixtures.map((fixture) => this.client.listScoreSnapshot(fixture.FixtureId, jwt)),
    );
    const matches = sortedFixtures.map((fixture, index) =>
      mapTxlineFixtureToGameCrewMatch(fixture, scoreResults[index]?.status === 'fulfilled'
        ? scoreResults[index].value
        : []),
    );

    return applyMatchQuery(matches, query);
  }

  async listMatchPulse(fixtureId: string | number): Promise<readonly MatchPulseEvent[]> {
    const { jwt } = await this.client.startGuestSession();
    const updates = await this.client.listScoreUpdates(fixtureId, jwt);
    const scores = updates.length > 0 ? updates : await this.client.listScoreHistory(fixtureId, jwt);

    return mapTxlineScoresToMatchPulseEvents(String(fixtureId), scores);
  }
}

export const sampleTxlineMatchAdapter = new SampleTxlineMatchAdapter();
