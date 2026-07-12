export interface ManagedFixtureSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  isStopped?(): boolean;
}

export class IngestionSupervisor {
  private readonly sessions = new Map<string, Promise<ManagedFixtureSession>>();

  constructor(private readonly createSession: (
    fixtureId: string,
  ) => ManagedFixtureSession | Promise<ManagedFixtureSession>) {}

  ensureFixture(fixtureId: string | number): Promise<ManagedFixtureSession> {
    const key = String(fixtureId);
    const existing = this.sessions.get(key);
    if (existing) {
      return existing.then((session) => {
        if (!session.isStopped?.()) return session;
        if (this.sessions.get(key) === existing) this.sessions.delete(key);
        return this.ensureFixture(key);
      });
    }
    const pending = Promise.resolve(this.createSession(key)).then(async (session) => {
      await session.start();
      return session;
    }).catch((error) => {
      this.sessions.delete(key);
      throw error;
    });
    this.sessions.set(key, pending);
    return pending;
  }

  async stopFixture(fixtureId: string | number): Promise<void> {
    const key = String(fixtureId);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (session) await (await session).stop();
  }

  async stop(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.allSettled(entries.map(async ([, session]) => (await session).stop()));
  }

  activeFixtureCount(): number {
    return this.sessions.size;
  }
}
