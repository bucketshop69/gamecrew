import {
  type GameCrewMatch,
  type GameViewScene,
  gameCrewTokens,
  type MatchEngineScore,
  type MatchPulseCommentaryEntry,
} from '@gamecrew/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import type { PlaybackSnapshot } from '../../state/playback-engine';
import type { PlaybackEngineControls } from '../../state/use-playback-engine';
import { findNearestPriorStageableScene } from '../game-view-players/cluster-choreography-logic';
import {
  activeGoalSequenceBeatIndex,
  planGoalSequenceBeats,
} from '../game-view-takeovers/game-view-takeover-logic';
import { GameViewTakeover } from '../game-view-takeovers/game-view-takeover';
import { MinorSetPieceBadge } from '../game-view-takeovers/minor-set-piece-badge';
import { GameViewBoard } from './game-view-board';
import {
  isGameViewCommentaryProjectionCompatible,
  selectVisibleGameViewCommentary,
} from './game-view-commentary-logic';
import { GameViewCommentaryOverlay } from './game-view-commentary-overlay';
import { useGameViewSoundPreference } from './game-view-sound-preference';
import { GameViewSoundToggle } from './game-view-sound-toggle';
import { GameViewStatePanel, GameViewStaleBanner } from './game-view-state-panel';
import {
  type GameViewPresentationState,
  isLiveMatchStatus,
  isTakeoverSceneKind,
  mapSourceActionToCardVariant,
  mapSourceActionToSetPieceVariant,
  resolveGameViewLoadState,
  resolveMatchParticipants,
  resolvePresentationScene,
  resolveScoreRailScore,
  selectPlaybackModeForMatchStatus,
  shouldSetPieceUseFullVignette,
} from './game-view-screen-logic';
import { resolveGameViewTeamKits } from './game-view-team-kits';
import { useGameViewSoundscape } from './use-game-view-soundscape';

export type { GameViewPresentationState } from './game-view-screen-logic';

const tokens = gameCrewTokens;

/**
 * Composes the real Game View renderer (work item B4 of
 * docs/issues/game-view-board-and-presentation.md): `usePlaybackEngine` for
 * data + pacing, `GameViewBoard` for the ambient layer, and
 * `GameViewTakeover` in the board's overlay slot for moment scenes. Replaces
 * the scripted `MatchPreviewScreen` demo in the product path (see
 * gamecrew-screens.tsx's `MatchDetailScreen`).
 *
 * Mode selection: finished/upcoming/hosted fixtures replay from the start
 * (the PRD's judging/demo path); live fixtures track the live head. See
 * `selectPlaybackModeForMatchStatus` in game-view-screen-logic.ts.
 *
 * Playhead-advancement ownership: `PlaybackEngine` alone advances the
 * playhead (its own replay timer, or live-buffer recompute on new frames --
 * see that module's header comment). Takeover `onComplete` callbacks are
 * intentionally left unset here; see
 * `shouldTakeoverOnCompleteAdvancePlayback`'s doc comment in
 * game-view-screen-logic.ts for the full reasoning.
 */
export function GameViewScreen({
  commentaryEntries,
  commentaryProjectionGeneration,
  match,
  onPresentationChange,
  playback,
}: {
  commentaryEntries?: readonly MatchPulseCommentaryEntry[];
  commentaryProjectionGeneration?: number;
  match: GameCrewMatch;
  onPresentationChange?: (state: GameViewPresentationState | null) => void;
  playback: { controls: PlaybackEngineControls; snapshot: PlaybackSnapshot };
}) {
  const reduceMotion = useReduceMotionPreference();
  const [soundEnabled, setSoundEnabled] = useGameViewSoundPreference();
  const isLive = isLiveMatchStatus(match.status);
  const { snapshot, controls } = playback;

  const desiredMode = selectPlaybackModeForMatchStatus(match.status);
  const startedReplayRef = useRef(false);

  // Reset the "have we kicked off replay yet" guard whenever the fixture
  // itself changes (tab remount reuses the same session, but a genuinely
  // different fixture should replay from its own start).
  useEffect(() => {
    startedReplayRef.current = false;
  }, [match.txline.fixtureId]);

  // Kick a finished/upcoming/hosted fixture into replay once its timeline has
  // scenes to play; live fixtures stay on the engine's default live mode.
  // Guarded so this only fires once per fixture, not on every snapshot
  // update (startReplay() restarts the timeline from scene 0 if called
  // again).
  useEffect(() => {
    if (desiredMode !== 'replay') {
      // A fixture can genuinely travel upcoming -> live -> finished without
      // this screen remounting. Re-arm replay while it is live so the final
      // status transition can start the newly compressed replay timeline.
      startedReplayRef.current = false;
      return;
    }
    if (startedReplayRef.current) return;
    // A shared checkpoint selected from Match Pulse may already have put the
    // engine into replay before Game View mounts. Preserve that chosen moment
    // rather than restarting from kickoff.
    if (snapshot.mode === 'replay') {
      startedReplayRef.current = true;
      return;
    }
    // Paginated backfill can expose a partial timeline while the session is
    // still loading. Starting here would replay that prefix and miss the
    // eventual full-match compression; wait for loading to settle instead.
    if (snapshot.sessionStatus === 'loading') return;
    if (snapshot.timeline.length === 0) return;
    startedReplayRef.current = true;
    controls.startReplay();
  }, [
    controls,
    desiredMode,
    snapshot.mode,
    snapshot.sessionStatus,
    snapshot.timeline.length,
  ]);

  const participants = useMemo(
    () => resolveMatchParticipants(match.txline.participant1IsHome),
    [match.txline.participant1IsHome],
  );
  const teamKits = useMemo(
    () => resolveGameViewTeamKits(
      { ...match.homeTeam, flagBands: match.homeTeam.flag.bands },
      { ...match.awayTeam, flagBands: match.awayTeam.flag.bands },
    ),
    [match.awayTeam, match.homeTeam],
  );
  const homeTeam = useMemo(
    () => ({
      name: match.homeTeam.name,
      color: teamKits.home.outfield.shirt,
      participant: participants.home,
      kit: teamKits.home,
    }),
    [match.homeTeam.name, participants.home, teamKits.home],
  );

  const awayTeam = useMemo(
    () => ({
      name: match.awayTeam.name,
      color: teamKits.away.outfield.shirt,
      participant: participants.away,
      kit: teamKits.away,
    }),
    [match.awayTeam.name, participants.away, teamKits.away],
  );

  const currentScene = snapshot.currentScene;
  const sceneWindow = snapshot.activeSceneWindow;
  const presentationScene = useMemo(
    () => resolvePresentationScene(currentScene, sceneWindow) ?? undefined,
    [currentScene, sceneWindow],
  );
  const bootstrapScene = useMemo(
    () => findNearestPriorStageableScene(
      snapshot.timeline,
      presentationScene,
      homeTeam,
      awayTeam,
    ),
    [awayTeam, homeTeam, presentationScene, snapshot.timeline],
  );
  const hasScenes = snapshot.timeline.length > 0;
  const { status: loadStatus, isStale } = resolveGameViewLoadState(
    snapshot.sessionStatus,
    hasScenes,
  );

  // Fix #3 (no score spoiler): tracks which goal_sequence beat is currently
  // active so `resolveScoreRailScore` can hold the pre-goal score through
  // the tension beat and commit only once celebration starts. See
  // `useGoalSequenceScoreHold`'s doc comment.
  const { activeBeatIndex, previousScoreRef } = useGoalSequenceScoreHold(
    presentationScene,
    reduceMotion,
    sceneWindow?.instanceKey,
  );

  // R4: the board's action cluster celebrates on the pitch during the
  // checking (tension) beat and yields to the confirmation takeover once the
  // celebration beat starts -- same beat clock the score hold above uses.
  const activeGoalBeat = presentationScene?.kind === 'goal_sequence' && presentationScene.beats?.length
    ? presentationScene.beats[Math.min(activeBeatIndex, presentationScene.beats.length - 1)]
    : undefined;
  const goalBeat = activeGoalBeat?.kind;

  const soundscape = useGameViewSoundscape({
    enabled: soundEnabled,
    goalBeat,
    isStale,
    scene: presentationScene,
    sceneWindowKey: sceneWindow?.instanceKey,
  });

  const handleSoundToggle = () => {
    if (soundEnabled) {
      soundscape.deactivate();
      setSoundEnabled(false);
      return;
    }
    // Called directly inside the press gesture so browsers are allowed to
    // open their audio context; the state-driven sound plan takes over after.
    soundscape.activateFromGesture();
    setSoundEnabled(true);
  };

  const visibleCommentary = useMemo(
    () => selectVisibleGameViewCommentary(
      isGameViewCommentaryProjectionCompatible(
        commentaryProjectionGeneration,
        snapshot.projectionGeneration,
      ) ? commentaryEntries ?? [] : [],
      snapshot.timeline,
      snapshot.playheadIndex,
      activeGoalBeat,
    ),
    [
      activeGoalBeat,
      commentaryEntries,
      commentaryProjectionGeneration,
      snapshot.playheadIndex,
      snapshot.projectionGeneration,
      snapshot.timeline,
    ],
  );

  useEffect(() => {
    if (!currentScene) {
      onPresentationChange?.(null);
      return;
    }
    const railScore = resolveScoreRailScore(currentScene, previousScoreRef.current, activeBeatIndex);
    if (railScore) previousScoreRef.current = railScore;

    onPresentationChange?.({
      clockLabel: formatClockLabel(currentScene.clockSeconds),
      phaseLabel: formatPhaseLabel(currentScene.phase, isLive),
      score: {
        home: participants.home === 1 ? railScore?.participant1 ?? 0 : railScore?.participant2 ?? 0,
        away: participants.away === 1 ? railScore?.participant1 ?? 0 : railScore?.participant2 ?? 0,
      },
    });
  }, [activeBeatIndex, currentScene, isLive, onPresentationChange, participants, previousScoreRef]);

  useEffect(() => () => onPresentationChange?.(null), [onPresentationChange]);

  const handleRetry = () => {
    // The session already retries polling on its own cadence; a manual
    // retry re-enters live/replay mode so a fixture stuck on 'error' with no
    // frames yet gets an immediate nudge rather than waiting for the next
    // scheduled poll. For replay, clear the "already started" guard and, if
    // the timeline already has scenes (e.g. an error arrived after a
    // successful backfill), kick replay off immediately rather than relying
    // on the mode-selection effect to notice -- resetting the ref alone
    // doesn't re-run that effect since its dependencies haven't changed.
    if (desiredMode === 'live') {
      controls.play();
      return;
    }
    startedReplayRef.current = false;
    if (snapshot.sessionStatus !== 'loading' && snapshot.timeline.length > 0) {
      startedReplayRef.current = true;
      controls.startReplay();
    }
  };

  if (loadStatus !== 'ready') {
    return (
      <View style={styles.root}>
        <GameViewStatePanel onRetry={handleRetry} status={loadStatus} />
      </View>
    );
  }

  // Fix #2: a minor set piece (throw-in, free kick) renders as a compact
  // badge over the still-visible ambient board instead of the full-screen
  // SetPieceVignette that corner/penalty use -- see
  // `shouldSetPieceUseFullVignette`'s doc comment. The scene still occupies
  // its full playback window either way; only the visual treatment differs.
  const isMinorSetPiece = presentationScene?.kind === 'set_piece'
    && !shouldSetPieceUseFullVignette(presentationScene.sourceAction);

  const overlay = presentationScene && isMinorSetPiece ? (
    <MinorSetPieceBadge
      key={sceneWindow?.instanceKey ?? presentationScene.id}
      awayTeam={awayTeam}
      homeTeam={homeTeam}
      reduceMotion={reduceMotion}
      scene={presentationScene}
      variant={mapSourceActionToSetPieceVariant(presentationScene.sourceAction)}
    />
  ) : presentationScene && isTakeoverSceneKind(presentationScene.kind) ? (
    <GameViewTakeover
      key={sceneWindow?.instanceKey ?? presentationScene.id}
      awayTeam={awayTeam}
      cardVariant={mapSourceActionToCardVariant(presentationScene.sourceAction)}
      homeTeam={homeTeam}
      reduceMotion={reduceMotion}
      scene={presentationScene}
      setPieceVariant={mapSourceActionToSetPieceVariant(presentationScene.sourceAction)}
    />
  ) : undefined;

  return (
    <View style={styles.root}>
      <GameViewBoard
        awayTeam={awayTeam}
        bootstrapScene={bootstrapScene}
        commentaryOverlay={visibleCommentary.length > 0
          ? <GameViewCommentaryOverlay entries={visibleCommentary} />
          : undefined}
        goalBeat={goalBeat}
        homeTeam={homeTeam}
        overlay={overlay}
        reduceMotion={reduceMotion}
        scene={presentationScene ?? null}
        sceneWindowKey={sceneWindow?.instanceKey}
        soundControl={(
          <GameViewSoundToggle
            enabled={soundEnabled}
            onPress={handleSoundToggle}
          />
        )}
      />
      {isStale ? <GameViewStaleBanner /> : null}
    </View>
  );
}

/**
 * Fix #3 (no score spoiler): tracks which beat of the *current* scene, if
 * it's a `goal_sequence`, is active -- so `resolveScoreRailScore` can hold
 * the header's score at `previousScoreRef.current` through the tension beat
 * and only advance it once the celebration beat actually starts, instead of
 * reading the scene's (already post-goal) `scoreAtMoment` the instant the
 * takeover mounts.
 *
 * Schedules its own timers from `planGoalSequenceBeats` (the same pure plan
 * `GoalSequenceTakeover` uses to choreograph its beat content) rather than
 * reaching into that component's internal state, keeping the score-rail
 * decision independent of whichever takeover component happens to render
 * the scene. `previousScoreRef` is exposed (not just read) so the caller can
 * update it once a score has actually been shown, without this hook needing
 * to know what "the score to show" resolves to for non-goal_sequence scenes.
 *
 * Under reduce-motion, `GoalSequenceTakeover` renders only the final
 * (most-informative) beat statically -- see `ReducedMotionGoalSequence` in
 * goal-sequence-takeover.tsx -- so there is no tension beat shown to hold
 * against; this hook mirrors that by jumping straight to the last beat
 * instead of scheduling per-beat timers.
 */
function useGoalSequenceScoreHold(
  scene: GameViewScene | undefined,
  reduceMotion: boolean,
  sceneWindowKey: string | undefined,
) {
  const [activeBeatIndex, setActiveBeatIndex] = useState(0);
  const previousScoreRef = useRef<MatchEngineScore | undefined>(undefined);

  useEffect(() => {
    if (!scene || scene.kind !== 'goal_sequence') {
      setActiveBeatIndex(0);
      return;
    }

    const plan = planGoalSequenceBeats(scene);

    if (reduceMotion) {
      setActiveBeatIndex(plan.length > 0 ? plan.length - 1 : 0);
      return;
    }

    setActiveBeatIndex(activeGoalSequenceBeatIndex(plan, 0));

    const timers = plan
      .map((entry) => {
        if (entry.offsetMs === 0) return undefined;
        return setTimeout(() => setActiveBeatIndex(entry.index), entry.offsetMs);
      })
      .filter((handle): handle is ReturnType<typeof setTimeout> => handle !== undefined);

    return () => {
      timers.forEach(clearTimeout);
    };
    // The playback engine can replace one logical goal scene in place when
    // a provisional goal becomes confirmed. Its scene id stays stable, but
    // the active-window instance changes; keying on that instance restarts
    // the beat clock and keeps the score rail synchronized with the freshly
    // mounted takeover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, scene?.id, scene?.kind, sceneWindowKey]);

  return { activeBeatIndex, previousScoreRef };
}

function formatClockLabel(clockSeconds: number | undefined): string {
  if (clockSeconds === undefined) return '--:--';
  const totalSeconds = Math.max(0, Math.floor(clockSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPhaseLabel(phase: string | undefined, isLive: boolean): string {
  if (!phase) return isLive ? 'Live' : 'Replay';
  const label = phase.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  return isLive ? `Live · ${label}` : label;
}

/**
 * Same detection pattern used across the app (gamecrew-screens.tsx's
 * useReducedMotionPreference, takeover-shared.tsx's
 * useReducedMotionPreference): defaults to true (motion-safe) until the OS
 * setting resolves, then tracks live changes. Not deduplicated into a shared
 * hook module in this change -- see PR notes -- to avoid touching those two
 * existing call sites' import graphs as a side effect of this work item.
 */
function useReduceMotionPreference(): boolean {
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: tokens.shell.background,
    flex: 1,
  },
});
