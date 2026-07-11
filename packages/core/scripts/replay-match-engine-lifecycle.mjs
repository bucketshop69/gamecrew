import { readFile } from 'node:fs/promises';

import { replayMatchEngine } from '../src/match-engine/index.ts';

const fixture = JSON.parse(await readFile(
  new URL('../tests/fixtures/txline-18179759-lifecycle.json', import.meta.url),
  'utf8',
));
const players = Object.fromEntries(Object.entries(fixture.players).map(([id, player]) => [
  id,
  { ...player, sourcePreferredName: player.name, displayName: player.name },
]));
const result = replayMatchEngine(fixture.records, {
  ...fixture.fixture,
  confirmedScore: { participant1: 0, participant2: 0 },
  players,
});
const state = result.state;
const incidents = Object.values(state.incidents);
const phaseSequences = new Set([25, 28, 428, 432, 439, 881, 885]);

console.log('\nShared match-engine lifecycle · fixture 18179759\n');
console.log('Phase checkpoints');
for (const frame of result.frames.filter(({ seq }) => phaseSequences.has(seq))) {
  const phase = frame.facts.find(({ kind }) => kind === 'phase')?.value.phase;
  console.log(`  Seq ${String(frame.seq).padEnd(3)} → ${phase}`);
}

console.log('\nCanonical lifecycle');
for (const incident of incidents.filter(({ action }) =>
  ['goal', 'yellow_card', 'red_card', 'var', 'substitution'].includes(action))) {
  const player = incident.player?.displayName ? ` · ${incident.player.displayName}` : '';
  console.log(`  ${incident.action.padEnd(13)} #${String(incident.sourceId).padEnd(3)} ${incident.lifecycle.padEnd(9)} r${incident.revision}${player}`);
}

const active = state.activePlayerIdsByParticipant;
const truePossibleFlags = Object.values(state.possibleEvents)
  .flatMap((flags) => Object.entries(flags))
  .filter(([, value]) => value === true);
console.log('\nFinal checkpoint');
console.log(`  Phase/score: ${state.phase} · Mexico ${state.finalScore.participant1}–${state.finalScore.participant2} Ecuador`);
console.log(`  Last playing clock: ${Math.floor(state.lastPlayingElapsedSeconds / 60)}:${String(state.lastPlayingElapsedSeconds % 60).padStart(2, '0')}`);
console.log(`  Active players: Mexico ${active['1'].length} · Ecuador ${active['2'].length}`);
console.log(`  Cards: ${incidents.filter((item) => item.action === 'yellow_card').length} yellow · ${incidents.filter((item) => item.action === 'red_card').length} red`);
console.log(`  Discard #366: ${state.incidents['18179759:throw_in:366'].lifecycle}`);
console.log(`  Open possible-event flags: ${truePossibleFlags.length}`);
console.log(`  Source records/frames: ${result.ledger.length}/${result.frames.length} · warnings ${state.integrityWarnings.length}`);
