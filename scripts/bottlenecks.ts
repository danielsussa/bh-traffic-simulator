// Onde a rede satura: fila de entrada por portão, links com mais carros parados e
// motivo das paradas. Uso: npx tsx scripts/bottlenecks.ts [minutos] [escala]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';

const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);
sim.demandScale = Number(process.argv[3] ?? 1);
const minutes = Number(process.argv[2] ?? 20);
for (let i = 0; i < (minutes * 60) / DT; i++) sim.step();
const backlog = (sim as unknown as { backlog: Map<{ edge: { name: string | null; cls: string } }, unknown[]> }).backlog;
const byGate = [...backlog].map(([l, q]) => [l.edge.name ?? l.edge.cls, q.length] as const).sort((a, b) => b[1] - a[1]);
console.log('fila de entrada por origem (top 12):');
for (const [n, q] of byGate.slice(0, 12)) console.log(`  ${String(q).padStart(5)}  ${n}`);
const stopped = new Map<string, { n: number; reasons: Record<string, number> }>();
for (const v of sim.vehicles) {
  if (v.v > 0.5) continue;
  const k = v.lane.link.edge.name ?? '(sem nome)';
  const e = stopped.get(k) ?? { n: 0, reasons: {} };
  e.n++;
  e.reasons[v.reason] = (e.reasons[v.reason] ?? 0) + 1;
  stopped.set(k, e);
}
console.log('vias com mais carros parados:');
for (const [k, e] of [...stopped].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) console.log(`  ${String(e.n).padStart(5)}  ${k}  ${JSON.stringify(e.reasons)}`);

// Cabeças de fila: primeiro carro parado de uma faixa cheia, com o motivo (não 'leader')
console.log('cabeças de fila (faixas lotadas cujo primeiro carro está parado):');
const heads: [string, number][] = [];
for (const l of sim.graph.links) for (const lane of l.lanes) {
  const vs = lane.vehicles;
  if (vs.length < 5) continue;
  const occupied = vs.reduce((s, v) => s + v.len + 2, 0) / l.length;
  const f = vs[0];
  if (occupied < 0.7 || f.v > 0.5) continue;
  const next = f.route[f.ri + 1];
  const n = net.nodes[l.to];
  const nl = f.nextLane;
  const space = nl && nl.vehicles.length ? (nl.vehicles[nl.vehicles.length - 1].pos - nl.vehicles[nl.vehicles.length - 1].len).toFixed(1) : '-';
  heads.push([`${f.reason.padEnd(6)} ${(l.edge.name ?? l.edge.cls).slice(0, 34).padEnd(34)} → ${(next?.edge.name ?? next?.edge.cls ?? 'fim').slice(0, 30).padEnd(30)} link ${l.id} faixa ${lane.index}/${l.lanes.length} (${n.x.toFixed(0)},${n.y.toFixed(0)}) espaço-no-próximo ${space} ctrl ${l.control}`, vs.length]);
}
for (const [h, n] of heads.sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(3)} ${h}`);
