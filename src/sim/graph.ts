// Grafo dirigido da simulação: cada aresta do mapa vira 1 ou 2 "links" (um por sentido),
// e cada link tem N faixas. Coordenadas do link seguem o sentido de tráfego.
import { LANE_WIDTH, RoadNetwork, type Control, type Edge } from '../map/network';
import type { Vehicle } from './vehicle';

export interface Lane {
  link: Link;
  /** 0 = faixa mais à esquerda (junto ao eixo), n-1 = mais à direita */
  index: number;
  /** deslocamento lateral (m, positivo = direita do sentido) do eixo da faixa */
  offset: number;
  /** Veículos do primeiro (mais adiantado) ao último */
  vehicles: Vehicle[];
}

export interface Link {
  id: number;
  edge: Edge;
  forward: boolean;
  from: number;
  to: number;
  pts: Float32Array;
  /** distância acumulada até cada vértice */
  cum: Float32Array;
  length: number;
  /** velocidade máxima em m/s */
  vmax: number;
  lanes: Lane[];
  control: Control;
  /** distância do fim do link até a linha de retenção */
  setback: number;
  /** direção (unitária) ao sair do link e ao entrar nele */
  outDir: [number, number];
  inDir: [number, number];
  /** links seguintes possíveis (sem retorno, exceto em rua sem saída) */
  next: Link[];
  /** ângulo de conversão (rad) e raio da curva (m) para cada `next[i]` — pré-calculados */
  nextTurn: Float32Array;
  nextRadius: Float32Array;
  prev: Link[];
  /** índice de prioridade na chegada (maior = via principal) */
  rank: number;
  /** semáforo que controla este link, se houver (preenchido por signals.ts) */
  signal: { controller: number; phase: number } | null;
  /** tempo de percurso observado (média móvel, s) — usado no roteamento */
  ttEma: number;
  /** curvas dentro do link: pares [distância do vértice, raio (m)] */
  curves: Float32Array;
  /** razão velocidade/limite observada (média móvel) — camada de trânsito */
  speedRatio: number;
  /** faz parte de uma rotatória (marcada no OSM ou anel detectado) — tem preferência */
  ring: boolean;
  /** o link pode ser origem/destino (alcança e é alcançável pela rede principal) */
  canStart: boolean;
  canEnd: boolean;
}

const RANK: Record<string, number> = {
  motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3,
  unclassified: 2, residential: 2, living_street: 1,
};

export class SimGraph {
  readonly links: Link[] = [];
  /** links que chegam em cada nó */
  readonly incoming: Link[][];

  constructor(readonly net: RoadNetwork) {
    this.incoming = net.nodes.map(() => []);
    for (const e of net.edges) {
      if (e.lanesFwd > 0) this.addLink(e, true);
      if (e.lanesBwd > 0) this.addLink(e, false);
    }
    const outgoing: Link[][] = net.nodes.map(() => []);
    for (const l of this.links) {
      outgoing[l.from].push(l);
      this.incoming[l.to].push(l);
    }
    for (const l of this.links) {
      const outs = outgoing[l.to];
      const noUturn = outs.filter((o) => o.edge !== l.edge);
      l.next = noUturn.length ? noUturn : outs;
      for (const n of l.next) n.prev.push(l);
      l.setback = this.computeSetback(l);
    }
    // depois do setback (o raio depende dele)
    for (const l of this.links) {
      l.nextTurn = Float32Array.from(l.next, (n) => turnAngle(l, n));
      l.nextRadius = Float32Array.from(l.next, (n) => junctionRadius(l, n));
    }
    this.markReachability();
    this.detectRings();
  }

  /**
   * Praças circulares (ex.: Raul Soares) muitas vezes não têm junction=roundabout no OSM.
   * Anel = links de mão única com o mesmo nome que, seguindo pela mesma via, voltam ao
   * início em menos de 1,5 km, formando uma figura compacta (exclui pistas duplas que
   * fecham circuito pelo retorno).
   */
  private detectRings() {
    for (const start of this.links) {
      if (start.ring || start.lanes.length === 0 || !start.edge.name || start.edge.lanesBwd > 0) continue;
      const path: Link[] = [start];
      let cur = start, total = start.length;
      while (total < 1500 && path.length < 80) {
        const nx = cur.next.find((n) => n.edge.name === start.edge.name && n.edge.lanesBwd === 0 && n.forward);
        if (!nx) break;
        if (nx === start) {
          if (compactness(path) > 0.5) for (const l of path) l.ring = true;
          break;
        }
        if (path.includes(nx)) break;
        path.push(nx);
        total += nx.length;
        cur = nx;
      }
    }
  }

  private addLink(e: Edge, forward: boolean) {
    const src = e.pts;
    const pts = new Float32Array(src.length);
    if (forward) pts.set(src);
    else for (let i = 0; i < src.length; i += 2) {
      pts[i] = src[src.length - 2 - i];
      pts[i + 1] = src[src.length - 1 - i];
    }
    const cum = new Float32Array(pts.length / 2);
    for (let i = 1; i < cum.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    }
    const nThis = forward ? e.lanesFwd : e.lanesBwd;
    const nOther = forward ? e.lanesBwd : e.lanesFwd;
    // Faixas deste sentido ocupam o lado direito: do divisor d0 até a borda
    const d0 = ((nOther - nThis) * LANE_WIDTH) / 2;
    const n = pts.length;
    const link: Link = {
      id: this.links.length,
      edge: e,
      forward,
      from: forward ? e.from : e.to,
      to: forward ? e.to : e.from,
      pts,
      cum,
      length: cum[cum.length - 1],
      vmax: e.maxSpeed / 3.6,
      lanes: [],
      control: forward ? e.controlAtTo : e.controlAtFrom,
      setback: 0,
      outDir: unit(pts[n - 2] - pts[n - 4], pts[n - 1] - pts[n - 3]),
      inDir: unit(pts[2] - pts[0], pts[3] - pts[1]),
      next: [],
      nextTurn: new Float32Array(0),
      nextRadius: new Float32Array(0),
      prev: [],
      rank: RANK[e.cls] ?? 2,
      signal: null,
      ttEma: 0,
      curves: vertexCurves(pts, cum),
      speedRatio: 1,
      canStart: false,
      canEnd: false,
      ring: e.roundabout,
    };
    link.ttEma = link.length / link.vmax;
    for (let k = 0; k < nThis; k++) {
      link.lanes.push({ link, index: k, offset: d0 + (k + 0.5) * LANE_WIDTH, vehicles: [] });
    }
    this.links.push(link);
  }

  /** Recuo da linha de retenção: metade da largura da via transversal mais larga */
  private computeSetback(l: Link): number {
    let half = 0;
    for (const id of this.net.nodes[l.to].edges) {
      const e = this.net.edges[id];
      if (e === l.edge) continue;
      const other = e.from === l.to ? unit(e.pts[2] - e.pts[0], e.pts[3] - e.pts[1])
        : unit(e.pts[e.pts.length - 4] - e.pts[e.pts.length - 2], e.pts[e.pts.length - 3] - e.pts[e.pts.length - 1]);
      // continuação quase reta da mesma via não conta como transversal
      if (Math.abs(cross(l.outDir, other)) < 0.35) continue;
      half = Math.max(half, ((e.lanesFwd + e.lanesBwd) * LANE_WIDTH) / 2);
    }
    return Math.min(half + 1, 14, l.length * 0.45);
  }

  /** Marca links que podem ser origem (alcançam a rede principal) e destino (alcançáveis) */
  private markReachability() {
    const scc = largestScc(this.links);
    const bfs = (dir: 'next' | 'prev', mark: 'canStart' | 'canEnd') => {
      const queue = this.links.filter((l) => scc.has(l.id));
      for (const l of queue) l[mark] = true;
      while (queue.length) {
        const l = queue.pop()!;
        for (const o of l[dir]) {
          if (!o[mark]) {
            o[mark] = true;
            queue.push(o);
          }
        }
      }
    };
    bfs('prev', 'canStart'); // quem alcança a SCC via `next` é alcançado via `prev`
    bfs('next', 'canEnd');
  }

  /** Posição e direção no link a `dist` metros, deslocado `offset` à direita */
  pointAt(l: Link, dist: number, offset: number, hint = 0): { x: number; y: number; dx: number; dy: number; seg: number } {
    const { cum, pts } = l;
    let i = Math.min(hint, cum.length - 2);
    while (i > 0 && cum[i] > dist) i--;
    while (i < cum.length - 2 && cum[i + 1] < dist) i++;
    const segLen = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, (dist - cum[i]) / segLen));
    const dx = (pts[2 * i + 2] - pts[2 * i]) / segLen, dy = (pts[2 * i + 3] - pts[2 * i + 1]) / segLen;
    return {
      x: pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * t - dy * offset,
      y: pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * t + dx * offset,
      dx, dy, seg: i,
    };
  }
}

/**
 * Quão "redondo" é o circuito: 4π·área/perímetro² (círculo = 1, quadrado ≈ 0,79,
 * ida-e-volta de pista dupla ≈ 0).
 */
function compactness(loop: Link[]): number {
  let area = 0, perim = 0;
  for (const l of loop) {
    const p = l.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      area += p[i] * p[i + 3] - p[i + 2] * p[i + 1];
      perim += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    }
  }
  return (4 * Math.PI * Math.abs(area / 2)) / (perim * perim);
}

/**
 * Raio de curva em cada vértice da polilinha: para um desvio θ entre segmentos de
 * comprimento a e b, o arco que cabe tangente aos dois tem R ≈ (min(a, b) / 2) / tan(θ / 2).
 * Só guarda vértices que realmente limitam a velocidade (R < 150 m).
 */
function vertexCurves(pts: Float32Array, cum: Float32Array): Float32Array {
  const out: number[] = [];
  const n = cum.length;
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[2 * i] - pts[2 * i - 2], ay = pts[2 * i + 1] - pts[2 * i - 1];
    const bx = pts[2 * i + 2] - pts[2 * i], by = pts[2 * i + 3] - pts[2 * i + 1];
    const theta = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    if (theta < 0.05) continue;
    const half = Math.min(cum[i] - cum[i - 1], cum[i + 1] - cum[i]) / 2;
    const r = Math.max(3, half / Math.tan(theta / 2));
    if (r < 150) out.push(cum[i], r);
  }
  return Float32Array.from(out);
}

/** Raio da curva ao passar de a para b num cruzamento (a curva cabe no miolo do cruzamento) */
export function junctionRadius(a: Link, b: Link): number {
  const theta = Math.abs(turnAngle(a, b));
  if (theta < 0.05) return Infinity;
  // O motorista abre a curva usando a largura das duas vias (e o miolo do cruzamento)
  const widthA = a.edge.lanesFwd + a.edge.lanesBwd, widthB = b.edge.lanesFwd + b.edge.lanesBwd;
  const corner = Math.max(5, Math.min(25, ((widthA + widthB) * LANE_WIDTH) / 2 + a.setback));
  return Math.max(3, corner / Math.tan(Math.min(theta, 3) / 2));
}

/** Raio da curva a→b usando o valor pré-calculado quando b é um `next` de a */
export function turnRadius(a: Link, b: Link): number {
  const i = a.next.indexOf(b);
  return i >= 0 ? a.nextRadius[i] : junctionRadius(a, b);
}

/** Ângulo a→b usando o valor pré-calculado quando b é um `next` de a */
export function turnOf(a: Link, b: Link): number {
  const i = a.next.indexOf(b);
  return i >= 0 ? a.nextTurn[i] : turnAngle(a, b);
}

/** Ângulo de conversão de a para b: negativo = esquerda, positivo = direita (rad) */
export function turnAngle(a: Link, b: Link): number {
  // y cresce para o sul: cross > 0 significa virar à direita
  return Math.atan2(cross(a.outDir, b.inDir), dot(a.outDir, b.inDir));
}

function unit(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
const cross = (a: [number, number], b: [number, number]) => a[0] * b[1] - a[1] * b[0];
const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];

/** Maior componente fortemente conexa (Tarjan iterativo) */
function largestScc(links: Link[]): Set<number> {
  const n = links.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  let counter = 0;
  let best: number[] = [];
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      const next = links[v].next;
      if (i < next.length) {
        top[1]++;
        const w = next[i].id;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) {
          const u = work[work.length - 1][0];
          low[u] = Math.min(low[u], low[v]);
        }
        if (low[v] === index[v]) {
          const comp: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp.push(w);
          } while (w !== v);
          if (comp.length > best.length) best = comp;
        }
      }
    }
  }
  return new Set(best);
}
