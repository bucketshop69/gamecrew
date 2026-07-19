import { useEffect, useState } from 'react';

export function useReducedMotion(): boolean {
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


export function TeamFlag({ team }: { team: 'england' | 'argentina' }) {
  return (
    <span className={`flag flag-${team}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
