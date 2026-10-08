// Roda a simulação sem interface para medir desempenho e calibrar a demanda.
// Uso: npx tsx scripts/bench.ts [minutos] [demanda veh/h]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
import { CordonDemand } from '../src/sim/cordon';

const minutes = Number(process.argv[2] ?? 30);
// MAPA=contorno usa o recorte dentro da Contorno com a matriz OD extraída
const contorno = process.env.MAPA === 'contorno';
const net = RoadNetwork.fromJSON(JSON.parse(readFileSync(contorno ? 'public/data/bh-contorno.json' : 'public/data/bh.json', 'utf8')));
let t0 = performance.now();
const od = contorno ? JSON.parse(readFileSync('public/data/bh-contorno-od.json', 'utf8')) : null;
const sim = new Simulation(net, 42, 9.5 * 3600, od ? (g) => new CordonDemand(g, od) : undefined);
if (process.argv[3]) sim.demandScale = Number(process.argv[3]);
console.log(`init ${(performance.now() - t0).toFixed(0)}ms · links ${sim.graph.links.length} · semáforos ${sim.signals.controllers.length} · portões de entrada ${sim.demand.entryGates.length} · demanda ${Math.round(sim.demandPerHour())} veíc/h`);
const phases = new Map<number, number>();
for (const c of sim.signals.controllers) phases.set(c.phases.length, (phases.get(c.phases.length) ?? 0) + 1);
console.log('fases por cruzamento:', Object.fromEntries(phases));
const inferred = sim.signals.controllers.filter((c) => c.inferred).length;
console.log(`semáforos: ${sim.signals.controllers.length - inferred} do OSM + ${inferred} estimados`);
if (process.env.SEMAFOROS === '0') sim.setSignals(false);
if (process.env.CHAOS) sim.chaos = Number(process.env.CHAOS);
if (process.env.PREFILL) console.log('início a quente:', sim.prefill(Math.round(sim.demandPerHour() * 0.2)), 'carros');
const clock = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
let exp0 = 0;
for (let m = 1; m <= minutes; m++) {
  t0 = performance.now();
  for (let i = 0; i < 60 / DT; i++) sim.step();
  const ms = performance.now() - t0;
  if (m % 5 === 0 || m === 1) {
    const s = sim.getStats();
    console.log(
      `${clock(sim.t)} ativos ${s.active} fila-entrada ${s.waitingToEnter} chegaram ${s.arrived} travados ${s.removedStuck} rerotas ${s.rerouted} fechando ${s.blockingNow} avançaram ${s.ranRed} ` +
      `vel ${s.meanSpeedKmh.toFixed(1)}km/h parados ${s.stoppedPct.toFixed(0)}% no-vermelho ${s.atRed} viagem ${s.avgTripMin.toFixed(1)}min ` +
      `| ${ms.toFixed(0)}ms/min-sim, A* ${((sim.router.expansions - exp0) / Math.max(1, s.spawned)).toFixed(0)} exp/rota`,
    );
  }
}
const reasons: Record<string, number> = {};
for (const v of sim.vehicles) if (v.v < 0.5) reasons[v.reason] = (reasons[v.reason] ?? 0) + 1;
console.log('parados por motivo:', reasons);
