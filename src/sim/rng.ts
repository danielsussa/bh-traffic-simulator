export type Rng = () => number;

/** Gerador determinístico (mulberry32) para simulações reproduzíveis */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Amostragem ponderada com tabela acumulada + busca binária */
export class WeightedPicker<T> {
  private cum: Float64Array;
  constructor(private items: T[], weight: (t: T) => number) {
    this.cum = new Float64Array(items.length);
    let acc = 0;
    items.forEach((it, i) => (this.cum[i] = acc += Math.max(0, weight(it))));
  }
  get size() {
    return this.items.length;
  }
  pick(rng: Rng): T {
    const total = this.cum[this.cum.length - 1];
    const r = rng() * total;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return this.items[lo];
  }
}
