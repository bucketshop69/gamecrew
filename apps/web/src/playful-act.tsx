import { useEffect, useRef } from 'react';

/**
 * Act two: the playful economy, told as a continuation of the semi-final the
 * visitor just scrolled through. Free drop → stake the gift → the comeback
 * pays → coolness and bragging. Deliberately no wallet/NFT vocabulary — the
 * words that carry this are drop, gift, coolness, gang.
 */

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const targets = node.querySelectorAll('.reveal');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal-in');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.35 },
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);
  return ref;
}

const BANANAS = Array.from({ length: 7 }, (_, index) => index);

export function PlayfulAct() {
  const revealRef = useReveal();

  return (
    <section className="play-act" aria-labelledby="play-title">
      <div className="page-width" ref={revealRef}>
        <header className="section-heading reveal">
          <p className="eyebrow">The same match · Played with your gang</p>
          <h2 id="play-title">You weren't just watching that comeback.</h2>
          <p>Every big match on GameCrew comes with a free drop, a call to make, and coolness on the line. Gifts, never money.</p>
        </header>

        <div className="play-steps">
          <article className="play-card reveal">
            <div className="play-banana-rain" aria-hidden="true">
              {BANANAS.map((index) => (
                <span key={index} style={{ left: `${8 + index * 13}%`, animationDelay: `${index * 0.35}s` }}>🍌</span>
              ))}
            </div>
            <p className="play-step-label">Six hours before kickoff</p>
            <h3>Gifts rained on everyone who showed up early.</h3>
            <p className="play-copy">Open the match, catch the drop. Today it was bananas. Free, every time. You never buy in.</p>
            <div className="play-chip">🍌 You caught 12 bananas</div>
          </article>

          <article className="play-card reveal">
            <p className="play-step-label">23' · England 1-0 up</p>
            <h3>Then the question dropped.</h3>
            <p className="play-copy">Streamer rules: one call, gifts on the line, no takebacks. You believed in the comeback.</p>
            <div className="play-call">
              <p className="play-call-q">Who wins it from here?</p>
              <div className="play-call-options">
                <span>England</span>
                <span>Draw</span>
                <span className="play-call-picked">Argentina ✓</span>
              </div>
              <p className="play-call-stake">Staked: 12 🍌 · locked at 23:58</p>
            </div>
          </article>

          <article className="play-card play-card-win reveal">
            <p className="play-step-label">Full-time · Argentina 2-1</p>
            <h3>The comeback paid.</h3>
            <p className="play-copy">Your bananas came home as the gift-pool jackpot. Tonight, that meant the big one.</p>
            <div className="play-lambo" aria-hidden="true">
              <span className="play-lambo-car">🏎️</span>
              <span className="play-lambo-shine" />
            </div>
            <div className="play-chip play-chip-win">LAMBO GIFT UNLOCKED · +340 coolness</div>
            <p className="play-fineprint">Playful gifts and bragging rights. Never cash, never a purchase.</p>
          </article>

          <article className="play-card reveal">
            <p className="play-step-label">After the match</p>
            <h3>Now go brag about it.</h3>
            <p className="play-copy">Coolness is the only currency that matters here, and your gang can see the table.</p>
            <div className="play-board">
              <div className="play-board-row play-board-you">
                <span className="play-rank">👑</span><span className="play-name">You</span><span className="play-pts">2,140 cool</span>
              </div>
              <div className="play-board-row">
                <span className="play-rank">2</span><span className="play-name">Ravi</span><span className="play-pts">1,870 cool</span>
              </div>
              <div className="play-board-row">
                <span className="play-rank">3</span><span className="play-name">Momo</span><span className="play-pts">1,420 cool</span>
              </div>
              <div className="play-board-chat">
                <span className="bubble bubble-static">Ravi: no way you called ARG 😤</span>
                <span className="bubble bubble-static">You: coolness speaks for itself 😎🍌</span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
