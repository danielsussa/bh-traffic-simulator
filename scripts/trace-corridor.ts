// Segue um corredor a partir do portão de entrada mostrando ocupação e velocidade de cada
// trecho — a fila termina onde está o gargalo. Uso: npx tsx scripts/trace-corridor.ts "<nome>" [min]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';

const name = process.argv[2] ?? 'Avenida Presidente Antônio Carlos';
const minutes = Number(process.argv[3] ?? 20);
const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);
for (let i = 0; i < (minutes * 60) / DT; i++) sim.step();
const gate = sim.demand.entryGates.find((g) => g.link.edge.name === name || g.corridor === name)!;
let l = gate.link;
const seen = new Set<number>();
for (let k = 0; k < 60 && l && !seen.has(l.id); k++) {
  seen.add(l.id);
  const vs = l.lanes.flatMap((la) => la.vehicles);
  const occ = vs.reduce((s, v) => s + v.len + 2, 0) / (l.length * l.lanes.length);
  const mean = vs.length ? (vs.reduce((s, v) => s + v.v, 0) / vs.length) * 3.6 : NaN;
  const heads = l.lanes.map((la) => la.vehicles[0] ? `${la.vehicles[0].reason}${la.vehicles[0].v < 0.5 ? '⏸' : ''}` : '-').join(',');
  const n = net.nodes[l.to];
  console.log(`${String(l.id).padStart(5)} ${(l.edge.name ?? l.edge.cls).slice(0, 28).padEnd(28)} ${l.lanes.length}f ${l.length.toFixed(0).padStart(4)}m ocup ${(occ * 100).toFixed(0).padStart(3)}% vel ${isNaN(mean) ? '  -' : mean.toFixed(0).padStart(3)} km/h  cabeças[${heads}] ctrl=${l.control ?? '-'} nó ${net.nodes[l.to].edges.length}v (${n.x.toFixed(0)},${n.y.toFixed(0)})`);
  // segue para o próximo link por onde passa mais gente (mesmo nome primeiro)
  const cands = l.next.filter((x) => !seen.has(x.id));
  const same = cands.filter((x) => x.edge.name === l.edge.name);
  const pool = same.length ? same : cands;
  l = pool.sort((a, b) => b.lanes.length - a.lanes.length)[0];
}
