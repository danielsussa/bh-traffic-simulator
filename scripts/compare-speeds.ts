// Compara a velocidade dos carros simulados no ponto de cada radar (10h–10h20) com a
// velocidade real medida (automóveis, ter–qui set/2023). Uso: npx tsx scripts/compare-speeds.ts [escala]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
import { CordonDemand } from '../src/sim/cordon';
import type { Link } from '../src/sim/graph';

const raw = JSON.parse(readFileSync('public/data/bh-contorno.json', 'utf8'));
const net = RoadNetwork.fromJSON(raw);
const od = JSON.parse(readFileSync('public/data/bh-contorno-od.json', 'utf8'));
const sim = new Simulation(net, 42, 9.75 * 3600, (g) => new CordonDemand(g, od));
sim.demandScale = Number(process.argv[2] ?? 0.7);
const { origin } = raw.meta;
const R = 6378137, kx = (Math.PI / 180) * R * Math.cos((origin.lat * Math.PI) / 180), ky = (Math.PI / 180) * R;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^(av\.?|avenida|rua|r\.)\s+/, '');
const street = (a: string) => norm(a.split(/,| nº| oposto| a \d/)[0].trim());
function proj(l: Link, x: number, y: number) {
  // distância ao link e posição ao longo dele
  let best = Infinity, at = 0;
  for (let i = 0; i + 1 < l.cum.length; i++) {
    const ax = l.pts[2 * i], ay = l.pts[2 * i + 1], dx = l.pts[2 * i + 2] - ax, dy = l.pts[2 * i + 3] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) { best = d; at = l.cum[i] + t * (l.cum[i + 1] - l.cum[i]); }
  }
  return { d: best, at };
}
interface Probe { label: string; real: number; spots: { link: Link; at: number }[]; speeds: number[] }
const probes: Probe[] = [];
for (const r of JSON.parse(readFileSync('data/radar/velocidades-set2023.json', 'utf8'))) {
  const x = (r.lon - origin.lon) * kx, y = -(r.lat - origin.lat) * ky;
  const st = street(r.endereco);
  const cands = sim.graph.links.filter((l) => l.edge.name && norm(l.edge.name).includes(st)).map((l) => ({ l, ...proj(l, x, y) })).filter((c) => c.d < 40);
  if (!cands.length) continue;
  const [from, to] = r.sentido.split('/').map((s: string) => s.trim().toLowerCase());
  const inbound = (l: Link) => Math.hypot(net.nodes[l.to].x, net.nodes[l.to].y) < Math.hypot(net.nodes[l.from].x, net.nodes[l.from].y);
  let sel = cands;
  if (to?.startsWith('centro')) sel = cands.filter((c) => inbound(c.l));
  else if (from?.startsWith('centro')) sel = cands.filter((c) => !inbound(c.l));
  if (!sel.length) continue;
  sel.sort((a, b) => a.d - b.d);
  // sentido ambíguo (ex.: "Savassi / Sta. Efigênia"): usa os dois sentidos mais próximos
  const spots = (to?.startsWith('centro') || from?.startsWith('centro') ? sel.slice(0, 1) : sel.slice(0, 2)).map((c) => ({ link: c.l, at: c.at }));
  probes.push({ label: `${r.endereco.slice(0, 40)} [${r.sentido.slice(0, 18)}]`, real: r.med10, spots, speeds: [] });
}
sim.prefill(Math.round(sim.demandPerHour() * 0.2));
while (sim.t < 10 * 3600) sim.step();
while (sim.t < 10.33 * 3600) {
  sim.step();
  for (const p of probes) for (const s of p.spots) for (const lane of s.link.lanes) for (const v of lane.vehicles)
    if (Math.abs(v.pos - v.len / 2 - s.at) < v.v * DT + 0.5 && v.v > 0) p.speeds.push(v.v * 3.6); // passou pelo radar neste passo
}
console.log(`${'radar'.padEnd(62)} real  sim  (km/h, mediana)`);
for (const p of probes.sort((a, b) => a.real - b.real)) {
  const s = [...p.speeds].sort((a, b) => a - b);
  const med = s.length ? s[s.length >> 1] : NaN;
  console.log(`${p.label.padEnd(62)} ${p.real.toFixed(0).padStart(4)} ${isNaN(med) ? '   -' : med.toFixed(0).padStart(4)}  (n=${s.length})`);
}
