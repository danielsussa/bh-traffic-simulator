// Velocidade dos carros nas conversões: ao cruzar o nó (entrada numa conversão) e no
// anel de rotatórias. Uso: npx tsx scripts/check-turns.ts [minutos]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
import { turnAngle } from '../src/sim/graph';

const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);

const minutes = Number(process.argv[2] ?? 10);
const buckets: Record<string, number[]> = { 'reto (<15°)': [], 'suave (15–60°)': [], 'fechada (>60°)': [], 'entrada Raul Soares (Bias Fortes)': [], 'no anel de rotatória': [] };
const last = new Map<number, number>();
for (let i = 0; i < (minutes * 60) / DT; i++) {
  sim.step();
  for (const v of sim.vehicles) {
    const prev = last.get(v.id);
    const cur = v.lane.link.id;
    if (prev !== undefined && prev !== cur && v.reason === 'free') {
      const a = sim.graph.links[prev], b = v.lane.link;
      const th = Math.abs(turnAngle(a, b)) * 180 / Math.PI;
      const kmh = v.v * 3.6;
      if (b.ring && a.ring) buckets['no anel de rotatória'].push(kmh);
      else if (th < 15) buckets['reto (<15°)'].push(kmh);
      else if (th < 60) buckets['suave (15–60°)'].push(kmh);
      else buckets['fechada (>60°)'].push(kmh);
      if (a.edge.name === 'Avenida Bias Fortes' && b.ring) buckets['entrada Raul Soares (Bias Fortes)'].push(kmh);
    }
    last.set(v.id, cur);
  }
}
for (const [k, arr] of Object.entries(buckets)) {
  arr.sort((a, b) => a - b);
  const q = (p: number) => arr.length ? arr[Math.floor(p * (arr.length - 1))].toFixed(0) : '-';
  console.log(`${k.padEnd(36)} n=${String(arr.length).padStart(6)}  mediana ${q(0.5)} km/h  (p10 ${q(0.1)}, p90 ${q(0.9)})`);
}
