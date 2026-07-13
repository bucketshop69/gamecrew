import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

type Beat = {
  key: 'possession' | 'pressure' | 'breakthrough' | 'goal';
  label: string;
  clock: string;
  title: string;
  copy: string;
  meta: string;
  phase: string;
  score: readonly [number, number];
  ball: readonly [number, number];
  zone: readonly [number, number, number, number];
  positions: readonly (readonly [number, number])[];
};

const beats: readonly Beat[] = [
  {
    key: 'possession',
    label: 'Possession',
    clock: '67:08 · In possession',
    title: 'Settled possession',
    copy: 'Mexico begin patiently, drawing Ecuador toward the ball before looking for space.',
    meta: 'Mexico · Building from the back',
    phase: 'Building',
    score: [1, 0],
    ball: [37, 58],
    zone: [42, 55, 0.28, 0.82],
    positions: [[12, 50], [25, 26], [26, 72], [39, 43], [43, 68], [55, 54], [54, 28], [60, 45], [64, 66], [74, 33], [78, 55], [86, 72]],
  },
  {
    key: 'pressure',
    label: 'Pressure',
    clock: '67:16 · Pressure building',
    title: 'The space is tightening',
    copy: 'Ecuador narrow the centre and force the move toward the right touchline.',
    meta: 'Ecuador · Defensive pressure',
    phase: 'Under pressure',
    score: [1, 0],
    ball: [52, 66],
    zone: [54, 64, 0.7, 1.02],
    positions: [[13, 50], [29, 28], [31, 73], [45, 45], [51, 69], [59, 58], [52, 31], [58, 49], [62, 66], [71, 36], [77, 56], [84, 72]],
  },
  {
    key: 'breakthrough',
    label: 'Breakthrough',
    clock: '67:29 · Opening forming',
    title: 'The final lane opens',
    copy: 'A quick switch pulls the block across and releases the runner beyond the pressure.',
    meta: 'Mexico · Breakthrough',
    phase: 'Breakthrough',
    score: [1, 0],
    ball: [70, 38],
    zone: [69, 39, 0.88, 1.08],
    positions: [[13, 50], [35, 25], [34, 73], [54, 52], [63, 66], [75, 31], [54, 29], [61, 48], [68, 62], [75, 45], [82, 56], [88, 70]],
  },
  {
    key: 'goal',
    label: 'Goal',
    clock: '67:33 · Goal confirmed',
    title: 'The move reaches its finish',
    copy: 'Mexico turn the opening into a goal. The score updates only when the moment is confirmed.',
    meta: 'Mexico · Goal',
    phase: 'Goal',
    score: [2, 0],
    ball: [94, 49],
    zone: [88, 49, 0.36, 1.28],
    positions: [[14, 50], [39, 27], [37, 73], [59, 54], [72, 66], [85, 38], [58, 28], [66, 49], [74, 61], [81, 45], [87, 57], [91, 72]],
  },
];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}

function AndroidGlyph() {
  return <span className="android-glyph" aria-hidden="true" />;
}

function TeamFlag({ team }: { team: 'mexico' | 'ecuador' }) {
  return (
    <span className={`flag flag-${team}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function Pitch({ beat }: { beat: Beat }) {
  const zoneStyle = {
    '--zone-x': `${beat.zone[0]}%`,
    '--zone-y': `${beat.zone[1]}%`,
    '--zone-opacity': beat.zone[2],
    '--zone-scale': beat.zone[3],
  } as CSSProperties;
  const ballStyle = {
    '--ball-x': beat.ball[0],
    '--ball-y': beat.ball[1],
  } as CSSProperties;

  return (
    <section className="pitch-wrap" aria-label="Game View tactical illustration">
      <div className="pitch-label">
        <span className="pitch-label-dot" />
        {beat.phase}
      </div>
      <div className="pitch" aria-hidden="true">
        <div className="pitch-boundary" />
        <div className="halfway" />
        <div className="center-circle" />
        <div className="penalty-box penalty-box-left" />
        <div className="penalty-box penalty-box-right" />
        <div className="goal-box goal-box-left" />
        <div className="goal-box goal-box-right" />
        <div className="pressure-zone" style={zoneStyle} />
        {beat.positions.map(([x, y], index) => (
          <span
            className={`player ${index < 6 ? 'player-home' : 'player-away'}`}
            key={index}
            style={{ '--x': x, '--y': y } as CSSProperties}
          />
        ))}
        <span className="ball" style={ballStyle} />
      </div>
      <div className="pitch-status">Tactical illustration · Not player-tracking footage</div>
    </section>
  );
}

function MatchDemo({ onReady }: { onReady?: (replay: () => void) => void }) {
  const reduceMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(reduceMotion ? 2 : 0);
  const timers = useRef<number[]>([]);
  const activeBeat = beats[activeIndex];

  const clearTimers = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
  }, []);

  const replay = useCallback(() => {
    clearTimers();
    if (reduceMotion) {
      setActiveIndex(2);
      return;
    }
    setActiveIndex(0);
    [1, 2, 3].forEach((beatIndex) => {
      timers.current.push(window.setTimeout(() => setActiveIndex(beatIndex), beatIndex * 2600));
    });
  }, [clearTimers, reduceMotion]);

  useEffect(() => {
    onReady?.(replay);
  }, [onReady, replay]);

  useEffect(() => {
    const starter = window.setTimeout(replay, 900);
    return () => {
      window.clearTimeout(starter);
      clearTimers();
    };
  }, [clearTimers, replay]);

  const selectBeat = (index: number) => {
    clearTimers();
    setActiveIndex(index);
  };

  return (
    <div className="match-demo" id="match-demo" data-beat={activeBeat.key}>
      <div className="match-color-line" aria-hidden="true"><span /><span /></div>
      <div className="demo-kicker">
        <span>Product demo · Match replay</span>
        <button className="replay-demo" type="button" onClick={replay}>Replay sequence</button>
      </div>

      <div className="score-rail">
        <div className="team team-home">
          <TeamFlag team="mexico" />
          <span className="team-copy"><strong>MEX</strong><small>Mexico</small></span>
        </div>
        <div className="score-center" aria-live="polite">
          <span className="score"><strong>{activeBeat.score[0]}</strong><i>—</i><strong>{activeBeat.score[1]}</strong></span>
          <span className="match-clock">{activeBeat.clock}</span>
        </div>
        <div className="team team-away">
          <span className="team-copy"><strong>ECU</strong><small>Ecuador</small></span>
          <TeamFlag team="ecuador" />
        </div>
      </div>

      <div className="demo-body">
        <section className="pulse-panel" aria-labelledby="pulse-title-label">
          <div className="panel-label">
            <span id="pulse-title-label">Match Pulse</span>
            <span className="story-view-label">Story view</span>
          </div>
          <div className="pulse-feed">
            <div className="pulse-item pulse-previous">
              <span className="pulse-minute">66'</span>
              <span><strong>Shape restored</strong><small>Mexico recover their structure after the restart.</small></span>
            </div>
            <div className="pulse-item pulse-current" aria-live="polite" aria-atomic="true">
              <span className="pulse-minute">67'</span>
              <span>
                <strong>{activeBeat.title}</strong>
                <small>{activeBeat.copy}</small>
                <em>{activeBeat.meta}</em>
              </span>
            </div>
          </div>
        </section>
        <Pitch beat={activeBeat} />
      </div>

      <div className="beat-controls">
        <span className="beat-progress" style={{ width: `${(activeIndex + 1) * 25}%` }} />
        <div className="beat-list" aria-label="Match sequence moments">
          {beats.map((beat, index) => (
            <button
              className="beat-button"
              type="button"
              aria-pressed={index === activeIndex}
              key={beat.key}
              onClick={() => selectBeat(index)}
            >
              {beat.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="site-header">
      <nav className="nav page-width" aria-label="Primary navigation">
        <a className="wordmark" href="#top">GameCrew</a>
        <div className="nav-links">
          <a href="#product">The app</a>
          <a href="#story">How it works</a>
          <a href="#replay">Match archive</a>
        </div>
        <a className="button button-primary button-compact nav-action" href="#get-gamecrew">
          <AndroidGlyph /> Android access
        </a>
      </nav>
    </header>
  );
}

function OneMatchTwoViews() {
  return (
    <section className="section section-rule page-width" id="product" aria-labelledby="product-title">
      <header className="section-heading">
        <p className="eyebrow">One match · One shared truth</p>
        <h2 id="product-title">Two ways to follow it.</h2>
        <p>Read the developing story in Match Pulse, then see the same pressure and progression take shape in Game View.</p>
      </header>
      <div className="shared-match">
        <div className="shared-rail"><strong>Mexico 1 — 0 Ecuador</strong><span>67:29 · Opening forming</span></div>
        <div className="view-pair">
          <article className="view">
            <p className="view-label">Match Pulse · Read the shift</p>
            <h3>The final pass is beginning to appear.</h3>
            <p>GameCrew turns confirmed match signals into concise commentary that explains the pressure and the turning point—not another wall of statistics.</p>
            <div className="pulse-quote">
              <span>67'</span>
              <div><strong>Mexico pull the block narrow, then find the runner beyond it.</strong><small>Mexico · Breakthrough</small></div>
            </div>
          </article>
          <article className="view">
            <p className="view-label">Game View · See the space</p>
            <h3>Pressure, progression and important moments—on one board.</h3>
            <p>Anonymous tactical markers show how the passage develops without claiming exact player-tracking coordinates.</p>
            <div className="tactical-diagram" aria-label="Illustrative tactical diagram">
              <span className="diagram-run" />
              {[[29, 61, 'home'], [43, 48, 'home'], [61, 38, 'home'], [70, 64, 'home'], [56, 52, 'away'], [66, 45, 'away'], [78, 54, 'away']].map(([x, y, side], index) => (
                <span className={`diagram-dot ${side}`} key={index} style={{ left: `${x}%`, top: `${y}%` }} />
              ))}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function MatchStory() {
  const moments = [
    ['67:08', 'Possession', 'The team settles on the ball. Match Pulse establishes who has control; Game View shows the shape before it changes.'],
    ['67:16', 'Pressure', 'Space tightens around the ball. The commentary explains the shift while the tactical view makes the pressure visible.'],
    ['67:29', 'Breakthrough', 'A lane opens and the story changes instantly. You see the turning point without digging through a statistics screen.'],
    ['67:33', 'Goal', 'The score changes only after the moment is confirmed. Both views stay tied to the same match truth.'],
  ] as const;
  return (
    <section className="section section-rule page-width" id="story" aria-labelledby="story-title">
      <div className="story-grid">
        <header className="story-intro">
          <p className="eyebrow">A match, moment by moment</p>
          <h2 id="story-title">Follow the change, not the noise.</h2>
          <p>GameCrew keeps the important movement of the match in one readable story while you watch.</p>
        </header>
        <div className="story-list">
          {moments.map(([time, title, copy]) => (
            <article className="story-step" key={title}>
              <time>{time}</time>
              <div><h3>{title}</h3><p>{copy}</p></div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReplayArchive() {
  const matches = [
    ['Mexico', '#137a4b', '2 — 0', 'Ecuador', '#f0cb28'],
    ['Argentina', '#74acdf', '1 — 1', 'Portugal', '#d52b1e'],
    ['England', '#ffffff', '3 — 2', 'Brazil', '#009b3a'],
  ] as const;
  return (
    <section className="section section-rule page-width" id="replay" aria-labelledby="replay-title">
      <div className="replay-grid">
        <div className="replay-copy">
          <p className="eyebrow">After full time</p>
          <h2 id="replay-title">The match story stays with you.</h2>
          <p>Return to completed matches, revisit the turning points and see how the final score took shape.</p>
        </div>
        <div className="archive" aria-label="Example completed match archive">
          <div className="archive-header"><span>Recent matches</span><span>Replay ready</span></div>
          {matches.map(([home, homeColor, score, away, awayColor]) => (
            <div className="archive-match" key={`${home}-${away}`}>
              <span className="archive-team"><i style={{ background: homeColor }} />{home}</span>
              <strong>{score}</strong>
              <span className="archive-team archive-team-away">{away}<i style={{ background: awayColor }} /></span>
              <small>Full time · Match story saved</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AndroidCta() {
  const [message, setMessage] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage('Thanks—this preview keeps your email on this device only.');
  };
  return (
    <section className="cta-section page-width" id="get-gamecrew" aria-labelledby="cta-title">
      <div className="cta-team-line" aria-hidden="true"><span /><span /></div>
      <div className="cta-inner">
        <div className="cta-copy">
          <p className="eyebrow">Android early access</p>
          <h2 id="cta-title">Your next match deserves more than a scoreline.</h2>
          <p>Be first to know when GameCrew is ready for your Android phone.</p>
        </div>
        <form className="signup-form" onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <div className="signup-row">
            <input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
            <button type="submit">Join Android access</button>
          </div>
          <small>Preview signup only—this site does not send or store your details.</small>
          <p role="status" aria-live="polite">{message}</p>
        </form>
      </div>
    </section>
  );
}

export function App() {
  const replayRef = useRef<() => void>(() => undefined);
  const registerReplay = useCallback((replay: () => void) => {
    replayRef.current = replay;
  }, []);
  const watchMatch = () => {
    document.getElementById('match-demo')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    replayRef.current();
  };

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      <main id="main">
        <section className="hero page-width" id="top" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">The Android match companion</p>
            <h1 id="hero-title"><span>See the match</span><span>taking shape.</span></h1>
            <p className="hero-intro">GameCrew turns football match events into a clear live story—so you can follow the <strong>pressure, turning points and momentum</strong>, not just the score.</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#get-gamecrew"><AndroidGlyph /> Get GameCrew for Android</a>
              <button className="button button-secondary" type="button" onClick={watchMatch}>Watch a match unfold</button>
            </div>
            <p className="hero-note">Android first · Live fixtures and completed-match stories</p>
          </div>
          <MatchDemo onReady={registerReplay} />
        </section>

        <section className="section section-rule page-width" aria-label="GameCrew value proposition">
          <p className="statement">A score tells you what happened. <span>GameCrew helps you understand how the match is changing.</span></p>
        </section>
        <OneMatchTwoViews />
        <MatchStory />
        <ReplayArchive />
        <AndroidCta />
      </main>
      <footer className="site-footer page-width"><strong>GameCrew</strong><span>Android-first football match intelligence · Game View uses illustrative positioning, not player tracking.</span></footer>
    </>
  );
}
