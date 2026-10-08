// Modelo do grafo viário carregado de public/data/*.json (gerado por scripts/build-map.mjs).
// Convenções: coordenadas em metros, x → leste, y → sul. Mão de direção: a direita
// (Brasil), então as faixas "forward" (a→b) ficam à direita do sentido a→b.

export const LANE_WIDTH = 3.2;

export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary'
  | 'residential' | 'unclassified' | 'living_street';

interface RawEdge {
  a: number;
  b: number;
  pts: number[];
  len: number;
  hw: string;
  name: number;
  lf: number;
  lb: number;
  v: number;
  layer?: number;
  rb?: 1;
  /** Controle na chegada em b / em a: S = semáforo, P = PARE */
  cb?: 'S' | 'P';
  ca?: 'S' | 'P';
  osm: number;
}

export type Control = 'signal' | 'stop' | null;
const CONTROL: Record<string, Control> = { S: 'signal', P: 'stop' };

interface RawMap {
  meta: {
    name: string;
    bounds: [number, number, number, number];
    clip: [number, number, number, number];
    /** polígono do recorte de subárea [x0, y0, x1, y1, ...], se houver */
    cordon?: number[];
    source: string;
  };
  names: string[];
  nodes: [number, number][];
  edges: RawEdge[];
  areas: { kind: 'green' | 'water'; pts: number[] }[];
  lines: { kind: 'water' | 'rail'; pts: number[] }[];
}

export interface Edge {
  id: number;
  from: number;
  to: number;
  /** Polilinha achatada [x0, y0, x1, y1, ...] de from → to */
  pts: Float32Array;
  length: number;
  cls: RoadClass;
  isLink: boolean;
  name: string | null;
  /** Faixas no sentido from→to e to→from (0 = mão única) */
  lanesFwd: number;
  lanesBwd: number;
  /** km/h */
  maxSpeed: number;
  layer: number;
  roundabout: boolean;
  /** Controle de tráfego para quem chega em `to` (sentido from→to) / em `from` (to→from) */
  controlAtTo: Control;
  controlAtFrom: Control;
  osmId: number;
  bbox: [number, number, number, number];
}

export interface GraphNode {
  id: number;
  x: number;
  y: number;
  /** Arestas que tocam o nó (independente do sentido) */
  edges: number[];
}

export class RoadNetwork {
  readonly name: string;
  readonly source: string;
  readonly bounds: [number, number, number, number];
  /** Recorte da extração OSM (x0, y0, x1, y1) */
  readonly clip: [number, number, number, number];
  readonly cordon: Float32Array | null;
  readonly nodes: GraphNode[];
  readonly edges: Edge[];
  readonly areas: RawMap['areas'];
  readonly lines: RawMap['lines'];
  private grid = new Map<number, number[]>();
  private static CELL = 80;

  private constructor(raw: RawMap) {
    this.name = raw.meta.name;
    this.source = raw.meta.source;
    this.bounds = raw.meta.bounds;
    const [cx0, cy0, cx1, cy1] = raw.meta.clip;
    this.cordon = raw.meta.cordon ? Float32Array.from(raw.meta.cordon) : null;
    this.clip = [Math.min(cx0, cx1), Math.min(cy0, cy1), Math.max(cx0, cx1), Math.max(cy0, cy1)];
    this.areas = raw.areas;
    this.lines = raw.lines;
    this.nodes = raw.nodes.map(([x, y], id) => ({ id, x, y, edges: [] }));
    this.edges = raw.edges.map((e, id) => {
      const pts = Float32Array.from(e.pts);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
      }
      return {
        id,
        from: e.a,
        to: e.b,
        pts,
        length: e.len,
        cls: e.hw.replace(/_link$/, '') as RoadClass,
        isLink: e.hw.endsWith('_link'),
        name: e.name >= 0 ? raw.names[e.name] : null,
        lanesFwd: e.lf,
        lanesBwd: e.lb,
        maxSpeed: e.v,
        layer: e.layer ?? 0,
        roundabout: !!e.rb,
        controlAtTo: e.cb ? CONTROL[e.cb] : null,
        controlAtFrom: e.ca ? CONTROL[e.ca] : null,
        osmId: e.osm,
        bbox: [x0, y0, x1, y1],
      };
    });
    for (const e of this.edges) {
      this.nodes[e.from].edges.push(e.id);
      if (e.to !== e.from) this.nodes[e.to].edges.push(e.id);
      this.indexEdge(e);
    }
  }

  static async load(url: string): Promise<RoadNetwork> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao carregar ${url}: ${res.status}`);
    return new RoadNetwork(await res.json());
  }

  static fromJSON(raw: unknown): RoadNetwork {
    return new RoadNetwork(raw as RawMap);
  }

  totalLanes(e: Edge): number {
    return e.lanesFwd + e.lanesBwd;
  }

  isOneWay(e: Edge): boolean {
    return e.lanesBwd === 0;
  }

  /** Arestas pelas quais um veículo pode sair do nó */
  outgoing(node: number): { edge: Edge; forward: boolean }[] {
    const out: { edge: Edge; forward: boolean }[] = [];
    for (const id of this.nodes[node].edges) {
      const e = this.edges[id];
      if (e.from === node && e.lanesFwd > 0) out.push({ edge: e, forward: true });
      if (e.to === node && e.lanesBwd > 0) out.push({ edge: e, forward: false });
    }
    return out;
  }

  /** Aresta mais próxima de (x, y) dentro de maxDist metros */
  pickEdge(x: number, y: number, maxDist: number): Edge | null {
    const C = RoadNetwork.CELL;
    const r = Math.ceil(maxDist / C);
    const cx = Math.floor(x / C), cy = Math.floor(y / C);
    let best: Edge | null = null;
    let bestD = maxDist * maxDist;
    const seen = new Set<number>();
    for (let gx = cx - r; gx <= cx + r; gx++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        for (const id of this.grid.get(cellKey(gx, gy)) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const e = this.edges[id];
          const p = e.pts;
          for (let i = 0; i + 3 < p.length; i += 2) {
            const d = distSqToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]);
            // Vias por cima (viadutos) ganham um pequeno desempate
            const adj = d - e.layer * 4;
            if (adj < bestD) {
              bestD = adj;
              best = e;
            }
          }
        }
      }
    }
    return best;
  }

  private indexEdge(e: Edge) {
    const C = RoadNetwork.CELL;
    const [x0, y0, x1, y1] = e.bbox;
    for (let gx = Math.floor(x0 / C); gx <= Math.floor(x1 / C); gx++) {
      for (let gy = Math.floor(y0 / C); gy <= Math.floor(y1 / C); gy++) {
        const k = cellKey(gx, gy);
        let cell = this.grid.get(k);
        if (!cell) this.grid.set(k, (cell = []));
        cell.push(e.id);
      }
    }
  }
}

const cellKey = (gx: number, gy: number) => (gx + 32768) * 65536 + (gy + 32768);

function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}
