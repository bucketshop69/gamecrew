import { useCallback, useEffect, useRef, useState } from 'react';

import { MatchSound } from './sound';
import {
  ARGENTINA_COLOR,
  ARGENTINA_KIT,
  ENGLAND_COLOR,
  ENGLAND_KIT,
  type Figure,
  Stadium,
} from './stadium';
import { TeamFlag, useReducedMotion } from './ui';

/* ------------------------------------------------------------------ */
/* Formation staging (honest theater — never player tracking)          */
/* y: 0 = top goal, 100 = bottom goal.                                 */
/* ------------------------------------------------------------------ */

type Spot = { x: number; y: number; gk?: boolean };

const ATTACK_UP: readonly Spot[] = [
  { x: 50, y: 92, gk: true },
  { x: 18, y: 76 }, { x: 38, y: 78 }, { x: 62, y: 78 }, { x: 82, y: 76 },
  { x: 30, y: 56 }, { x: 50, y: 60 }, { x: 70, y: 56 },
  { x: 24, y: 34 }, { x: 50, y: 28 }, { x: 76, y: 33 },
];

const DEFEND_TOP: readonly Spot[] = [
  { x: 50, y: 7, gk: true },
  { x: 20, y: 17 }, { x: 38, y: 19 }, { x: 62, y: 19 }, { x: 80, y: 17 },
  { x: 18, y: 34 }, { x: 38, y: 36 }, { x: 62, y: 36 }, { x: 82, y: 34 },
  { x: 40, y: 48 }, { x: 60, y: 48 },
];

type Override = { x: number; y: number; run?: boolean };

interface Beat {
  key: string;
  from: number;
  label: string;
  minute: string;
  clock: string;
  title: string;
  copy: string;
  meta: string;
  /** [England, Argentina] */
  score: readonly [number, number];
  /** Which side England plays this beat; Argentina gets the other shape. */
  englandShape: 'attackUp' | 'defendTop';
  /** Sparse overrides by absolute figure index (0-10 England, 11-21 Argentina). */
  moves?: Readonly<Record<number, Override>>;
  /** Indices kept bright; when present, everyone else dims. */
  engaged?: readonly number[];
  /** Compress the top-defending block toward its goal, 0..1. */
  squeeze?: number;
  /** Push the attacking block up-field by this many y-units. */
  push?: number;
  ball: readonly [number, number];
  chrome: { danger: number; crowd: number; led: number };
  intensity: number;
  goal?: number;
  swell?: boolean;
  whistle?: boolean;
  bubbles: readonly string[];
}

const BEATS: readonly Beat[] = [
  {
    key: 'build', from: 0.07, label: 'Build', minute: "23'", clock: '23:12 · First half',
    title: 'England come forward',
    copy: 'England slide it through midfield and start to climb toward the far end.',
    meta: 'England · Building', score: [0, 0], englandShape: 'attackUp',
    moves: { 6: { x: 55, y: 44, run: true }, 17: { x: 51, y: 41, run: true }, 18: { x: 60, y: 43 } },
    engaged: [6, 9, 10, 17, 18], push: 3,
    ball: [55.5, 42.3], chrome: { danger: 0.3, crowd: 0.65, led: 0.8 },
    intensity: 0.3,
    bubbles: ['semi-final babyyy', 'ENG look sharp ⚡'],
  },
  {
    key: 'goal-eng', from: 0.17, label: 'ENG 1-0', minute: "23'", clock: '23:41 · GOAL',
    title: 'GOAL! England',
    copy: 'The winger cuts in and buries it low at the near post. England lead the semi-final.',
    meta: 'England 1-0 Argentina', score: [1, 0], englandShape: 'attackUp',
    moves: { 10: { x: 74, y: 16, run: true }, 9: { x: 55, y: 19, run: true }, 6: { x: 57, y: 34 }, 11: { x: 55, y: 8 }, 13: { x: 58, y: 14 } },
    engaged: [6, 9, 10, 11, 13], push: 6, squeeze: 0.6,
    ball: [51, 5.5], chrome: { danger: 0.6, crowd: 0.95, led: 0.32 },
    intensity: 1, goal: 0.65,
    bubbles: ['ENGLAND 🔥🔥', '1-0!! called it'],
  },
  {
    key: 'halftime', from: 0.3, label: 'Half-time', minute: 'HT', clock: 'HALF-TIME · 1-0',
    title: 'Ends swap at the break',
    copy: 'England hold 1-0. Argentina attack this end now, and the comeback has a stage.',
    meta: 'World Cup · Semi-final 2', score: [1, 0], englandShape: 'defendTop',
    ball: [50, 50], chrome: { danger: 0.12, crowd: 0.5, led: 1 },
    intensity: 0.15,
    bubbles: ['my 🍌 still on ARG', 'trust the comeback'],
  },
  {
    key: 'pressure', from: 0.4, label: 'Pressure', minute: "57'", clock: '56:30 · Second half',
    title: 'Argentina turn the screw',
    copy: "Waves down the left; England's block drops deeper every time the ball comes back.",
    meta: 'Argentina · Pressure building', score: [1, 0], englandShape: 'defendTop',
    moves: { 17: { x: 46, y: 42, run: true }, 18: { x: 60, y: 44 }, 6: { x: 44, y: 38 }, 7: { x: 58, y: 40 } },
    engaged: [6, 7, 17, 18, 20], squeeze: 0.5, push: 4,
    ball: [46.5, 40.3], chrome: { danger: 0.55, crowd: 0.85, led: 0.4 },
    intensity: 0.5, swell: true,
    bubbles: ['here they come 🇦🇷', 'ENG boxed in 😬'],
  },
  {
    key: 'goal-arg1', from: 0.52, label: 'ARG 1-1', minute: "57'", clock: '57:04 · GOAL',
    title: 'GOAL! Argentina level it',
    copy: 'One touch splits the line and the finish is pure ice. 1-1, and the away end erupts.',
    meta: 'Argentina 1-1 England', score: [1, 1], englandShape: 'defendTop',
    moves: { 20: { x: 52, y: 15, run: true }, 17: { x: 48, y: 30 }, 0: { x: 46, y: 8 }, 2: { x: 44, y: 16 } },
    engaged: [0, 2, 17, 20], squeeze: 0.7, push: 6,
    ball: [49.5, 5.5], chrome: { danger: 0.7, crowd: 1, led: 0.3 },
    intensity: 1, goal: 0.85,
    bubbles: ['VAMOSSS 🇦🇷🇦🇷', 'bananas cooking 🍌📈'],
  },
  {
    key: 'waves', from: 0.64, label: 'Waves', minute: "80'", clock: '80:15 · Second half',
    title: 'England are hanging on',
    copy: 'Ten minutes left. Argentina camp in the England half; every clearance comes straight back.',
    meta: 'Argentina · Sustained pressure', score: [1, 1], englandShape: 'defendTop',
    moves: { 19: { x: 42, y: 34 }, 21: { x: 64, y: 33, run: true } },
    engaged: [19, 21, 6, 7], squeeze: 0.75, push: 8,
    ball: [58, 30], chrome: { danger: 0.75, crowd: 0.9, led: 0.35 },
    intensity: 0.65, swell: true,
    bubbles: ["can't watch 😭", 'one more wave…'],
  },
  {
    key: 'goal-arg2', from: 0.76, label: 'ARG 2-1', minute: "81'", clock: '81:22 · GOAL',
    title: 'GOAL! The comeback is complete',
    copy: 'Cut-back from the byline, side-footed home. 2-1 Argentina, and the semi-final has flipped.',
    meta: 'Argentina 2-1 England', score: [1, 2], englandShape: 'defendTop',
    moves: { 21: { x: 78, y: 12, run: true }, 20: { x: 56, y: 12, run: true }, 17: { x: 60, y: 24 }, 0: { x: 52, y: 7.5 }, 4: { x: 70, y: 12 } },
    engaged: [0, 4, 17, 20, 21], squeeze: 0.8, push: 9,
    ball: [48.5, 5], chrome: { danger: 0.85, crowd: 1, led: 0.28 },
    intensity: 1, goal: 1,
    bubbles: ['LAMBO INCOMING 🏎️🍌', 'coolness +340 😎'],
  },
  {
    key: 'settle', from: 0.9, label: 'Full-time', minute: 'FT', clock: 'FULL-TIME · 2-1',
    title: 'One shared match truth',
    copy: 'Argentina win it 2-1. Match Pulse told it, Game View showed it, the gang lived it. One story, saved.',
    meta: 'GameCrew', score: [1, 2], englandShape: 'defendTop',
    ball: [50, 46], chrome: { danger: 0.15, crowd: 0.6, led: 1 },
    intensity: 0.25, whistle: true,
    bubbles: ['what a comeback 🐐', 'story saved 📼'],
  },
];

const JUMPS = [1, 4, 6, 7].map((index) => BEATS[index]);

function buildFigures(beat: Beat): Figure[] {
  const englandShape = beat.englandShape === 'attackUp' ? ATTACK_UP : DEFEND_TOP;
  const argentinaShape = beat.englandShape === 'attackUp' ? DEFEND_TOP : ATTACK_UP;
  const attackingTeam: 'home' | 'away' = beat.englandShape === 'attackUp' ? 'home' : 'away';

  const spots: { spot: Spot; team: 'home' | 'away' }[] = [
    ...englandShape.map((spot) => ({ spot, team: 'home' as const })),
    ...argentinaShape.map((spot) => ({ spot, team: 'away' as const })),
  ];

  return spots.map(({ spot, team }, index) => {
    const move = beat.moves?.[index];
    let x = move?.x ?? spot.x;
    let y = move?.y ?? spot.y;
    if (!move && !spot.gk) {
      const attacking = team === attackingTeam;
      if (attacking && beat.push) y -= beat.push;
      if (!attacking && beat.squeeze) y = y * (1 - 0.22 * beat.squeeze) + 3 * beat.squeeze;
    }
    return {
      x,
      y,
      team,
      gk: spot.gk,
      run: move?.run,
      dim: beat.engaged ? !beat.engaged.includes(index) : false,
      lean: team === attackingTeam ? -6 : 6,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Scroll ramps                                                        */
/* ------------------------------------------------------------------ */

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

const CAM_S: readonly Stop[] = [[0, 0.97], [0.07, 1], [0.14, 1.06], [0.19, 1.2], [0.26, 1.1], [0.32, 1], [0.44, 1.1], [0.53, 1.26], [0.6, 1.12], [0.68, 1.18], [0.76, 1.34], [0.82, 1.55], [0.87, 1.2], [0.93, 1.05], [1, 1]];
const FOCUS_Y: readonly Stop[] = [[0, 0.5], [0.1, 0.4], [0.19, 0.24], [0.28, 0.4], [0.33, 0.5], [0.44, 0.36], [0.54, 0.22], [0.62, 0.34], [0.7, 0.3], [0.78, 0.2], [0.84, 0.16], [0.9, 0.4], [1, 0.48]];
const TILT: readonly Stop[] = [[0, 17], [0.74, 17], [0.8, 22.5], [0.85, 23], [0.9, 18.5], [1, 17]];
const FLASH: readonly Stop[] = [[0, 0], [0.175, 0], [0.187, 0.5], [0.215, 0], [0.52, 0], [0.532, 0.65], [0.565, 0], [0.757, 0], [0.77, 0.9], [0.81, 0]];
const TITLE_O: readonly Stop[] = [[0, 1], [0.05, 1], [0.1, 0]];
const TITLE_Y: readonly Stop[] = [[0, 0], [0.1, -48]];
const HINT_O: readonly Stop[] = [[0, 1], [0.05, 0]];
const BOARD_DIM: readonly Stop[] = [[0, 0.62], [0.09, 1]];

function activeBeatIndex(p: number): number {
  let index = -1;
  for (let i = 0; i < BEATS.length; i += 1) {
    if (p >= BEATS[i].from) index = i;
  }
  return index;
}

/* ------------------------------------------------------------------ */
/* Sound preference                                                    */
/* ------------------------------------------------------------------ */

const SOUND_PREF_KEY = 'gc-sound';

function readSoundPref(): boolean {
  try {
    return window.localStorage.getItem(SOUND_PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

function writeSoundPref(on: boolean) {
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode — fine */
  }
}

/* ------------------------------------------------------------------ */

export function MatchStage() {
  const reduced = useReducedMotion();
  return reduced ? <ReducedStage /> : <ScrollStage />;
}

function ScrollStage() {
  const trackRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastBeat = useRef(-2);
  const [beat, setBeat] = useState(-1);
  const soundRef = useRef<MatchSound | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  /* Scroll director: continuous camera vars + discrete beat state. */
  useEffect(() => {
    let raf = 0;
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

      const camScale = ramp(p, CAM_S);
      const focusY = ramp(p, FOCUS_Y);
      const follow = Math.min(1, Math.max(0, (camScale - 1) / 0.55));

      const vars: Record<string, number | string> = {
        '--cam-s': camScale,
        '--cam-y': (0.5 - focusY) * 40 * follow,
        '--tilt': `${ramp(p, TILT)}deg`,
        '--title-o': ramp(p, TITLE_O),
        '--title-y': ramp(p, TITLE_Y),
        '--hint-o': ramp(p, HINT_O),
        '--flash': ramp(p, FLASH),
        '--board-dim': ramp(p, BOARD_DIM),
        '--progress': p,
      };
      for (const [name, value] of Object.entries(vars)) {
        stage.style.setProperty(name, String(value));
      }

      const index = activeBeatIndex(p);
      if (index !== lastBeat.current) {
        const forward = index > lastBeat.current;
        lastBeat.current = index;
        setBeat(index);

        const sound = soundRef.current;
        const entry = index >= 0 ? BEATS[index] : null;
        if (sound && entry) {
          sound.setIntensity(entry.intensity);
          if (forward && entry.goal) sound.goal(entry.goal);
          if (forward && entry.swell) sound.swell();
          if (forward && entry.whistle) sound.whistle();
        } else if (sound) {
          sound.setIntensity(0.1);
        }
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

  /* If sound was on last visit, arm it on the first tap anywhere. */
  useEffect(() => {
    if (!readSoundPref()) return;
    const arm = () => {
      if (!soundRef.current) {
        soundRef.current = new MatchSound();
        const index = lastBeat.current;
        soundRef.current.setIntensity(index >= 0 ? BEATS[index].intensity : 0.1);
        setSoundOn(true);
      }
    };
    window.addEventListener('pointerdown', arm, { once: true });
    return () => window.removeEventListener('pointerdown', arm);
  }, []);

  useEffect(() => () => soundRef.current?.dispose(), []);

  const toggleSound = useCallback(() => {
    if (!soundRef.current) {
      soundRef.current = new MatchSound();
      const index = lastBeat.current;
      soundRef.current.setIntensity(index >= 0 ? BEATS[index].intensity : 0.1);
      setSoundOn(true);
      writeSoundPref(true);
      return;
    }
    setSoundOn((on) => {
      soundRef.current?.setMuted(on);
      writeSoundPref(!on);
      return !on;
    });
  }, []);

  const jumpTo = (from: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const scrub = rect.height - window.innerHeight;
    window.scrollTo({ top: window.scrollY + rect.top + (from + 0.02) * scrub, behavior: 'smooth' });
  };

  const entry = beat >= 0 ? BEATS[beat] : null;
  const score = entry?.score ?? [0, 0];
  const clock = entry?.clock ?? '22:40 · First half';
  const chrome = entry?.chrome ?? { danger: 0.12, crowd: 0.55, led: 1 };
  const figures = buildFigures(entry ?? BEATS[0]);
  const goalBeat = entry?.goal !== undefined;
  const topGoalColor = (entry?.englandShape ?? 'attackUp') === 'attackUp' ? ARGENTINA_COLOR : ENGLAND_COLOR;
  const bottomGoalColor = (entry?.englandShape ?? 'attackUp') === 'attackUp' ? ENGLAND_COLOR : ARGENTINA_COLOR;

  return (
    <section className="act" ref={trackRef} aria-label="Scroll to play the semi-final" id="top">
      <div
        className="stage"
        ref={stageRef}
        data-beat={beat}
        style={{
          '--crowd': chrome.crowd,
          '--led-dim': chrome.led,
          '--danger': chrome.danger,
        } as React.CSSProperties}
      >
        <p className="stage-wordmark">GameCrew</p>

        <div className="stage-camera">
          <Stadium
            figures={figures}
            ball={entry?.ball ?? [50, 50]}
            homeKit={ENGLAND_KIT}
            awayKit={ARGENTINA_KIT}
            topGoalColor={topGoalColor}
            bottomGoalColor={bottomGoalColor}
          />
        </div>
        <div className="stage-vignette" aria-hidden="true" />
        <div className="stage-dim" aria-hidden="true" />
        <div className="stage-flash" aria-hidden="true" />

        <header className={`stage-title${beat >= 0 ? ' stage-title-gone' : ''}`}>
          <p className="eyebrow">The football match companion</p>
          <h1>
            <span>See the match</span>
            <span>taking shape.</span>
          </h1>
          <p className="stage-intro">
            Live football, told the GameCrew way. The pressure, the turning points, the comeback. Scroll and the match plays.
          </p>
          <div className="hero-actions">
            <a className="button button-primary button-store" href="#get-gamecrew">
              <span className="store-cta">Get GameCrew</span>
              <img className="store-lockup" src="/Wordmark_Lockup_Logo_Black.png" alt="Seeker, Solana Mobile" />
            </a>
          </div>
        </header>

        <div className={`stage-hud${goalBeat ? ' is-goal' : ''}`}>
          <p className="hud-comp">World Cup · Semi-final 2 <span className="hud-live" /></p>
          <div className="hud-row">
            <span className="hud-team">
              <TeamFlag team="england" />
              <strong>ENG</strong>
            </span>
            <span className="hud-score" aria-live="off">
              <strong key={`h${score[0]}`} className="hud-score-cell">{score[0]}</strong>
              <i>-</i>
              <strong key={`a${score[1]}`} className="hud-score-cell">{score[1]}</strong>
            </span>
            <span className="hud-team hud-team-away">
              <strong>ARG</strong>
              <TeamFlag team="argentina" />
            </span>
          </div>
          <span className="hud-clock">{clock}</span>
        </div>

        <button
          type="button"
          className={`sound-pill${soundOn ? ' sound-pill-on' : ''}`}
          onClick={toggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? 'Mute stadium sound' : 'Turn stadium sound on'}
        >
          <span className="sound-pill-icon" aria-hidden="true" />
          {soundOn ? 'Sound on' : 'Sound off'}
        </button>

        <div className="stage-bubbles" aria-hidden="true" key={beat}>
          {(entry?.bubbles ?? []).map((line, index) => (
            <span className="bubble" style={{ animationDelay: `${0.25 + index * 0.5}s` }} key={index}>
              {line}
            </span>
          ))}
        </div>

        <div className="stage-caption" aria-live="polite" aria-atomic="true">
          {BEATS.map((item, index) => (
            <article key={item.key} className={`cap${index === beat ? ' cap-active' : ''}`}>
              <span className="cap-minute">{item.minute}</span>
              <div>
                <p className="cap-kicker">Match Pulse</p>
                <h2>{item.title}</h2>
                <p className="cap-copy">{item.copy}</p>
                <p className="cap-meta">{item.meta}</p>
              </div>
            </article>
          ))}
        </div>

        <p className="stage-hint" aria-hidden="true">
          Scroll to play the match
          <span className="hint-chevron" />
        </p>

        <nav className="stage-beats" aria-label="Match moments">
          <span className="stage-progress" aria-hidden="true" />
          {JUMPS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={entry?.key === item.key}
              onClick={() => jumpTo(item.from)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}

/**
 * Reduced-motion alternative: no pinning, no scrub, no sound. The hero, the
 * winner-goal frame as a still, and the story written out as cards.
 */
function ReducedStage() {
  const winner = BEATS[6];
  return (
    <section className="act-reduced page-width" aria-label="The semi-final, step by step" id="top">
      <p className="reduced-wordmark">GameCrew</p>
      <header className="reduced-hero">
        <p className="eyebrow">The football match companion</p>
        <h1>
          <span>See the match</span>
          <span>taking shape.</span>
        </h1>
        <p className="stage-intro">
          Live football, told the GameCrew way. The pressure, the turning points, the comeback.
        </p>
        <div className="hero-actions">
          <a className="button button-primary button-store" href="#get-gamecrew">
            <span className="store-cta">Get GameCrew</span>
            <img className="store-lockup" src="/Wordmark_Lockup_Logo_Black.png" alt="Seeker, Solana Mobile" />
          </a>
        </div>
      </header>
      <div className="reduced-body">
        <div className="mini-stadium">
          <Stadium
            figures={buildFigures(winner)}
            ball={winner.ball}
            homeKit={ENGLAND_KIT}
            awayKit={ARGENTINA_KIT}
            topGoalColor={ENGLAND_COLOR}
            bottomGoalColor={ARGENTINA_COLOR}
            style={{ '--danger': 0.6, '--crowd': 0.9, '--led-dim': 0.5 } as React.CSSProperties}
          />
        </div>
        <div className="reduced-beats">
          {[BEATS[1], BEATS[4], BEATS[5], BEATS[6], BEATS[7]].map((item) => (
            <article key={item.key} className="reduced-beat">
              <span className="cap-minute">{item.minute}</span>
              <div>
                <h2>{item.title}</h2>
                <p className="cap-copy">{item.copy}</p>
                <p className="cap-meta">{item.meta}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
