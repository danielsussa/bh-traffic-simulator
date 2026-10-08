// Semáforos de tempo fixo ("normais"): os pontos de semáforo do OSM próximos entre si
// formam um cruzamento controlado; as aproximações são agrupadas em fases pela
// direção (eixos paralelos abrem juntos). Ciclo: verde → amarelo → vermelho geral.
import type { Link, SimGraph } from './graph';
import type { Rng } from './rng';

export type LightState = 'green' | 'yellow' | 'red';

export const YELLOW = 3;
export const ALL_RED = 2;
const CLUSTER_RADIUS = 35;
/** cruzamentos a esta distância de um semáforo pertencem ao mesmo grupo */
const JUNCTION_ATTACH = 25;
/** semáforo estimado só onde não há semáforo do OSM a menos desta distância */
const INFER_CLEARANCE = 45;

export interface Phase {
  green: number;
  links: Link[];
  /** direção média do eixo (rad, módulo π) */
  axis: number;
}

export interface SignalController {
  id: number;
  x: number;
  y: number;
  phases: Phase[];
  /** fase só de pedestres (todos os veículos em vermelho), em segundos; 0 = não há */
  pedestrian: number;
  cycle: number;
  offset: number;
  /** true = não está no OSM, foi estimado (cruzamento de avenidas dentro do Contorno) */
  inferred: boolean;
  /** nós do grafo que formam o cruzamento */
  members: Set<number>;
}

export class SignalSystem {
  readonly controllers: SignalController[] = [];

  constructor(
    private graph: SimGraph,
    private rng: Rng,
    /** região onde cruzamentos de avenida sem dado ganham semáforo estimado */
    inferArea?: (x: number, y: number) => boolean,
  ) {
    const approaches = graph.links.filter((l) => l.control === 'signal');
    const nodes = graph.net.nodes;

    // 1) Semáforos do OSM: agrupa os nós de retenção próximos
    const stopNodes = [...new Set(approaches.map((l) => l.to))];
    for (const members of clusterNodes(stopNodes, nodes, CLUSTER_RADIUS)) {
      // Cruzamentos colados no semáforo fazem parte dele (ex.: faixa de pedestre
      // logo depois do cruzamento não é um segundo semáforo)
      for (const n of nodes) {
        if (n.edges.length < 3 || members.has(n.id)) continue;
        for (const m of members) {
          if (Math.hypot(nodes[m].x - n.x, nodes[m].y - n.y) < JUNCTION_ATTACH) {
            members.add(n.id);
            break;
          }
        }
      }
      // Links vindos de dentro do próprio cruzamento já passaram por um semáforo
      const links = approaches.filter((l) => members.has(l.to) && !members.has(l.from));
      for (const l of approaches) if (members.has(l.to) && members.has(l.from)) l.control = null;
      if (links.length) this.addController(members, links, false);
    }

    // 2) Semáforos estimados: cruzamentos de avenida sem dado no OSM
    if (inferArea) this.inferSignals(inferArea);
  }

  private inferSignals(inside: (x: number, y: number) => boolean) {
    const { graph } = this;
    const nodes = graph.net.nodes;
    const covered: { x: number; y: number }[] = [];
    for (const c of this.controllers) for (const m of c.members) covered.push(nodes[m]);
    const candidates: number[] = [];
    for (const n of nodes) {
      if (n.edges.length < 3 || !inside(n.x, n.y)) continue;
      if (graph.incoming[n.id].some((l) => l.edge.roundabout)) continue;
      // Alças não contam; precisa cruzar 2+ vias com nome, sendo ao menos uma avenida
      // (no OSM de BH várias avenidas estão como tertiary, então o nome também vale)
      const named = graph.incoming[n.id].filter((l) => !l.edge.isLink && l.rank >= 3 && l.edge.name);
      const names = new Set(named.map((l) => l.edge.name));
      if (names.size < 2 || !named.some(isAvenue)) continue;
      if (covered.some((p) => Math.abs(p.x - n.x) < INFER_CLEARANCE && Math.hypot(p.x - n.x, p.y - n.y) < INFER_CLEARANCE)) continue;
      candidates.push(n.id);
    }
    for (const members of clusterNodes(candidates, nodes, CLUSTER_RADIUS)) {
      const links = graph.links.filter((l) => members.has(l.to) && !members.has(l.from) && !l.edge.isLink);
      if (links.length < 2) continue;
      // Precisa haver pelo menos dois eixos de chegada (senão não há conflito)
      if (groupByAxis(links).length < 2) continue;
      for (const l of links) l.control = 'signal';
      this.addController(members, links, true);
    }
  }

  private addController(members: Set<number>, links: Link[], inferred: boolean) {
    const nodes = this.graph.net.nodes;
    const phases = groupByAxis(links);
    // Semáforo num só eixo (travessia de pedestres): fase de pedestres curta; muitos são
    // de botoeira na vida real, então os carros ficam com a maior parte do ciclo
    const pedestrian = phases.length === 1 ? 15 : 0;
    // Verde total cresce com o número de fases; dividido pelo "peso" das aproximações
    const totalGreen = phases.length === 1 ? 60 : phases.length === 2 ? 70 : 60 + 15 * phases.length;
    const weights = phases.map((p) => p.links.reduce((s, l) => s + l.lanes.length * (1 + l.rank / 3), 0));
    const wsum = weights.reduce((a, b) => a + b, 0);
    phases.forEach((p, i) => (p.green = Math.max(14, Math.round((totalGreen * weights[i]) / wsum))));
    const cycle =
      phases.reduce((s, p) => s + p.green + YELLOW + ALL_RED, 0) + (pedestrian ? pedestrian + ALL_RED : 0);
    let x = 0, y = 0;
    for (const n of members) { x += nodes[n].x; y += nodes[n].y; }
    const ctrl: SignalController = {
      id: this.controllers.length,
      x: x / members.size,
      y: y / members.size,
      phases,
      pedestrian,
      cycle,
      offset: this.rng() * cycle, // sem coordenação ("onda verde") entre cruzamentos
      inferred,
      members,
    };
    phases.forEach((p, pi) => p.links.forEach((l) => (l.signal = { controller: ctrl.id, phase: pi })));
    this.controllers.push(ctrl);
  }

  /** Estado do semáforo para a fase `phase` do controlador no instante t (s) */
  state(ctrlId: number, phase: number, t: number): { state: LightState; remaining: number } {
    const c = this.controllers[ctrlId];
    let tc = (t + c.offset) % c.cycle;
    for (let i = 0; i < c.phases.length; i++) {
      const g = c.phases[i].green;
      const span = g + YELLOW + ALL_RED;
      if (tc < span) {
        if (i !== phase) return { state: 'red', remaining: this.untilGreen(c, phase, t) };
        if (tc < g) return { state: 'green', remaining: g - tc };
        if (tc < g + YELLOW) return { state: 'yellow', remaining: g + YELLOW - tc };
        return { state: 'red', remaining: this.untilGreen(c, phase, t) };
      }
      tc -= span;
    }
    return { state: 'red', remaining: this.untilGreen(c, phase, t) };
  }

  private untilGreen(c: SignalController, phase: number, t: number): number {
    let start = 0;
    for (let i = 0; i < phase; i++) start += c.phases[i].green + YELLOW + ALL_RED;
    const tc = (t + c.offset) % c.cycle;
    return (start - tc + c.cycle) % c.cycle;
  }
}

const isAvenue = (l: Link) => l.rank >= 4 || /^Avenida\b/.test(l.edge.name ?? '');

/** Agrupa nós a menos de `radius` metros entre si (ligação simples, union-find) */
function clusterNodes(ids: number[], nodes: { x: number; y: number }[], radius: number): Set<number>[] {
  const parent = new Map<number, number>(ids.map((n) => [n, n]));
  const find = (n: number): number => {
    while (parent.get(n) !== n) n = parent.get(n)!;
    return n;
  };
  const sorted = [...ids].sort((a, b) => nodes[a].x - nodes[b].x);
  for (let i = 0; i < sorted.length; i++) {
    const a = nodes[sorted[i]];
    for (let j = i + 1; j < sorted.length && nodes[sorted[j]].x - a.x < radius; j++) {
      const b = nodes[sorted[j]];
      if (Math.hypot(a.x - b.x, a.y - b.y) < radius) parent.set(find(sorted[i]), find(sorted[j]));
    }
  }
  const out = new Map<number, Set<number>>();
  for (const n of ids) {
    const r = find(n);
    if (!out.has(r)) out.set(r, new Set());
    out.get(r)!.add(n);
  }
  return [...out.values()];
}

/** Agrupa aproximações cujo sentido de chegada é paralelo (±30°), no máximo 4 fases */
function groupByAxis(links: Link[]): Phase[] {
  const angle = (l: Link) => {
    let a = Math.atan2(l.outDir[1], l.outDir[0]);
    if (a < 0) a += Math.PI;
    return a % Math.PI;
  };
  const diff = (a: number, b: number) => {
    const d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  };
  const phases: Phase[] = [];
  // Vias mais importantes definem os eixos primeiro
  for (const l of [...links].sort((a, b) => b.rank - a.rank || b.lanes.length - a.lanes.length)) {
    const a = angle(l);
    let best: Phase | null = null, bestD = Math.PI / 6;
    for (const p of phases) {
      const d = diff(p.axis, a);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best && phases.length >= 4) {
      best = phases.reduce((m, p) => (diff(p.axis, a) < diff(m.axis, a) ? p : m));
    }
    if (best) best.links.push(l);
    else phases.push({ green: 0, links: [l], axis: a });
  }
  return phases;
}
