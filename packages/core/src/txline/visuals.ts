import type { TeamColorSet } from '../match';

export const countryVisuals: Record<string, { code: string; bands: readonly string[]; colors: TeamColorSet }> = {
  Argentina: {
    code: 'AR',
    bands: ['#74ACDF', '#FFFFFF', '#74ACDF'],
    colors: { primary: '#74ACDF', secondary: '#FFFFFF', accent: '#F6B40E' },
  },
  Australia: {
    code: 'AU',
    bands: ['#002B7F', '#FFFFFF', '#E4002B'],
    colors: { primary: '#002B7F', secondary: '#FFFFFF', accent: '#E4002B' },
  },
  Belgium: {
    code: 'BE',
    bands: ['#000000', '#FAE042', '#ED2939'],
    colors: { primary: '#FAE042', secondary: '#ED2939', accent: '#000000' },
  },
  Brazil: {
    code: 'BR',
    bands: ['#009B3A', '#FFDF00', '#002776'],
    colors: { primary: '#009B3A', secondary: '#FFDF00', accent: '#002776' },
  },
  Colombia: {
    code: 'CO',
    bands: ['#FCD116', '#003893', '#CE1126'],
    colors: { primary: '#FCD116', secondary: '#003893', accent: '#CE1126' },
  },
  'Congo DR': {
    code: 'CD',
    bands: ['#007FFF', '#F7D618', '#CE1021'],
    colors: { primary: '#007FFF', secondary: '#F7D618', accent: '#CE1021' },
  },
  Ecuador: {
    code: 'EC',
    bands: ['#FFD100', '#003893', '#CE1126'],
    colors: { primary: '#FFD100', secondary: '#003893', accent: '#CE1126' },
  },
  England: {
    code: 'GB-ENG',
    bands: ['#FFFFFF', '#CE1124', '#FFFFFF'],
    colors: { primary: '#FFFFFF', secondary: '#CE1124' },
  },
  France: {
    code: 'FR',
    bands: ['#002395', '#FFFFFF', '#ED2939'],
    colors: { primary: '#002395', secondary: '#FFFFFF', accent: '#ED2939' },
  },
  Germany: {
    code: 'DE',
    bands: ['#000000', '#DD0000', '#FFCE00'],
    colors: { primary: '#DD0000', secondary: '#FFCE00', accent: '#000000' },
  },
  Japan: {
    code: 'JP',
    bands: ['#FFFFFF', '#BC002D', '#FFFFFF'],
    colors: { primary: '#FFFFFF', secondary: '#BC002D' },
  },
  Mexico: {
    code: 'MX',
    bands: ['#006847', '#FFFFFF', '#CE1126'],
    colors: { primary: '#006847', secondary: '#FFFFFF', accent: '#CE1126' },
  },
  Morocco: {
    code: 'MA',
    bands: ['#C1272D', '#006233', '#C1272D'],
    colors: { primary: '#C1272D', secondary: '#006233' },
  },
  Netherlands: {
    code: 'NL',
    bands: ['#AE1C28', '#FFFFFF', '#21468B'],
    colors: { primary: '#AE1C28', secondary: '#FFFFFF', accent: '#21468B' },
  },
  Portugal: {
    code: 'PT',
    bands: ['#006600', '#FF0000', '#FFCC00'],
    colors: { primary: '#006600', secondary: '#FF0000', accent: '#FFCC00' },
  },
  Senegal: {
    code: 'SN',
    bands: ['#00853F', '#FDEF42', '#E31B23'],
    colors: { primary: '#00853F', secondary: '#FDEF42', accent: '#E31B23' },
  },
  Spain: {
    code: 'ES',
    bands: ['#AA151B', '#F1BF00', '#AA151B'],
    colors: { primary: '#AA151B', secondary: '#F1BF00' },
  },
  Switzerland: {
    code: 'CH',
    bands: ['#D52B1E', '#FFFFFF', '#D52B1E'],
    colors: { primary: '#D52B1E', secondary: '#FFFFFF' },
  },
  USA: {
    code: 'US',
    bands: ['#3C3B6E', '#FFFFFF', '#B22234'],
    colors: { primary: '#3C3B6E', secondary: '#FFFFFF', accent: '#B22234' },
  },
};

export const fallbackVisuals: readonly { bands: readonly string[]; colors: TeamColorSet }[] = [
  {
    bands: ['#FFFFFF', '#111111', '#FFFFFF'],
    colors: { primary: '#FFFFFF', secondary: '#111111' },
  },
  {
    bands: ['#00A3FF', '#FFFFFF', '#FF4D4D'],
    colors: { primary: '#00A3FF', secondary: '#FFFFFF', accent: '#FF4D4D' },
  },
  {
    bands: ['#2FD17C', '#FFFFFF', '#F4CA3A'],
    colors: { primary: '#2FD17C', secondary: '#FFFFFF', accent: '#F4CA3A' },
  },
  {
    bands: ['#FF7A1A', '#FFFFFF', '#1E5BFF'],
    colors: { primary: '#FF7A1A', secondary: '#FFFFFF', accent: '#1E5BFF' },
  },
];
