import type { GameViewScene } from '@gamecrew/core';

import { CardTakeover } from './card-takeover';
import type { CardVariant, SetPieceVariant } from './game-view-takeover-logic';
import { resolveTakeoverComponentKind } from './game-view-takeover-logic';
import { GoalRetractedTakeover } from './goal-retracted-takeover';
import { GoalSequenceTakeover } from './goal-sequence-takeover';
import { MatchMomentBanner } from './match-moment-banner';
import { PhaseBreakTakeover } from './phase-break-takeover';
import { RestartCard } from './restart-card';
import { SetPieceVignette } from './set-piece-vignette';
import type { TakeoverBaseProps } from './takeover-shared';
import { VarTakeover } from './var-takeover';

export type { CardVariant, SetPieceVariant } from './game-view-takeover-logic';
export type { TakeoverBaseProps, TakeoverTeam } from './takeover-shared';
export { useReducedMotionPreference } from './takeover-shared';

/**
 * Dispatches a GameViewScene to the takeover component that renders it,
 * switching on `scene.kind` (via `resolveTakeoverComponentKind`, kept as a
 * pure, independently testable mapping -- see
 * game-view-takeover-logic.test.mjs's dispatcher mapping tests).
 *
 * Shared onComplete contract: every takeover calls `onComplete` exactly once
 * when it has finished playing (immediately for `reduceMotion`, after a
 * readable hold), so the playback layer can advance to the next scene
 * without knowing anything about a specific takeover's internal timing.
 *
 * `cardVariant`/`setPieceVariant` are optional passthroughs for the two
 * scene kinds whose distinguishing detail (yellow/red, corner/free
 * kick/throw-in/penalty) isn't carried on `GameViewScene` itself -- see
 * `resolveCardVariant`/`resolveSetPieceVariant`'s doc comments for why. Omit
 * them and the takeover renders its safe default (yellow card, free kick)
 * rather than guessing.
 *
 * Renders nothing (`null`) for scene kinds this work item doesn't own
 * (`ambient`, `shot`, `substitution`) -- those are the ambient board's
 * territory, not a takeover.
 */
export function GameViewTakeover({
  awayTeam,
  cardVariant,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
  setPieceVariant,
}: TakeoverBaseProps & {
  scene: GameViewScene;
  cardVariant?: CardVariant;
  setPieceVariant?: SetPieceVariant;
}) {
  const componentKind = resolveTakeoverComponentKind(scene.kind);

  switch (componentKind) {
    case 'goal_sequence':
      return (
        <GoalSequenceTakeover
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
        />
      );
    case 'card':
      return (
        <CardTakeover
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
          variant={cardVariant}
        />
      );
    case 'set_piece':
      return (
        <SetPieceVignette
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
          variant={setPieceVariant}
        />
      );
    case 'var_review':
      return (
        <VarTakeover
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
        />
      );
    case 'goal_retracted':
      return (
        <GoalRetractedTakeover
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
        />
      );
    case 'phase_break':
      return (
        <PhaseBreakTakeover
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
        />
      );
    case 'restart':
      return (
        <RestartCard
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
        />
      );
    case 'substitution':
    case 'injury':
    case 'additional_time':
      return (
        <MatchMomentBanner
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          onComplete={onComplete}
          reduceMotion={reduceMotion}
          scene={scene}
          variant={componentKind}
        />
      );
    case 'none':
    default:
      return null;
  }
}
