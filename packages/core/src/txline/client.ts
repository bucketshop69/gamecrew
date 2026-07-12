import {
  parseTxlineScoreEventData,
  parseTxlineScoreEvents,
  TxlineSseDecoder,
} from './parser';
import type {
  TxlineClientConfig,
  TxlineFetcher,
  TxlineFixtureSnapshotOptions,
  TxlineFixture,
  TxlineGuestSession,
  TxlineResponse,
  TxlineScore,
  TxlineScoreIntervalOptions,
  TxlineScoreSnapshotOptions,
  TxlineScoreStreamEvent,
  TxlineScoreStreamOptions,
  TxlineSseMessage,
} from './types';

export class TxlineTransportError extends Error {
  readonly status?: number;
  readonly path: string;

  constructor(message: string, options: { path: string; status?: number; cause?: unknown }) {
    super(message);
    this.name = 'TxlineTransportError';
    this.path = options.path;
    this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

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
    const path = '/auth/guest/start';
    const response = await this.fetchResponse(path, { method: 'POST' });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new TxlineTransportError(
        `TxLINE guest session failed (${response.status}): ${body.text}`,
        { path, status: response.status },
      );
    }

    const token = body.json?.token ?? body.json?.jwt ?? body.json?.accessToken ?? body.text.trim();
    if (!token) {
      throw new TxlineTransportError('TxLINE guest session did not return a JWT.', { path });
    }

    return { jwt: token };
  }

  async listFixtures(
    jwt: string,
    options: TxlineFixtureSnapshotOptions = {},
  ): Promise<readonly TxlineFixture[]> {
    const path = withQuery('/api/fixtures/snapshot', {
      startEpochDay: options.startEpochDay,
      competitionId: options.competitionId,
    });
    return this.requestJson<readonly TxlineFixture[]>(path, jwt);
  }

  async listScoreSnapshot(
    fixtureId: string | number,
    jwt: string,
    options: TxlineScoreSnapshotOptions = {},
  ): Promise<readonly TxlineScore[]> {
    const path = withQuery(`/api/scores/snapshot/${fixtureId}`, { asOf: options.asOf });
    const scores = await this.requestJson<readonly TxlineScore[]>(path, jwt);
    return filterScoresForFixture(scores, fixtureId);
  }

  async listScoreHistory(fixtureId: string | number, jwt: string): Promise<readonly TxlineScore[]> {
    return this.requestScoreEvents(`/api/scores/historical/${fixtureId}`, jwt, fixtureId);
  }

  async listScoreUpdates(fixtureId: string | number, jwt: string): Promise<readonly TxlineScore[]> {
    return this.requestScoreEvents(`/api/scores/updates/${fixtureId}`, jwt, fixtureId);
  }

  async listScoreInterval(
    epochDay: number,
    hourOfDay: number,
    interval: number,
    jwt: string,
    options: TxlineScoreIntervalOptions = {},
  ): Promise<readonly TxlineScore[]> {
    const basePath = `/api/scores/updates/${epochDay}/${hourOfDay}/${interval}`;
    if (!Number.isInteger(hourOfDay) || hourOfDay < 0 || hourOfDay > 23) {
      throw new TxlineTransportError('TxLINE score interval hourOfDay must be between 0 and 23.', {
        path: basePath,
      });
    }
    if (!Number.isInteger(interval) || interval < 0 || interval > 11) {
      throw new TxlineTransportError('TxLINE score interval must be between 0 and 11.', {
        path: basePath,
      });
    }
    const path = withQuery(basePath, { fixtureId: options.fixtureId });
    return this.requestScoreEvents(path, jwt, options.fixtureId);
  }

  async *streamScoreUpdates(
    fixtureId: string | number,
    jwt: string,
    options: TxlineScoreStreamOptions = {},
  ): AsyncGenerator<TxlineScoreStreamEvent> {
    const path = withQuery('/api/scores/stream', { fixtureId });
    const headers: Record<string, string> = {
      ...this.authorizedHeaders(jwt),
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    if (options.lastEventId !== undefined) headers['Last-Event-ID'] = options.lastEventId;

    const response = await this.fetchResponse(path, { headers, signal: options.signal });
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new TxlineTransportError(
        `TxLINE stream failed (${response.status} ${path}): ${body.text}`,
        { path, status: response.status },
      );
    }
    if (!response.body) {
      throw new TxlineTransportError('TxLINE stream response did not include a readable body.', { path });
    }

    await options.onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TxlineSseDecoder();
    try {
      while (!options.signal?.aborted) {
        const { done, value } = await reader.read();
        const messages = done ? decoder.finish() : decoder.push(value ?? new Uint8Array());
        for (const message of messages) {
          for (const event of scoreStreamEvents(message, fixtureId)) {
            await dispatchStreamCallbacks(event, options);
            yield event;
          }
        }
        if (done) break;
      }
    } catch (cause) {
      if (!options.signal?.aborted) {
        throw new TxlineTransportError('TxLINE score stream failed while reading.', { path, cause });
      }
    } finally {
      if (options.signal?.aborted) await reader.cancel?.(options.signal.reason).catch(() => undefined);
      reader.releaseLock?.();
    }
  }

  private async requestJson<T>(path: string, jwt: string): Promise<T> {
    const response = await this.fetchResponse(path, { headers: this.authorizedHeaders(jwt) });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new TxlineTransportError(`TxLINE request failed (${response.status} ${path}): ${body.text}`, {
        path,
        status: response.status,
      });
    }
    if (body.json === undefined) {
      throw new TxlineTransportError(`TxLINE request returned invalid JSON (${path}).`, { path });
    }
    return body.json as T;
  }

  private async requestScoreEvents(
    path: string,
    jwt: string,
    fixtureId?: string | number,
  ): Promise<readonly TxlineScore[]> {
    const response = await this.fetchResponse(path, {
      headers: {
        ...this.authorizedHeaders(jwt),
        Accept: 'text/event-stream, application/json',
      },
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new TxlineTransportError(`TxLINE request failed (${response.status} ${path}): ${body.text}`, {
        path,
        status: response.status,
      });
    }
    return filterScoresForFixture(parseTxlineScoreEvents(body.text), fixtureId);
  }

  private authorizedHeaders(jwt: string): Record<string, string> {
    return {
      Authorization: `Bearer ${jwt}`,
      'X-Api-Token': this.apiToken,
    };
  }

  private async fetchResponse(
    path: string,
    init?: Parameters<TxlineFetcher>[1],
  ): Promise<TxlineResponse> {
    try {
      return await this.fetcher(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new TxlineTransportError(`TxLINE transport request failed (${path}).`, { path, cause });
    }
  }
}

function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}

function filterScoresForFixture(
  scores: readonly TxlineScore[],
  fixtureId?: string | number,
): readonly TxlineScore[] {
  if (fixtureId === undefined) return scores;
  return scores.filter((score) => {
    const recordFixtureId = score.FixtureId ?? score.fixtureId;
    return recordFixtureId !== undefined && String(recordFixtureId) === String(fixtureId);
  });
}

function scoreStreamEvents(
  message: TxlineSseMessage,
  fixtureId: string | number,
): readonly TxlineScoreStreamEvent[] {
  if (message.event?.toLowerCase() === 'heartbeat') {
    return [{ kind: 'heartbeat', message, timestamp: heartbeatTimestamp(message.data) }];
  }
  const parsedScores = parseTxlineScoreEventData(message.data);
  if (parsedScores.length > 0) {
    const filtered = filterScoresForFixture(parsedScores, fixtureId);
    return filtered.map((score, scoreIndex) => ({
      kind: 'score' as const,
      message,
      score,
      scoreIndex,
      scoreCount: filtered.length,
      isLastInMessage: scoreIndex === filtered.length - 1,
    }));
  }
  return [{ kind: 'control', message }];
}

function heartbeatTimestamp(data: string): number | undefined {
  try {
    const value = JSON.parse(data) as { Ts?: unknown; ts?: unknown };
    const timestamp = value.Ts ?? value.ts;
    return typeof timestamp === 'number' ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

async function dispatchStreamCallbacks(
  event: TxlineScoreStreamEvent,
  options: TxlineScoreStreamOptions,
): Promise<void> {
  await options.onEvent?.(event);
  if (event.kind === 'score') await options.onScore?.(event.score, event.message);
  if (event.kind === 'heartbeat') await options.onHeartbeat?.(event);
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
