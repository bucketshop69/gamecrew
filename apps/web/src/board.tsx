import type { CSSProperties } from 'react';

/**
 * Glow colors are brighter variants of the flag colors so the possession
 * presence stays legible against the near-black turf. The shell itself stays
 * black and white — the match brings the color.
 */
export const MEXICO_GLOW = '#2fbf7a';
export const ECUADOR_GLOW = '#f0cb28';

const LED_REPEAT = Array.from({ length: 12 }, (_, index) => index);
const TURF_STRIPES = Array.from({ length: 12 }, (_, index) => index % 2);

const ZONE_BANDS = [
  { label: 'High danger', weight: 0.8 },
  { label: 'Danger', weight: 1.2 },
  { label: 'Attack', weight: 1.6 },
  { label: 'Midfield', weight: 2 },
  { label: 'Build-up', weight: 1.2 },
] as const;

/**
 * Web recreation of the app's Game View board: black turf with mowing
 * stripes, chalk line work, LED perimeter boards and a team-colored
 * possession glow. Mirrors the app's honesty rule — the glow marks a zone of
 * pressure, never player positions.
 *
 * Position/intensity of the glow is driven by CSS custom properties
 * (--glow-y, --glow-x, --glow-scale, --glow-opacity) so a scroll director can
 * animate it without re-rendering, and static usages can pin values inline.
 */
export function BroadcastBoard({
  bottomGoal = 'Mexico goal',
  glowColor = MEXICO_GLOW,
  held = false,
  label,
  style,
  teamName = 'Mexico',
  topGoal = 'Ecuador goal',
}: {
  bottomGoal?: string;
  glowColor?: string;
  held?: boolean;
  label?: string;
  style?: CSSProperties;
  teamName?: string;
  topGoal?: string;
}) {
  return (
    <div
      className="board"
      style={style}
      role="img"
      aria-label={label ?? `Game View board — ${teamName} possession pressure shown as a zone glow`}
    >
      <div className="board-led board-led-top" aria-hidden="true">
        <div className="board-led-track">
          {LED_REPEAT.map((index) => (
            <span key={index}>GAMECREW</span>
          ))}
        </div>
      </div>
      <div className="board-led board-led-bottom" aria-hidden="true">
        <div className="board-led-track">
          {LED_REPEAT.map((index) => (
            <span key={index}>GAMECREW</span>
          ))}
        </div>
      </div>
      <div className="board-rail board-rail-left" aria-hidden="true" />
      <div className="board-rail board-rail-right" aria-hidden="true" />

      <div className="board-pitch">
        <div className="board-turf" aria-hidden="true">
          {TURF_STRIPES.map((stripe, index) => (
            <span key={index} className={stripe ? 'turf-alt' : undefined} />
          ))}
        </div>

        <div className="board-apron" aria-hidden="true">
          <div className="board-boundary" />
          <div className="board-halfway" />
          <div className="board-center-circle" />
          <div className="board-center-dot" />

          <div className="board-box board-box-top board-box-penalty" />
          <div className="board-box board-box-top board-box-six" />
          <div className="board-spot board-spot-top" />
          <div className="board-d board-d-top" />
          <div className="board-goalmouth board-goalmouth-top" />

          <div className="board-box board-box-bottom board-box-penalty" />
          <div className="board-box board-box-bottom board-box-six" />
          <div className="board-spot board-spot-bottom" />
          <div className="board-d board-d-bottom" />
          <div className="board-goalmouth board-goalmouth-bottom" />

          <div className="board-corner board-corner-tl" />
          <div className="board-corner board-corner-tr" />
          <div className="board-corner board-corner-bl" />
          <div className="board-corner board-corner-br" />

          <div className="board-zones">
            {ZONE_BANDS.map((band) => (
              <div key={band.label} className="board-zone" style={{ flex: band.weight }}>
                <span>{band.label}</span>
              </div>
            ))}
          </div>

          <p className="board-goal-label board-goal-top">{topGoal}</p>
          <p className="board-goal-label board-goal-bottom">{bottomGoal}</p>
        </div>

        <div
          className={`board-glow${held ? ' board-glow-held' : ''}`}
          style={{ '--glow-color': glowColor } as CSSProperties}
          aria-hidden="true"
        >
          <span className="glow-outer" />
          <span className="glow-inner" />
          <span className="glow-core" />
          <span className="glow-team">{teamName}</span>
        </div>
      </div>
    </div>
  );
}
