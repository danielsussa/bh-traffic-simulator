// Mede sobreposição de carros: na mesma faixa, e logo após cruzar um nó / entrar na via.
// Uso: npx tsx scripts/check-overlap.ts [minutos] [demanda]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
import { turnAngle } from '../src/sim/graph';

const minutes = Number(process.argv[2] ?? 10);
const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);
sim.demandScale = Number(process.argv[3] ?? 1);
let overlaps = 0, samples = 0, laneJumps = 0, transitions = 0;
const lastLane = new Map<number, { link: number; idx: number; n: number }>();
for (let i = 0; i < (minutes * 60) / DT; i++) {
  sim.step();
  if (i % 4) continue;
  for (const l of sim.graph.links) for (const lane of l.lanes) {
    for (let k = 1; k < lane.vehicles.length; k++) {
      samples++;
      const a = lane.vehicles[k - 1], b = lane.vehicles[k];
      if (b.pos > a.pos - a.len + 0.05) overlaps++;
    }
  }
  for (const v of sim.vehicles) {
    const prev = lastLane.get(v.id);
    const cur = { link: v.lane.link.id, idx: v.lane.index, n: v.lane.link.lanes.length };
    if (prev && prev.link !== cur.link && Math.abs(turnAngle(sim.graph.links[prev.link], v.lane.link)) < 0.5) {
      transitions++;
      // seguiu reto mas mudou de faixa relativa (contada pela direita)
      const fromRight = prev.n - 1 - prev.idx, toRight = cur.n - 1 - cur.idx;
      if (fromRight !== toRight) laneJumps++;
    }
    lastLane.set(v.id, cur);
  }
}
console.log({ overlaps, samples, overlapPct: ((100 * overlaps) / samples).toFixed(2), straightTransitions: transitions, laneJumpsGoingStraight: laneJumps, jumpPct: ((100 * laneJumps) / transitions).toFixed(1) });
