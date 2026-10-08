// Simulação microscópica: cada carro segue o da frente pelo modelo IDM (Intelligent
// Driver Model), respeita semáforos, PARE e preferência nos cruzamentos, e percorre
// uma rota calculada por tempo de viagem.
import type { RoadNetwork } from '../map/network';
import { Demand, pointInPolygon, type TripKind, type TripSource } from './demand';
import { FRICTION_BUFFER, URBAN_FRICTION } from './calibration';
import { SimGraph, turnOf, turnRadius, type Lane, type Link } from './graph';
import { Router, STOP_DELAY } from './router';
import { mulberry32, type Rng } from './rng';
import { SignalSystem, YELLOW } from './signals';
import { makeDriver, pickStyle, type DriverStyle } from './drivers';
import type { StopReason, Vehicle } from './vehicle';

export const DT = 0.25; // passo de integração (s)
const MAX_DECEL = 9;
const STUCK_LIMIT = 240; // s parado → removido (evita travamentos permanentes)
const YIELD_GAP = 3.5; // s: brecha mínima para entrar num cruzamento sem semáforo
const MERGE_GAP = 1.6; // s: brecha numa confluência (intercalar)
const YIELD_GIVE_UP = 12; // s esperando brecha → força a passagem
const TURN_ANGLE = 0.5; // rad (~29°): acima disso é conversão, abaixo é "reto"
const REROUTE_AFTER = 20; // s bloqueado esperando espaço antes de procurar outro caminho
const ENROUTE_DELAY = 60; // s de atraso nos próximos trechos para recalcular a rota
const ENROUTE_BUDGET = 4; // recálculos por passo, no máximo (~16/s de simulação)
const APAGAO_DELAY = 8; // s: espera esperada num cruzamento com semáforo apagado (roteador)
const LOOKAHEAD = 70; // m: distância para escolher a faixa do próximo link
const SHORT_LINK = 120; // m: trecho curto demais para trocar de faixa dentro dele
// Troca de faixa (MOBIL simplificado; limiar, folga e frenagem aceita vêm do perfil do motorista)
const LC_KEEP_RIGHT = 0.1; // viés para a direita
const LC_MANDATORY_ZONE = 150; // m antes do fim: só troca por vantagem se continuar numa faixa válida
const LATERAL_SPEED = 1.4; // m/s: velocidade da manobra lateral (animação)

export interface SimStats {
  active: number;
  spawned: number;
  arrived: number;
  removedStuck: number;
  rerouted: number;
  /** avançaram o sinal vermelho (acumulado) */
  ranRed: number;
  signalsOn: boolean;
  /** carros parados dentro de um cruzamento agora */
  blockingNow: number;
  byStyle: Record<DriverStyle, number>;
  waitingToEnter: number;
  meanSpeedKmh: number;
  stoppedPct: number;
  atRed: number;
  avgTripMin: number;
  avgTripToWorkMin: number;
  demandPerHour: number;
}

export class Simulation {
  readonly graph: SimGraph;
  readonly signals: SignalSystem;
  readonly demand: TripSource;
  readonly router: Router;
  readonly vehicles: Vehicle[] = [];
  private rng: Rng;
  /** relógio em segundos desde 00:00 */
  t: number;
  /** multiplicador da demanda calibrada (1 = volume real contado pela BHTrans) */
  demandScale = 1;
  /** fração de motoristas ruins (apressados + barbeiros) entre os que entram */
  chaos = 0.3;
  /** semáforos funcionando (false = apagão, amarelo piscante) — mude com setSignals */
  signalsOn = true;
  private delays: Float32Array | null = null;
  /** nós com cruzamento fechado neste passo → link de quem está parado dentro */
  private blockedNodes = new Map<number, Link>();
  /** quem está no miolo de cada cruzamento sem semáforo (e em que direção) */
  /** nós que pertencem a um cruzamento semaforizado */
  private signalNodes: Set<number>;
  private occupancy = new Map<number, { v: Vehicle; dir: [number, number] }[]>();
  private spawnAcc = 0;
  private nextId = 1;
  private backlog = new Map<Link, Vehicle[]>();
  private conflicts: Link[][];
  private rerouteQueue = new Set<Vehicle>();
  private gateLinks: Set<Link>;
  private lastMetrics = 0;
  private stepCount = 0;
  private stats = {
    spawned: 0, arrived: 0, removedStuck: 0, rerouted: 0, ranRed: 0,
    tripSum: 0, tripN: 0, workSum: 0, workN: 0,
  };
  /** tempo gasto em roteamento no último passo (ms) */
  routingMs = 0;

  /**
   * @param makeDemand fonte de viagens; padrão: demanda calibrada da cidade (Demand)
   */
  constructor(
    net: RoadNetwork,
    seed = 42,
    startClock = 9.5 * 3600,
    makeDemand: (g: SimGraph) => TripSource = (g) => new Demand(g),
  ) {
    this.rng = mulberry32(seed);
    this.graph = new SimGraph(net);
    this.demand = makeDemand(this.graph);
    this.applyUrbanFriction();
    this.signals = new SignalSystem(this.graph, this.rng, (x, y) => this.demand.isInsideContorno(x, y));
    this.router = new Router(this.graph, this.controlDelays());
    this.t = startClock;
    this.signalNodes = new Set(this.signals.controllers.flatMap((c) => [...c.members]));
    this.conflicts = this.graph.links.map((l) => this.computeConflicts(l));
    this.gateLinks = new Set(this.demand.entryGates.map((g) => g.link));
  }

  /**
   * Espera média esperada no fim de cada link. Semáforo: fórmula de Webster para chegadas
   * uniformes, (ciclo − verde)² / (2·ciclo) — aproximação com muito verde espera pouco.
   */
  private controlDelays(): Float32Array {
    const d = this.delays ?? new Float32Array(this.graph.links.length);
    this.delays = d;
    for (const l of this.graph.links) {
      d[l.id] = 0;
      if (l.signal && !this.signalsOn) d[l.id] = APAGAO_DELAY;
      else if (l.signal) {
        const c = this.signals.controllers[l.signal.controller];
        const red = c.cycle - c.phases[l.signal.phase].green;
        d[l.id] = (red * red) / (2 * c.cycle);
      } else if (l.control === 'stop') d[l.id] = STOP_DELAY;
    }
    return d;
  }

  /**
   * Reduz a velocidade desejada (vmax efetivo) dos links dentro da Contorno pelo atrito
   * urbano; o limite da via continua em edge.maxSpeed.
   */
  private applyUrbanFriction() {
    const hull = this.demand.contorno;
    if (hull.length < 3) return;
    const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
    const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
    const poly = hull.map(([x, y]): [number, number] => {
      const d = Math.hypot(x - cx, y - cy);
      return [cx + ((x - cx) * (d + FRICTION_BUFFER)) / d, cy + ((y - cy) * (d + FRICTION_BUFFER)) / d];
    });
    const nodes = this.graph.net.nodes;
    for (const l of this.graph.links) {
      const a = nodes[l.from], b = nodes[l.to];
      if (!pointInPolygon((a.x + b.x) / 2, (a.y + b.y) / 2, poly)) continue;
      l.vmax *= URBAN_FRICTION[l.rank] ?? 0.85;
      l.ttEma = l.length / l.vmax;
    }
  }

  /** Controle efetivo do link: com os semáforos apagados, a aproximação fica sem controle */
  private ctl(l: Link) {
    return l.control === 'signal' && !this.signalsOn ? null : l.control;
  }

  /**
   * Liga/desliga os semáforos (apagão: amarelo piscante). Desligados, cada cruzamento
   * funciona pela preferência — via principal, quem vem da direita, rotatória, PARE.
   */
  setSignals(on: boolean) {
    if (on === this.signalsOn) return;
    this.signalsOn = on;
    this.conflicts = this.graph.links.map((l) => this.computeConflicts(l));
    this.controlDelays(); // atualiza o custo usado pelo roteador (mesmo array)
    for (const v of this.vehicles) v.committed = false;
  }

  // ------------------------------------------------------------------ passo

  step(dt = DT) {
    this.spawn(dt);
    this.stepCount++;
    this.findBlockedJunctions();
    // Cada carro avalia troca de faixa a cada ~1s (escalonado pelo id)
    for (const v of this.vehicles) {
      if (v.lcCooldown > 0) v.lcCooldown -= dt;
      if ((this.stepCount + v.id) % 4 === 0) this.tryLaneChange(v);
    }
    const accs = new Float64Array(this.vehicles.length);
    for (let i = 0; i < this.vehicles.length; i++) accs[i] = this.acceleration(this.vehicles[i], dt);
    const done: Vehicle[] = [];
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      v.acc = accs[i];
      const nv = Math.max(0, v.v + v.acc * dt);
      v.pos += nv === 0 ? 0 : (v.v + nv) * 0.5 * dt;
      v.v = nv;
      v.stuck = v.v < 0.3 ? v.stuck + dt : 0;
      // manobra lateral suave até o eixo da faixa atual
      const dLat = v.lane.offset - v.lat;
      v.lat += Math.sign(dLat) * Math.min(Math.abs(dLat), LATERAL_SPEED * dt);
      if (this.advance(v)) done.push(v);
      else if (v.stuck > STUCK_LIMIT) {
        this.remove(v);
        v.done = true;
        this.stats.removedStuck++;
        done.push(v);
      }
    }
    if (done.length) {
      const set = new Set(done);
      let j = 0;
      for (const v of this.vehicles) if (!set.has(v)) this.vehicles[j++] = v;
      this.vehicles.length = j;
    }
    this.enforceSpacing();
    // Recalcula rotas de quem tem congestionamento à frente (cota por passo)
    let budget = ENROUTE_BUDGET;
    for (const v of this.rerouteQueue) {
      this.rerouteQueue.delete(v);
      if (v.ri >= v.route.length - 2 || v.done) continue;
      this.rerouteFromHere(v);
      if (--budget <= 0) break;
    }
    this.t += dt;
    if (this.t - this.lastMetrics >= 2) {
      this.updateLinkMetrics(this.t - this.lastMetrics);
      this.lastMetrics = this.t;
    }
  }

  /**
   * Cruzamento fechado: carro que passou da linha de retenção e ficou parado dentro do
   * cruzamento porque não tem espaço do outro lado. Enquanto estiver lá, o tráfego
   * transversal não passa (mesmo com verde).
   */
  private findBlockedJunctions() {
    this.blockedNodes.clear();
    this.occupancy.clear();
    const nodes = this.graph.net.nodes;
    for (const v of this.vehicles) {
      v.blocking = false;
      // Quem está atravessando um cruzamento sem semáforo ocupa o miolo: passou da linha
      // de retenção e ainda não saiu, ou acabou de entrar no link seguinte (traseira dentro)
      const cur = v.lane.link;
      if (v.ri < v.route.length - 1 && cur.length - v.pos < cur.setback && this.isUncontrolledJunction(cur)) {
        this.occupy(cur.to, v, cur.outDir);
      } else if (v.prevLane && v.pos - v.len < 1 && this.isUncontrolledJunction(v.prevLane.link)) {
        this.occupy(cur.from, v, cur.inDir);
      }
      if (v.v > 0.8 || !v.nextLane || v.ri >= v.route.length - 1) continue;
      const l = v.lane.link;
      if (l.setback < 2 || l.length - v.pos > l.setback - 0.5) continue; // ainda antes da linha
      if (nodes[l.to].edges.length < 3 || !laneBlocked(v.nextLane, v.len)) continue;
      v.blocking = true;
      this.blockedNodes.set(l.to, l);
    }
  }

  /** Aproximação de um cruzamento cujo semáforo está apagado */
  private isDarkSignal(l: Link): boolean {
    return !this.signalsOn && (!!l.signal || this.signalNodes.has(l.to)) && this.graph.net.nodes[l.to].edges.length >= 3;
  }

  /** Cruzamento de verdade cuja aproximação `l` não tem semáforo funcionando */
  private isUncontrolledJunction(l: Link): boolean {
    if (this.ctl(l) === 'signal') return false;
    // nós internos de um cruzamento semaforizado (pista dupla): quem chega já passou pelo sinal
    if (this.signalsOn && this.signalNodes.has(l.to)) return false;
    return this.graph.net.nodes[l.to].edges.length >= 3 && this.graph.incoming[l.to].length >= 2;
  }

  private occupy(node: number, v: Vehicle, dir: [number, number]) {
    let list = this.occupancy.get(node);
    if (!list) this.occupancy.set(node, (list = []));
    list.push({ v, dir });
  }

  /** Alguém de uma direção que cruza a minha está no miolo do cruzamento? */
  private junctionOccupied(v: Vehicle, link: Link): boolean {
    const list = this.occupancy.get(link.to);
    if (!list) return false;
    const [dx, dy] = link.outDir;
    for (const o of list) {
      if (o.v === v) continue;
      // direções que se cruzam (> ~30°); mesma direção ou sentido oposto não conflitam
      if (Math.abs(dx * o.dir[1] - dy * o.dir[0]) > 0.5) return true;
    }
    return false;
  }

  /** Nós fechados agora (alguém parado dentro do cruzamento) */
  blockedJunctions(): number[] {
    return [...this.blockedNodes.keys()];
  }

  /** Aceleração IDM considerando líder, semáforo, preferência e destino */
  private acceleration(v: Vehicle, dt: number): number {
    const link = v.lane.link;
    const toEnd = link.length - v.pos;
    const isLast = v.ri === v.route.length - 1;
    const next = isLast ? null : v.route[v.ri + 1];

    // Velocidade desejada: limite da via (curvas são tratadas à parte, ver curveBrake)
    let v0 = link.vmax * v.v0f;
    if (next) {
      if (!v.nextLane && toEnd < LOOKAHEAD) v.nextLane = this.entryLane(next, v.route[v.ri + 2] ?? null, v.lane);
    } else {
      v0 = Math.min(v0, Math.sqrt(1 + 2 * 1.2 * Math.max(0, v.destPos - v.pos)));
    }
    v0 = Math.max(v0, 1);

    let reason: StopReason = 'free';
    let acc = idm(v, v0, Infinity, 0);
    const curve = this.curveBrake(v);
    if (curve < acc) acc = curve;

    // Líder na mesma faixa ou, se for o primeiro, o último carro da próxima faixa
    const lane = v.lane.vehicles;
    const idx = lane.indexOf(v);
    if (idx > 0) {
      const lead = lane[idx - 1];
      const a = idm(v, v0, lead.pos - lead.len - v.pos, v.v - lead.v);
      if (a < acc) { acc = a; reason = 'leader'; }
    } else if (v.nextLane && v.nextLane.vehicles.length) {
      const lead = v.nextLane.vehicles[v.nextLane.vehicles.length - 1];
      const a = idm(v, v0, toEnd + lead.pos - lead.len, v.v - lead.v);
      if (a < acc) { acc = a; reason = 'leader'; }
      // primeiro da fila, parado porque a via de destino não anda: depois de um tempo,
      // procura outro caminho
      if (v.v < 0.5 && toEnd < 30 && laneBlocked(v.nextLane, v.len)) {
        v.blockedWait += dt;
        if (v.blockedWait > REROUTE_AFTER) this.reroute(v);
      }
    }

    // Na faixa errada para a conversão, já perto do cruzamento: desiste dela e segue por
    // uma saída que a faixa atual permite, refazendo o caminho (não trava a faixa)
    if (next && idx === 0 && toEnd < 25 && !v.wrongLaneChecked) {
      v.wrongLaneChecked = true;
      const [lo, hi] = this.allowedLanes(link, next);
      if (v.lane.index < lo || v.lane.index > hi) this.reroute(v, true);
    }

    // Linha de retenção
    const dStop = toEnd - link.setback;
    if (next && dStop > -0.5 && idx === 0) {
      const hold = this.mustHold(v, link, dStop, dt);
      if (hold) {
        const a = idm(v, v0, Math.max(0.1, dStop + v.s0 - 1), v.v);
        if (a < acc) { acc = a; reason = hold; }
      }
    }
    // Distração (barbeiro): freia/desacelera do nada por 1–2,5 s
    const d = v.drv;
    if (d.distractions > 0 && v.distractT <= 0 && this.rng() < (d.distractions / 60) * dt) v.distractT = 1 + 1.5 * this.rng();
    if (v.distractT > 0) {
      v.distractT -= dt;
      if (v.v > 4) { acc = Math.min(acc, -1.8); reason = 'distracted'; }
    }
    // Tempo de reação para arrancar quando a frente libera (o barbeiro demora no verde)
    if (v.v < 0.3 && acc > 0.2) {
      v.reactT += dt;
      if (v.reactT < d.reaction) acc = 0;
    } else if (v.v > 0.5) v.reactT = 0;
    // Apressado no semáforo apagado: chega na linha a ~15 km/h (não para)
    if (next && idx === 0 && !v.lookDone && v.drv.rollSpeed > 0 && this.isDarkSignal(link) && dStop > 0) {
      const vc = v.drv.rollSpeed;
      if (v.v > vc) {
        const a = -(v.v * v.v - vc * vc) / (2 * Math.max(dStop, 1));
        if (a < acc) { acc = a; reason = 'looking'; }
      }
    }
    v.reason = reason;
    return Math.max(-MAX_DECEL, acc);
  }

  /**
   * Curvas de verdade: velocidade máxima numa curva de raio R é √(a_lat·R). O carro
   * mantém a velocidade e só freia quando precisa para chegar à curva nessa velocidade
   * (desaceleração exigida (v² − vc²)/2d); passado o ápice, volta a acelerar pelo IDM.
   * Olha as curvas do link atual, a conversão no fim dele, as curvas do próximo link e a
   * conversão seguinte, dentro do horizonte de frenagem.
   */
  private curveBrake(v: Vehicle): number {
    const speed = v.v;
    if (speed < 2) return Infinity;
    const horizon = Math.min(180, (speed * speed) / (2 * 0.6) + 10);
    const v2 = speed * speed;
    // velocidade de curva vc = √(a_lat·R) → só curvas com R < v²/a_lat limitam
    const rLimit = v2 / v.alat;
    let worst = 0; // maior desaceleração exigida
    let base = -v.pos;
    for (let k = v.ri; k < v.route.length && base < horizon; k++) {
      const l = v.route[k];
      const c = l.curves;
      for (let i = 0; i < c.length; i += 2) {
        const d = base + c[i];
        if (d < -0.5) continue;
        if (d > horizon) break;
        const r = c[i + 1];
        if (r >= rLimit) continue;
        const req = (v2 - v.alat * r) / (2 * Math.max(d, 1));
        if (req > worst) worst = req;
      }
      const nx = v.route[k + 1];
      const d = base + l.length;
      if (nx && d <= horizon) {
        const r = turnRadius(l, nx);
        if (r < rLimit) {
          const req = (v2 - v.alat * r) / (2 * Math.max(d, 1));
          if (req > worst) worst = req;
        }
      }
      base += l.length;
    }
    // Começa a frear com suavidade (só quando a exigência passa de ~40% do conforto)
    if (worst < 0.4 * v.bcomf) return Infinity;
    return -worst * 1.05;
  }

  /** Se o veículo precisa parar na linha de retenção, retorna o motivo */
  private mustHold(v: Vehicle, link: Link, dStop: number, dt: number): StopReason | null {
    // Alguém fechou o cruzamento (parado lá dentro): o tráfego transversal não passa
    const blocker = this.blockedNodes.get(link.to);
    if (blocker && blocker !== link && dStop > 0) {
      const dot = link.outDir[0] * blocker.outDir[0] + link.outDir[1] * blocker.outDir[1];
      if (Math.abs(dot) < 0.7) return 'blocked';
    }
    // Não bloqueie o cruzamento: só entra se houver espaço do outro lado. Vale só em
    // cruzamento de verdade (3+ vias no nó); emendas no meio da via não seguram ninguém.
    // Apressados e barbeiros às vezes entram mesmo assim — e fecham o cruzamento.
    if (v.nextLane && dStop > 0 && this.graph.net.nodes[link.to].edges.length >= 3) {
      if (laneBlocked(v.nextLane, v.len)) {
        // a faixa escolhida lotou: tenta outra faixa válida da via seguinte
        const alt = this.freeLaneIn(v);
        if (alt) v.nextLane = alt;
        else {
          if (v.boxDecision === null) v.boxDecision = this.rng() < v.drv.blockBox;
        }
        if (!alt && !v.boxDecision) {
          // parado há um tempo esperando espaço: muda o caminho (outra saída do cruzamento)
          if (v.v < 0.5) v.blockedWait += dt;
          if (v.blockedWait > REROUTE_AFTER && this.reroute(v)) return null;
          return 'box';
        }
      }
    }
    if (link.signal && this.signalsOn) {
      if (v.committed) return null;
      const { state } = this.signals.state(link.signal.controller, link.signal.phase, this.t);
      if (state === 'green') {
        if (dStop < 2) v.committed = true;
        return null;
      }
      if (state === 'yellow') {
        // Passa se não conseguir parar antes da linha com a frenagem que aceita
        // (o apressado aceita pouca: passa no amarelo tardio)
        if (dStop < (v.v * v.v) / (2 * v.drv.yellowDecel) + 0.5) {
          v.committed = true;
          return null;
        }
        return 'yellow';
      }
      // Vermelho que acabou de abrir: o apressado às vezes avança
      const c = this.signals.controllers[link.signal.controller];
      const redDuration = c.cycle - c.phases[link.signal.phase].green - YELLOW;
      const sinceRed = redDuration - this.signals.state(c.id, link.signal.phase, this.t).remaining;
      if (sinceRed < 1.5 && v.v > 5 && dStop < v.v * 1.5) {
        if (v.redDecision === null) v.redDecision = this.rng() < v.drv.runRed;
        if (v.redDecision) {
          v.committed = true;
          this.stats.ranRed++;
          return null;
        }
      }
      return 'red';
    }
    // Semáforo apagado: freia, para (o apressado só reduz), olha e só então segue
    if (!v.lookDone && this.isDarkSignal(link)) {
      const d = v.drv;
      if (dStop < 3 && v.v <= d.rollSpeed + 0.3) {
        v.lookT += dt;
        if (v.lookT >= d.lookTime) v.lookDone = true;
      }
      // quem para de verdade segura na linha; quem só reduz é limitado em acceleration()
      if (!v.lookDone && d.rollSpeed === 0) return 'looking';
    }
    // Cruzamento sem semáforo: espera o miolo liberar e, ao entrar, reserva a vez
    if (this.isUncontrolledJunction(link)) {
      // quem já passou da linha tem a vez (evita dois esperando um pelo outro)
      if (dStop > 0.5 && dStop < 20 && this.junctionOccupied(v, link)) return 'occupied';
    }
    if (link.control === 'stop' && !v.stopDone) {
      if (dStop < 3 && v.v < 0.4) v.stopDone = true;
      else return 'stop_sign';
    }
    if (dStop < 45 && this.mustYield(v, link)) {
      if (v.yieldDecision === null) v.yieldDecision = this.rng() < v.drv.ignoreYield;
      if (!v.yieldDecision) {
        if (v.v < 0.5) v.yieldWait += dt;
        if (v.yieldWait < YIELD_GIVE_UP) return 'yield';
      }
    }
    // vai entrar agora: reserva o miolo para quem vier depois neste mesmo passo
    if (dStop < Math.max(2, v.v) && this.isUncontrolledJunction(link)) this.occupy(link.to, v, link.outDir);
    return null;
  }

  /**
   * Refaz a rota a partir do link atual evitando a saída bloqueada: testa as outras saídas
   * do cruzamento com espaço e fica com a de menor custo até o destino.
   */
  private reroute(v: Vehicle, laneMustAllow = false): boolean {
    v.blockedWait = 0;
    const link = v.lane.link;
    const blocked = v.route[v.ri + 1];
    const dest = v.route[v.route.length - 1];
    let best: Link[] | null = null;
    let bestLen = Infinity;
    for (const alt of link.next) {
      if (alt === blocked || alt.lanes.every((la) => laneBlocked(la, v.len))) continue;
      if (laneMustAllow) {
        const [lo, hi] = this.allowedLanes(link, alt);
        if (v.lane.index < lo || v.lane.index > hi) continue;
      }
      const r = alt === dest ? [alt] : this.router.route(alt, dest, v.id + 7919);
      if (!r) continue;
      const cost = r.reduce((s, l) => s + l.ttEma, 0);
      if (cost < bestLen) { bestLen = cost; best = r; }
    }
    if (!best) return false;
    v.route = [...v.route.slice(0, v.ri + 1), ...best];
    if (best[best.length - 1] === dest && best.length === 1) v.destPos = Math.min(v.destPos, dest.length * 0.8);
    v.nextLane = null;
    this.stats.rerouted++;
    return true;
  }

  /** Atraso (s) em relação ao fluxo livre nos próximos 4 trechos da rota */
  private aheadDelay(v: Vehicle): number {
    let d = 0;
    for (let k = v.ri + 1; k < Math.min(v.route.length, v.ri + 5); k++) {
      const l = v.route[k];
      d += Math.max(0, l.ttEma - l.length / l.vmax);
    }
    return d;
  }

  /** Nova rota do link atual até o destino com os tempos atuais (mantém o que já rodou) */
  private rerouteFromHere(v: Vehicle) {
    const link = v.lane.link;
    const dest = v.route[v.route.length - 1];
    const r = this.router.route(link, dest, v.id);
    if (!r || r.length < 2 || r[1] === v.route[v.ri + 1]) return;
    v.route = [...v.route.slice(0, v.ri), ...r];
    v.nextLane = null;
    v.wrongLaneChecked = false;
    this.stats.rerouted++;
  }

  /** Outra faixa do próximo link, válida para a conversão seguinte, com espaço para entrar */
  private freeLaneIn(v: Vehicle): Lane | null {
    const next = v.route[v.ri + 1];
    const [lo, hi] = this.allowedLanes(next, v.route[v.ri + 2] ?? null);
    let best: Lane | null = null, bestSpace = -Infinity;
    const want = v.nextLane?.index ?? -1;
    for (let i = lo; i <= hi; i++) {
      // só a faixa vizinha da pretendida (não atravessa o cruzamento em diagonal)
      if (want >= 0 && Math.abs(i - want) > 1) continue;
      const lane = next.lanes[i];
      if (laneBlocked(lane, v.len)) continue;
      const last = lane.vehicles[lane.vehicles.length - 1];
      const space = last ? last.pos - last.len : Infinity;
      // prefere a mais próxima da faixa pretendida
      const score = space - 5 * Math.abs(i - (v.nextLane?.index ?? i));
      if (score > bestSpace) { bestSpace = score; best = lane; }
    }
    return best;
  }

  /** Há alguém com preferência chegando ao cruzamento? */
  private mustYield(v: Vehicle, link: Link): boolean {
    const myArrival = Math.max(0, link.length - link.setback - v.pos) / Math.max(v.v, 2);
    for (const o of this.conflicts[link.id]) {
      // Confluência (as duas vias seguem no mesmo sentido): entra intercalando, brecha curta
      const merge = link.outDir[0] * o.outDir[0] + link.outDir[1] * o.outDir[1] > 0.7;
      const gap = (merge ? MERGE_GAP : YIELD_GAP + myArrival * 0.3) * v.drv.gapFactor;
      for (const lane of o.lanes) {
        const f = lane.vehicles[0];
        if (!f) continue;
        const dist = o.length - f.pos;
        if (dist > 80) continue;
        if (f.v < 0.5) {
          // parado: só "vem" se estiver na linha esperando a vez no próprio cruzamento
          // (senão a preferencial morre de fome atrás de um fluxo contínuo da secundária)
          if (dist < 8 && f.reason === 'occupied') return true;
          continue;
        }
        const tArr = dist / Math.max(f.v, 0.5);
        if (tArr < gap) return true;
      }
    }
    return false;
  }

  /** Links que chegam ao mesmo nó e têm preferência sobre `l` */
  private computeConflicts(l: Link): Link[] {
    if (this.ctl(l) === 'signal' || this.graph.incoming[l.to].length < 2) return [];
    const out: Link[] = [];
    for (const o of this.graph.incoming[l.to]) {
      if (o === l || o.edge === l.edge) continue;
      const dot = l.outDir[0] * o.outDir[0] + l.outDir[1] * o.outDir[1];
      if (dot < -0.8) continue; // sentido oposto da mesma via
      const cross = l.outDir[0] * o.outDir[1] - l.outDir[1] * o.outDir[0];
      const myStop = l.control === 'stop';
      const otherStop = o.control === 'stop';
      let priority = false;
      if (this.ctl(o) === 'signal') priority = true;
      else if (o.ring !== l.ring) priority = o.ring; // quem está na rotatória tem preferência
      else if (myStop !== otherStop) priority = myStop;
      else if (o.rank !== l.rank) priority = o.rank > l.rank;
      else if (o.edge.isLink !== l.edge.isLink) priority = l.edge.isLink; // alça cede
      else priority = dot < 0.8 && cross < -0.3; // mesma hierarquia: preferência de quem vem da direita
      if (priority) out.push(o);
    }
    return out;
  }

  /** Move o veículo entre links; retorna true se ele chegou ao destino */
  private advance(v: Vehicle): boolean {
    for (;;) {
      const link = v.lane.link;
      if (v.ri === v.route.length - 1) {
        if (v.pos >= v.destPos || v.pos >= link.length) {
          this.remove(v);
          v.done = true;
          const trip = this.t - v.departT;
          this.stats.arrived++;
          this.stats.tripSum += trip;
          this.stats.tripN++;
          if (v.kind === 'to_work') { this.stats.workSum += trip; this.stats.workN++; }
          return true;
        }
        return false;
      }
      if (v.pos < link.length) return false;
      const next = v.route[v.ri + 1];
      const nl = v.nextLane ?? this.entryLane(next, v.route[v.ri + 2] ?? null, v.lane);
      // Trava física: só entra se couber atrás do último carro da faixa de destino
      // (dois carros vindos de aproximações diferentes podem mirar a mesma faixa)
      const last = nl.vehicles[nl.vehicles.length - 1];
      if (last && last.pos - last.len - 0.5 < v.pos - link.length) {
        v.pos = link.length - 0.01;
        v.v = Math.min(v.v, last.v);
        v.nextLane = nl;
        return false;
      }
      this.remove(v);
      v.pos -= link.length;
      v.ri++;
      v.prevLane = v.lane;
      v.lane = nl;
      v.lat = nl.offset;
      insertSorted(nl.vehicles, v);
      v.nextLane = null;
      v.blockedWait = 0;
      v.wrongLaneChecked = false;
      v.committed = false;
      v.boxDecision = null;
      v.redDecision = null;
      v.yieldDecision = null;
      v.lookT = 0;
      v.lookDone = false;
      if (this.aheadDelay(v) > ENROUTE_DELAY) this.rerouteQueue.add(v);
      v.stopDone = false;
      v.yieldWait = 0;
      v.seg = 0;
    }
  }

  private remove(v: Vehicle) {
    const arr = v.lane.vehicles;
    const i = arr[0] === v ? 0 : arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  }

  /**
   * Faixas válidas em `link` para seguir para `after`: [primeira, última].
   * A via principal no nó é a continuação de mesmo nome (ou a mais reta, se for quase
   * reta): quem segue nela usa todas as faixas. As demais saídas — mesmo as leves, tipo
   * alça — usam a(s) faixa(s) do lado para onde saem. Sem via principal (T, rotatória):
   * se só há saídas de um lado, todas as faixas servem; se há dos dois, metade para cada.
   */
  private allowedLanes(link: Link, after: Link | null): [number, number] {
    const n = link.lanes.length;
    if (!after || n === 1 || link.next.length === 1) return [0, n - 1];
    const main = this.mainContinuation(link);
    const i = link.next.indexOf(after);
    const turn = i >= 0 ? link.nextTurn[i] : turnOf(link, after);
    const edge = n >= 4 ? 2 : 1; // mínimo de faixas para uma saída em via larga
    if (main) {
      const mainTurn = link.nextTurn[link.next.indexOf(main)];
      if (after === main) {
        // divisão de pista: se a continuação tem menos faixas, fica do lado oposto aos ramos
        const m = main.lanes.length;
        if (m >= n) return [0, n - 1];
        let left = false, right = false;
        for (let k = 0; k < link.next.length; k++) {
          if (link.next[k] === main) continue;
          if (link.nextTurn[k] < mainTurn) left = true;
          else right = true;
        }
        if (left && !right) return [n - m, n - 1];
        if (right && !left) return [0, m - 1];
        return [0, n - 1];
      }
      // ramo: tantas faixas quanto ele tem (pelo menos `edge`, deixando uma para a principal)
      const k = Math.max(edge, Math.min(after.lanes.length, n - 1));
      return turn > mainTurn ? [n - k, n - 1] : [0, k - 1];
    }
    let hasL = false, hasR = false;
    for (let k = 0; k < link.next.length; k++) {
      if (link.nextTurn[k] > 0) hasR = true;
      else hasL = true;
    }
    if (!(hasL && hasR)) return [0, n - 1];
    return turn > 0 ? [Math.floor(n / 2), n - 1] : [0, Math.ceil(n / 2) - 1];
  }

  /** Continuação principal do link no nó (cache) */
  private mainCache = new Map<number, Link | null>();
  private mainContinuation(link: Link): Link | null {
    let m = this.mainCache.get(link.id);
    if (m !== undefined) return m;
    m = null;
    let best = Infinity;
    for (let k = 0; k < link.next.length; k++) {
      const nx = link.next[k];
      const t = Math.abs(link.nextTurn[k]);
      // mesma via tem prioridade; senão, a mais reta desde que seja quase reta
      const score = (nx.edge.name && nx.edge.name === link.edge.name ? 0 : 1) + t;
      if (t < TURN_ANGLE * 1.2 && score < best) { best = score; m = nx; }
    }
    this.mainCache.set(link.id, m);
    return m;
  }

  /**
   * Faixa ao entrar em `next` vindo de `from`, preservando a ordem das faixas: no reto,
   * a posição contada pela direita; numa conversão, as faixas que fazem a conversão
   * caem nas faixas correspondentes do destino (a da esquerda na da esquerda, etc.).
   * Em trechos curtos, sem espaço para trocar depois, já entra na faixa exigida pela
   * conversão seguinte.
   */
  private entryLane(next: Link, after: Link | null, from: Lane | null): Lane {
    const n = next.lanes.length;
    if (n === 1) return next.lanes[0];
    let pref: number;
    if (!from) pref = n - 1;
    else {
      const [lo, hi] = this.allowedLanes(from.link, next);
      const nFrom = from.link.lanes.length;
      const idx = Math.max(lo, Math.min(hi, from.index));
      // saída pela esquerda: alinhada pela esquerda; pela direita: pela direita;
      // seguindo a via (todas as faixas): posição contada pela direita
      if (hi < nFrom - 1) pref = idx - lo;
      else if (lo > 0) pref = n - 1 - (hi - idx);
      else pref = n - 1 - (nFrom - 1 - from.index);
      pref = Math.max(0, Math.min(n - 1, pref));
    }
    if (next.length < SHORT_LINK && after) {
      const [lo, hi] = this.allowedLanes(next, after);
      pref = Math.max(lo, Math.min(hi, pref));
    }
    return next.lanes[pref];
  }

  /** Líder (primeiro à frente) e seguidor (primeiro atrás) de `pos` numa faixa */
  private neighbors(lane: Lane, pos: number, self: Vehicle | null): [Vehicle | null, Vehicle | null] {
    const arr = lane.vehicles;
    let leader: Vehicle | null = null;
    for (const o of arr) {
      if (o === self) continue;
      if (o.pos > pos) leader = o;
      else return [leader, o];
    }
    return [leader, null];
  }

  /** Cabe um veículo com a frente em `pos` nesta faixa sem forçar ninguém a frear forte? */
  private safeGap(v: Vehicle, lane: Lane, pos: number, speed: number): boolean {
    const [lead, fol] = this.neighbors(lane, pos, v);
    const v0 = lane.link.vmax * v.v0f;
    // o motorista ruim aceita brechas menores e força quem vem atrás a frear
    const minGap = v.drv.lcMinGap, safeDecel = v.drv.lcSafeDecel;
    if (lead) {
      const gap = lead.pos - lead.len - pos;
      if (gap < minGap || idmAt(v, speed, v0, gap, speed - lead.v) < -safeDecel) return false;
    }
    if (fol) {
      const gap = pos - v.len - fol.pos;
      const fv0 = lane.link.vmax * fol.v0f;
      if (gap < minGap || idmAt(fol, fol.v, fv0, gap, fol.v - speed) < -safeDecel) return false;
    }
    return true;
  }

  /** Aceleração que o carro teria atrás do líder desta faixa (ignorando semáforos) */
  private laneAccel(v: Vehicle, lane: Lane): number {
    const [lead] = this.neighbors(lane, v.pos, v);
    const v0 = Math.max(1, lane.link.vmax * v.v0f);
    return lead ? idmAt(v, v.v, v0, lead.pos - lead.len - v.pos, v.v - lead.v) : idmAt(v, v.v, v0, Infinity, 0);
  }

  /**
   * Troca de faixa dentro do link: obrigatória (posicionar para a conversão) ou por
   * vantagem (MOBIL: ganho de aceleração acima do limiar), sempre com brecha segura.
   */
  private tryLaneChange(v: Vehicle) {
    const link = v.lane.link;
    const n = link.lanes.length;
    if (n < 2 || v.lcCooldown > 0) return;
    const toEnd = link.length - v.pos;
    // nada de trocar logo na entrada nem dentro/perto do cruzamento
    if (v.pos < v.len + 6 || toEnd < link.setback + 10) return;
    const next = v.ri < v.route.length - 1 ? v.route[v.ri + 1] : null;
    let [lo, hi] = this.allowedLanes(link, next);
    // Se o próximo trecho é curto e segue reto, já se posiciona para a conversão depois
    // dele (alinhando as faixas pela direita)
    const after = v.route[v.ri + 2];
    if (next && after && lo === 0 && hi === n - 1 && next.length < LC_MANDATORY_ZONE) {
      const [lo2, hi2] = this.allowedLanes(next, after);
      const shift = n - next.lanes.length;
      const a = Math.max(0, lo2 + shift), b = Math.min(n - 1, hi2 + shift);
      if (a <= b) { lo = a; hi = b; }
    }
    const cur = v.lane.index;
    let target = -1;
    if (cur < lo || cur > hi) {
      target = cur < lo ? cur + 1 : cur - 1;
    } else {
      const aCur = this.laneAccel(v, v.lane);
      let best = v.drv.lcThreshold;
      for (const d of [-1, 1]) {
        const idx = cur + d;
        if (idx < 0 || idx >= n) continue;
        if (toEnd < LC_MANDATORY_ZONE && (idx < lo || idx > hi)) continue;
        const gain = this.laneAccel(v, link.lanes[idx]) - aCur + d * LC_KEEP_RIGHT;
        if (gain > best) { best = gain; target = idx; }
      }
    }
    if (target < 0) return;
    const lane = link.lanes[target];
    if (!this.safeGap(v, lane, v.pos, v.v)) return;
    this.remove(v);
    v.lane = lane;
    insertSorted(lane.vehicles, v);
    v.nextLane = null; // recalcula a faixa do próximo link a partir da nova
    v.lcCooldown = v.drv.lcCooldown;
  }

  /** Garante que ninguém fique sobreposto ao carro da frente na mesma faixa */
  private enforceSpacing() {
    for (const v of this.vehicles) {
      const arr = v.lane.vehicles;
      if (arr[0] !== v) continue; // percorre cada faixa a partir do primeiro carro
      for (let k = 1; k < arr.length; k++) {
        const lead = arr[k - 1], f = arr[k];
        const maxPos = lead.pos - lead.len - 0.3;
        if (f.pos > maxPos) {
          f.pos = Math.max(0, maxPos);
          f.v = Math.min(f.v, lead.v);
        }
      }
    }
  }

  // ------------------------------------------------------------------ demanda

  demandPerHour(): number {
    return this.demand.ratePerHour(this.t / 3600) * this.demandScale;
  }

  private spawn(dt: number) {
    this.spawnAcc += (this.demandPerHour() * dt) / 3600;
    const t0 = performance.now();
    let guard = 0;
    while (this.spawnAcc >= 1 && guard++ < 50) {
      this.spawnAcc -= 1;
      const v = this.createVehicle();
      if (!v) continue;
      const q = this.backlog.get(v.route[0]);
      if (q) q.push(v);
      else this.backlog.set(v.route[0], [v]);
    }
    this.routingMs = performance.now() - t0;
    // Coloca na via quem estiver esperando: o carro sai de uma vaga ao longo da quadra
    // (antes da linha de retenção), na faixa válida para a conversão seguinte
    for (const [link, q] of this.backlog) {
      const isGate = this.gateLinks.has(link);
      while (q.length) {
        const v = q[0];
        if (isGate) {
          // Vem de fora do mapa já andando: entra no início do link se houver distância
          if (!this.enterAtStart(v, link)) break;
          q.shift();
          continue;
        }
        const [lo, hi] = this.allowedLanes(link, v.route[1] ?? null);
        const maxPos = Math.max(v.len + 1, Math.min(link.length * 0.7, link.length - link.setback - 8));
        const pos = v.len + 1 + this.rng() * (maxPos - v.len - 1);
        let placed: Lane | null = null;
        for (let i = hi; i >= lo; i--) {
          if (this.safeGap(v, link.lanes[i], pos, 0)) { placed = link.lanes[i]; break; }
        }
        if (!placed) break;
        q.shift();
        v.lane = placed;
        v.lat = placed.offset;
        v.pos = pos;
        v.v = 0;
        v.departT = this.t;
        insertSorted(placed.vehicles, v);
        this.vehicles.push(v);
        this.stats.spawned++;
      }
      if (!q.length) this.backlog.delete(link);
    }
  }

  /**
   * Início a quente: coloca `n` carros já no meio das suas viagens (posição sorteada ao
   * longo da rota, proporcional ao comprimento), para não esperar a rede encher.
   */
  prefill(n: number) {
    let placed = 0;
    for (let tries = 0; placed < n && tries < n * 3; tries++) {
      const v = this.createVehicle();
      if (!v) continue;
      const total = v.route.reduce((s, l) => s + l.length, 0);
      let at = this.rng() * total;
      let k = 0;
      while (k < v.route.length - 1 && at > v.route[k].length) at -= v.route[k++].length;
      const link = v.route[k];
      const pos = Math.max(v.len + 1, Math.min(at, link.length - link.setback - 3));
      if (k === v.route.length - 1 && pos >= v.destPos) continue;
      const [lo, hi] = this.allowedLanes(link, v.route[k + 1] ?? null);
      const lane = link.lanes[lo + Math.floor(this.rng() * (hi - lo + 1))];
      const speed = link.vmax * 0.5;
      v.ri = k;
      if (!this.safeGap(v, lane, pos, speed)) continue;
      v.lane = lane;
      v.lat = lane.offset;
      v.pos = pos;
      v.v = speed;
      // já estava rodando: o tempo de viagem conta desde uma partida estimada
      v.departT = this.t - (this.rng() * total) / Math.max(3, link.vmax * 0.5);
      insertSorted(lane.vehicles, v);
      this.vehicles.push(v);
      placed++;
    }
    return placed;
  }

  /** Insere no começo de um portão com a velocidade do fluxo (se couber) */
  private enterAtStart(v: Vehicle, link: Link): boolean {
    const [lo, hi] = this.allowedLanes(link, v.route[1] ?? null);
    let best: Lane | null = null, bestSpace = 0;
    for (let i = lo; i <= hi; i++) {
      const lane = link.lanes[i];
      const last = lane.vehicles[lane.vehicles.length - 1];
      const space = last ? last.pos - last.len : Infinity;
      if (space > bestSpace) { bestSpace = space; best = lane; }
    }
    const pos = v.len + 0.5;
    if (!best || bestSpace - pos < v.s0 + 1) return false;
    const last = best.vehicles[best.vehicles.length - 1];
    // velocidade que dá para manter atrás de quem está na frente (IDM de equilíbrio)
    const gap = bestSpace - pos;
    const speed = Math.min(link.vmax * v.v0f * 0.9, last ? Math.max(0, Math.min(last.v + 2, (gap - v.s0) / v.T)) : Infinity);
    v.lane = best;
    v.lat = best.offset;
    v.pos = pos;
    v.v = speed;
    v.departT = this.t;
    best.vehicles.push(v);
    this.vehicles.push(v);
    this.stats.spawned++;
    return true;
  }

  private createVehicle(): Vehicle | null {
    for (let attempt = 0; attempt < 4; attempt++) {
      const trip = this.demand.sample(this.rng);
      if (trip.origin === trip.dest) continue;
      const id = this.nextId++;
      const route = this.router.route(trip.origin, trip.dest, id);
      if (!route || route.length < 2) continue;
      const r = this.rng;
      const dest = route[route.length - 1];
      const drv = makeDriver(pickStyle(this.chaos, r), r);
      return {
        drv,
        reactT: 0,
        distractT: 0,
        blocking: false,
        boxDecision: null,
        redDecision: null,
        yieldDecision: null,
        id,
        kind: trip.kind,
        route,
        ri: 0,
        lane: trip.origin.lanes[0],
        nextLane: null,
        pos: 0,
        v: 0,
        acc: 0,
        len: r() < 0.06 ? 7 : 4.4, // alguns utilitários/vans
        // sai pela borda: vai até o fim do trecho; senão estaciona no meio da quadra
        destPos: trip.toGate ? dest.length * 0.97 : dest.length * (0.3 + 0.5 * r()),
        v0f: drv.v0f,
        // parâmetros IDM do perfil (drivers.ts)
        T: drv.T,
        amax: drv.amax,
        bcomf: drv.bcomf,
        s0: drv.s0,
        lat: 0,
        lcCooldown: 0,
        blockedWait: 0,
        lookT: 0,
        lookDone: false,
        wrongLaneChecked: false,
        done: false,
        alat: drv.alat,
        prevLane: null,
        committed: false,
        stopDone: false,
        yieldWait: 0,
        stuck: 0,
        departT: this.t,
        seg: 0,
        reason: 'free',
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ métricas

  /** Atualiza velocidade relativa e tempo de viagem estimado de cada link */
  private updateLinkMetrics(elapsed: number) {
    const k = Math.min(1, elapsed / 20);
    for (const l of this.graph.links) {
      let n = 0, sum = 0;
      for (const lane of l.lanes) for (const v of lane.vehicles) { n++; sum += v.v; }
      const free = l.length / l.vmax;
      if (n) {
        const mean = sum / n;
        const ratio = Math.min(1, mean / l.vmax);
        l.speedRatio += (ratio - l.speedRatio) * k * 2;
        const est = Math.min(900, l.length / Math.max(mean, 0.4));
        l.ttEma += (Math.max(free, est) - l.ttEma) * k;
      } else {
        l.speedRatio += (1 - l.speedRatio) * k;
        l.ttEma += (free - l.ttEma) * k * 0.5;
      }
    }
  }

  getStats(): SimStats {
    let moving = 0, speedSum = 0, stopped = 0, atRed = 0;
    for (const v of this.vehicles) {
      if (v.v < 0.5) {
        stopped++;
        if (v.reason === 'red' || v.reason === 'yellow') atRed++;
      } else { moving++; speedSum += v.v; }
    }
    let waiting = 0;
    for (const q of this.backlog.values()) waiting += q.length;
    const s = this.stats;
    return {
      active: this.vehicles.length,
      spawned: s.spawned,
      arrived: s.arrived,
      removedStuck: s.removedStuck,
      rerouted: s.rerouted,
      ranRed: s.ranRed,
      signalsOn: this.signalsOn,
      blockingNow: this.vehicles.reduce((n, v) => n + (v.blocking ? 1 : 0), 0),
      byStyle: this.styleCounts(),
      waitingToEnter: waiting,
      meanSpeedKmh: moving ? (speedSum / moving) * 3.6 : 0,
      stoppedPct: this.vehicles.length ? (100 * stopped) / this.vehicles.length : 0,
      atRed,
      avgTripMin: s.tripN ? s.tripSum / s.tripN / 60 : 0,
      avgTripToWorkMin: s.workN ? s.workSum / s.workN / 60 : 0,
      demandPerHour: this.demandPerHour(),
    };
  }

  styleCounts(): Record<DriverStyle, number> {
    const c: Record<DriverStyle, number> = { normal: 0, apressado: 0, barbeiro: 0 };
    for (const v of this.vehicles) c[v.drv.style]++;
    return c;
  }

  kindCounts(): Record<TripKind, number> {
    const c: Record<TripKind, number> = { to_work: 0, through: 0, outbound: 0, local: 0 };
    for (const v of this.vehicles) c[v.kind]++;
    return c;
  }
}

/** IDM: aceleração dado o gap até o obstáculo e a diferença de velocidade */
function idm(v: Vehicle, v0: number, gap: number, dv: number): number {
  const free = 1 - (v.v / v0) ** 4;
  if (gap === Infinity) return v.amax * free;
  const sStar = v.s0 + Math.max(0, v.v * v.T + (v.v * dv) / (2 * Math.sqrt(v.amax * v.bcomf)));
  const s = Math.max(gap, 0.1);
  return v.amax * (free - (sStar / s) ** 2);
}

/** A entrada da faixa está tomada por fila (não cabe um carro de `len`)? */
function laneBlocked(lane: Lane, len: number): boolean {
  const last = lane.vehicles[lane.vehicles.length - 1];
  // precisa caber inteiro do outro lado, com folga (senão a traseira fica no cruzamento)
  return !!last && last.pos - last.len < len + 3.5 && last.v < 3;
}

/** IDM com velocidade explícita (para avaliar situações hipotéticas) */
function idmAt(v: Vehicle, speed: number, v0: number, gap: number, dv: number): number {
  const free = 1 - (speed / v0) ** 4;
  if (gap === Infinity) return v.amax * free;
  const sStar = v.s0 + Math.max(0, speed * v.T + (speed * dv) / (2 * Math.sqrt(v.amax * v.bcomf)));
  return v.amax * (free - (sStar / Math.max(gap, 0.1)) ** 2);
}

function insertSorted(arr: Vehicle[], v: Vehicle) {
  let i = arr.length;
  while (i > 0 && arr[i - 1].pos < v.pos) i--;
  arr.splice(i, 0, v);
}
