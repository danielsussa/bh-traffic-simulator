// Desenha o estado da simulação por cima do mapa: carros, semáforos e camada de trânsito.
import { Camera } from './camera';
import type { Link } from '../sim/graph';
import type { Simulation } from '../sim/simulation';
import type { Vehicle } from '../sim/vehicle';

/** metade do arco desenhado numa conversão (m, de cada lado do nó) */
const ARC = 7;

// parado → livre, e por último quem está fechando um cruzamento
const CAR_COLORS = ['#d93b30', '#f08a24', '#f2c94c', '#2f9e55', '#c026d3'];
const TRAFFIC_COLORS = ['#8e1b16', '#e0433a', '#f5a33a', '#3fb45f'];
const LIGHT = { green: '#1fbf4c', yellow: '#f7c21b', red: '#e0342b' };

export interface SimRenderOptions {
  cars: boolean;
  signals: boolean;
  traffic: boolean;
}

export class SimRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, private sim: Simulation, private camera: Camera) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Espera que o transform mundo→tela já esteja aplicado (MapRenderer.applyWorldTransform) */
  render(opts: SimRenderOptions) {
    const view = this.camera.viewport();
    const pad = 30;
    const inView = (l: Link) => {
      const b = l.edge.bbox;
      return b[2] >= view[0] - pad && b[0] <= view[2] + pad && b[3] >= view[1] - pad && b[1] <= view[3] + pad;
    };
    const visible = this.sim.graph.links.filter(inView);
    if (opts.traffic) this.drawTraffic(visible);
    if (opts.cars) this.drawBlocked();
    if (opts.cars) this.drawCars(view);
    if (opts.signals) this.drawSignals(view);
  }

  private drawTraffic(links: Link[]) {
    const { ctx } = this;
    const s = this.camera.scale;
    const paths = TRAFFIC_COLORS.map(() => new Path2D());
    for (const l of links) {
      let n = 0;
      for (const lane of l.lanes) n += lane.vehicles.length;
      if (!n && l.speedRatio > 0.85) continue;
      const r = l.speedRatio;
      const bucket = r < 0.15 ? 0 : r < 0.35 ? 1 : r < 0.6 ? 2 : 3;
      const off = l.lanes.reduce((a, la) => a + la.offset, 0) / l.lanes.length;
      offsetPolyline(paths[bucket], l.pts, off);
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 0.75;
    paths.forEach((p, i) => {
      ctx.strokeStyle = TRAFFIC_COLORS[i];
      ctx.lineWidth = Math.max(3.2 / s, 2.5);
      ctx.stroke(p);
    });
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
  }

  /** Halo magenta nos cruzamentos fechados por alguém parado lá dentro */
  private drawBlocked() {
    const { ctx } = this;
    const s = this.camera.scale;
    const nodes = this.sim.graph.net.nodes;
    const r = Math.max(9, 7 / s);
    const p = new Path2D();
    for (const id of this.sim.blockedJunctions()) {
      const n = nodes[id];
      p.moveTo(n.x + r, n.y);
      p.arc(n.x, n.y, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = 'rgba(192,38,211,0.18)';
    ctx.fill(p);
    ctx.strokeStyle = 'rgba(192,38,211,0.8)';
    ctx.lineWidth = Math.max(0.6, 1.5 / s);
    ctx.stroke(p);
  }

  private drawCars(view: [number, number, number, number]) {
    const { ctx, sim } = this;
    const s = this.camera.scale;
    const paths = CAR_COLORS.map(() => new Path2D());
    // Zoom afastado: carro vira um ponto com tamanho mínimo em pixels
    const minW = 2.2 / s;
    const width = Math.max(1.9, minW);
    for (const v of sim.vehicles) {
      const l = v.lane.link;
      const b = l.edge.bbox;
      if (b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]) continue;
      const p = this.carPose(v);
      const len = Math.max(v.len, minW * 1.4);
      const hx = (p.dx * len) / 2, hy = (p.dy * len) / 2;
      const wx = (-p.dy * width) / 2, wy = (p.dx * width) / 2;
      const r = v.v / Math.max(1, l.vmax);
      const bucket = v.blocking ? 4 : v.v < 0.5 ? 0 : r < 0.3 ? 1 : r < 0.6 ? 2 : 3;
      const path = paths[bucket];
      path.moveTo(p.x + hx + wx, p.y + hy + wy);
      path.lineTo(p.x + hx - wx, p.y + hy - wy);
      path.lineTo(p.x - hx - wx, p.y - hy - wy);
      path.lineTo(p.x - hx + wx, p.y - hy + wy);
      path.closePath();
    }
    paths.forEach((p, i) => {
      ctx.fillStyle = CAR_COLORS[i];
      ctx.fill(p);
    });
    if (s > 2) {
      ctx.strokeStyle = 'rgba(30,35,45,0.55)';
      ctx.lineWidth = 0.15;
      paths.forEach((p) => ctx.stroke(p));
    }
  }

  /**
   * Posição/direção do centro do carro. Perto do nó, em vez de seguir a quina da
   * polilinha, percorre um arco (Bézier quadrática) entre a faixa de chegada e a de
   * saída — a conversão aparece como curva.
   */
  private carPose(v: Vehicle): { x: number; y: number; dx: number; dy: number } {
    const g = this.sim.graph;
    const l = v.lane.link;
    const center = v.pos - v.len / 2;
    // O arco começa na linha de retenção (quem está parado nela ainda está reto)
    const arcIn = (link: Link) => Math.max(1.5, Math.min(link.setback, ARC, link.length / 2));
    const arcOut = (link: Link) => Math.min(ARC, link.length / 2);
    // chegando: último trecho do link atual, já com a faixa do próximo definida
    if (v.nextLane && center > l.length - arcIn(l)) {
      const a = arcIn(l), b = arcOut(v.nextLane.link);
      return this.arc(l, v.lat, v.nextLane.link, v.nextLane.offset, (center - (l.length - a)) / (a + b));
    }
    // saindo: começo do link atual, vindo da faixa anterior
    if (v.prevLane && v.prevLane.link.next.includes(l) && center < arcOut(l)) {
      const a = arcIn(v.prevLane.link), b = arcOut(l);
      if (center > -a) return this.arc(v.prevLane.link, v.prevLane.offset, l, v.lat, (a + center) / (a + b));
    }
    const p = g.pointAt(l, Math.max(0, center), v.lat, v.seg);
    v.seg = p.seg;
    return p;
  }

  private arc(a: Link, offA: number, b: Link, offB: number, t: number) {
    const g = this.sim.graph;
    t = Math.max(0, Math.min(1, t));
    const p0 = g.pointAt(a, a.length - Math.max(1.5, Math.min(a.setback, ARC, a.length / 2)), offA, a.cum.length - 2);
    const endA = g.pointAt(a, a.length, offA, a.cum.length - 2);
    const startB = g.pointAt(b, 0, offB, 0);
    const p2 = g.pointAt(b, Math.min(ARC, b.length / 2), offB, 0);
    const cx = (endA.x + startB.x) / 2, cy = (endA.y + startB.y) / 2;
    const u = 1 - t;
    const x = u * u * p0.x + 2 * u * t * cx + t * t * p2.x;
    const y = u * u * p0.y + 2 * u * t * cy + t * t * p2.y;
    let dx = 2 * u * (cx - p0.x) + 2 * t * (p2.x - cx);
    let dy = 2 * u * (cy - p0.y) + 2 * t * (p2.y - cy);
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    return { x, y, dx, dy };
  }

  private drawSignals(view: [number, number, number, number]) {
    const { ctx, sim } = this;
    const s = this.camera.scale;
    if (s < 0.12) return;
    const g = sim.graph;
    // [real, estimado] por cor
    const mk = () => ({ green: new Path2D(), yellow: new Path2D(), red: new Path2D() });
    const groups = [mk(), mk()];
    const r = Math.max(1.4, 2.3 / s);
    const lines = s > 1.2;
    for (const c of sim.signals.controllers) {
      if (c.x < view[0] - 50 || c.x > view[2] + 50 || c.y < view[1] - 50 || c.y > view[3] + 50) continue;
      const byState = groups[c.inferred ? 1 : 0];
      c.phases.forEach((ph, pi) => {
        // Apagão: todos em amarelo piscante (liga/desliga a cada 0,6 s de tempo real)
        if (!sim.signalsOn && Math.floor(performance.now() / 600) % 2) return;
        const path = byState[sim.signalsOn ? sim.signals.state(c.id, pi, sim.t).state : 'yellow'];
        for (const l of ph.links) {
          const at = Math.max(0, l.length - l.setback);
          if (lines) {
            // Linha de retenção pintada com a cor do semáforo
            const first = l.lanes[0].offset - 1.6, last = l.lanes[l.lanes.length - 1].offset + 1.6;
            const a = g.pointAt(l, at, first), b = g.pointAt(l, at, last);
            path.moveTo(a.x, a.y);
            path.lineTo(b.x, b.y);
          } else {
            const p = g.pointAt(l, at, l.lanes[l.lanes.length - 1].offset + 2);
            path.moveTo(p.x + r, p.y);
            path.arc(p.x, p.y, r, 0, Math.PI * 2);
          }
        }
      });
    }
    groups.forEach((byState, inferred) => {
      for (const st of ['red', 'yellow', 'green'] as const) {
        const path = byState[st];
        if (lines) {
          // Estimado: linha tracejada
          ctx.setLineDash(inferred ? [0.9, 0.7] : []);
          ctx.strokeStyle = LIGHT[st];
          ctx.lineWidth = 0.9;
          ctx.lineCap = 'butt';
          ctx.stroke(path);
          ctx.setLineDash([]);
          ctx.lineCap = 'round';
        } else if (inferred) {
          // Estimado: anel vazado
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fill(path);
          ctx.strokeStyle = LIGHT[st];
          ctx.lineWidth = Math.max(0.5, 1.4 / s);
          ctx.stroke(path);
        } else {
          ctx.fillStyle = LIGHT[st];
          ctx.fill(path);
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = Math.max(0.3, 0.8 / s);
          ctx.stroke(path);
        }
      }
    });
  }
}

function offsetPolyline(path: Path2D, pts: Float32Array, d: number) {
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = Math.min(i, n - 2);
    const dx = pts[2 * j + 2] - pts[2 * j], dy = pts[2 * j + 3] - pts[2 * j + 1];
    const l = Math.hypot(dx, dy) || 1;
    const x = pts[2 * i] - (dy / l) * d, y = pts[2 * i + 1] + (dx / l) * d;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
}
