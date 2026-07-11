import { readFile } from 'node:fs/promises';

import { replayMatchEngine } from '../src/match-engine/index.ts';

const fixtureUrl = new URL(
  '../tests/fixtures/txline-18179759-seq-209-234.json',
  import.meta.url,
);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const result = replayMatchEngine(fixture.records, {
  ...fixture.fixture,
  ...fixture.baseline,
  players: fixture.players,
});

const teamName = (participant) =>
  fixture.fixture.participants.find((team) => team.participant === participant)?.name ?? '—';
const clock = (seconds) => {
  if (seconds === undefined) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const checkpoints = new Set([214, 217, 218, 219, 220, 221, 223, 224, 228, 231, 234]);

console.log('\nShared match-engine replay · fixture 18179759 · Seq 209–234\n');
console.log('Seq   Clock   Source update                 Shared facts                                                             | Simulation cues');
console.log('----  ------  ----------------------------  -----------------------------------------------------------------------  | --------------------------------------------');

for (const frame of result.frames.filter(({ seq }) => checkpoints.has(seq))) {
  const record = result.ledger.find(({ Seq }) => Seq === frame.seq);
  const source = `${record.Action} #${record.Id}`;
  const factText = frame.facts.length
    ? frame.facts.map((fact) => `${fact.kind}/${fact.lifecycle}${fact.player ? ` · ${fact.player.displayName}` : ''}`).join(', ')
    : '—';
  const cueText = frame.simulationCues.length
    ? frame.simulationCues.map((cue) => `${cue.kind}${cue.participant ? ` · ${teamName(cue.participant)}` : ''}`).join(', ')
    : '—';
  console.log(
    String(frame.seq).padEnd(5) +
      clock(frame.matchClockSeconds).padEnd(8) +
      source.padEnd(30) +
      factText.padEnd(73) +
      '| ' + cueText,
  );
}

const goal = result.state.incidents['18179759:goal:207'];
const shot = result.state.incidents['18179759:shot:206'];
console.log('\nFinal canonical checkpoint');
console.log(`  Confirmed score: Mexico ${result.state.confirmedScore.participant1}–${result.state.confirmedScore.participant2} Ecuador`);
console.log(`  Goal #207: ${goal.lifecycle}, revision ${goal.revision}, player ${goal.player?.displayName ?? 'unknown'}`);
console.log(`  Shot #206: ${shot.lifecycle}, revision ${shot.revision}, outcome ${shot.data.Outcome ?? 'unknown'}, player ${shot.player?.displayName ?? 'not supplied'}`);
console.log(`  Current probable band: ${teamName(result.state.possession?.participant)} · ${result.state.possession?.probableZone ?? 'unknown'}`);
console.log(`  Ledger/frames: ${result.ledger.length}/${result.frames.length}; integrity warnings: ${result.state.integrityWarnings.length}`);
