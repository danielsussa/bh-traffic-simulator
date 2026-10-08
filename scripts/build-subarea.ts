// Recorta a região dentro da Av. do Contorno (com uma folga) do mapa da cidade e extrai a
// demanda dela a partir do modelo da cidade ("extração de subárea"):
//   1. rede: arestas cujo ponto médio está dentro do polígono da Contorno + folga
//   2. demanda: sorteia viagens da demanda calibrada, roteia no mapa inteiro e registra
//      onde cada uma entra/sai da subárea (ou nasce/estaciona dentro dela)
// Saída: public/data/bh-contorno.json (mapa) e public/data/bh-contorno-od.json (matriz OD)
//   (as rotas usam os tempos de percurso de uma simulação da cidade inteira aquecida por
//   WARM minutos: com o centro congestionado, a passagem se espalha por outros caminhos)
// Uso: npx tsx scripts/build-subarea.ts [amostras=40000] [aquecimento-min=30]
import { readFileSync, writeFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation } from '../src/sim/simulation';
import { mulberry32 } from '../src/sim/rng';
import type { Link } from '../src/sim/graph';
import type { CordonOD } from '../src/sim/cordon';
import type { TripKind } from '../src/sim/demand';

const BUFFER = 120; // m além da Contorno (inclui a própria avenida e as aproximações)
const SAMPLES = Number(process.argv[2] ?? 40000);
const REF_HOUR = 10;
const WARM = Number(process.argv[3] ?? 30);

const raw = JSON.parse(readFileSync('public/data/bh.json', 'utf8'));
const net = RoadNetwork.fromJSON(raw);
const sim = new Simulation(net, 42, REF_HOUR * 3600 - WARM * 60);

// ---- polígono: casco da Contorno expandido em BUFFER metros ----
const hull = sim.demand.contorno;
const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
const poly = hull.map(([x, y]) => {
  const d = Math.hypot(x - cx, y - cy);
  return [cx + ((x - cx) * (d + BUFFER)) / d, cy + ((y - cy) * (d + BUFFER)) / d] as [number, number];
});
const inside = (x: number, y: number) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
let area = 0;
for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) area += hull[j][0] * hull[i][1] - hull[i][0] * hull[j][1];
console.log(`área dentro da Contorno: ${(Math.abs(area) / 2 / 1e6).toFixed(1)} km²`);

// ---- rede recortada ----
const keep = new Int32Array(raw.edges.length).fill(-1);
const nodeMap = new Map<number, number>();
const nodes: [number, number][] = [];
const edges: unknown[] = [];
raw.edges.forEach((e: { a: number; b: number; pts: number[] }, i: number) => {
  const m = Math.floor(e.pts.length / 4) * 2; // vértice do meio
  const [mx, my] = e.pts.length > 4 ? [e.pts[m], e.pts[m + 1]] : [(e.pts[0] + e.pts[2]) / 2, (e.pts[1] + e.pts[3]) / 2];
  if (!inside(mx, my)) return;
  const remap = (n: number) => {
    let k = nodeMap.get(n);
    if (k === undefined) { k = nodes.length; nodes.push(raw.nodes[n]); nodeMap.set(n, k); }
    return k;
  };
  keep[i] = edges.length;
  edges.push({ ...e, a: remap(e.a), b: remap(e.b), src: i });
});
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const [x, y] of nodes) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const nearBox = (pts: number[]) => {
  for (let i = 0; i < pts.length; i += 2) if (pts[i] > x0 - 300 && pts[i] < x1 + 300 && pts[i + 1] > y0 - 300 && pts[i + 1] < y1 + 300) return true;
  return false;
};
const small = {
  meta: {
    ...raw.meta,
    name: 'Belo Horizonte — dentro da Contorno',
    bounds: [x0, y0, x1, y1],
    clip: [x0, y0, x1, y1],
    cordon: poly.flat().map((v) => Math.round(v)),
  },
  names: raw.names,
  nodes,
  edges,
  areas: raw.areas.filter((a: { pts: number[] }) => nearBox(a.pts)),
  lines: raw.lines.filter((l: { pts: number[] }) => nearBox(l.pts)),
};
writeFileSync('public/data/bh-contorno.json', JSON.stringify(small));
console.log(`rede: ${edges.length} de ${raw.edges.length} arestas, ${nodes.length} nós`);

// ---- simula a cidade para obter tempos de percurso congestionados ----
if (WARM > 0) {
  const t0 = performance.now();
  sim.prefill(Math.round(sim.demandPerHour() * 0.2));
  // média dos tempos de percurso na metade final do aquecimento (a média móvel instantânea oscila)
  const sum = new Float64Array(sim.graph.links.length);
  let n = 0;
  const avgFrom = REF_HOUR * 3600 - (WARM * 60) / 2;
  let nextSample = avgFrom;
  while (sim.t < REF_HOUR * 3600) {
    sim.step();
    if (sim.t >= nextSample) {
      for (const l of sim.graph.links) sum[l.id] += l.ttEma;
      n++;
      nextSample += 30;
    }
  }
  for (const l of sim.graph.links) l.ttEma = sum[l.id] / n;
  const st = sim.getStats();
  console.log(`cidade aquecida por ${WARM} min (${((performance.now() - t0) / 1000).toFixed(0)}s): ${st.active} carros, vel ${st.meanSpeedKmh.toFixed(0)} km/h, parados ${st.stoppedPct.toFixed(0)}%`);
}

// ---- matriz OD do cordão ----
const rng = mulberry32(2024);
const rate = sim.demand.ratePerHour(REF_HOUR);
const perSample = rate / SAMPLES;
const key = (l: Link) => [keep[l.edge.id], l.forward ? 1 : 0] as [number, number];
const agg = new Map<string, CordonOD['trips'][number]>();
let routed = 0, touching = 0;
const t0 = performance.now();
for (let i = 0; i < SAMPLES; i++) {
  const trip = sim.demand.sample(rng);
  const route = sim.router.route(trip.origin, trip.dest, i);
  if (!route) continue;
  routed++;
  let segStart = -1, touched = false;
  for (let k = 0; k <= route.length; k++) {
    const isIn = k < route.length && keep[route[k].edge.id] >= 0;
    if (isIn && segStart < 0) segStart = k;
    if (!isIn && segStart >= 0) {
      touched = true;
      const o = route[segStart], d = route[k - 1];
      // começa/termina dentro da subárea se a viagem original começa/termina aqui
      const oGate = segStart === 0 && !trip.fromGate ? 0 : 1;
      const dGate = k - 1 === route.length - 1 && !trip.toGate ? 0 : 1;
      if (!(o === d && oGate && dGate)) {
        const kind: TripKind = oGate && dGate ? 'through' : oGate ? 'to_work' : dGate ? 'outbound' : 'local';
        const ok = key(o), dk = key(d);
        const id = `${ok}|${dk}|${oGate}|${dGate}`;
        const cur = agg.get(id);
        if (cur) cur.flow += perSample;
        else agg.set(id, { o: ok, d: dk, oGate: oGate as 0 | 1, dGate: dGate as 0 | 1, kind, flow: perSample });
      }
      segStart = -1;
    }
  }
  if (touched) touching++;
  if (i % 5000 === 4999) console.log(`  ${i + 1}/${SAMPLES} viagens roteadas (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
}
const trips = [...agg.values()].map((t) => ({ ...t, flow: Math.round(t.flow * 10) / 10 }));
const od: CordonOD = {
  refHour: REF_HOUR,
  trips,
  source: `extraído de ${SAMPLES} viagens da demanda da cidade (${Math.round(rate)} veíc/h às ${REF_HOUR}h) roteadas no mapa inteiro com tempos de percurso de ${WARM} min de simulação`,
};
writeFileSync('public/data/bh-contorno-od.json', JSON.stringify(od));
const tot = trips.reduce((s, t) => s + t.flow, 0);
const by = (f: (t: (typeof trips)[number]) => boolean) => Math.round(trips.filter(f).reduce((s, t) => s + t.flow, 0));
console.log(`${touching}/${routed} viagens passam pela subárea → ${Math.round(tot)} veíc/h, ${trips.length} pares OD`);
console.log(`  entram → estacionam dentro: ${by((t) => !!t.oGate && !t.dGate)}`);
console.log(`  atravessam: ${by((t) => !!t.oGate && !!t.dGate)}`);
console.log(`  saem de dentro: ${by((t) => !t.oGate && !!t.dGate)}`);
console.log(`  dentro → dentro: ${by((t) => !t.oGate && !t.dGate)}`);
