import { useRouter } from 'expo-router';

import { HomeScreen } from '../src/screens/gamecrew-screens';

export default function HomeRoute() {
  const router = useRouter();

  return (
    <HomeScreen
      onOpenMatch={(match) =>
        router.push({
          pathname: '/matches/[fixtureId]',
          params: { fixtureId: match.txline.fixtureId },
        })
      }
    />
  );
}
