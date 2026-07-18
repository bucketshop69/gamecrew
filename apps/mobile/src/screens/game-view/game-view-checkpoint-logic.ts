import type {
  GameViewScene,
  MatchEngineParticipant,
  MatchPulseCommentaryEntry,
} from '@gamecrew/core';

const REGULATION_SECONDS = 90 * 60;
const CHECKPOINT_LEAD_SCENE_COUNT = 2;

export type GameViewCheckpointKind =
  | 'goal'
  | 'red_card'
  | 'penalty'
  | 'var'
  | 'overturned_goal';

export interface GameViewCheckpoint {
  id: string;
  kind: GameViewCheckpointKind;
  sceneIndex: number;
  clockSeconds: number;
  minute: number;
  position: number;
  /** One of three narrow horizontal lanes used when critical moments cluster in time. */
  lane: 0 | 1 | 2;
  participant?: MatchEngineParticipant;
  accessibilityLabel: string;
}

export interface GameViewCheckpointRailModel {
  checkpoints: readonly GameViewCheckpoint[];
  durationSeconds: number;
  endLabel: string;
}

/**
 * Derives navigation-only match moments from canonical Game View scenes.
 * The rail never promotes routine events and never places an event without
 * a source clock: its vertical position must remain match truth, not visual
 * guesswork. Regulation is the minimum scale; a recorded later finish grows
 * the scale so stoppage/extra-time moments never bunch beyond the bottom.
 */
export function buildGameViewCheckpointRail(
  timeline: readonly GameViewScene[],
): GameViewCheckpointRailModel {
  const durationSeconds = Math.max(
    REGULATION_SECONDS,
    ...timeline.map((scene) => validClock(scene.clockSeconds) ?? 0),
  );

  const checkpoints = timeline.flatMap((scene, sceneIndex) => {
    const clockSeconds = validClock(scene.clockSeconds);
    const kind = checkpointKind(scene);
    if (clockSeconds === undefined || kind === undefined) return [];

    const minute = Math.max(1, Math.ceil(clockSeconds / 60));
    return [{
      id: `${scene.id}:checkpoint:${kind}`,
      kind,
      sceneIndex,
      clockSeconds,
      minute,
      position: clamp01(clockSeconds / durationSeconds),
      lane: 0,
      participant: scene.participant,
      accessibilityLabel: `Jump to ${checkpointName(kind)} at ${minute}′`,
    } satisfies GameViewCheckpoint];
  });

  let previousCheckpoint: GameViewCheckpoint | undefined;
  const laidOutCheckpoints = checkpoints.map((checkpoint) => {
    const previous = previousCheckpoint;
    const lane = previous && checkpoint.clockSeconds - previous.clockSeconds <= 90
      ? ((previous.lane + 1) % 3) as 0 | 1 | 2
      : 0;
    const laidOut = { ...checkpoint, lane };
    previousCheckpoint = laidOut;
    return laidOut;
  });

  return {
    checkpoints: laidOutCheckpoints,
    durationSeconds,
    endLabel: `${Math.ceil(durationSeconds / 60)}′`,
  };
}

/** Latest critical moment reached by the canonical scene playhead. */
export function findActiveGameViewCheckpointId(
  checkpoints: readonly GameViewCheckpoint[],
  playheadIndex: number,
): string | undefined {
  let active: GameViewCheckpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (checkpoint.sceneIndex > playheadIndex) break;
    active = checkpoint;
  }
  return active?.id;
}

/** Current match-clock progress on the same scale as every checkpoint. */
export function resolveGameViewCheckpointProgress(
  clockSeconds: number | undefined,
  durationSeconds: number,
): number {
  const clock = validClock(clockSeconds);
  if (clock === undefined || durationSeconds <= 0) return 0;
  return clamp01(clock / durationSeconds);
}

/**
 * Gives a selected critical moment a short source-grounded buildup without
 * inventing a wall-clock offset inside a scene. Two prior canonical scenes
 * normally provide the run-in; early moments safely clamp to kickoff.
 */
export function resolveGameViewCheckpointReplayStartIndex(
  checkpointSceneIndex: number,
): number {
  return Math.max(0, Math.floor(checkpointSceneIndex) - CHECKPOINT_LEAD_SCENE_COUNT);
}

/** Exact source-provenance bridge from a visual checkpoint to Match Pulse. */
export function findGameViewCheckpointCommentaryEntryId(
  timeline: readonly GameViewScene[],
  checkpointSceneIndex: number,
  entries: readonly MatchPulseCommentaryEntry[],
): string | undefined {
  const scene = timeline[checkpointSceneIndex];
  if (!scene) return undefined;

  const cueIds = new Set(scene.sourceCueIds);
  const frameIds = new Set(scene.sourceFrameIds);
  let bestMatch: MatchPulseCommentaryEntry | undefined;
  let bestFrameOverlap = 0;
  let bestCueOverlap = 0;

  for (const entry of entries) {
    const frameOverlap = countOverlap(entry.sourceFrameIds, frameIds);
    const cueOverlap = countOverlap(entry.cueIds, cueIds);
    if (frameOverlap === 0 && cueOverlap === 0) continue;

    // Frame IDs identify the exact source moment. Cue IDs are the fallback,
    // but some cue kinds (notably score_commit) are reused across goals, so
    // the strongest overlap must win instead of whichever entry happens to
    // appear first in the newest-first Match Pulse response.
    if (
      !bestMatch
      || frameOverlap > bestFrameOverlap
      || (frameOverlap === bestFrameOverlap && cueOverlap > bestCueOverlap)
    ) {
      bestMatch = entry;
      bestFrameOverlap = frameOverlap;
      bestCueOverlap = cueOverlap;
    }
  }

  return bestMatch?.id;
}

function countOverlap(
  candidates: readonly string[] | undefined,
  sourceIds: ReadonlySet<string>,
): number {
  if (!candidates || sourceIds.size === 0) return 0;
  return candidates.reduce((count, id) => count + Number(sourceIds.has(id)), 0);
}

function checkpointKind(scene: GameViewScene): GameViewCheckpointKind | undefined {
  if (scene.kind === 'goal_retracted') return 'overturned_goal';

  if (scene.kind === 'goal_sequence') {
    const confirmedCelebration = scene.beats?.some((beat) =>
      beat.kind === 'celebration' && beat.lifecycle === 'confirmed');
    return scene.lifecycle === 'confirmed' || confirmedCelebration ? 'goal' : undefined;
  }

  if (scene.lifecycle === 'retracted' || scene.lifecycle === 'unresolved') return undefined;

  const classification = `${scene.sourceAction ?? ''} ${scene.sourceType ?? ''}`
    .replaceAll(/[^a-zA-Z]/g, '')
    .toLowerCase();

  if (scene.kind === 'card' && classification.includes('red')) return 'red_card';
  if (scene.kind === 'set_piece' && classification.includes('penalty')) return 'penalty';
  if (scene.kind === 'var_review') return 'var';
  return undefined;
}

function checkpointName(kind: GameViewCheckpointKind): string {
  switch (kind) {
    case 'goal': return 'goal';
    case 'red_card': return 'red card';
    case 'penalty': return 'penalty';
    case 'var': return 'VAR review';
    case 'overturned_goal': return 'overturned goal';
  }
}

function validClock(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
