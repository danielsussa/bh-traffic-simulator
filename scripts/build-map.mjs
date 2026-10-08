// Converte o extrato bruto do OpenStreetMap (Overpass) num grafo viário compacto
// usado pelo frontend. Uso: node scripts/build-map.mjs
//
// Saída (public/data/bh.json):
//   nodes:  [x, y] em metros (projeção local, y cresce para o sul) — só cruzamentos/pontas
//   edges:  trechos entre dois nós, com geometria, classe, faixas por sentido, velocidade
//   areas:  polígonos de contexto (parques, água)
//   lines:  linhas de contexto (rios, ferrovia)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const RAW = 'data/raw/osm.json';
const EXTRAS = 'data/raw/extras.json';
const OUT = 'public/data/bh.json';

// Recorte usado na consulta Overpass (ver README)
const BBOX = { south: -19.96, west: -43.985, north: -19.9, east: -43.9 };

// Origem da projeção: Praça Sete, aproximadamente
const ORIGIN = { lat: -19.9191, lon: -43.9386 };
const R = 6378137;
const kx = (Math.PI / 180) * R * Math.cos((ORIGIN.lat * Math.PI) / 180);
const ky = (Math.PI / 180) * R;
const project = (lat, lon) => [
  round((lon - ORIGIN.lon) * kx),
  round(-(lat - ORIGIN.lat) * ky),
];
const round = (v) => Math.round(v * 10) / 10;

// Padrões por classe quando o OSM não informa
const DEFAULTS = {
  motorway: { lanes: 2, speed: 80 },
  trunk: { lanes: 2, speed: 60 },
  primary: { lanes: 2, speed: 60 },
  secondary: { lanes: 2, speed: 50 },
  tertiary: { lanes: 1, speed: 40 },
  residential: { lanes: 1, speed: 30 },
  unclassified: { lanes: 1, speed: 30 },
  living_street: { lanes: 1, speed: 20 },
};
const baseClass = (hw) => hw.replace(/_link$/, '');

function parseSpeed(v) {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseLanes(tags, cls, oneway) {
  const total = parseInt(tags.lanes, 10);
  const fwd = parseInt(tags['lanes:forward'], 10);
  const bwd = parseInt(tags['lanes:backward'], 10);
  const def = DEFAULTS[cls]?.lanes ?? 1;
  if (oneway) return [Number.isFinite(total) ? total : def, 0];
  if (Number.isFinite(fwd) && Number.isFinite(bwd)) return [fwd, bwd];
  if (Number.isFinite(total)) {
    const f = Math.max(1, Math.ceil(total / 2));
    return [f, Math.max(1, total - f)];
  }
  return [def, def];
}

// ---------- vias ----------
const raw = JSON.parse(readFileSync(RAW, 'utf8'));
const osmNodes = new Map();
const ways = [];
// Controles de tráfego em nós: semáforo e PARE, com sentido opcional (forward/backward da via)
const controls = new Map(); // id → { kind: 'signal' | 'stop', dir: 'forward' | 'backward' | null }
for (const el of raw.elements) {
  if (el.type === 'node') {
    osmNodes.set(el.id, [el.lat, el.lon]);
    const hw = el.tags?.highway ?? '';
    // Faixa de pedestre com semáforo também para os carros (linha de retenção na faixa)
    const signalCrossing =
      hw.split(';').includes('crossing') &&
      (el.tags.crossing === 'traffic_signals' || el.tags['crossing:signals'] === 'yes');
    if (hw.split(';').includes('traffic_signals') || signalCrossing) {
      const d = el.tags['traffic_signals:direction'];
      controls.set(el.id, { kind: 'signal', dir: d === 'forward' || d === 'backward' ? d : null });
    } else if (hw === 'stop') {
      const d = el.tags.direction;
      controls.set(el.id, { kind: 'stop', dir: d === 'forward' || d === 'backward' ? d : null });
    }
  } else if (el.type === 'way' && el.tags?.highway) ways.push(el);
}
/** O controle no nó vale para quem trafega no sentido indicado da via? */
function controlFor(id, travelsWayForward) {
  const c = controls.get(id);
  if (!c) return null;
  if (c.dir === 'forward' && !travelsWayForward) return null;
  if (c.dir === 'backward' && travelsWayForward) return null;
  return c.kind;
}

// Um nó OSM vira nó do grafo se for ponta de via ou compartilhado por 2+ vias
const usage = new Map();
for (const w of ways) {
  const seen = new Set();
  for (const id of w.nodes) {
    if (seen.has(id)) continue; // via fechada (rotatória) repete o primeiro nó
    seen.add(id);
    usage.set(id, (usage.get(id) ?? 0) + 1);
  }
}
// Semáforos e PAREs também viram nós do grafo (são linhas de retenção)
const isGraphNode = (id, i, w) =>
  i === 0 || i === w.nodes.length - 1 || usage.get(id) > 1 || controls.has(id);

const nodeIndex = new Map();
const nodes = [];
function graphNode(id) {
  let idx = nodeIndex.get(id);
  if (idx === undefined) {
    const [lat, lon] = osmNodes.get(id);
    idx = nodes.length;
    nodes.push(project(lat, lon));
    nodeIndex.set(id, idx);
  }
  return idx;
}

const names = [];
const nameIndex = new Map();
function nameId(name) {
  if (!name) return -1;
  let i = nameIndex.get(name);
  if (i === undefined) {
    i = names.length;
    names.push(name);
    nameIndex.set(name, i);
  }
  return i;
}

const edges = [];
for (const w of ways) {
  const t = w.tags;
  const cls = baseClass(t.highway);
  if (t.access === 'no' || t.access === 'private') continue;
  const reversed = t.oneway === '-1';
  const oneway =
    t.oneway === 'yes' || t.oneway === '1' || reversed ||
    t.junction === 'roundabout' || t.highway === 'motorway';
  const refs = reversed ? [...w.nodes].reverse() : w.nodes;
  if (refs.some((id) => !osmNodes.has(id))) continue;
  const [lanesF, lanesB] = parseLanes(t, cls, oneway);
  const speed = parseSpeed(t.maxspeed) ?? DEFAULTS[cls]?.speed ?? 30;
  const layer = parseInt(t.layer, 10) || (t.bridge ? 1 : t.tunnel ? -1 : 0);

  let start = 0;
  for (let i = 1; i < refs.length; i++) {
    if (!isGraphNode(refs[i], i, { nodes: refs })) continue;
    const slice = refs.slice(start, i + 1);
    const pts = [];
    let len = 0;
    let prev = null;
    for (const id of slice) {
      const p = project(...osmNodes.get(id));
      if (prev) len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      pts.push(p[0], p[1]);
      prev = p;
    }
    if (len > 0.5) {
      // Controle na chegada em b (sentido a→b) e em a (sentido b→a).
      // a→b é o sentido original da via, exceto em oneway=-1 (refs invertidos).
      const atB = controlFor(slice[slice.length - 1], !reversed);
      const atA = oneway ? null : controlFor(slice[0], reversed);
      edges.push({
        a: graphNode(slice[0]),
        b: graphNode(slice[slice.length - 1]),
        pts,
        len: round(len),
        hw: t.highway,
        name: nameId(t.name),
        lf: lanesF,
        lb: lanesB,
        v: speed,
        ...(layer ? { layer } : {}),
        ...(t.junction === 'roundabout' ? { rb: 1 } : {}),
        ...(atB ? { cb: atB === 'signal' ? 'S' : 'P' } : {}),
        ...(atA ? { ca: atA === 'signal' ? 'S' : 'P' } : {}),
        osm: w.id,
      });
    }
    start = i;
  }
}

// ---------- contexto (parques, água, rios, ferrovia) ----------
const extras = JSON.parse(readFileSync(EXTRAS, 'utf8'));
const xNodes = new Map();
for (const el of extras.elements) if (el.type === 'node') xNodes.set(el.id, [el.lat, el.lon]);
const areas = [];
const lines = [];
for (const el of extras.elements) {
  if (el.type !== 'way' || !el.tags) continue;
  if (el.nodes.some((id) => !xNodes.has(id))) continue;
  const pts = el.nodes.flatMap((id) => project(...xNodes.get(id)));
  const t = el.tags;
  if (t.waterway) lines.push({ kind: 'water', pts });
  else if (t.railway) lines.push({ kind: 'rail', pts });
  else if (t.natural === 'water') areas.push({ kind: 'water', pts });
  else areas.push({ kind: 'green', pts });
}

// ---------- bounds ----------
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const [x, y] of nodes) {
  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
}

mkdirSync('public/data', { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({
    meta: {
      name: 'Belo Horizonte — Centro-Sul',
      origin: ORIGIN,
      bounds: [minX, minY, maxX, maxY],
      // Recorte da consulta ao OSM: vias que saem dele são portas de entrada/saída
      clip: [...project(BBOX.north, BBOX.west), ...project(BBOX.south, BBOX.east)],
      source: '© OpenStreetMap contributors (ODbL)',
    },
    names,
    nodes,
    edges,
    areas,
    lines,
  }),
);
console.log(`${nodes.length} nós, ${edges.length} arestas, ${names.length} nomes, ${areas.length} áreas, ${lines.length} linhas → ${OUT}`);
