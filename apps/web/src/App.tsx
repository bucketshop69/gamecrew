import { type CSSProperties, type FormEvent, useState } from 'react';

import { MatchStage } from './match-stage';
import { PlayfulAct } from './playful-act';
import { submitEarlyAccess } from './signup';
import {
  ARGENTINA_COLOR,
  ARGENTINA_KIT,
  ENGLAND_COLOR,
  ENGLAND_KIT,
  Stadium,
  type Figure,
} from './stadium';

const MINI_FIGURES: readonly Figure[] = [
  { x: 50, y: 7, team: 'home', gk: true },
  { x: 26, y: 17, team: 'home' }, { x: 44, y: 19, team: 'home' }, { x: 66, y: 18, team: 'home' },
  { x: 30, y: 36, team: 'home' }, { x: 62, y: 38, team: 'home' },
  { x: 78, y: 12, team: 'away', run: true }, { x: 56, y: 12, team: 'away', run: true },
  { x: 60, y: 24, team: 'away' }, { x: 40, y: 30, team: 'away' }, { x: 50, y: 44, team: 'away' },
];

function ThreeWays() {
  return (
    <section className="section section-rule page-width" id="product" aria-labelledby="product-title">
      <header className="section-heading">
        <p className="eyebrow">One match · One shared truth</p>
        <h2 id="product-title">Watch it. Hear it. Play it.</h2>
        <p>Three ways into the same confirmed match events: a board that stages the story, a voice that calls it, and a gang to live it with.</p>
      </header>
      <div className="ways">
        <article className="way">
          <p className="view-label">Watch · Game View</p>
          <h3>The pressure, staged like a broadcast.</h3>
          <p>Kitted figures, floodlit turf, the danger building end to end. Honest theater, never a player-tracking claim.</p>
          <div className="mini-stadium mini-stadium-card">
            <Stadium
              figures={MINI_FIGURES}
              ball={[48.5, 5]}
              homeKit={ENGLAND_KIT}
              awayKit={ARGENTINA_KIT}
              topGoalColor={ENGLAND_COLOR}
              bottomGoalColor={ARGENTINA_COLOR}
              style={{ '--danger': 0.55, '--crowd': 0.85, '--led-dim': 0.5 } as CSSProperties}
            />
          </div>
        </article>
        <article className="way">
          <p className="view-label">Hear · Match Pulse</p>
          <h3>Commentary that speaks.</h3>
          <p>Confirmed events become broadcast-grade lines, written for reading in Match Pulse and spoken by the broadcast voice in the app.</p>
          <div className="way-transcript">
            <div className="way-line"><span>57'</span><p>One touch splits the line, the finish is pure ice. 1-1!</p></div>
            <div className="way-line way-line-hot"><span>81'</span><p>Cut-back, side-footed home. The comeback is complete!</p></div>
            <div className="way-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          </div>
        </article>
        <article className="way">
          <p className="view-label">Play · With your gang</p>
          <h3>Gifts on the line, coolness on the table.</h3>
          <p>Catch the free drop, make your call, win playful gifts and coolness points. Never money, just bragging rights.</p>
          <div className="way-play">
            <span className="play-chip">🍌 Drop caught · 12 bananas</span>
            <span className="play-chip">🏎️ Comeback paid · Lambo gift</span>
            <span className="play-chip">😎 +340 coolness</span>
          </div>
        </article>
      </div>
    </section>
  );
}

function ReplayArchive() {
  const matches = [
    ['England', '#F2F5F1', '1 - 2', 'Argentina', '#7EC8E8', 'Semi-final 2 · Story saved'],
    ['France', '#2B4C9B', '2 - 1', 'Spain', '#C60B1E', 'Semi-final 1 · Story saved'],
    ['Mexico', '#137a4b', '2 - 0', 'Ecuador', '#f0cb28', 'Group stage · Story saved'],
  ] as const;
  return (
    <section className="section section-rule page-width" id="replay" aria-labelledby="replay-title">
      <div className="replay-grid">
        <div className="replay-copy">
          <p className="eyebrow">After full time</p>
          <h2 id="replay-title">The match story stays with you.</h2>
          <p>Return to completed matches, replay the turning points, and see exactly where the coolness was won.</p>
        </div>
        <div className="archive" aria-label="Example completed match archive">
          <div className="archive-header"><span>Recent matches</span><span>Replay ready</span></div>
          {matches.map(([home, homeColor, score, away, awayColor, note]) => (
            <div className="archive-match" key={`${home}-${away}`}>
              <span className="archive-team"><i style={{ background: homeColor }} />{home}</span>
              <strong>{score}</strong>
              <span className="archive-team archive-team-away">{away}<i style={{ background: awayColor }} /></span>
              <small>{note}</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DocsCallout() {
  return (
    <section className="section section-rule page-width docs-callout" aria-labelledby="docs-title">
      <p className="eyebrow">The docs</p>
      <h2 id="docs-title">Curious how it all works?</h2>
      <p>Game View, Match Pulse, calls, gifts, coolness: everything we're building, written down in one place.</p>
      <a className="button button-docs" href="https://gamecrew-docs.vercel.app" target="_blank" rel="noopener noreferrer">
        Read the docs <span aria-hidden="true">→</span>
      </a>
    </section>
  );
}

function AndroidCta() {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (form.elements.namedItem('email') as HTMLInputElement).value;
    const honeypot = (form.elements.namedItem('website') as HTMLInputElement).value;
    if (honeypot) {
      setMessage("You're in. We'll email you when GameCrew is ready.");
      return;
    }
    setSending(true);
    const result = await submitEarlyAccess(email);
    setSending(false);
    if (result === 'ok') {
      form.reset();
      setMessage("You're in. We'll email you when GameCrew is ready.");
    } else if (result === 'duplicate') {
      setMessage("You're already on the list. See you at kickoff.");
    } else {
      setMessage("Couldn't sign you up just now. Please try again in a moment.");
    }
  };
  return (
    <section className="cta-section page-width" id="get-gamecrew" aria-labelledby="cta-title">
      <div className="cta-team-line" aria-hidden="true"><span /><span /></div>
      <div className="cta-inner">
        <div className="cta-copy">
          <p className="eyebrow">Early access</p>
          <h2 id="cta-title">Your next match deserves more than a scoreline.</h2>
          <p>Be first to know when GameCrew is ready for your phone.</p>
        </div>
        <form className="signup-form" onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <div className="signup-row">
            <input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={sending} />
            <input className="signup-trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
            <button type="submit" disabled={sending}>{sending ? 'Joining…' : 'Join early access'}</button>
          </div>
          <small>Only launch news. Nothing else, ever.</small>
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
          <p className="statement">A score tells you what happened. <span>GameCrew lets you watch it, hear it, and play it with your gang.</span></p>
        </section>
        <PlayfulAct />
        <ThreeWays />
        <ReplayArchive />
        <DocsCallout />
        <AndroidCta />
      </main>
      <footer className="site-footer page-width">
        <div className="footer-brand">
          <strong>GameCrew</strong>
          <span>Football match intelligence · Illustrated from live match data, not player tracking · Gifts are playful, never money.</span>
        </div>
        <nav className="footer-links" aria-label="GameCrew links">
          <a href="https://x.com/bs_dev_" target="_blank" rel="noopener noreferrer">X</a>
          <a href="#">GitHub</a>
        </nav>
      </footer>
    </>
  );
}
