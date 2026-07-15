import { useEffect, useRef, useState } from 'react';

import { BroadcastBoard, MEXICO_GLOW } from './board';
import { AndroidGlyph, TeamFlag, useReducedMotion } from './ui';

type Beat = {
  key: string;
  from: number;
  label: string;
  minute: string;
  clock: string;
  title: string;
  copy: string;
  meta: string;
};

const BEATS: readonly Beat[] = [
  {
    key: 'possession',
    from: 0.12,
    label: 'Possession',
    minute: "67'",
    clock: '67:08 · In possession',
    title: 'Settled possession',
    copy: 'Mexico build patiently from the back, drawing Ecuador toward the ball to open space behind the press.',
    meta: 'Mexico · Building',
  },
  {
    key: 'pressure',
    from: 0.4,
    label: 'Pressure',
    minute: "67'",
    clock: '67:16 · Pressure building',
    title: 'The space tightens',
    copy: 'Ecuador narrow the centre and force the move wide. The pressure pushes into the attacking third.',
    meta: 'Ecuador · Defensive pressure',
  },
  {
    key: 'breakthrough',
    from: 0.6,
    label: 'Breakthrough',
    minute: "67'",
    clock: '67:29 · Opening forming',
    title: 'The lane opens',
    copy: 'A quick switch pulls the block across. One pass now separates Mexico from the penalty area.',
    meta: 'Mexico · Breakthrough',
  },
  {
    key: 'goal',
    from: 0.8,
    label: 'Goal',
    minute: "67'",
    clock: '67:33 · Goal confirmed',
    title: 'Goal — Mexico',
    copy: 'The move reaches its finish. The score changes only when the moment is confirmed.',
    meta: 'Mexico 2 — 0 Ecuador',
  },
  {
    key: 'settle',
    from: 0.9,
    label: 'Full story',
    minute: "68'",
    clock: '68:00 · Story saved',
    title: 'One shared match truth',
    copy: 'Match Pulse tells the story in words. Game View shows the pressure. Both read from the same confirmed events.',
    meta: 'GameCrew',
  },
];

const GOAL_INDEX = 3;

/** Piecewise value track: eased interpolation between [progress, value] stops. */
type Stop = readonly [number, number];

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function ramp(p: number, stops: readonly Stop[]): number {
  if (p <= stops[0][0]) return stops[0][1];
  for (let index = 1; index < stops.length; index += 1) {
    const [x1, v1] = stops[index];
    if (p <= x1) {
      const [x0, v0] = stops[index - 1];
      return v0 + (v1 - v0) * easeInOut((p - x0) / (x1 - x0));
    }
  }
  return stops[stops.length - 1][1];
}

// The camera and the glow move on arcs, not straight lines: the glow drifts
// laterally while it advances up the zones, and the camera kicks back out on
// the goal impact before settling.
const GLOW_Y: readonly Stop[] = [[0, 0.72], [0.18, 0.66], [0.38, 0.6], [0.52, 0.44], [0.66, 0.3], [0.78, 0.2], [0.815, 0.16], [0.845, 0.075], [0.92, 0.09], [1, 0.42]];
const GLOW_X: readonly Stop[] = [[0, 0], [0.3, -7], [0.5, 8], [0.66, -6], [0.78, -2], [0.845, 4], [1, 0]];
const GLOW_SCALE: readonly Stop[] = [[0, 0.85], [0.3, 1], [0.6, 1.12], [0.78, 1.32], [0.815, 1.5], [0.845, 2.05], [0.9, 1.15], [1, 0.85]];
const GLOW_OPACITY: readonly Stop[] = [[0, 0.55], [0.12, 0.92], [0.8, 1], [0.92, 0.9], [1, 0.6]];
const CAM_SCALE: readonly Stop[] = [[0, 0.97], [0.12, 1], [0.38, 1.08], [0.56, 1.18], [0.78, 1.32], [0.815, 1.38], [0.85, 1.16], [0.92, 1.06], [1, 1]];
const TITLE_OPACITY: readonly Stop[] = [[0, 1], [0.08, 1], [0.14, 0]];
const TITLE_Y: readonly Stop[] = [[0, 0], [0.14, -48]];
const HINT_OPACITY: readonly Stop[] = [[0, 1], [0.07, 0]];
const FLASH: readonly Stop[] = [[0.8, 0], [0.825, 0], [0.838, 0.85], [0.868, 0]];
const BOARD_DIM: readonly Stop[] = [[0, 0.55], [0.13, 1]];

function activeBeatIndex(p: number): number {
  let index = -1;
  for (let i = 0; i < BEATS.length; i += 1) {
    if (p >= BEATS[i].from) index = i;
  }
  return index;
}

export function MatchStage() {
  const reduced = useReducedMotion();
  return reduced ? <ReducedStage /> : <ScrollStage />;
}

function ScrollStage() {
  const trackRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastBeat = useRef(-2);
  const [beat, setBeat] = useState(-1);

  useEffect(() => {
    let raf = 0;

    // Dev hook: ?p=0.65 freezes the stage at that scroll progress so any
    // individual frame of the sequence can be inspected without scrolling.
    const pinned = new URLSearchParams(window.location.search).get('p');

    const update = () => {
      raf = 0;
      const track = trackRef.current;
      const stage = stageRef.current;
      if (!track || !stage) return;

      const rect = track.getBoundingClientRect();
      const scrub = rect.height - window.innerHeight;
      const p = pinned !== null
        ? Math.min(1, Math.max(0, Number(pinned) || 0))
        : Math.min(1, Math.max(0, scrub > 0 ? -rect.top / scrub : 0));

      const glowY = ramp(p, GLOW_Y);
      const camScale = ramp(p, CAM_SCALE);
      const follow = Math.min(1, Math.max(0, (camScale - 1) / 0.38));

      const vars: Record<string, number> = {
        '--cam-s': camScale,
        '--cam-x': -ramp(p, GLOW_X) * 0.4 * follow,
        '--cam-y': (0.5 - glowY) * 46 * follow,
        '--glow-y': glowY,
        '--glow-x': ramp(p, GLOW_X),
        '--glow-scale': ramp(p, GLOW_SCALE),
        '--glow-opacity': ramp(p, GLOW_OPACITY),
        '--title-o': ramp(p, TITLE_OPACITY),
        '--title-y': ramp(p, TITLE_Y),
        '--hint-o': ramp(p, HINT_OPACITY),
        '--flash': ramp(p, FLASH),
        '--board-dim': ramp(p, BOARD_DIM),
        '--progress': p,
      };
      for (const [name, value] of Object.entries(vars)) {
        stage.style.setProperty(name, String(value));
      }

      const index = activeBeatIndex(p);
      if (index !== lastBeat.current) {
        lastBeat.current = index;
        setBeat(index);
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const jumpTo = (from: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const scrub = rect.height - window.innerHeight;
    window.scrollTo({ top: window.scrollY + rect.top + from * scrub + 2, behavior: 'smooth' });
  };

  const scored = beat >= GOAL_INDEX;
  const clock = beat >= 0 ? BEATS[beat].clock : '67:05 · Live';

  return (
    <section className="act" ref={trackRef} aria-label="Scroll to play a match sequence" id="top">
      <div className="stage" ref={stageRef} data-beat={beat}>
        <p className="stage-wordmark">GameCrew</p>
        <div className="stage-camera">
          <BroadcastBoard glowColor={MEXICO_GLOW} teamName="Mexico" />
        </div>
        <div className="stage-vignette" aria-hidden="true" />
        <div className="stage-dim" aria-hidden="true" />
        <div className="stage-flash" aria-hidden="true" />

        <header className={`stage-title${beat >= 0 ? ' stage-title-gone' : ''}`}>
          <p className="eyebrow">The Android match companion</p>
          <h1>
            <span>See the match</span>
            <span>taking shape.</span>
          </h1>
          <p className="stage-intro">
            GameCrew turns live match events into a clear story — the pressure, the turning points, the momentum. Not just the score.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#get-gamecrew">
              <AndroidGlyph /> Get GameCrew for Android
            </a>
          </div>
        </header>

        <div className={`stage-hud${scored ? ' is-goal' : ''}`}>
          <span className="hud-team">
            <TeamFlag team="mexico" />
            <strong>MEX</strong>
          </span>
          <span className="hud-score" aria-live="off">
            <strong className="hud-score-home">{scored ? 2 : 1}</strong>
            <i>—</i>
            <strong>0</strong>
          </span>
          <span className="hud-team hud-team-away">
            <strong>ECU</strong>
            <TeamFlag team="ecuador" />
          </span>
          <span className="hud-clock">{clock}</span>
        </div>

        <div className="stage-caption" aria-live="polite" aria-atomic="true">
          {BEATS.map((entry, index) => (
            <article key={entry.key} className={`cap${index === beat ? ' cap-active' : ''}`}>
              <span className="cap-minute">{entry.minute}</span>
              <div>
                <p className="cap-kicker">Match Pulse</p>
                <h2>{entry.title}</h2>
                <p className="cap-copy">{entry.copy}</p>
                <p className="cap-meta">{entry.meta}</p>
              </div>
            </article>
          ))}
        </div>

        <p className="stage-hint" aria-hidden="true">
          Scroll to play the match
          <span className="hint-chevron" />
        </p>

        <nav className="stage-beats" aria-label="Match sequence moments">
          <span className="stage-progress" aria-hidden="true" />
          {BEATS.slice(0, 4).map((entry, index) => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={beat === index || (index === 3 && beat > 3)}
              onClick={() => jumpTo(entry.from + 0.02)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}

/**
 * Reduced-motion alternative: no pinning, no scrub. The hero, a static board
 * held at the danger phase, and the sequence written out as plain cards.
 */
function ReducedStage() {
  return (
    <section className="act-reduced page-width" aria-label="A match sequence, step by step" id="top">
      <p className="reduced-wordmark">GameCrew</p>
      <header className="reduced-hero">
        <p className="eyebrow">The Android match companion</p>
        <h1>
          <span>See the match</span>
          <span>taking shape.</span>
        </h1>
        <p className="stage-intro">
          GameCrew turns live match events into a clear story — the pressure, the turning points, the momentum. Not just the score.
        </p>
        <div className="hero-actions">
          <a className="button button-primary" href="#get-gamecrew">
            <AndroidGlyph /> Get GameCrew for Android
          </a>
        </div>
      </header>
      <div className="reduced-body">
        <div className="mini-board">
          <BroadcastBoard
            glowColor={MEXICO_GLOW}
            teamName="Mexico"
            style={{ '--glow-y': 0.24, '--glow-x': 4, '--glow-scale': 1.1 } as React.CSSProperties}
          />
        </div>
        <div className="reduced-beats">
          {BEATS.slice(0, 4).map((entry) => (
            <article key={entry.key} className="reduced-beat">
              <span className="cap-minute">{entry.minute}</span>
              <div>
                <h2>{entry.title}</h2>
                <p className="cap-copy">{entry.copy}</p>
                <p className="cap-meta">{entry.meta}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
