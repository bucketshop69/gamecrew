import { useLocalSearchParams, useRouter } from 'expo-router';

import { useGameCrewMatches } from '../../src/hooks/use-gamecrew-matches';
import { MatchDetailSkeleton } from '../../src/screens/match-detail-skeleton';
import { resolveMatchDetail } from '../../src/screens/match-detail-route-state';
import { MatchDetailScreen, MatchDetailStateScreen } from '../../src/screens/gamecrew-screens';

export default function MatchDetailRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ fixtureId?: string | string[]; tab?: string | string[] }>();
  const fixtureId = Array.isArray(params.fixtureId) ? params.fixtureId[0] : params.fixtureId;
  // Fix round item 4: `?tab=game` (set by the now-listening bar's navigate
  // handler, app/index.tsx's `openFixture`) opens directly on the Game View
  // tab instead of the default Match Pulse landing. Any other/absent value
  // falls back to MatchDetailScreen's own 'pulse' default.
  const tabParam = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const initialMode = tabParam === 'game' ? 'game' : undefined;
  const { loadState, reload } = useGameCrewMatches();
  const resolution = resolveMatchDetail(loadState, fixtureId);

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/');
  };

  if (resolution.status === 'ready') {
    return <MatchDetailScreen initialMode={initialMode} match={resolution.match} onBack={goBack} />;
  }

  if (resolution.status === 'error') {
    return (
      <MatchDetailStateScreen
        actionLabel="Retry"
        body="Refresh the TxLINE feed to find this fixture."
        eyebrow="TxLINE unavailable"
        onAction={reload}
        onBack={goBack}
        title="Could not load match."
      />
    );
  }

  if (resolution.status === 'not_found') {
    return (
      <MatchDetailStateScreen
        actionLabel="Refresh"
        body="This fixture is not available in GameCrew's saved matches."
        eyebrow="Match unavailable"
        onAction={reload}
        onBack={goBack}
        title="Match not found."
      />
    );
  }

  // Fix round item 1: the LOADING branch alone swaps the old text-y
  // "finding match" state message for a skeleton shaped like the real match
  // layout -- error/not_found above keep MatchDetailStateScreen unchanged.
  return <MatchDetailSkeleton />;
}
