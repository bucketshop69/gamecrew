import type { GameCrewMatch, MatchPulseCommentaryEntry, SemanticFrame } from '@gamecrew/core';

const gameCrewApiUrl = process.env.EXPO_PUBLIC_GAMECREW_API_URL ?? 'http://localhost:8787';

export const matchRefreshIntervalMs = 10_000;

/** Poll cadence for the Game View engine frames stream while a fixture is live. */
export const engineFramesPollIntervalMs = 10_000;

interface MatchesResponse {
  source: 'txline' | 'engine' | 'combined' | 'sample' | 'sample-fallback';
  matches: readonly GameCrewMatch[];
}

export interface MatchPulseCommentaryResponse {
  fixtureId?: string;
  projectionGeneration?: number;
  entries: readonly MatchPulseCommentaryEntry[];
  source: 'engine' | 'txline';
  persistence: {
    inserted: number;
    updated: number;
    unchanged: number;
    store: string;
  };
}

export async function fetchGameCrewMatches({
  signal,
}: {
  signal?: AbortSignal;
} = {}): Promise<readonly GameCrewMatch[]> {
  const response = await fetch(`${gameCrewApiUrl}/matches`, { signal });
  const parsed = await readGameCrewResponse<MatchesResponse>(response);

  return parsed.matches;
}

// -- Commentary voice audio (see apps/api/src/tts/commentary-audio-routes.ts,
// mounted at the app root by apps/api/src/app.ts) ---------------------------

export interface CommentaryAudioManifestEntry {
  entryId: string;
  voiceId: string;
  speed: number;
  textHash: string;
  byteLength: number;
}

export interface CommentaryAudioManifestResponse {
  fixtureId: string;
  entries: readonly CommentaryAudioManifestEntry[];
}

/** GET /matches/:fixtureId/pulse/commentary/audio -- entries with generated voice for this fixture. */
export async function fetchCommentaryAudioManifest(
  fixtureId: string,
  {
    signal,
  }: {
    signal?: AbortSignal;
  } = {},
): Promise<CommentaryAudioManifestResponse> {
  const response = await fetch(
    `${gameCrewApiUrl}/matches/${encodeURIComponent(fixtureId)}/pulse/commentary/audio`,
    { signal },
  );
  return readGameCrewResponse<CommentaryAudioManifestResponse>(response);
}

/** URL for GET /matches/:fixtureId/pulse/commentary/audio/:entryId -- the clip's audio/mpeg body. */
export function resolveCommentaryAudioClipUrl(fixtureId: string, entryId: string): string {
  return `${gameCrewApiUrl}/matches/${encodeURIComponent(fixtureId)}/pulse/commentary/audio/${encodeURIComponent(entryId)}`;
}

export async function fetchMatchPulseCommentary(
  fixtureId: string,
  {
    signal,
  }: {
    signal?: AbortSignal;
  } = {},
): Promise<MatchPulseCommentaryResponse> {
  const response = await fetch(
    `${gameCrewApiUrl}/matches/${encodeURIComponent(fixtureId)}/pulse/commentary`,
    { signal },
  );
  const parsed = await readGameCrewResponse<MatchPulseCommentaryResponse>(response);

  return parsed;
}

export interface EngineFramesResponse {
  fixtureId: string;
  projectionGeneration: number;
  resyncRequired: boolean;
  frames: readonly SemanticFrame[];
  headRevision: number;
  nextAfterRevision: number;
  hasMore: boolean;
}

/** The API serves stored rows with the semantic frame nested under `frame`. */
interface EngineFrameRow {
  seq: number;
  stateRevision: number;
  frame: SemanticFrame;
}

type EngineFramesWirePayload = Omit<EngineFramesResponse, 'frames'> & {
  frames: readonly (EngineFrameRow | SemanticFrame)[];
};

function unwrapEngineFrame(row: EngineFrameRow | SemanticFrame): SemanticFrame {
  return 'frame' in row && row.frame !== undefined ? row.frame : (row as SemanticFrame);
}

export interface EngineStateResponse {
  fixtureId: string;
  checkpoint: unknown;
}

export async function fetchEngineFrames(
  fixtureId: string,
  {
    afterRevision = 0,
    projectionGeneration,
    limit,
    signal,
  }: {
    afterRevision?: number;
    projectionGeneration?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<EngineFramesResponse> {
  const params = new URLSearchParams({ afterRevision: String(afterRevision) });
  if (projectionGeneration !== undefined) {
    // The engine route names this wire parameter `generation`; keep the
    // public client option explicit while honoring the API contract so a
    // corrected projection can actually trigger `resyncRequired`.
    params.set('generation', String(projectionGeneration));
  }
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }

  const response = await fetch(
    `${gameCrewApiUrl}/matches/${encodeURIComponent(fixtureId)}/engine/frames?${params.toString()}`,
    { signal },
  );

  const payload = await readGameCrewResponse<EngineFramesWirePayload>(response);
  return { ...payload, frames: payload.frames.map(unwrapEngineFrame) };
}

export async function fetchEngineState(
  fixtureId: string,
  {
    signal,
  }: {
    signal?: AbortSignal;
  } = {},
): Promise<EngineStateResponse> {
  const response = await fetch(
    `${gameCrewApiUrl}/matches/${encodeURIComponent(fixtureId)}/engine/state`,
    { signal },
  );

  return readGameCrewResponse<EngineStateResponse>(response);
}

async function readGameCrewResponse<T>(response: Response): Promise<T> {
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `GameCrew API failed with ${response.status}`);
  }

  return JSON.parse(body) as T;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

// -- Playful Economy: Solana claim flow (V1, Privy-shaped) ------------------
// See docs/prds/playful_economy.md, docs/plans/playful-economy-v1.md ("On-chain
// claim"). Endpoints are a FROZEN contract owned by the backend; shapes
// mirror the wire responses exactly (camelCase, as sent). V1 supersedes the
// POC's server-provisioned custodial wallet (`POST /economy/users`,
// `GET /economy/users/:userId`) -- the wallet address now arrives from Privy
// social login, client-side, so there is no user-provisioning endpoint: the
// wallet address itself is the identity key for claims.

export type EconomyClaimStatus = 'pending' | 'minted' | 'failed';

export interface EconomyClaimResponse {
  claimId: string;
  status: EconomyClaimStatus;
  mintAddress?: string;
  txSignature?: string;
  explorerUrl?: string;
}

export interface CreateEconomyClaimInput {
  walletAddress: string;
  fixtureId: string;
  itemId: string;
  quantity: number;
  sourceEventId: string;
}

/** POST /economy/claims -- idempotent on (walletAddress, sourceEventId). Returns 202 with the initial 'pending' claim. */
export async function createEconomyClaim(
  input: CreateEconomyClaimInput,
  { signal }: { signal?: AbortSignal } = {},
): Promise<EconomyClaimResponse> {
  const response = await fetch(`${gameCrewApiUrl}/economy/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  return readGameCrewResponse<EconomyClaimResponse>(response);
}

/** GET /economy/claims/:claimId -- current status of a previously-created claim. */
export async function fetchEconomyClaim(
  claimId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<EconomyClaimResponse> {
  const response = await fetch(`${gameCrewApiUrl}/economy/claims/${encodeURIComponent(claimId)}`, { signal });
  return readGameCrewResponse<EconomyClaimResponse>(response);
}

/** GET /economy/wallets/:walletAddress/claims -- every claim ever made by this wallet (each in the same shape as EconomyClaimResponse). Used to resolve claim state for a wallet that was set on a fresh session (e.g. Privy resolving the same social account on a new device). */
export async function fetchEconomyWalletClaims(
  walletAddress: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<readonly EconomyClaimResponse[]> {
  const response = await fetch(
    `${gameCrewApiUrl}/economy/wallets/${encodeURIComponent(walletAddress)}/claims`,
    { signal },
  );
  return readGameCrewResponse<readonly EconomyClaimResponse[]>(response);
}
