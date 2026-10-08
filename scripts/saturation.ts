// Mede a vazão de saturação: carros por hora de verde por faixa que cruzam a linha de
// retenção de semáforos quando há fila (carro atrás a menos de 15 m). Referência ~1.800.
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);
for (let i = 0; i < (15 * 60) / DT; i++) sim.step();
// mede por 10 min: por faixa, tempo de verde com fila e carros que passaram
const green = new Map<object, number>(), passed = new Map<object, number>();
const prevLink = new Map<number, number>();
for (let i = 0; i < (10 * 60) / DT; i++) {
  for (const l of sim.graph.links) {
    if (!l.signal) continue;
    const st = sim.signals.state(l.signal.controller, l.signal.phase, sim.t).state;
    if (st !== 'green') continue;
    for (const lane of l.lanes) {
      // fila: pelo menos 3 carros a menos de 40 m da linha
      const near = lane.vehicles.filter((v) => l.length - l.setback - v.pos < 40 && l.length - l.setback - v.pos > -2).length;
      if (near >= 3) green.set(lane, (green.get(lane) ?? 0) + DT);
    }
  }
  sim.step();
  for (const v of sim.vehicles) {
    const p = prevLink.get(v.id);
    if (p !== undefined && p !== v.lane.link.id) {
      const pl = sim.graph.links[p];
      if (pl.signal && v.prevLane && green.has(v.prevLane)) passed.set(v.prevLane, (passed.get(v.prevLane) ?? 0) + 1);
    }
    prevLink.set(v.id, v.lane.link.id);
  }
}
let g = 0, n = 0;
for (const [lane, t] of green) if (t > 30) { g += t; n += passed.get(lane) ?? 0; }
console.log(`vazão de saturação medida: ${(n / (g / 3600)).toFixed(0)} veíc/h de verde por faixa (${n} carros em ${(g / 60).toFixed(0)} faixa·min de verde com fila)`);
