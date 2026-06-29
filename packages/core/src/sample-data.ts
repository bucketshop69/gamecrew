import type { GameCrewMatch, MatchTeam } from './match';

const portugal: MatchTeam = {
  id: 'team-portugal',
  name: 'Portugal',
  shortName: 'POR',
  countryCode: 'PT',
  colors: {
    primary: '#006600',
    secondary: '#FF0000',
    accent: '#FFCC00',
  },
  flag: {
    code: 'PT',
    bands: ['#006600', '#FF0000', '#FFCC00'],
  },
};

const argentina: MatchTeam = {
  id: 'team-argentina',
  name: 'Argentina',
  shortName: 'ARG',
  countryCode: 'AR',
  colors: {
    primary: '#74ACDF',
    secondary: '#FFFFFF',
    accent: '#F6B40E',
  },
  flag: {
    code: 'AR',
    bands: ['#74ACDF', '#FFFFFF', '#74ACDF'],
  },
};

const netherlands: MatchTeam = {
  id: 'team-netherlands',
  name: 'Netherlands',
  shortName: 'NED',
  countryCode: 'NL',
  colors: {
    primary: '#AE1C28',
    secondary: '#FFFFFF',
    accent: '#21468B',
  },
  flag: {
    code: 'NL',
    bands: ['#AE1C28', '#FFFFFF', '#21468B'],
  },
};

const italy: MatchTeam = {
  id: 'team-italy',
  name: 'Italy',
  shortName: 'ITA',
  countryCode: 'IT',
  colors: {
    primary: '#009246',
    secondary: '#FFFFFF',
    accent: '#CE2B37',
  },
  flag: {
    code: 'IT',
    bands: ['#009246', '#FFFFFF', '#CE2B37'],
  },
};

const japan: MatchTeam = {
  id: 'team-japan',
  name: 'Japan',
  shortName: 'JPN',
  countryCode: 'JP',
  colors: {
    primary: '#FFFFFF',
    secondary: '#BC002D',
  },
  flag: {
    code: 'JP',
    bands: ['#FFFFFF', '#BC002D', '#FFFFFF'],
  },
};

const brazil: MatchTeam = {
  id: 'team-brazil',
  name: 'Brazil',
  shortName: 'BRA',
  countryCode: 'BR',
  colors: {
    primary: '#009B3A',
    secondary: '#FFDF00',
    accent: '#002776',
  },
  flag: {
    code: 'BR',
    bands: ['#009B3A', '#FFDF00', '#002776'],
  },
};

const england: MatchTeam = {
  id: 'team-england',
  name: 'England',
  shortName: 'ENG',
  countryCode: 'GB-ENG',
  colors: {
    primary: '#FFFFFF',
    secondary: '#CE1124',
  },
  flag: {
    code: 'GB-ENG',
    bands: ['#FFFFFF', '#CE1124', '#FFFFFF'],
  },
};

const france: MatchTeam = {
  id: 'team-france',
  name: 'France',
  shortName: 'FRA',
  countryCode: 'FR',
  colors: {
    primary: '#002395',
    secondary: '#FFFFFF',
    accent: '#ED2939',
  },
  flag: {
    code: 'FR',
    bands: ['#002395', '#FFFFFF', '#ED2939'],
  },
};

const morocco: MatchTeam = {
  id: 'team-morocco',
  name: 'Morocco',
  shortName: 'MAR',
  countryCode: 'MA',
  colors: {
    primary: '#C1272D',
    secondary: '#006233',
  },
  flag: {
    code: 'MA',
    bands: ['#C1272D', '#006233', '#C1272D'],
  },
};

const spain: MatchTeam = {
  id: 'team-spain',
  name: 'Spain',
  shortName: 'ESP',
  countryCode: 'ES',
  colors: {
    primary: '#AA151B',
    secondary: '#F1BF00',
  },
  flag: {
    code: 'ES',
    bands: ['#AA151B', '#F1BF00', '#AA151B'],
  },
};

export const sampleTxlineMatches: readonly GameCrewMatch[] = [
  {
    id: 'gc-live-por-arg',
    txline: {
      fixtureId: 'txline-fixture-1001',
      scoreSnapshotId: 'txline-score-1001-67',
    },
    filter: 'live',
    status: 'live',
    competition: 'World Cup',
    round: 'Group Stage',
    kickoffUtc: '2026-06-29T14:00:00.000Z',
    homeTeam: portugal,
    awayTeam: argentina,
    score: {
      home: 1,
      away: 1,
    },
    clock: {
      minute: 67,
      label: "Live 67'",
      phase: 'second_half',
    },
  },
  {
    id: 'gc-live-ned-ita',
    txline: {
      fixtureId: 'txline-fixture-1005',
      scoreSnapshotId: 'txline-score-1005-32',
    },
    filter: 'live',
    status: 'live',
    competition: 'Continental Cup',
    round: 'Quarter-final',
    kickoffUtc: '2026-06-29T15:30:00.000Z',
    homeTeam: netherlands,
    awayTeam: italy,
    score: {
      home: 0,
      away: 1,
    },
    clock: {
      minute: 32,
      label: "Live 32'",
      phase: 'first_half',
    },
  },
  {
    id: 'gc-upcoming-jpn-bra',
    txline: {
      fixtureId: 'txline-fixture-1002',
    },
    filter: 'upcoming',
    status: 'upcoming',
    competition: 'World Cup',
    round: 'Round of 16',
    kickoffUtc: '2026-06-29T20:00:00.000Z',
    homeTeam: japan,
    awayTeam: brazil,
    clock: {
      label: 'Starts 20:00 UTC',
      phase: 'pre_match',
    },
  },
  {
    id: 'gc-replay-eng-fra',
    txline: {
      fixtureId: 'txline-fixture-1003',
      historicalSnapshotId: 'txline-history-1003-final',
    },
    filter: 'replay',
    status: 'replayable',
    competition: 'Nations Cup',
    round: 'Semi-final',
    kickoffUtc: '2026-06-28T18:00:00.000Z',
    homeTeam: england,
    awayTeam: france,
    score: {
      home: 2,
      away: 3,
    },
    clock: {
      label: 'Full time',
      phase: 'replay_ready',
    },
    replay: {
      available: true,
      label: 'Replay ready',
    },
  },
  {
    id: 'gc-hosted-mar-esp',
    txline: {
      fixtureId: 'txline-fixture-1004',
    },
    filter: 'hosted',
    status: 'hosted',
    competition: 'Friendly',
    round: 'Hosted room preview',
    kickoffUtc: '2026-06-30T17:30:00.000Z',
    homeTeam: morocco,
    awayTeam: spain,
    clock: {
      label: 'Hosted room opens soon',
      phase: 'hosted_room',
    },
    hosted: {
      available: true,
      label: 'Room opens before kick-off',
    },
  },
];
