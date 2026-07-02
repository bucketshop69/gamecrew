import { useLocalSearchParams, useRouter } from 'expo-router';

import { useGameCrewMatches } from '../../src/hooks/use-gamecrew-matches';
import { MatchDetailScreen, MatchDetailStateScreen } from '../../src/screens/gamecrew-screens';

export default function MatchDetailRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ fixtureId?: string | string[] }>();
  const fixtureId = Array.isArray(params.fixtureId) ? params.fixtureId[0] : params.fixtureId;
  const { loadState, reload } = useGameCrewMatches();
  const match = fixtureId
    ? loadState.matches.find((candidate) => candidate.txline.fixtureId === fixtureId)
    : undefined;

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/');
  };

  if (match) {
    return <MatchDetailScreen match={match} onBack={goBack} />;
  }

  if (loadState.status === 'error') {
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
