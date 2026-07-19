import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://gamecrew-docs.vercel.app',
  integrations: [
    starlight({
      title: 'GameCrew',
      favicon: '/favicon.svg',
      description:
        'Pick a match. Follow the pulse. Watch the play. Bet your Lambo (playfully).',
      customCss: ['./src/styles/theme.css'],
      expressiveCode: {
        themes: ['github-dark'],
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/bucketshop69/gamecrew',
        },
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'What is GameCrew', slug: 'start-here/what-is-gamecrew' },
            { label: 'Try it', slug: 'start-here/try-it' },
          ],
        },
        {
          label: 'The Journey',
          items: [
            { label: 'Home Screen — pick a match', slug: 'journey/home-screen' },
            { label: 'Game View — watch the play', slug: 'journey/game-view' },
            { label: 'Match Pulse — follow the story', slug: 'journey/match-pulse' },
            { label: 'Global Chat — the crowd', slug: 'journey/global-chat' },
            { label: 'Playful Economy — bet your Lambo', slug: 'journey/playful-economy' },
          ],
        },
        {
          label: 'How it works',
          items: [
            { label: 'From TxLINE to your phone', slug: 'how-it-works/pipeline' },
            { label: 'The Solana Layer', slug: 'how-it-works/solana-layer' },
          ],
        },
      ],
    }),
  ],
});
