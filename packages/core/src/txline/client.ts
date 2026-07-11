import { parseTxlineScoreEvents } from './parser';
import type {
  TxlineClientConfig,
  TxlineFetcher,
  TxlineFixture,
  TxlineGuestSession,
  TxlineResponse,
  TxlineScore,
} from './types';

export class TxlineApiClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly fetcher: TxlineFetcher;

  constructor(config: TxlineClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiToken = config.apiToken;
    this.fetcher = config.fetcher ?? getGlobalFetch();
  }

  async startGuestSession(): Promise<TxlineGuestSession> {
    const response = await this.fetcher(`${this.baseUrl}/auth/guest/start`, { method: 'POST' });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(`TxLINE guest session failed (${response.status}): ${body.text}`);
    }

    const token = body.json?.token ?? body.json?.jwt ?? body.json?.accessToken ?? body.text.trim();
    if (!token) {
      throw new Error('TxLINE guest session did not return a JWT.');
    }

    return { jwt: token };
  }

  async listFixtures(jwt: string): Promise<readonly TxlineFixture[]> {
    return this.requestJson<readonly TxlineFixture[]>('/api/fixtures/snapshot', jwt);
  }

  async listScoreSnapshot(fixtureId: string | number, jwt: string): Promise<readonly TxlineScore[]> {
    return this.requestJson<readonly TxlineScore[]>(`/api/scores/snapshot/${fixtureId}`, jwt);
  }

  async listScoreHistory(fixtureId: string | number, jwt: string): Promise<readonly TxlineScore[]> {
    return this.requestScoreEvents(`/api/scores/historical/${fixtureId}`, jwt);
  }

  async listScoreUpdates(fixtureId: string | number, jwt: string): Promise<readonly TxlineScore[]> {
    return this.requestScoreEvents(`/api/scores/updates/${fixtureId}`, jwt);
  }

  private async requestJson<T>(path: string, jwt: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': this.apiToken,
      },
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(`TxLINE request failed (${response.status} ${path}): ${body.text}`);
    }

    return body.json as T;
  }

  private async requestScoreEvents(path: string, jwt: string): Promise<readonly TxlineScore[]> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': this.apiToken,
        Accept: 'text/event-stream, application/json',
      },
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(`TxLINE request failed (${response.status} ${path}): ${body.text}`);
    }

    return parseTxlineScoreEvents(body.text);
  }
}

function getGlobalFetch(): TxlineFetcher {
  const maybeFetch = globalThis as typeof globalThis & { fetch?: TxlineFetcher };
  if (!maybeFetch.fetch) {
    throw new Error('TxLINE client requires a fetch implementation.');
  }

  return maybeFetch.fetch;
}

async function readResponseBody(response: TxlineResponse): Promise<{ text: string; json?: any }> {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text };
  }
}
