// Distribuição das viagens: tipo, origem→destino, distância e tempo em fluxo livre.
// Uso: npx tsx scripts/trip-report.ts [amostras]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation } from '../src/sim/simulation';
import { mulberry32 } from '../src/sim/rng';

const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);
const rng = mulberry32(1);
const N = Number(process.argv[2] ?? 3000);
const byCat = new Map<string, number[]>();
const all: number[] = [];
const cats = sim.demand.categories;
const total = cats.reduce((s, c) => s + c.flow, 0);
// amostra por categoria, proporcional ao fluxo
for (const c of cats) {
  const n = Math.round((N * c.flow) / total);
  const arr: number[] = [];
  let tries = 0;
  while (arr.length < n && tries++ < n * 5) {
    const t = sim.demand.sample(rng);
    const label = cats.find((k) => k.kind === t.kind && sampleMatches(k, t))?.label;
    if (label !== c.label) continue;
    const r = sim.router.route(t.origin, t.dest, arr.length);
    if (!r) continue;
    const km = r.reduce((s, l) => s + l.length, 0) / 1000;
    arr.push(km);
    all.push(km);
  }
  byCat.set(c.label, arr);
}
function sampleMatches(k: { from: string; to: string }, t: { origin: { id: number }; dest: { id: number } }) {
  const gIn = sim.demand.entryGates.some((g) => g.link === t.origin);
  const gOut = sim.demand.exitGates.some((g) => g.link === t.dest);
  const inside = (l: { to: number }) => sim.demand.isInsideContorno(net.nodes[l.to].x, net.nodes[l.to].y);
  const zone = (l: { to: number; id: number }, gate: boolean) => (gate ? 'gate' : inside(l) ? 'centro' : 'bairro');
  return k.from === zone(t.origin as never, gIn) && k.to === zone(t.dest as never, gOut);
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))] ?? 0; };
console.log(`${'categoria'.padEnd(28)} ${'veíc/h'.padStart(7)} ${'%'.padStart(4)}  km mediana (p10–p90)`);
for (const c of cats) {
  const a = byCat.get(c.label)!;
  console.log(`${c.label.padEnd(28)} ${String(Math.round(c.flow)).padStart(7)} ${((100 * c.flow) / total).toFixed(0).padStart(3)}%  ${q(a, 0.5).toFixed(1)} (${q(a, 0.1).toFixed(1)}–${q(a, 0.9).toFixed(1)})  n=${a.length}`);
}
const mean = all.reduce((s, x) => s + x, 0) / all.length;
console.log(`TODAS: média ${mean.toFixed(1)} km, mediana ${q(all, 0.5).toFixed(1)} km · ${Math.round(total)} veíc/h → ${Math.round(total * mean).toLocaleString('pt-BR')} veíc·km/h`);
