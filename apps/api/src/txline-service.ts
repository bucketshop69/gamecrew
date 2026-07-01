import {
  LiveTxlineMatchAdapter,
  TxlineApiClient,
  type GameCrewMatch,
  type GameCrewMatchFilter,
  type MatchPulseEvent,
} from '@gamecrew/core';
import type { ApiConfig } from './config.js';

export interface MatchListResult {
  matches: readonly GameCrewMatch[];
  source: 'txline';
}

export interface MatchListQuery {
  filter?: GameCrewMatchFilter;
  limit?: number;
}

export interface MatchPulseResult {
  events: readonly MatchPulseEvent[];
  source: 'txline';
}

export function createTxlineService(config: ApiConfig) {
  const adapter = new LiveTxlineMatchAdapter(
    new TxlineApiClient({
      apiToken: config.txlineApiToken,
      baseUrl: config.txlineBaseUrl,
    }),
  );

  return {
    async listMatches(query: MatchListQuery = {}): Promise<MatchListResult> {
      return {
        matches: await adapter.listMatches(query),
        source: 'txline',
      };
    },

    async listMatchPulse(fixtureId: string): Promise<MatchPulseResult> {
      return {
        events: await adapter.listMatchPulse(fixtureId),
        source: 'txline',
      };
    },
  };
}
