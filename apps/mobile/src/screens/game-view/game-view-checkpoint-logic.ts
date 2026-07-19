import type {
  GameViewScene,
  MatchEngineParticipant,
  MatchPulseCommentaryEntry,
} from '@gamecrew/core';

const REGULATION_SECONDS = 90 * 60;
const CHECKPOINT_LEAD_SCENE_COUNT = 2;
/** Item 8: a checkpoint clip spans from ~1 match-minute before the moment to ~1 match-minute after it. */
const CHECKPOINT_CLIP_WINDOW_SECONDS = 60;
/**
 * Item 2 (fix round): once a goal checkpoint's clip window reaches the end
 * of its goal_sequence scene(s), it must still push a few more scenes past
 * that point before stopping. `rangeStopAtIndex` plays its own stop scene's
 * full `durationHint` and then halts (see playback-engine.ts's
 * `scheduleReplayAdvance`), but `MatchDetailScreen`'s highlights/clip
 * watcher effect (gamecrew-screens.tsx) reacts to `playheadIndex ===
 * rangeStopAtIndex` the instant the playhead LANDS on that scene -- not
 * after its duration elapses -- so a clip that stops exactly ON the
 * goal_sequence scene itself flips back to idle (or advances to the next
 * highlight) before the celebration beat has any chance to render. Landing
 * the stop a few scenes further out gives the goal_sequence scene(s) a real
 * tail to play through before the watcher ever notices the stop index.
 */
const GOAL_CLIP_TAIL_SCENE_COUNT = 3;

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

// ---------------------------------------------------------------------------
// Bounded checkpoint clips (item 8) + highlights sequencing (item 13)
// ---------------------------------------------------------------------------

/** A checkpoint's resolved clip: play `startSceneIndex` through `endSceneIndex` (inclusive), then stop. */
export interface GameViewCheckpointClipWindow {
  checkpointId: string;
  startSceneIndex: number;
  endSceneIndex: number;
}

/**
 * Resolves the bounded clip window for a single checkpoint (item 8): start
 * at the earliest scene whose clock is at least
 * `CHECKPOINT_CLIP_WINDOW_SECONDS` before the moment, end at the latest
 * scene whose clock is at most that many seconds after it. Both ends clamp
 * to the timeline's bounds (a moment near kickoff or near the final whistle
 * simply gets a shorter clip on that side).
 *
 * The existing 2-scene lead-in (`resolveGameViewCheckpointReplayStartIndex`)
 * is preserved as a floor: for an early moment where few scenes exist per
 * minute, the minute-based start can land later (closer to the moment) than
 * the 2-scene lead-in would -- in that case the 2-scene lead-in wins, so a
 * clip is never a more abrupt entrance than checkpoint navigation already
 * was before this item.
 */
export function resolveGameViewCheckpointClipWindow(
  timeline: readonly GameViewScene[],
  checkpoint: GameViewCheckpoint,
): GameViewCheckpointClipWindow {
  const lastIndex = timeline.length - 1;
  const moment = checkpoint.clockSeconds;

  const minuteBasedStart = findEarliestIndexWithClockAtLeast(
    timeline,
    moment - CHECKPOINT_CLIP_WINDOW_SECONDS,
  );
  const leadInStart = resolveGameViewCheckpointReplayStartIndex(checkpoint.sceneIndex);
  const startSceneIndex = clampIndex(Math.min(minuteBasedStart, leadInStart), 0, lastIndex);

  const clockBasedEnd = findLatestIndexWithClockAtMost(timeline, moment + CHECKPOINT_CLIP_WINDOW_SECONDS, checkpoint.sceneIndex);
  // Item 2 (fix round): a goal checkpoint's window must extend past the
  // celebration takeover itself, not stop on it -- see
  // `GOAL_CLIP_TAIL_SCENE_COUNT`'s doc comment. `goalSequenceTailFloor`
  // walks past every contiguous goal_sequence scene starting at the
  // checkpoint (covering a provisional scene immediately followed by its
  // own confirmed sibling -- see checkpointKind's doc comment on how a goal
  // can be two sibling scenes), then adds the fixed tail so the stop always
  // lands a few scenes clear of the sequence, never on it.
  const endSceneIndex = clampIndex(
    checkpoint.kind === 'goal'
      ? Math.max(clockBasedEnd, goalSequenceTailFloor(timeline, checkpoint.sceneIndex))
      : clockBasedEnd,
    startSceneIndex,
    lastIndex,
  );

  return { checkpointId: checkpoint.id, startSceneIndex, endSceneIndex };
}

/**
 * Walks forward from a goal checkpoint's own scene index past every
 * contiguous `goal_sequence` scene (a provisional scene immediately followed
 * by its confirmed sibling counts as one contiguous run), then adds
 * `GOAL_CLIP_TAIL_SCENE_COUNT` more scenes so the resolved stop index always
 * lands clear of the celebration takeover itself. Clamped to the timeline's
 * last index -- a goal right at the final whistle simply gets whatever tail
 * the timeline actually has.
 */
function goalSequenceTailFloor(
  timeline: readonly GameViewScene[],
  checkpointSceneIndex: number,
): number {
  const lastIndex = timeline.length - 1;
  let sequenceEnd = checkpointSceneIndex;
  while (sequenceEnd + 1 <= lastIndex && timeline[sequenceEnd + 1]?.kind === 'goal_sequence') {
    sequenceEnd += 1;
  }
  return clampIndex(sequenceEnd + GOAL_CLIP_TAIL_SCENE_COUNT, 0, lastIndex);
}

/** Earliest scene index whose clock is `>= minClockSeconds` (falls back to 0 -- kickoff -- if none qualify). */
function findEarliestIndexWithClockAtLeast(
  timeline: readonly GameViewScene[],
  minClockSeconds: number,
): number {
  for (let index = 0; index < timeline.length; index += 1) {
    const clock = validClock(timeline[index]?.clockSeconds);
    if (clock !== undefined && clock >= minClockSeconds) return index;
  }
  return 0;
}

/**
 * Latest scene index whose clock is `<= maxClockSeconds`, never earlier than
 * `atLeastIndex` (the checkpoint's own scene -- a clip always includes the
 * moment itself even if later scenes lack clock data to extend past it).
 */
function findLatestIndexWithClockAtMost(
  timeline: readonly GameViewScene[],
  maxClockSeconds: number,
  atLeastIndex: number,
): number {
  let best = atLeastIndex;
  for (let index = atLeastIndex; index < timeline.length; index += 1) {
    const clock = validClock(timeline[index]?.clockSeconds);
    if (clock === undefined || clock > maxClockSeconds) break;
    best = index;
  }
  return best;
}

function clampIndex(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Play-highlights sequencing (item 13): resolves every checkpoint's clip
 * window in match order, merging/skipping windows that overlap the previous
 * one so no moment plays twice. A window that starts at or before the
 * previous window's end is pulled forward to start right after it (or
 * dropped entirely if the previous window already reaches or passes its own
 * end -- fully swallowed, e.g. a VAR review immediately followed by a goal).
 */
export function buildGameViewHighlightsSequence(
  timeline: readonly GameViewScene[],
  checkpoints: readonly GameViewCheckpoint[],
): readonly GameViewCheckpointClipWindow[] {
  const sequence: GameViewCheckpointClipWindow[] = [];
  let previousEnd = -1;

  for (const checkpoint of checkpoints) {
    const window = resolveGameViewCheckpointClipWindow(timeline, checkpoint);
    if (window.endSceneIndex <= previousEnd) continue; // fully swallowed by the prior clip

    const startSceneIndex = Math.max(window.startSceneIndex, previousEnd + 1);
    const mergedWindow: GameViewCheckpointClipWindow = {
      ...window,
      startSceneIndex: Math.min(startSceneIndex, window.endSceneIndex),
    };
    sequence.push(mergedWindow);
    previousEnd = mergedWindow.endSceneIndex;
  }

  return sequence;
}

/**
 * Given the currently playing highlight window's index into `sequence`,
 * decides what happens once the playback engine reports its bounded range
 * has reached `stopAtIndex` (see `PlaybackSnapshot.rangeStopAtIndex`):
 * advance to the next clip, or settle (highlights are finished, land back on
 * the full-time board) once the last clip's window ends.
 */
export type GameViewHighlightsAdvanceDecision =
  | { kind: 'advance'; nextIndex: number; window: GameViewCheckpointClipWindow }
  | { kind: 'settle' };

export function resolveGameViewHighlightsAdvance(
  sequence: readonly GameViewCheckpointClipWindow[],
  currentIndex: number,
): GameViewHighlightsAdvanceDecision {
  const nextIndex = currentIndex + 1;
  const nextWindow = sequence[nextIndex];
  if (!nextWindow) return { kind: 'settle' };
  return { kind: 'advance', nextIndex, window: nextWindow };
}

// ---------------------------------------------------------------------------
// Full-time scorer timeline (item 12)
// ---------------------------------------------------------------------------

export interface GameViewScorerTimelineEntry {
  checkpointId: string;
  participant?: MatchEngineParticipant;
  minute: number;
  minuteLabel: string;
  /** Parsed from the goal's commentary text when available; undefined when parsing fails (see `parseGoalScorerName`). */
  scorerName?: string;
}

/**
 * Derives the full-time board's scorer timeline from the checkpoint rail's
 * own `goal` checkpoints (already source-grounded on clock/participant --
 * see `buildGameViewCheckpointRail`), attaching a parsed scorer name from
 * the matching Match Pulse commentary entry's text where one can be found.
 * A goal whose name can't be resolved (no matching entry, or text that
 * doesn't match the known fallback shape) still gets a timeline row --
 * team + minute are already known match truth -- just without a name.
 */
export function buildGameViewScorerTimeline(
  timeline: readonly GameViewScene[],
  checkpoints: readonly GameViewCheckpoint[],
  entries: readonly MatchPulseCommentaryEntry[],
): readonly GameViewScorerTimelineEntry[] {
  return checkpoints
    .filter((checkpoint) => checkpoint.kind === 'goal')
    .map((checkpoint) => {
      const entryId = findGameViewCheckpointCommentaryEntryId(timeline, checkpoint.sceneIndex, entries);
      const entry = entryId ? entries.find((candidate) => candidate.id === entryId) : undefined;
      return {
        checkpointId: checkpoint.id,
        participant: checkpoint.participant,
        minute: checkpoint.minute,
        minuteLabel: formatCheckpointMinuteLabel(checkpoint.minute),
        scorerName: entry ? parseGoalScorerName(entry.commentary) : undefined,
      } satisfies GameViewScorerTimelineEntry;
    });
}

// ---------------------------------------------------------------------------
// Scorer display rows (fix round item 13b): clusters nameless goals
// ---------------------------------------------------------------------------

/** A named-scorer row: one line, "{name} {minute}′" -- unchanged one-row-per-goal shape. */
export interface GameViewScorerNamedRow {
  kind: 'named';
  checkpointId: string;
  participant?: MatchEngineParticipant;
  minute: number;
  scorerName: string;
}

/**
 * A clustered row for a team's nameless goals: one row total per team,
 * "⚽ {minute}′ · {minute}′ · ..." -- item 13b's fallback, replacing what
 * used to be one bare "Goal {minute}′" row per unparsed goal.
 */
export interface GameViewScorerClusterRow {
  kind: 'cluster';
  /** Stable across rebuilds for the same team's set of nameless goals (join of checkpoint ids), safe as a React list key. */
  checkpointId: string;
  participant?: MatchEngineParticipant;
  /** Match order, ascending. */
  minutes: readonly number[];
}

export type GameViewScorerRow = GameViewScorerNamedRow | GameViewScorerClusterRow;

/**
 * Item 13b: groups `buildGameViewScorerTimeline`'s flat per-goal entries
 * into display rows -- every named scorer keeps its own row (unchanged
 * behavior), but a team's goals that couldn't be parsed to a name collapse
 * into a SINGLE clustered row for that team ("⚽ 3′ · 18′ · 37′") instead of
 * one bare "Goal {minute}′" line per goal, per the spec's broadcast-card
 * framing (repeated bare "Goal" rows read as noise, not a scoreboard).
 * Order is preserved: each row (named or cluster) appears at the position
 * of its EARLIEST contributing goal, so the column still reads top-to-
 * bottom in match order even though a cluster gathers goals from several
 * different minutes into one row.
 */
export function buildGameViewScorerRows(
  scorerTimeline: readonly GameViewScorerTimelineEntry[],
): readonly GameViewScorerRow[] {
  const rows: GameViewScorerRow[] = [];
  const clusterIndexByParticipant = new Map<string, number>();

  for (const entry of scorerTimeline) {
    if (entry.scorerName) {
      rows.push({
        kind: 'named',
        checkpointId: entry.checkpointId,
        participant: entry.participant,
        minute: entry.minute,
        scorerName: entry.scorerName,
      });
      continue;
    }

    const participantKey = String(entry.participant ?? 'unknown');
    const existingIndex = clusterIndexByParticipant.get(participantKey);
    if (existingIndex === undefined) {
      clusterIndexByParticipant.set(participantKey, rows.length);
      rows.push({
        kind: 'cluster',
        checkpointId: entry.checkpointId,
        participant: entry.participant,
        minutes: [entry.minute],
      });
      continue;
    }

    const existing = rows[existingIndex];
    if (existing?.kind === 'cluster') {
      rows[existingIndex] = {
        ...existing,
        checkpointId: `${existing.checkpointId}+${entry.checkpointId}`,
        minutes: [...existing.minutes, entry.minute],
      };
    }
  }

  return rows;
}

/**
 * Stoppage time past the 90th reads as e.g. "90+2′" rather than a flat "92′",
 * matching the PRD's example copy ("Lautaro Martinez 90+2'"). The checkpoint
 * model doesn't carry a half-time boundary, so first-half stoppage isn't
 * distinguished from early second-half minutes -- only second-half added
 * time (past 90') gets the "+" treatment; everything else (including
 * first-half stoppage) renders as a plain minute, matching the existing
 * checkpoint rail's own minute labeling (no "45+" anywhere in that module
 * today). This is presentation-only rounding over the checkpoint's already
 * source-grounded whole minute; it invents no new time data.
 */
function formatCheckpointMinuteLabel(minute: number): string {
  return minute > 90 ? `90+${minute - 90}′` : `${minute}′`;
}

/**
 * A capitalized name token run: one or more words starting with an uppercase
 * letter, each word itself allowing accented letters and internal hyphens/
 * apostrophes (e.g. "Enzo", "Fernandez", "O'Brien", "Álvarez", "Saint-Maximin").
 */
const NAME_TOKEN = "[\\p{Lu}][\\p{L}'-]*";
const NAME_GROUP = `(${NAME_TOKEN}(?:\\s+${NAME_TOKEN})*)`;

/**
 * Anchored patterns for the real shapes goal commentary text is seen in,
 * checked in order (item 6/fix): the engine's own fallback shape (`"<Name>
 * scores for <Team>."`) plus the LLM-enriched shapes that lead with the
 * scorer's name before a scoring verb, anywhere in the sentence -- not just
 * at the very start, since enriched lines often open with a team-reaction
 * clause first (e.g. "Argentina have it! Enzo Fernandez finds the goal...").
 * Each pattern's single capture group is the candidate name.
 */
const GOAL_SCORER_PATTERNS: readonly RegExp[] = [
  // "<Name> scores for <Team>[.<score>]" -- the engine's own fallback shape.
  new RegExp(`${NAME_GROUP}\\s+scores\\s+for\\b`, 'u'),
  // "<Name> scores!" / "<Name> scores," etc. -- enriched lines that open
  // with (or otherwise contain) the scorer's name directly before "scores".
  new RegExp(`${NAME_GROUP}\\s+scores\\b`, 'u'),
  // "<Name> finds the goal" -- enriched alternate phrasing.
  new RegExp(`${NAME_GROUP}\\s+finds\\s+the\\s+goal\\b`, 'u'),
];

/**
 * Parses a scorer's display name from goal commentary text. Tries each
 * pattern in `GOAL_SCORER_PATTERNS` in turn against the full text (not just
 * an anchored prefix), since enriched lines can lead with a team-reaction
 * clause before naming the scorer (e.g. "Argentina have it! Enzo Fernandez
 * finds the goal, and we are level at 1-1!"). Returns undefined (never
 * throws, never guesses) when no pattern matches, e.g. `"Goal for <Team>."`
 * (the no-scorer fallback) or free-form text that never names a scorer --
 * callers must treat a missing name as a valid, expected outcome per the
 * spec ("graceful when parsing fails").
 */
export function parseGoalScorerName(commentary: string | undefined): string | undefined {
  if (!commentary) return undefined;
  const trimmed = commentary.trim();
  for (const pattern of GOAL_SCORER_PATTERNS) {
    const match = pattern.exec(trimmed);
    const name = match?.[1]?.trim();
    if (name) return name;
  }
  return undefined;
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
