// Classifica as cabeças de fila (primeiro carro parado de cada faixa com fila) pelo motivo
// e pelo tipo de nó. Uso: npx tsx scripts/head-reasons.ts [min] [escala]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);
sim.demandScale = Number(process.argv[3] ?? 1);
for (let i = 0; i < (Number(process.argv[2] ?? 25) * 60) / DT; i++) sim.step();
const tally = new Map<string, number>();
let queued = 0;
for (const l of sim.graph.links) for (const lane of l.lanes) {
  const f = lane.vehicles[0];
  if (!f || f.v > 0.5 || lane.vehicles.length < 3) continue;
  queued += lane.vehicles.length;
  let r: string = f.reason;
  if (r === 'leader' && f.nextLane) {
    // líder está na próxima faixa: é fila que continua (spillback)
    r = 'spillback';
  }
  const deg = net.nodes[l.to].edges.length;
  const k = `${r.padEnd(10)} nó ${deg >= 3 ? 'cruzamento' : 'meio-de-via'} ${l.signal ? 'semáforo' : l.control ?? 'sem-controle'}`;
  tally.set(k, (tally.get(k) ?? 0) + lane.vehicles.length);
}
console.log(`carros em filas: ${queued} de ${sim.vehicles.length}`);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
