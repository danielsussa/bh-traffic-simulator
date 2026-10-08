import { Camera } from './camera';
import { LANE_WIDTH, RoadNetwork, type Edge, type RoadClass } from '../map/network';

interface RoadStyle {
  fill: string;
  casing: string;
  /** largura mínima em pixels (zoom afastado) */
  minPx: number;
  /** ordem de desenho: maior fica por cima */
  z: number;
}

const STYLES: Record<RoadClass, RoadStyle> = {
  motorway: { fill: '#7f97b8', casing: '#5f7797', minPx: 3.2, z: 7 },
  trunk: { fill: '#8aa1c0', casing: '#6a82a3', minPx: 3, z: 6 },
  primary: { fill: '#a9bad2', casing: '#8a9dba', minPx: 2.2, z: 5 },
  secondary: { fill: '#c9d4e3', casing: '#a8b6ca', minPx: 1.6, z: 4 },
  tertiary: { fill: '#ffffff', casing: '#c3ccd8', minPx: 1.2, z: 3 },
  unclassified: { fill: '#ffffff', casing: '#cdd4de', minPx: 0.9, z: 2 },
  residential: { fill: '#ffffff', casing: '#cdd4de', minPx: 0.9, z: 2 },
  living_street: { fill: '#f4f4f4', casing: '#d6dbe2', minPx: 0.8, z: 1 },
};

const COLORS = {
  background: '#f3f1ec',
  green: '#cfe8c9',
  water: '#a9d3f0',
  rail: '#b7b2ab',
  laneDivider: 'rgba(255,255,255,0.9)',
  centerLine: '#e8b923',
  arrow: 'rgba(60,75,100,0.55)',
  label: '#3a4250',
  labelHalo: 'rgba(255,255,255,0.92)',
  highlight: '#ff5a36',
  node: '#4a5a73',
};

export interface RenderOptions {
  lanes: boolean;
  arrows: boolean;
  labels: boolean;
  nodes: boolean;
}

interface Group {
  style: RoadStyle;
  widthM: number;
  layer: number;
  path: Path2D;
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  private groups: Group[] = [];
  private greenPath = new Path2D();
  private waterPath = new Path2D();
  private riverPath = new Path2D();
  private railPath = new Path2D();
  private labelChains: LabelChain[];
  highlighted: Edge | null = null;
  selectedName: string | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private net: RoadNetwork,
    private camera: Camera,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.buildPaths();
    // Para rótulos: vias mais importantes e mais longas primeiro
    this.labelChains = buildLabelChains(net).sort((a, b) => b.z - a.z || b.length - a.length);
  }

  private buildPaths() {
    const byKey = new Map<string, Group>();
    for (const e of this.net.edges) {
      const style = STYLES[e.cls];
      const widthM = this.net.totalLanes(e) * LANE_WIDTH;
      const layer = Math.max(-1, Math.min(2, e.layer));
      const key = `${layer}|${e.cls}|${widthM}`;
      let g = byKey.get(key);
      if (!g) byKey.set(key, (g = { style, widthM, layer, path: new Path2D() }));
      addPolyline(g.path, e.pts);
    }
    this.groups = [...byKey.values()].sort(
      (a, b) => a.layer - b.layer || a.style.z - b.style.z || a.widthM - b.widthM,
    );
    for (const a of this.net.areas) {
      const p = a.kind === 'water' ? this.waterPath : this.greenPath;
      addPolyline(p, Float32Array.from(a.pts));
      p.closePath();
    }
    for (const l of this.net.lines) {
      addPolyline(l.kind === 'water' ? this.riverPath : this.railPath, Float32Array.from(l.pts));
    }
  }

  render(opts: RenderOptions, overlay?: () => void) {
    const { ctx, camera: cam } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, cam.width, cam.height);

    // Transformação mundo → tela
    const s = cam.scale;
    ctx.setTransform(
      dpr * s, 0, 0, dpr * s,
      dpr * (cam.width / 2 - cam.cx * s),
      dpr * (cam.height / 2 - cam.cy * s),
    );
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.fillStyle = COLORS.green;
    ctx.fill(this.greenPath);
    ctx.fillStyle = COLORS.water;
    ctx.fill(this.waterPath);
    ctx.strokeStyle = COLORS.water;
    ctx.lineWidth = Math.max(6, 2 / s);
    ctx.stroke(this.riverPath);
    ctx.strokeStyle = COLORS.rail;
    ctx.lineWidth = Math.max(1.5, 1 / s);
    ctx.setLineDash([6, 4].map((v) => v / Math.min(1, s)));
    ctx.stroke(this.railPath);
    ctx.setLineDash([]);

    // Limite da subárea simulada
    if (this.net.cordon) {
      const p = new Path2D();
      addPolyline(p, this.net.cordon);
      p.closePath();
      ctx.strokeStyle = 'rgba(37,99,235,0.35)';
      ctx.lineWidth = Math.max(2, 2.5 / s);
      ctx.setLineDash([12 / Math.min(1, s), 8 / Math.min(1, s)]);
      ctx.stroke(p);
      ctx.setLineDash([]);
    }

    // Vias: por camada (viadutos por cima), primeiro contorno, depois preenchimento
    const casingPx = s > 1.5 ? 1.2 : 0.7;
    const layers = [...new Set(this.groups.map((g) => g.layer))];
    for (const layer of layers) {
      const gs = this.groups.filter((g) => g.layer === layer);
      for (const g of gs) {
        ctx.strokeStyle = g.style.casing;
        ctx.lineWidth = Math.max(g.widthM, g.style.minPx / s) + (2 * casingPx) / s;
        ctx.stroke(g.path);
      }
      for (const g of gs) {
        ctx.strokeStyle = g.style.fill;
        ctx.lineWidth = Math.max(g.widthM, g.style.minPx / s);
        ctx.stroke(g.path);
      }
    }

    const view = cam.viewport();
    const visible = this.net.edges.filter((e) => intersects(e.bbox, view, 20));

    if (opts.lanes && s > 1.6) this.drawLaneMarkings(visible);
    if (opts.arrows && s > 0.9) this.drawArrows(visible);
    this.drawHighlight();
    if (opts.nodes && s > 0.6) this.drawNodes(view);
    overlay?.();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (opts.labels && s > 0.07) this.drawLabels(view);
  }

  private drawLaneMarkings(visible: Edge[]) {
    const { ctx } = this;
    const s = this.camera.scale;
    const L = LANE_WIDTH;
    ctx.lineCap = 'butt';
    for (const e of visible) {
      const total = e.lanesFwd + e.lanesBwd;
      const half = (total * L) / 2;
      // Divisão entre sentidos (só em mão dupla)
      if (e.lanesBwd > 0) {
        const d = ((e.lanesBwd - e.lanesFwd) * L) / 2;
        ctx.strokeStyle = COLORS.centerLine;
        ctx.lineWidth = 0.18;
        ctx.setLineDash([]);
        strokeOffset(ctx, e.pts, d);
      }
      // Divisórias de faixa no mesmo sentido (tracejadas)
      if (total > 1) {
        ctx.strokeStyle = COLORS.laneDivider;
        ctx.lineWidth = Math.max(0.15, 0.8 / s);
        ctx.setLineDash([3, 4]);
        const split = e.lanesBwd > 0 ? e.lanesBwd : -1;
        for (let k = 1; k < total; k++) {
          if (k === split) continue;
          strokeOffset(ctx, e.pts, -half + k * L);
        }
      }
    }
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
  }

  private drawArrows(visible: Edge[]) {
    const { ctx } = this;
    const s = this.camera.scale;
    const size = Math.max(2, 5 / s);
    const spacing = Math.max(60, 160 / s);
    ctx.fillStyle = COLORS.arrow;
    for (const e of visible) {
      if (e.lanesBwd > 0) continue; // setas só em mão única
      const n = Math.max(1, Math.floor(e.length / spacing));
      for (let k = 0; k < n; k++) {
        const at = pointAlong(e.pts, (e.length * (k + 0.5)) / n);
        if (!at) continue;
        const [x, y, dx, dy] = at;
        ctx.beginPath();
        ctx.moveTo(x + dx * size, y + dy * size);
        ctx.lineTo(x - dx * size - dy * size * 0.7, y - dy * size + dx * size * 0.7);
        ctx.lineTo(x - dx * size * 0.4, y - dy * size * 0.4);
        ctx.lineTo(x - dx * size + dy * size * 0.7, y - dy * size - dx * size * 0.7);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  private drawHighlight() {
    const { ctx } = this;
    const s = this.camera.scale;
    if (this.selectedName) {
      ctx.strokeStyle = 'rgba(255,90,54,0.35)';
      ctx.lineWidth = Math.max(4 / s, 8);
      const p = new Path2D();
      for (const e of this.net.edges) if (e.name === this.selectedName) addPolyline(p, e.pts);
      ctx.stroke(p);
    }
    const e = this.highlighted;
    if (!e) return;
    ctx.strokeStyle = COLORS.highlight;
    ctx.lineWidth = Math.max(3 / s, this.net.totalLanes(e) * LANE_WIDTH * 0.5);
    const p = new Path2D();
    addPolyline(p, e.pts);
    ctx.stroke(p);
    for (const id of [e.from, e.to]) {
      const n = this.net.nodes[id];
      ctx.fillStyle = COLORS.highlight;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(4 / s, 2), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawNodes(view: [number, number, number, number]) {
    const { ctx } = this;
    const r = Math.max(1.2, 2 / this.camera.scale);
    ctx.fillStyle = COLORS.node;
    ctx.beginPath();
    for (const n of this.net.nodes) {
      if (n.edges.length < 3) continue; // só cruzamentos de verdade
      if (n.x < view[0] || n.x > view[2] || n.y < view[1] || n.y > view[3]) continue;
      ctx.moveTo(n.x + r, n.y);
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  private drawLabels(view: [number, number, number, number]) {
    const { ctx, camera: cam } = this;
    const s = cam.scale;
    ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const placed: [number, number, number][] = [];
    const minClassZ = s > 1.2 ? 0 : s > 0.7 ? 3 : s > 0.3 ? 4 : 5;
    const pad = 40 / s;
    for (const c of this.labelChains) {
      if (placed.length > 220) break;
      if (c.z < minClassZ) continue;
      if (!intersects(c.bbox, view, pad)) continue;
      const w = ctx.measureText(c.name).width;
      const halfM = (w / 2 + 8) / s;
      if (c.length < halfM * 2) continue;
      // Candidatos espaçados ao longo da cadeia; o primeiro no centro
      const step = (w + 320) / s;
      const n = Math.max(1, Math.floor(c.length / step));
      for (let k = 0; k < n; k++) {
        const d = (c.length * (k + 0.5)) / n;
        if (d < halfM || d > c.length - halfM) continue;
        const a = pointAlong(c.pts, d - halfM), b = pointAlong(c.pts, d + halfM), m = pointAlong(c.pts, d);
        if (!a || !b || !m) continue;
        // Evita curvas fechadas: a corda precisa ser quase o comprimento do texto
        const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (chord < halfM * 1.8) continue;
        const [sx, sy] = cam.toScreen(m[0], m[1]);
        if (sx < 20 || sy < 10 || sx > cam.width - 20 || sy > cam.height - 10) continue;
        const radius = w / 2 + 6;
        if (placed.some(([px, py, pr]) => Math.hypot(px - sx, py - sy) < pr + radius)) continue;
        let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(angle);
        ctx.strokeStyle = COLORS.labelHalo;
        ctx.lineWidth = 3.5;
        ctx.strokeText(c.name, 0, 0);
        ctx.fillStyle = COLORS.label;
        ctx.fillText(c.name, 0, 0);
        ctx.restore();
        placed.push([sx, sy, radius]);
      }
    }
  }
}

interface LabelChain {
  name: string;
  z: number;
  pts: Float32Array;
  length: number;
  bbox: [number, number, number, number];
}

/** Junta trechos consecutivos com o mesmo nome em polilinhas longas (só para rótulos) */
function buildLabelChains(net: RoadNetwork): LabelChain[] {
  const byName = new Map<string, Edge[]>();
  for (const e of net.edges) {
    if (!e.name) continue;
    let list = byName.get(e.name);
    if (!list) byName.set(e.name, (list = []));
    list.push(e);
  }
  const chains: LabelChain[] = [];
  for (const [name, edges] of byName) {
    const atNode = new Map<number, Edge[]>();
    for (const e of edges) {
      for (const n of [e.from, e.to]) {
        let l = atNode.get(n);
        if (!l) atNode.set(n, (l = []));
        l.push(e);
      }
    }
    const used = new Set<number>();
    // Segue a cadeia a partir de `node`, sempre pelo trecho não usado mais alinhado
    const walk = (node: number, dirX: number, dirY: number): number[] => {
      const out: number[] = [];
      for (;;) {
        let best: Edge | null = null, bestDot = 0.3;
        for (const e of atNode.get(node) ?? []) {
          if (used.has(e.id)) continue;
          const seg = oriented(e, node);
          const dx = seg[2] - seg[0], dy = seg[3] - seg[1], l = Math.hypot(dx, dy) || 1;
          const dot = (dx * dirX + dy * dirY) / l;
          if (dot > bestDot) { bestDot = dot; best = e; }
        }
        if (!best) return out;
        used.add(best.id);
        const pts = oriented(best, node);
        for (let i = 2; i < pts.length; i++) out.push(pts[i]);
        const L = pts.length;
        const dx = pts[L - 2] - pts[L - 4], dy = pts[L - 1] - pts[L - 3], l = Math.hypot(dx, dy) || 1;
        dirX = dx / l; dirY = dy / l;
        node = best.from === node ? best.to : best.from;
      }
    };
    const z = Math.max(...edges.map((e) => STYLES[e.cls].z));
    for (const e of [...edges].sort((a, b) => b.length - a.length)) {
      if (used.has(e.id)) continue;
      used.add(e.id);
      const p = Array.from(e.pts), L = p.length;
      const fx = p[L - 2] - p[L - 4], fy = p[L - 1] - p[L - 3], fl = Math.hypot(fx, fy) || 1;
      const bx = p[0] - p[2], by = p[1] - p[3], bl = Math.hypot(bx, by) || 1;
      const ahead = walk(e.to, fx / fl, fy / fl);
      const behind = walk(e.from, bx / bl, by / bl);
      const back: number[] = [];
      for (let i = behind.length - 2; i >= 0; i -= 2) back.push(behind[i], behind[i + 1]);
      const pts = Float32Array.from([...back, ...p, ...ahead]);
      let length = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        if (i) length += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
        x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
      }
      chains.push({ name, z, pts, length, bbox: [x0, y0, x1, y1] });
    }
  }
  return chains;
}

/** Pontos da aresta começando pelo nó `start` */
function oriented(e: Edge, start: number): number[] {
  const p = Array.from(e.pts);
  if (e.from === start) return p;
  const r: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]);
  return r;
}

function addPolyline(path: Path2D, pts: Float32Array) {
  path.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
}

/** Desenha a polilinha deslocada `d` metros para a direita (y para baixo) */
function strokeOffset(ctx: CanvasRenderingContext2D, pts: Float32Array, d: number) {
  const n = pts.length / 2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [nx, ny] = vertexNormal(pts, i, n);
    const x = pts[2 * i] + nx * d, y = pts[2 * i + 1] + ny * d;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Normal à direita no vértice i (média dos segmentos adjacentes, com miter limitado) */
function vertexNormal(pts: Float32Array, i: number, n: number): [number, number] {
  const seg = (j: number): [number, number] => {
    const dx = pts[2 * j + 2] - pts[2 * j], dy = pts[2 * j + 3] - pts[2 * j + 1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  if (i === 0) return seg(0);
  if (i === n - 1) return seg(n - 2);
  const [ax, ay] = seg(i - 1), [bx, by] = seg(i);
  let mx = ax + bx, my = ay + by;
  const ml = Math.hypot(mx, my) || 1;
  mx /= ml; my /= ml;
  const cos = Math.max(0.5, mx * ax + my * ay);
  return [mx / cos, my / cos];
}

/** Ponto e direção unitária a `dist` metros do início da polilinha */
function pointAlong(pts: Float32Array, dist: number): [number, number, number, number] | null {
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const dx = pts[i + 2] - pts[i], dy = pts[i + 3] - pts[i + 1];
    const l = Math.hypot(dx, dy);
    if (l > 0 && acc + l >= dist) {
      const t = (dist - acc) / l;
      return [pts[i] + dx * t, pts[i + 1] + dy * t, dx / l, dy / l];
    }
    acc += l;
  }
  return null;
}

function intersects(b: [number, number, number, number], v: [number, number, number, number], pad: number) {
  return b[2] >= v[0] - pad && b[0] <= v[2] + pad && b[3] >= v[1] - pad && b[1] <= v[3] + pad;
}
