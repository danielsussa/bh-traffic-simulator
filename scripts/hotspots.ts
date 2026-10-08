// Focos de congestionamento da simulação: vias com mais carros parados/lentos (média de
// amostras entre 10h e 10h20). Uso: MAPA=contorno npx tsx scripts/hotspots.ts [escala]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
import { CordonDemand } from '../src/sim/cordon';

const contorno = process.env.MAPA !== 'cidade';
const net = RoadNetwork.fromJSON(JSON.parse(readFileSync(contorno ? 'public/data/bh-contorno.json' : 'public/data/bh.json', 'utf8')));
const od = contorno ? JSON.parse(readFileSync('public/data/bh-contorno-od.json', 'utf8')) : null;
const sim = new Simulation(net, 42, 9.75 * 3600, od ? (g) => new CordonDemand(g, od) : undefined);
sim.demandScale = Number(process.argv[2] ?? (contorno ? 0.7 : 1));
sim.prefill(Math.round(sim.demandPerHour() * 0.2));
while (sim.t < 10 * 3600) sim.step();
const agg = new Map<string, { veh: number; stopped: number; km: number; cls: string }>();
let samples = 0;
while (sim.t < 10.33 * 3600) {
  sim.step();
  if (Math.round(sim.t) % 30 !== 0) continue;
  samples++;
  for (const v of sim.vehicles) {
    const e = v.lane.link.edge;
    const k = e.name ?? `(${e.cls})`;
    const a = agg.get(k) ?? { veh: 0, stopped: 0, km: 0, cls: e.cls };
    a.veh++;
    if (v.v < 1.5) a.stopped++;
    agg.set(k, a);
  }
}
// comprimento de cada via no mapa, para normalizar (carros parados por km)
for (const e of net.edges) { const k = e.name ?? `(${e.cls})`; const a = agg.get(k); if (a) a.km += e.length / 1000; }
const rows = [...agg].map(([k, a]) => ({ k, cls: a.cls, stoppedAvg: a.stopped / samples, perKm: a.stopped / samples / Math.max(0.1, a.km), km: a.km }));
console.log(`amostras: ${samples} · ${sim.vehicles.length} carros`);
console.log('Mais carros parados (média entre 10h e 10h20):');
for (const r of rows.sort((a, b) => b.stoppedAvg - a.stoppedAvg).slice(0, 22))
  console.log(`  ${r.stoppedAvg.toFixed(0).padStart(4)} parados · ${r.perKm.toFixed(0).padStart(4)}/km · ${r.k} [${r.cls}, ${r.km.toFixed(1)} km]`);
const byCls = new Map<string, number>();
for (const r of rows) byCls.set(r.cls, (byCls.get(r.cls) ?? 0) + r.stoppedAvg);
console.log('parados por classe de via:', Object.fromEntries([...byCls].map(([k, v]) => [k, Math.round(v)])));
