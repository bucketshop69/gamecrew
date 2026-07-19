import type { CSSProperties } from 'react';

/**
 * Web recreation of the Game View 2.5D board, matching the app's taste-review
 * prototype (docs/prototypes/game-view-2.5d-mock.html): perspective-tilted
 * floodlit turf, parallax stands, three-sided LED ecosystem wall, thin
 * stickmen in two-tone kits with depth scaling, color-coded goal mouths.
 *
 * Everything staged — positions are honest theater, not data. The stage
 * director owns choreography; this component just renders a formation frame.
 * Pressure chrome (crowd, LED dim, danger glow, tilt) rides on CSS vars:
 * --crowd, --led-dim, --danger, --tilt.
 */

export interface Kit {
  /** CSS background value for shirts — a color or a stripe gradient. */
  shirt: string;
  shorts: string;
  gk: string;
}

export interface Figure {
  x: number;
  y: number;
  team: 'home' | 'away';
  gk?: boolean;
  run?: boolean;
  dim?: boolean;
  lean?: number;
}

export const ENGLAND_KIT: Kit = {
  shirt: '#F2F5F1',
  shorts: '#1B2A57',
  gk: '#E8C51B',
};

export const ARGENTINA_KIT: Kit = {
  shirt: 'repeating-linear-gradient(90deg, #7EC8E8 0 1.2px, #F4F7F4 1.2px 2.4px)',
  shorts: '#15171A',
  gk: '#2FA36B',
};

export const ENGLAND_COLOR = '#F2F5F1';
export const ARGENTINA_COLOR = '#7EC8E8';

const LED_TEXT = 'GAMECREW · SOLANA · JUPITER · PHOENIX · METEORA · $ANSEM · ';
const LED_REPEAT = LED_TEXT.repeat(4);

function Stickman({ figure, kit }: { figure: Figure; kit: Kit }) {
  const scale = 0.82 + (figure.y / 100) * 0.34;
  const style = {
    left: `${figure.x}%`,
    top: `${figure.y}%`,
    transform: `translate(-50%, -88%) scale(${scale.toFixed(3)})`,
    '--shirt-bg': figure.gk ? kit.gk : kit.shirt,
    '--shorts-bg': figure.gk ? '#111312' : kit.shorts,
    '--lean': `${figure.lean ?? (figure.team === 'home' ? -6 : 6)}deg`,
  } as CSSProperties;
  return (
    <div className={`pl${figure.dim ? ' pl-dim' : ''}${figure.run ? ' pl-run' : ''}`} style={style}>
      <span className="pl-sh" />
      <div className="pl-fig">
        <i className="pl-hd" />
        <i className="pl-to" />
        <i className="pl-ar pl-ar-l" />
        <i className="pl-ar pl-ar-r" />
        <i className="pl-lg pl-lg-l" />
        <i className="pl-lg pl-lg-r" />
      </div>
    </div>
  );
}

export function Stadium({
  ball,
  bottomGoalColor,
  figures,
  homeKit,
  awayKit,
  style,
  topGoalColor,
}: {
  ball: readonly [number, number];
  bottomGoalColor: string;
  figures: readonly Figure[];
  homeKit: Kit;
  awayKit: Kit;
  style?: CSSProperties;
  topGoalColor: string;
}) {
  return (
    <div className="stadium" style={style} role="img" aria-label="Game View board: staged match illustration, not player tracking">
      <div className="stands" aria-hidden="true" />
      <div className="flood flood-l" aria-hidden="true" />
      <div className="flood flood-r" aria-hidden="true" />

      <div className="led led-top" aria-hidden="true"><div className="led-track">{LED_REPEAT}</div></div>
      <div className="led led-left" aria-hidden="true"><div className="led-track led-track-v">{LED_REPEAT}</div></div>
      <div className="led led-right" aria-hidden="true"><div className="led-track led-track-v">{LED_REPEAT}</div></div>

      <div className="pitch-tilt">
        <div className="pitch">
          <div className="danger-glow" aria-hidden="true" />
          <div className="chalk-lines" aria-hidden="true" />
          <div className="chalk-half" aria-hidden="true" />
          <div className="chalk-circle" aria-hidden="true" />
          <div className="chalk-box chalk-box-top" aria-hidden="true" />
          <div className="chalk-box chalk-box-bot" aria-hidden="true" />
          <div className="chalk-six chalk-six-top" aria-hidden="true" />
          <div className="chalk-six chalk-six-bot" aria-hidden="true" />
          <div className="chalk-spot" style={{ top: '32%' }} aria-hidden="true" />
          <div className="chalk-spot" style={{ top: '50%' }} aria-hidden="true" />
          <div className="chalk-spot" style={{ top: '66%' }} aria-hidden="true" />
          <div
            className="goal-mouth goal-mouth-top"
            style={{ '--goal-color': topGoalColor } as CSSProperties}
            aria-hidden="true"
          />
          <div
            className="goal-mouth goal-mouth-bot"
            style={{ '--goal-color': bottomGoalColor } as CSSProperties}
            aria-hidden="true"
          />

          {figures.map((figure, index) => (
            <Stickman key={index} figure={figure} kit={figure.team === 'home' ? homeKit : awayKit} />
          ))}

          <div className="pitch-ball" style={{ left: `${ball[0]}%`, top: `${ball[1]}%` }} aria-hidden="true"><i /></div>
        </div>
      </div>
    </div>
  );
}
