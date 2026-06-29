export const gameCrewTokens = {
  shell: {
    background: '#050505',
    surface: '#0D0D0D',
    surfaceRaised: '#151515',
    text: '#F7F7F7',
    textMuted: '#A6A6A6',
    textDim: '#6E6E6E',
    divider: '#2A2A2A',
    inverseText: '#050505',
  },
  typography: {
    family: undefined,
    size: {
      caption: 12,
      body: 15,
      label: 13,
      title: 22,
      display: 42,
    },
    lineHeight: {
      caption: 16,
      body: 21,
      title: 28,
      display: 48,
    },
    weight: {
      regular: '400',
      medium: '600',
      bold: '800',
    },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  radii: {
    sm: 8,
    md: 14,
    lg: 24,
    pill: 999,
  },
  shadows: {
    matchGlow: '0 0 42px rgba(255, 255, 255, 0.14)',
    quietLift: '0 12px 32px rgba(0, 0, 0, 0.24)',
  },
} as const;

export type GameCrewTokens = typeof gameCrewTokens;

export const teamColorUsage = {
  posterField: 'Use team or country colors as the match-owned visual field.',
  flagGlow: 'Use team or country colors for subtle identity glow only.',
  shell: 'Keep app chrome black, white, and gray.',
} as const;
