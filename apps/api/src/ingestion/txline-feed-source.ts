import {
  TxlineApiClient,
  TxlineTransportError,
  type TxlineFixture,
  type TxlineFixtureSnapshotOptions,
  type TxlineScore,
  type TxlineScoreStreamEvent,
} from '@gamecrew/core';
import { TxlineAuthSession } from './txline-auth-session.js';

export interface StreamFixtureOptions {
  lastEventId?: string;
  signal: AbortSignal;
  onOpen?: () => void | Promise<void>;
}

export class TxlineFeedSource {
  constructor(
    private readonly client: TxlineApiClient,
    private readonly auth: TxlineAuthSession,
  ) {}

  fetchFixtures(options: TxlineFixtureSnapshotOptions = {}): Promise<readonly TxlineFixture[]> {
    return this.auth.request((jwt) => this.client.listFixtures(jwt, options));
  }

  fetchSnapshot(fixtureId: string): Promise<readonly TxlineScore[]> {
    return this.auth.request((jwt) => this.client.listScoreSnapshot(fixtureId, jwt));
  }

  fetchUpdates(fixtureId: string): Promise<readonly TxlineScore[]> {
    return this.auth.request((jwt) => this.client.listScoreUpdates(fixtureId, jwt));
  }

  fetchHistorical(fixtureId: string): Promise<readonly TxlineScore[]> {
    return this.auth.request((jwt) => this.client.listScoreHistory(fixtureId, jwt));
  }

  fetchInterval(
    epochDay: number,
    hour: number,
    interval: number,
    fixtureId: string,
  ): Promise<readonly TxlineScore[]> {
    return this.auth.request((jwt) => this.client.listScoreInterval(
      epochDay,
      hour,
      interval,
      jwt,
      { fixtureId },
    ));
  }

  async *streamFixture(
    fixtureId: string,
    options: StreamFixtureOptions,
  ): AsyncGenerator<TxlineScoreStreamEvent> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const jwt = await this.auth.getJwt();
      try {
        yield* this.client.streamScoreUpdates(fixtureId, jwt, options);
        return;
      } catch (error) {
        if (!(error instanceof TxlineTransportError) || error.status !== 401 || attempt > 0) throw error;
        this.auth.invalidate();
      }
    }
  }
}
