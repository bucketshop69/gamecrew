import { type GameCrewMatch, gameCrewTokens } from '@gamecrew/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { usePlaybackEngine } from '../../state/use-playback-engine';
import { GameViewTakeover } from '../game-view-takeovers/game-view-takeover';
import { GameViewBoard } from './game-view-board';
import { GameViewStatePanel, GameViewStaleBanner } from './game-view-state-panel';
import {
  type GameViewPresentationState,
  isLiveMatchStatus,
  isTakeoverSceneKind,
  mapSourceActionToCardVariant,
  mapSourceActionToSetPieceVariant,
  resolveGameViewLoadState,
  selectPlaybackModeForMatchStatus,
} from './game-view-screen-logic';
import { DEFAULT_AWAY_COLOR, DEFAULT_HOME_COLOR, getTeamColor } from './game-view-team-colors';

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
  match,
  onPresentationChange,
}: {
  match: GameCrewMatch;
  onPresentationChange?: (state: GameViewPresentationState | null) => void;
}) {
  const reduceMotion = useReduceMotionPreference();
  const isLive = isLiveMatchStatus(match.status);
  const { snapshot, controls } = usePlaybackEngine(match.txline.fixtureId, isLive);

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
    if (desiredMode !== 'replay') return;
    if (startedReplayRef.current) return;
    if (snapshot.timeline.length === 0) return;
    startedReplayRef.current = true;
    controls.startReplay();
  }, [controls, desiredMode, snapshot.timeline.length]);

  const homeTeam = useMemo(
    () => ({
      name: match.homeTeam.name,
      color: getTeamColor(match.homeTeam.flag.bands, DEFAULT_HOME_COLOR),
      participant: 1 as const,
    }),
    [match.homeTeam.flag.bands, match.homeTeam.name],
  );

  const awayTeam = useMemo(
    () => ({
      name: match.awayTeam.name,
      color: getTeamColor(match.awayTeam.flag.bands, DEFAULT_AWAY_COLOR, homeTeam.color),
      participant: 2 as const,
    }),
    [homeTeam.color, match.awayTeam.flag.bands, match.awayTeam.name],
  );

  const currentScene = snapshot.currentScene;
  const hasScenes = snapshot.timeline.length > 0;
  const { status: loadStatus, isStale } = resolveGameViewLoadState(
    snapshot.sessionStatus,
    hasScenes,
  );

  useEffect(() => {
    if (!currentScene) {
      onPresentationChange?.(null);
      return;
    }
    onPresentationChange?.({
      clockLabel: formatClockLabel(currentScene.clockSeconds),
      phaseLabel: formatPhaseLabel(currentScene.phase, isLive),
      score: {
        home: currentScene.scoreAtMoment?.participant1 ?? 0,
        away: currentScene.scoreAtMoment?.participant2 ?? 0,
      },
    });
  }, [currentScene, isLive, onPresentationChange]);

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
    if (snapshot.timeline.length > 0) {
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

  const overlay = currentScene && isTakeoverSceneKind(currentScene.kind) ? (
    <GameViewTakeover
      awayTeam={awayTeam}
      cardVariant={mapSourceActionToCardVariant(currentScene.sourceAction)}
      homeTeam={homeTeam}
      reduceMotion={reduceMotion}
      scene={currentScene}
      setPieceVariant={mapSourceActionToSetPieceVariant(currentScene.sourceAction)}
    />
  ) : undefined;

  return (
    <View style={styles.root}>
      <GameViewBoard
        awayTeam={awayTeam}
        homeTeam={homeTeam}
        overlay={overlay}
        reduceMotion={reduceMotion}
        scene={currentScene ?? null}
      />
      {isStale ? <GameViewStaleBanner /> : null}
    </View>
  );
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
