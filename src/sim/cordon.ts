// Demanda de uma subárea (ex.: dentro da Contorno), extraída do modelo da cidade por
// scripts/build-subarea.ts: cada viagem da cidade que passa pela subárea vira uma viagem
// "de onde entra (ou nasce) até onde sai (ou estaciona)" — matriz origem-destino do cordão.
import { Demand, convexHull, pointInPolygon, type DemandCategory, type Trip, type TripKind, type TripSource } from './demand';
import type { Link, SimGraph } from './graph';
import { WeightedPicker, type Rng } from './rng';

/** Formato de public/data/*-od.json */
export interface CordonOD {
  refHour: number;
  /** viagens agregadas: link de origem/destino como [aresta, sentido a→b] */
  trips: { o: [number, number]; d: [number, number]; oGate: 0 | 1; dGate: 0 | 1; kind: TripKind; flow: number }[];
  source: string;
}

interface Pair { origin: Link; dest: Link; fromGate: boolean; toGate: boolean; kind: TripKind; flow: number }

export class CordonDemand implements TripSource {
  readonly contorno: [number, number][];
  readonly entryGates: { link: Link }[];
  readonly categories: DemandCategory[];
  private picker: WeightedPicker<Pair>;
  private total: number;
  private refHour: number;

  constructor(graph: SimGraph, od: CordonOD) {
    const net = graph.net;
    this.contorno = convexHull(
      net.edges.filter((e) => e.name === 'Avenida do Contorno').flatMap((e) => {
        const p: [number, number][] = [];
        for (let i = 0; i < e.pts.length; i += 2) p.push([e.pts[i], e.pts[i + 1]]);
        return p;
      }),
    );
    // aresta + sentido → link da simulação
    const linkOf = new Map<string, Link>();
    for (const l of graph.links) linkOf.set(`${l.edge.id}:${l.forward ? 1 : 0}`, l);
    const pairs: Pair[] = [];
    for (const t of od.trips) {
      const origin = linkOf.get(`${t.o[0]}:${t.o[1]}`), dest = linkOf.get(`${t.d[0]}:${t.d[1]}`);
      if (!origin || !dest || !origin.canStart || !dest.canEnd) continue;
      pairs.push({ origin, dest, fromGate: !!t.oGate, toGate: !!t.dGate, kind: t.kind, flow: t.flow });
    }
    this.picker = new WeightedPicker(pairs, (p) => p.flow);
    this.total = pairs.reduce((s, p) => s + p.flow, 0);
    this.refHour = od.refHour;
    this.entryGates = [...new Set(pairs.filter((p) => p.fromGate).map((p) => p.origin))].map((link) => ({ link }));

    const cat = (label: string, from: 'gate' | 'centro', to: 'gate' | 'centro', kind: TripKind, f: (p: Pair) => boolean): DemandCategory => ({
      kind, from, to, label, flow: pairs.filter(f).reduce((s, p) => s + p.flow, 0),
    });
    this.categories = [
      cat('entram pela Contorno → estacionam dentro', 'gate', 'centro', 'to_work', (p) => p.fromGate && !p.toGate),
      cat('atravessam (entram e saem)', 'gate', 'gate', 'through', (p) => p.fromGate && p.toGate),
      cat('saem de dentro → para fora', 'centro', 'gate', 'outbound', (p) => !p.fromGate && p.toGate),
      cat('de dentro para dentro', 'centro', 'centro', 'local', (p) => !p.fromGate && !p.toGate),
    ];
  }

  ratePerHour(hour: number): number {
    return (this.total * Demand.peakFactor(hour)) / Demand.peakFactor(this.refHour);
  }

  sample(rng: Rng): Trip {
    const p = this.picker.pick(rng);
    return { origin: p.origin, dest: p.dest, kind: p.kind, fromGate: p.fromGate, toGate: p.toGate };
  }

  isInsideContorno(x: number, y: number) {
    return pointInPolygon(x, y, this.contorno);
  }
}
