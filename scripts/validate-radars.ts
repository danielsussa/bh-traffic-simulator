// Valida a simulação contra os radares da BHTrans dentro do mapa: compara o fluxo
// simulado (10h–10h30, ×2) com o medido às 10h (média ter–qui set/2023, UVP/h).
// Uso: npx tsx scripts/validate-radars.ts [escala]
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/map/network';
import { Simulation, DT } from '../src/sim/simulation';
import type { Link } from '../src/sim/graph';

interface Radar {
  eqp: number; sentido: string; lat: number; lon: number; endereco: string; faixas: number[];
  porHora: Record<string, Record<string, number>>;
}
const UVP: Record<string, number> = { 'AUTOMÓVEL': 1, 'MOTO': 0.3, 'CAMINHÃO / ÔNIBUS': 2.1 };

const raw = JSON.parse(readFileSync('public/data/bh.json', 'utf8'));
const net = RoadNetwork.fromJSON(raw);
const sim = new Simulation(net, 42, 9.5 * 3600);
sim.demandScale = Number(process.argv[2] ?? 1);
const { origin } = raw.meta;
const R = 6378137;
const kx = (Math.PI / 180) * R * Math.cos((origin.lat * Math.PI) / 180), ky = (Math.PI / 180) * R;
const [cx0, cy0, cx1, cy1] = net.clip;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/^(av\.?|avenida|rua|r\.)\s+/, '').replace(/presidente\s+/, '').replace(/tereza/, 'teresa');
const streetOf = (addr: string) => norm(addr.split(/,| nº| oposto| a \d/)[0].trim());

function distToLink(l: Link, x: number, y: number): number {
  let best = Infinity;
  const p = l.pts;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1];
    const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[i] + t * dx - x, p[i + 1] + t * dy - y));
  }
  return best;
}

const radars: Radar[] = JSON.parse(readFileSync('data/radar/radares-set2023-6a12h.json', 'utf8'));
interface Check { label: string; real: number; links: Link[] }
const checks: Check[] = [];
const skipped: string[] = [];
for (const r of radars) {
  const x = (r.lon - origin.lon) * kx, y = -(r.lat - origin.lat) * ky;
  if (x < Math.min(cx0, cx1) || x > Math.max(cx0, cx1) || y < Math.min(cy0, cy1) || y > Math.max(cy0, cy1)) continue;
  const street = streetOf(r.endereco);
  const near = sim.graph.links.filter((l) => l.edge.name && norm(l.edge.name).includes(street) && distToLink(l, x, y) < 40);
  if (!near.length) { skipped.push(`${r.eqp} ${r.endereco} (${r.sentido}) — nenhuma via "${street}" a 40 m`); continue; }
  const [from, to] = r.sentido.split('/').map((s) => s.trim().toLowerCase());
  // sentido pela distância à Praça Sete: "Bairro/Centro" = aproximando do centro
  const inbound = (l: Link) => {
    const a = net.nodes[l.from], b = net.nodes[l.to];
    return Math.hypot(b.x, b.y) < Math.hypot(a.x, a.y);
  };
  let dirLinks: Link[] | null = null;
  if (to?.startsWith('centro')) dirLinks = near.filter(inbound);
  else if (from?.startsWith('centro')) dirLinks = near.filter((l) => !inbound(l));
  const pick = (ls: Link[]) => {
    // um link por pista: o mais próximo de cada sentido de percurso
    const byDir = new Map<string, Link>();
    for (const l of ls) {
      const k = `${Math.round(Math.atan2(l.outDir[1], l.outDir[0]) / 0.5)}`;
      const cur = byDir.get(k);
      if (!cur || distToLink(l, x, y) < distToLink(cur, x, y)) byDir.set(k, l);
    }
    return [...byDir.values()];
  };
  const real = Object.entries(r.porHora['10'] ?? {}).reduce((s, [c, n]) => s + (UVP[c] ?? 1) * n, 0);
  if (dirLinks && dirLinks.length) {
    checks.push({ label: `${r.endereco.slice(0, 44)} [${r.sentido.slice(0, 16)}]`, real, links: pick(dirLinks).slice(0, 1) });
  } else {
    // sentido sem "Centro" (ex.: Contorno "Savassi / Sta. Efigênia"): soma os dois sentidos depois
    checks.push({ label: `${r.endereco.slice(0, 44)} [${r.sentido.slice(0, 16)}]`, real, links: [] });
  }
}

// junta radares de mesmo endereço sem sentido definido: compara a soma dos dois sentidos
const merged = new Map<string, Check>();
for (const c of checks) {
  if (c.links.length) { merged.set(c.label, c); continue; }
  const key = c.label.split(' [')[0];
  const m = merged.get(key) ?? { label: `${key} [2 sentidos]`, real: 0, links: [] };
  m.real += c.real;
  merged.set(key, m);
}
for (const m of merged.values()) {
  if (m.links.length) continue;
  const r = radars.find((r) => m.label.startsWith(r.endereco.slice(0, 44)))!;
  const x = (r.lon - origin.lon) * kx, y = -(r.lat - origin.lat) * ky;
  const street = streetOf(r.endereco);
  const near = sim.graph.links.filter((l) => l.edge.name && norm(l.edge.name).includes(street) && distToLink(l, x, y) < 40)
    .sort((a, b) => distToLink(a, x, y) - distToLink(b, x, y));
  // um link em cada sentido
  const a = near[0];
  const b = near.find((l) => a && l.outDir[0] * a.outDir[0] + l.outDir[1] * a.outDir[1] < -0.5);
  m.links = [a, b].filter(Boolean) as Link[];
}

// ---- roda a simulação e conta passagens ----
const counted = new Set<Link>([...merged.values()].flatMap((m) => m.links));
const passes = new Map<Link, number>();
const last = new Map<number, Link>();
const t0 = performance.now();
while (sim.t < 10 * 3600) sim.step();
const warmMs = performance.now() - t0;
for (const v of sim.vehicles) last.set(v.id, v.lane.link);
while (sim.t < 10.5 * 3600) {
  sim.step();
  for (const v of sim.vehicles) {
    const prev = last.get(v.id);
    if (prev && prev !== v.lane.link && counted.has(prev)) passes.set(prev, (passes.get(prev) ?? 0) + 1);
    last.set(v.id, v.lane.link);
  }
}
const st = sim.getStats();
console.log(`escala ${sim.demandScale} · demanda ${Math.round(sim.demandPerHour())} veíc/h · ${st.active} carros · vel ${st.meanSpeedKmh.toFixed(0)} km/h · parados ${st.stoppedPct.toFixed(0)}% · fila-entrada ${st.waitingToEnter} · travados ${st.removedStuck} · aquecimento ${(warmMs / 1000).toFixed(0)}s`);
console.log(`${'radar'.padEnd(64)} ${'real'.padStart(6)} ${'sim'.padStart(6)}  razão`);
let sumR = 0, sumS = 0, sq = 0, n = 0;
for (const m of [...merged.values()].sort((a, b) => a.label.localeCompare(b.label))) {
  const sim2 = m.links.reduce((s, l) => s + (passes.get(l) ?? 0), 0) * 2;
  const ratio = sim2 / Math.max(1, m.real);
  sumR += m.real; sumS += sim2; n++;
  // GEH: estatística padrão de validação de fluxo (< 5 = bom)
  const geh = Math.sqrt((2 * (sim2 - m.real) ** 2) / Math.max(1, sim2 + m.real));
  if (geh < 5) sq++;
  console.log(`${m.label.padEnd(64)} ${String(Math.round(m.real)).padStart(6)} ${String(sim2).padStart(6)}  ${ratio.toFixed(2)}  GEH ${geh.toFixed(1)}`);
}
console.log(`TOTAL real ${Math.round(sumR)} · sim ${sumS} · razão ${(sumS / sumR).toFixed(2)} · ${sq}/${n} pontos com GEH < 5`);
if (skipped.length) console.log('sem correspondência no mapa:\n  ' + skipped.join('\n  '));
