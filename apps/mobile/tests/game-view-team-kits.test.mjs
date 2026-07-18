import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveGameViewTeamKits,
  resolveFigureKitColors,
} from '../src/screens/game-view/game-view-team-kits.ts';

function team(overrides) {
  return {
    name: overrides.name,
    countryCode: overrides.countryCode,
    colors: overrides.colors,
    flagBands: overrides.flagBands ?? [],
  };
}

test('France and Spain receive recognizable two-tone outfield and distinct keeper kits', () => {
  const kits = resolveGameViewTeamKits(
    team({ name: 'France', countryCode: 'FR', colors: { primary: '#002395', secondary: '#FFFFFF', accent: '#ED2939' } }),
    team({ name: 'Spain', countryCode: 'ES', colors: { primary: '#AA151B', secondary: '#F1BF00' } }),
  );

  assert.equal(kits.home.variant, 'home');
  assert.deepEqual(kits.home.outfield, { shirt: '#1B3F8B', shorts: '#F4F5F7', trim: '#D72B3F' });
  assert.notEqual(kits.home.keeper.shirt, kits.home.outfield.shirt);
  assert.equal(kits.away.variant, 'home');
  assert.notEqual(kits.away.outfield.shirt, kits.home.outfield.shirt);
});

test('a home-kit clash moves only the away side onto its away palette', () => {
  const kits = resolveGameViewTeamKits(
    team({ name: 'Spain', countryCode: 'ES', colors: { primary: '#AA151B', secondary: '#F1BF00' } }),
    team({ name: 'Morocco', countryCode: 'MA', colors: { primary: '#C1272D', secondary: '#006233' } }),
  );

  assert.equal(kits.home.variant, 'home');
  assert.equal(kits.away.variant, 'away');
  assert.equal(kits.away.outfield.shirt, '#F4F2EC');
});

test('unknown teams get an honesty-safe flag/color fallback with a contrasting keeper', () => {
  const kits = resolveGameViewTeamKits(
    team({
      name: 'Unknown A',
      countryCode: 'UA',
      colors: { primary: '#2040A0', secondary: '#FFFFFF', accent: '#F0C000' },
      flagBands: ['#2040A0', '#FFFFFF', '#F0C000'],
    }),
    team({
      name: 'Unknown B',
      countryCode: 'UB',
      colors: { primary: '#A02030', secondary: '#101018' },
      flagBands: ['#A02030', '#101018'],
    }),
  );

  assert.equal(kits.home.source, 'fallback');
  assert.equal(kits.home.outfield.shirt, '#2040A0');
  assert.equal(kits.home.outfield.shorts, '#FFFFFF');
  assert.notEqual(kits.home.keeper.shirt, kits.home.outfield.shirt);
});

test('keepers use the keeper palette while every outfield role shares the outfield kit', () => {
  const kits = resolveGameViewTeamKits(
    team({ name: 'France', countryCode: 'FR', colors: { primary: '#002395', secondary: '#FFFFFF' } }),
    team({ name: 'Spain', countryCode: 'ES', colors: { primary: '#AA151B', secondary: '#F1BF00' } }),
  );

  assert.deepEqual(resolveFigureKitColors(kits.home, 'keeper'), kits.home.keeper);
  assert.deepEqual(resolveFigureKitColors(kits.home, 'attacker'), kits.home.outfield);
  assert.deepEqual(resolveFigureKitColors(kits.home, 'defender'), kits.home.outfield);
});
