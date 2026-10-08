// A* sobre o grafo de links, custo = tempo de viagem esperado.
// O tempo de cada link vem da média móvel observada (congestionamento), com um ruído
// por motorista para que nem todo mundo escolha exatamente a mesma rota.
import type { Link, SimGraph } from './graph';

const STOP_DELAY = 5;
/**
 * Motoristas preferem a hierarquia viária (arteriais) mesmo quando a rua local parece
 * mais curta: fator sobre o tempo de percurso por classe (rank da via).
 */
const CLASS_FACTOR: Record<number, number> = { 7: 1, 6: 1, 5: 1, 4: 1.05, 3: 1.15, 2: 1.4, 1: 1.8 };
const HEURISTIC_SPEED = 22;
export { STOP_DELAY }; // m/s, maior que qualquer velocidade média real → admissível

export class Router {
  private g: Float64Array;
  private from: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap = new MinHeap();
  expansions = 0;

  /**
   * @param controlDelay espera esperada (s) no fim de cada link: semáforo (Webster) ou PARE
   */
  constructor(private graph: SimGraph, private controlDelay: Float32Array) {
    const n = graph.links.length;
    this.g = new Float64Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /** Rota de `origin` até `dest` (inclusive). `seed` diferencia motoristas. */
  route(origin: Link, dest: Link, seed: number): Link[] | null {
    const { links, net } = this.graph;
    const gen = ++this.gen;
    const target = net.nodes[dest.from];
    const h = (l: Link) => {
      const n = net.nodes[l.to];
      return Math.hypot(n.x - target.x, n.y - target.y) / HEURISTIC_SPEED;
    };
    const heap = this.heap;
    heap.clear();
    this.g[origin.id] = 0;
    this.from[origin.id] = -1;
    this.stamp[origin.id] = gen;
    heap.push(origin.id, h(origin));
    while (heap.size) {
      const id = heap.pop();
      if (this.closed[id] === gen) continue;
      this.closed[id] = gen;
      this.expansions++;
      if (id === dest.id) break;
      const l = links[id];
      const base = this.g[id] + this.linkCost(l, seed);
      for (let i = 0; i < l.next.length; i++) {
        const nx = l.next[i];
        if (this.closed[nx.id] === gen) continue;
        const turn = Math.abs(l.nextTurn[i]);
        const cost = base + (turn > 2.6 ? 40 : turn > 1.0 ? 6 : 0);
        if (this.stamp[nx.id] !== gen || cost < this.g[nx.id]) {
          this.stamp[nx.id] = gen;
          this.g[nx.id] = cost;
          this.from[nx.id] = id;
          heap.push(nx.id, cost + h(nx));
        }
      }
    }
    if (this.closed[dest.id] !== gen) return null;
    const path: Link[] = [];
    for (let id = dest.id; id !== -1; id = this.from[id]) path.push(links[id]);
    return path.reverse();
  }

  private linkCost(l: Link, seed: number): number {
    const free = l.length / (l.vmax * 0.85);
    const tt = Math.max(free, l.ttEma);
    // ruído estável por (motorista, link) em [0.85, 1.35]
    const noise = 0.85 + 0.5 * hash01(seed * 2654435761 + l.id * 40503);
    return tt * noise * (CLASS_FACTOR[l.rank] ?? 1.2) + this.controlDelay[l.id];
  }
}

function hash01(x: number): number {
  x = Math.imul((x ^ (x >>> 16)) >>> 0, 0x45d9f3b);
  x = Math.imul((x ^ (x >>> 16)) >>> 0, 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  clear() {
    this.ids.length = 0;
    this.keys.length = 0;
  }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
