import { useLocalSearchParams, useRouter } from 'expo-router';

import { useGameCrewMatches } from '../../src/hooks/use-gamecrew-matches';
import { resolveMatchDetail } from '../../src/screens/match-detail-route-state';
import { MatchDetailScreen, MatchDetailStateScreen } from '../../src/screens/gamecrew-screens';

export default function MatchDetailRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ fixtureId?: string | string[] }>();
  const fixtureId = Array.isArray(params.fixtureId) ? params.fixtureId[0] : params.fixtureId;
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
    return <MatchDetailScreen match={resolution.match} onBack={goBack} />;
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

  return (
    <MatchDetailStateScreen
      actionLabel="Refresh"
      body="Fetching the latest TxLINE match feed."
      onAction={reload}
      onBack={goBack}
      title="Loading match."
    />
  );
}
