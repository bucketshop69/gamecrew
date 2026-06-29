import {
  LiveTxlineMatchAdapter,
  TxlineApiClient,
  type GameCrewMatch,
  type GameCrewMatchFilter,
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
  };
}
