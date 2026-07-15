import { type CSSProperties, type FormEvent, useState } from 'react';

import { BroadcastBoard, MEXICO_GLOW } from './board';
import { MatchStage } from './match-stage';

function OneMatchTwoViews() {
  return (
    <section className="section section-rule page-width" id="product" aria-labelledby="product-title">
      <header className="section-heading">
        <p className="eyebrow">One match · One shared truth</p>
        <h2 id="product-title">Two ways to follow it.</h2>
        <p>Read the developing story in Match Pulse, then see the same pressure take shape on the Game View board.</p>
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
            <p className="view-label">Game View · See the pressure</p>
            <h3>Where the danger is building—on one board.</h3>
            <p>A team-colored presence marks the zone under pressure. Honest by design: it never claims exact player positions.</p>
            <div className="mini-board">
              <BroadcastBoard
                glowColor={MEXICO_GLOW}
                teamName="Mexico"
                style={{ '--glow-y': 0.28, '--glow-x': -5, '--glow-scale': 1.05 } as CSSProperties}
              />
            </div>
          </article>
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
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <main id="main">
        <MatchStage />
        <section className="section section-rule page-width" aria-label="GameCrew value proposition">
          <p className="statement">A score tells you what happened. <span>GameCrew helps you understand how the match is changing.</span></p>
        </section>
        <OneMatchTwoViews />
        <ReplayArchive />
        <AndroidCta />
      </main>
      <footer className="site-footer page-width"><strong>GameCrew</strong><span>Android-first football match intelligence · Game View shows zones of pressure, not player tracking.</span></footer>
    </>
  );
}
