export interface TxlineGuestTokenProvider {
  startGuestSession(): Promise<{ jwt: string }>;
}

export class TxlineAuthSession {
  private jwt?: string;
  private refresh?: Promise<string>;

  constructor(private readonly provider: TxlineGuestTokenProvider) {}

  async getJwt(): Promise<string> {
    if (this.jwt) return this.jwt;
    if (!this.refresh) {
      this.refresh = this.provider.startGuestSession()
        .then(({ jwt }) => {
          this.jwt = jwt;
          return jwt;
        })
        .finally(() => {
          this.refresh = undefined;
        });
    }
    return this.refresh;
  }

  async request<T>(operation: (jwt: string) => Promise<T>): Promise<T> {
    const jwt = await this.getJwt();
    try {
      return await operation(jwt);
    } catch (error) {
      if (transportStatus(error) !== 401) throw error;
      if (this.jwt === jwt) this.jwt = undefined;
      return operation(await this.getJwt());
    }
  }

  invalidate(): void {
    this.jwt = undefined;
  }
}

function transportStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
