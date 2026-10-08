// Demanda de viagens de carro num dia útil, calibrada com contagens reais da BHTrans e a
// Pesquisa OD (ver calibration.ts): cada portão (via que sai do mapa) recebe o fluxo
// contado no seu corredor; o destino segue o mix de viagens da hora.
import {
  CORRIDORS, DEFAULT_PER_LANE, GATE_IN_SPLIT, HOUR_FACTOR, LOCAL_RATIO, LOCAL_SPLIT, REF_HOUR, SCENARIO,
} from './calibration';
import type { Link, SimGraph } from './graph';
import { WeightedPicker, type Rng } from './rng';

export interface Trip {
  origin: Link;
  dest: Link;
  kind: TripKind;
  /** entra pela borda do mapa (vem andando, não sai de uma vaga) */
  fromGate?: boolean;
  /** sai pela borda do mapa: vai até o fim do último trecho em vez de estacionar */
  toGate?: boolean;
}

/** Fonte de viagens usada pela simulação (demanda da cidade ou matriz de uma subárea) */
export interface TripSource {
  readonly contorno: [number, number][];
  /** links de entrada pela borda (carros entram andando) */
  readonly entryGates: { link: Link }[];
  readonly categories: DemandCategory[];
  ratePerHour(hour: number): number;
  sample(rng: Rng): Trip;
  isInsideContorno(x: number, y: number): boolean;
}

export type TripKind = 'to_work' | 'through' | 'outbound' | 'local';
type Zone = 'gate' | 'bairro' | 'centro';

export interface Gate {
  link: Link;
  /** corredor da contagem BHTrans, ou null (estimativa por faixa) */
  corridor: string | null;
  /** veículos/h às 10h */
  flow: number;
  /** contagem original, se o portão foi limitado pela capacidade da via de chegada */
  cappedFrom?: number;
}

/** vazão por faixa observada nas contagens (Carlos Luz: 4.000/h em 3 faixas ≈ 1.330) */
const LANE_CAPACITY = 1350;

function gateCapacity(start: Link): number {
  let lanes = start.lanes.length, dist = 0, l: Link | undefined = start;
  while (l && dist < 400) {
    lanes = Math.min(lanes, l.lanes.length);
    dist += l.length;
    // segue pela continuação mais larga (a mesma via)
    l = l.next.filter((n) => n.edge.name === l!.edge.name).sort((a, b) => b.lanes.length - a.lanes.length)[0]
      ?? l.next.sort((a, b) => b.lanes.length - a.lanes.length)[0];
  }
  return lanes * LANE_CAPACITY;
}

export interface DemandCategory {
  kind: TripKind;
  from: Zone;
  to: Zone;
  label: string;
  /** veículos/h na hora pico */
  flow: number;
}

// Polos de emprego (metros, origem na Praça Sete)
const JOB_CENTERS = [
  // pesos moderados: o destino se espalha pela região (garagens e vagas por todo lado)
  { x: 0, y: 0, r: 1000, w: 1.5 }, // hipercentro / Praça Sete
  { x: 420, y: 2150, r: 800, w: 0.9 }, // Savassi / Funcionários
  { x: -1150, y: 900, r: 700, w: 0.6 }, // Lourdes / Assembleia
  { x: 1300, y: 600, r: 600, w: 0.4 }, // Santa Efigênia (hospitais)
];

export class Demand implements TripSource {
  readonly contorno: [number, number][];
  readonly entryGates: Gate[];
  readonly exitGates: Gate[];
  readonly categories: DemandCategory[];
  private zones: Record<'bairro' | 'centro', WeightedPicker<Link>>;
  private entryPicker: WeightedPicker<Gate>;
  private exitPicker: WeightedPicker<Gate>;
  private categoryPicker: WeightedPicker<DemandCategory>;

  private nodeOf: (id: number) => { x: number; y: number };

  constructor(graph: SimGraph) {
    const net = graph.net;
    this.nodeOf = (id) => net.nodes[id];
    this.contorno = convexHull(
      net.edges.filter((e) => e.name === 'Avenida do Contorno').flatMap((e) => {
        const p: [number, number][] = [];
        for (let i = 0; i < e.pts.length; i += 2) p.push([e.pts[i], e.pts[i + 1]]);
        return p;
      }),
    );
    const [cx0, cy0, cx1, cy1] = net.clip;
    const INSET = 300;
    const borderDist = (n: number) => {
      const { x, y } = net.nodes[n];
      return Math.min(x - cx0, cx1 - x, y - cy0, cy1 - y);
    };
    const nearBorder = (n: number) => borderDist(n) < INSET;
    const deadEnd = (n: number) => net.nodes[n].edges.length === 1;
    const inside = (l: Link) => {
      const n = net.nodes[l.to];
      return pointInPolygon(n.x, n.y, this.contorno);
    };

    // ---- portões ----
    const corridorOf = (l: Link): string | null => {
      if (!l.edge.name && l.edge.cls === 'motorway' && net.nodes[l.from].y > cy1 - INSET) return '@sul-motorway';
      if (!l.edge.name && l.edge.cls === 'motorway' && net.nodes[l.to].y > cy1 - INSET) return '@sul-motorway';
      // o OSM grafa a mesma avenida de dois jeitos (Tereza/Teresa Cristina)
      const name = l.edge.name?.replace('Tereza Cristina', 'Teresa Cristina') ?? null;
      return CORRIDORS.some((c) => c.name === name) ? name : null;
    };
    const entries = graph.links.filter((l) => l.canStart && l.rank >= 3 && deadEnd(l.from) && nearBorder(l.from));
    const exits = graph.links.filter((l) => l.canEnd && l.rank >= 3 && deadEnd(l.to) && nearBorder(l.to));
    const toGates = (links: Link[], dir: 'in10' | 'out10'): Gate[] => {
      const lanesBy = new Map<string, number>();
      for (const l of links) {
        const c = corridorOf(l);
        if (c) lanesBy.set(c, (lanesBy.get(c) ?? 0) + l.lanes.length);
      }
      return links.map((l) => {
        const c = corridorOf(l);
        const corr = c ? CORRIDORS.find((k) => k.name === c)! : null;
        // corredor com mais de um portão: divide a contagem pelas faixas
        const flow = corr
          ? (corr[dir] * l.lanes.length) / lanesBy.get(c!)!
          : l.lanes.length * (DEFAULT_PER_LANE[l.rank] ?? 125);
        return { link: l, corridor: c, flow };
      });
    };
    this.entryGates = toGates(entries, 'in10');
    // A contagem pode ser de um ponto mais distante do corredor (antes de parte do fluxo
    // desviar); no portão, o fluxo não passa do que a via de chegada comporta: menor
    // número de faixas nos primeiros ~400 m × vazão por faixa de via semaforizada.
    for (const g of this.entryGates) {
      const cap = gateCapacity(g.link);
      if (g.flow > cap) {
        g.cappedFrom = g.flow;
        g.flow = cap;
      }
    }
    this.exitGates = toGates(exits, 'out10');
    this.entryPicker = new WeightedPicker(this.entryGates, (g) => g.flow);
    this.exitPicker = new WeightedPicker(this.exitGates, (g) => g.flow);

    // ---- zonas internas ----
    const parkable = (l: Link) => l.rank <= 5 && l.length > 25;
    const bairro = graph.links.filter((l) => l.canStart && l.canEnd && parkable(l) && !inside(l) && !nearBorder(l.to));
    const centro = graph.links.filter((l) => l.canStart && l.canEnd && parkable(l) && inside(l));
    const jobDensity = (l: Link) => {
      const n = net.nodes[l.to];
      let w = 1;
      for (const c of JOB_CENTERS) w += c.w * Math.exp(-((n.x - c.x) ** 2 + (n.y - c.y) ** 2) / (c.r * c.r));
      return w;
    };
    this.zones = {
      bairro: new WeightedPicker(bairro, (l) => l.length * (l.rank <= 2 ? 1 : 0.5)),
      // estaciona sobretudo em ruas locais/coletoras (vagas, garagens), menos nas avenidas
      centro: new WeightedPicker(centro, (l) => l.length * jobDensity(l) * (l.rank <= 3 ? 1 : 0.35)),
    };

    // ---- categorias de viagem (veículos/h no pico) ----
    const totalIn = this.entryGates.reduce((s, g) => s + g.flow, 0);
    const totalOut = this.exitGates.reduce((s, g) => s + g.flow, 0);
    const through = totalIn * GATE_IN_SPLIT.through;
    const gateToCentro = totalIn * GATE_IN_SPLIT.centro;
    // o que sai pelos portões e não é passagem vem do centro (70%) e dos bairros (30%)
    const leaving = Math.max(0, totalOut - through);
    const centroToGate = leaving * 0.7;
    const local = LOCAL_RATIO * (gateToCentro + centroToGate);
    this.categories = [
      { kind: 'to_work', from: 'gate', to: 'centro', label: 'entrando → centro', flow: gateToCentro },
      { kind: 'local', from: 'gate', to: 'bairro', label: 'entrando → bairros do mapa', flow: totalIn * GATE_IN_SPLIT.bairro },
      { kind: 'through', from: 'gate', to: 'gate', label: 'passagem (cruzando o centro)', flow: through * SCENARIO.throughBoost },
      { kind: 'outbound', from: 'centro', to: 'gate', label: 'centro → fora', flow: centroToGate * SCENARIO.outboundBoost },
      { kind: 'outbound', from: 'bairro', to: 'gate', label: 'bairros → fora', flow: leaving * 0.3 },
      { kind: 'to_work', from: 'bairro', to: 'centro', label: 'bairros → centro', flow: local * LOCAL_SPLIT.bairroToCentro },
      { kind: 'outbound', from: 'centro', to: 'bairro', label: 'centro → bairros', flow: local * LOCAL_SPLIT.centroToBairro * SCENARIO.outboundBoost },
      { kind: 'local', from: 'centro', to: 'centro', label: 'dentro do centro', flow: local * LOCAL_SPLIT.centroToCentro },
      { kind: 'local', from: 'bairro', to: 'bairro', label: 'entre bairros', flow: local * LOCAL_SPLIT.bairroToBairro },
    ];
    this.categoryPicker = new WeightedPicker(this.categories, (c) => c.flow);
  }

  /** Tráfego da hora em relação à hora de referência (10h) dos fluxos calibrados */
  static hourFactor(hour: number): number {
    return Demand.peakFactor(hour) / Demand.peakFactor(REF_HOUR);
  }

  /** Tráfego da hora em relação ao pico da manhã (7h) — curva medida nos radares */
  static peakFactor(hour: number): number {
    const P = HOUR_FACTOR;
    if (hour <= P[0][0]) return P[0][1];
    for (let i = 1; i < P.length; i++) {
      const [h1, f1] = P[i];
      const [h0, f0] = P[i - 1];
      if (hour <= h1) return f0 + ((f1 - f0) * (hour - h0)) / (h1 - h0);
    }
    return P[P.length - 1][1];
  }

  /** Veículos/h gerados na hora (escala 1 = real) */
  ratePerHour(hour: number): number {
    return this.categories.reduce((s, c) => s + c.flow, 0) * Demand.hourFactor(hour);
  }

  sample(rng: Rng): Trip {
    const cat = this.categoryPicker.pick(rng);
    let originGate: Gate | null = null;
    const origin =
      cat.from === 'gate' ? (originGate = this.entryPicker.pick(rng)).link : this.zones[cat.from].pick(rng);
    let dest: Link;
    if (cat.to === 'gate') {
      // Saída ponderada pela contagem. Passagem cruza o centro: a saída tem de ficar do
      // outro lado da cidade (ângulo em torno da Praça Sete ≥ SCENARIO.throughMinAngle)
      let g = this.exitPicker.pick(rng);
      if (originGate) {
        const o = this.nodeOf(originGate.link.from);
        const minCos = Math.cos((SCENARIO.throughMinAngle * Math.PI) / 180);
        for (let i = 0; i < 30; i++) {
          const d = this.nodeOf(g.link.to);
          const cos = (o.x * d.x + o.y * d.y) / (Math.hypot(o.x, o.y) * Math.hypot(d.x, d.y) || 1);
          if (g.corridor !== originGate.corridor && cos <= minCos) break;
          g = this.exitPicker.pick(rng);
        }
      }
      dest = g.link;
    } else dest = this.zones[cat.to].pick(rng);
    return { origin, dest, kind: cat.kind, fromGate: cat.from === 'gate', toGate: cat.to === 'gate' };
  }

  isInsideContorno(x: number, y: number) {
    return pointInPolygon(x, y, this.contorno);
  }
}

export function convexHull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function pointInPolygon(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
