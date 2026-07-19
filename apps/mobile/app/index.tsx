import { useRouter } from 'expo-router';

import { HomeScreen, type MatchDetailMode } from '../src/screens/gamecrew-screens';

export default function HomeRoute() {
  const router = useRouter();

  // Fix round item 4: an optional tab hint travels as a `?tab=` route param,
  // read back by app/matches/[fixtureId].tsx and passed as MatchDetailScreen's
  // `initialMode` -- lets the now-listening bar land directly on Game View
  // while every other entry path (omitting `tab`) keeps the default 'pulse'
  // landing.
  const openFixture = (fixtureId: string, tab?: MatchDetailMode) =>
    router.push({
      pathname: '/matches/[fixtureId]',
      params: tab ? { fixtureId, tab } : { fixtureId },
    });

  return (
    <HomeScreen
      onOpenFixture={openFixture}
      onOpenMatch={(match) => openFixture(match.txline.fixtureId)}
    />
  );
}
