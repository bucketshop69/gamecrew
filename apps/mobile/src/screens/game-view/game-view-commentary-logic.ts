import type {
  GameViewGoalBeat,
  GameViewScene,
  MatchPulseCommentaryEntry,
} from '@gamecrew/core';

/** Product decision: current commentary plus the two prior grounded lines, newest at the bottom. */
export const GAME_VIEW_COMMENTARY_LINE_LIMIT = 3;

/**
 * Selects the Match Pulse lines that are honest at the current Game View
 * playhead. Both projections carry source-frame ids, so synchronization is
 * based on source sequence rather than a second wall-clock timer. When one
 * semantic frame produces multiple scenes, cue ids select the exact scene
 * that activates each line instead of revealing every same-frame caption at
 * once. Taking the maximum sequence reached by the timeline prefix also means
 * delayed source corrections cannot make an already-shown line disappear.
 *
 * Confirmed goal copy is held during a goal scene's tension/checking beat.
 * The entry becomes eligible only once the scene reaches celebration, which
 * mirrors the score rail's existing no-spoiler rule.
 */
export function selectVisibleGameViewCommentary(
  entries: readonly MatchPulseCommentaryEntry[],
  timeline: readonly GameViewScene[],
  playheadIndex: number,
  activeGoalBeat?: GameViewGoalBeat,
  limit = GAME_VIEW_COMMENTARY_LINE_LIMIT,
): readonly MatchPulseCommentaryEntry[] {
  if (entries.length === 0 || timeline.length === 0 || playheadIndex < 0 || limit <= 0) {
    return [];
  }

  const safePlayhead = Math.min(playheadIndex, timeline.length - 1);
  const currentScene = timeline[safePlayhead];
  const reachedSequence = getReachedSourceSequence(timeline, safePlayhead, activeGoalBeat);
  if (reachedSequence === undefined) return [];

  const currentSourceIds = new Set(currentScene?.sourceFrameIds ?? []);
  const eligible = entries
    .map((entry) => ({
      entry,
      sceneIndex: getCommentaryActivationSceneIndex(entry, timeline),
      sequence: getCommentaryActivationSequence(entry),
    }))
    .filter((item): item is {
      entry: MatchPulseCommentaryEntry;
      sceneIndex: number | undefined;
      sequence: number;
    } => (
      item.sequence !== undefined && item.sequence <= reachedSequence
    ))
    .filter(({ sceneIndex }) => sceneIndex === undefined || sceneIndex <= safePlayhead)
    .filter(({ entry }) => !isSpoilingCurrentGoal(entry, currentScene, currentSourceIds, activeGoalBeat))
    .sort((left, right) => (
      left.sequence - right.sequence
      || (left.sceneIndex ?? Number.MAX_SAFE_INTEGER) - (right.sceneIndex ?? Number.MAX_SAFE_INTEGER)
      || left.entry.id.localeCompare(right.entry.id)
    ));

  return eligible.slice(-Math.max(0, Math.floor(limit))).map(({ entry }) => entry);
}

function getReachedSourceSequence(
  timeline: readonly GameViewScene[],
  playheadIndex: number,
  activeGoalBeat: GameViewGoalBeat | undefined,
): number | undefined {
  let reached: number | undefined;

  for (let index = 0; index <= playheadIndex; index += 1) {
    const scene = timeline[index];
    const sourceFrameIds = index === playheadIndex
      && scene?.kind === 'goal_sequence'
      && activeGoalBeat
      ? activeGoalBeat.sourceFrameIds
      : scene?.sourceFrameIds ?? [];

    for (const sourceFrameId of sourceFrameIds) {
      const sequence = sourceSequenceFromFrameId(sourceFrameId);
      if (sequence !== undefined && (reached === undefined || sequence > reached)) {
        reached = sequence;
      }
    }
  }

  return reached;
}

function getCommentaryActivationSceneIndex(
  entry: MatchPulseCommentaryEntry,
  timeline: readonly GameViewScene[],
): number | undefined {
  const sourceFrameIds = new Set(entry.sourceFrameIds ?? []);
  if (sourceFrameIds.size === 0) return undefined;
  const cueIds = new Set(entry.cueIds ?? []);

  if (cueIds.size > 0) {
    const cueAlignedIndex = timeline.findIndex((scene) =>
      scene.sourceFrameIds.some((frameId) => sourceFrameIds.has(frameId))
      && scene.sourceCueIds.some((cueId) => cueIds.has(cueId)));
    if (cueAlignedIndex >= 0) return cueAlignedIndex;
  }

  const sourceAlignedIndex = timeline.findIndex((scene) =>
    scene.sourceFrameIds.some((frameId) => sourceFrameIds.has(frameId)));
  return sourceAlignedIndex >= 0 ? sourceAlignedIndex : undefined;
}

function getCommentaryActivationSequence(entry: MatchPulseCommentaryEntry): number | undefined {
  const sourceSequences = (entry.sourceFrameIds ?? [])
    .map(sourceSequenceFromFrameId)
    .filter((sequence): sequence is number => sequence !== undefined);

  if (sourceSequences.length > 0) return Math.max(...sourceSequences);

  const durableSequences = [entry.toSeq, entry.sortSeq, entry.fromSeq]
    .filter((sequence): sequence is number => Number.isFinite(sequence));
  return durableSequences.length > 0 ? Math.max(...durableSequences) : undefined;
}

function sourceSequenceFromFrameId(sourceFrameId: string): number | undefined {
  const match = sourceFrameId.match(/:(\d+)$/);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function isSpoilingCurrentGoal(
  entry: MatchPulseCommentaryEntry,
  currentScene: GameViewScene | undefined,
  currentSourceIds: ReadonlySet<string>,
  activeGoalBeat: GameViewGoalBeat | undefined,
): boolean {
  if (
    entry.kind !== 'goal'
    || currentScene?.kind !== 'goal_sequence'
    || activeGoalBeat?.kind === 'celebration'
  ) {
    return false;
  }

  return (entry.sourceFrameIds ?? []).some((sourceFrameId) => currentSourceIds.has(sourceFrameId));
}

/** Prevents commentary from one corrected projection mixing with another. */
export function isGameViewCommentaryProjectionCompatible(
  commentaryProjectionGeneration: number | undefined,
  playbackProjectionGeneration: number,
): boolean {
  return commentaryProjectionGeneration === undefined
    || commentaryProjectionGeneration === playbackProjectionGeneration;
}
