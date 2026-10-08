// Mostra a demanda calibrada: fluxo por categoria e por portão na hora escolhida.
// Uso: npx tsx scripts/demand-report.ts [hora=10]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation } from '../src/sim/simulation';
import { Demand, type Gate } from '../src/sim/demand';

const hour = Number(process.argv[2] ?? 10);
const net = RoadNetwork.fromJSON(JSON.parse(readFileSync('public/data/bh.json', 'utf8')));
const sim = new Simulation(net);
const f = Demand.hourFactor(hour);
console.log(`${hour}h — fator em relação às 10h: ${f}`);
for (const c of sim.demand.categories) console.log(`  ${c.label.padEnd(28)} ${String(Math.round(c.flow * f)).padStart(6)} veíc/h`);
console.log(`  ${'TOTAL'.padEnd(28)} ${String(Math.round(sim.demand.ratePerHour(hour))).padStart(6)} veíc/h`);
const agg = (gs: Gate[]) => {
  const m = new Map<string, number>();
  for (const g of gs) {
    const k = g.corridor ?? `~ ${g.link.edge.name ?? g.link.edge.cls}`;
    m.set(k, (m.get(k) ?? 0) + g.flow * f);
  }
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${k.padEnd(42)} ${String(Math.round(v)).padStart(5)}`).join('\n');
};
console.log('Entrando pelos portões (~ = estimado por faixa):\n' + agg(sim.demand.entryGates));
for (const g of sim.demand.entryGates) if (g.cappedFrom) console.log(`  limitado pela capacidade da via: ${g.corridor ?? g.link.edge.name} ${Math.round(g.cappedFrom * f)} → ${Math.round(g.flow * f)} veíc/h`);
console.log('Saindo pelos portões:\n' + agg(sim.demand.exitGates));
