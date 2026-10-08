import type { Lane, Link } from './graph';
import type { TripKind } from './demand';
import type { DriverProfile } from './drivers';

export interface Vehicle {
  id: number;
  kind: TripKind;
  route: Link[];
  /** índice do link atual na rota */
  ri: number;
  lane: Lane;
  /** faixa escolhida no próximo link (definida ao se aproximar do cruzamento) */
  nextLane: Lane | null;
  /** posição da frente do veículo ao longo do link (m) */
  pos: number;
  v: number;
  acc: number;
  len: number;
  /** onde estaciona no último link (m) */
  destPos: number;
  /** perfil do motorista (normal, apressado, barbeiro) */
  drv: DriverProfile;
  /** tempo parado querendo arrancar (s) — compara com o tempo de reação */
  reactT: number;
  /** distração em andamento (s restantes) */
  distractT: number;
  /** está parado dentro de um cruzamento, fechando-o */
  blocking: boolean;
  /** semáforo apagado: tempo olhando parado e se já olhou neste cruzamento */
  lookT: number;
  lookDone: boolean;
  /** decisões tomadas uma vez por cruzamento (null = ainda não decidiu) */
  boxDecision: boolean | null;
  redDecision: boolean | null;
  yieldDecision: boolean | null;
  // parâmetros do motorista (IDM)
  v0f: number;
  T: number;
  amax: number;
  bcomf: number;
  s0: number;
  /** aceleração lateral aceita em curvas (m/s²) — define a velocidade de curva */
  alat: number;
  /** faixa anterior (para desenhar o arco da conversão) */
  prevLane: Lane | null;
  /** deslocamento lateral renderizado (m) — anima a troca de faixa */
  lat: number;
  /** tempo até poder trocar de faixa de novo (s) */
  lcCooldown: number;
  // estado nos cruzamentos
  /** decidiu passar no amarelo neste link */
  committed: boolean;
  /** já parou na placa de PARE deste link */
  stopDone: boolean;
  /** tempo parado esperando brecha (s) */
  yieldWait: number;
  /** tempo parado esperando espaço na saída escolhida (s) — dispara nova rota */
  blockedWait: number;
  /** já conferiu se está na faixa certa para a conversão deste link */
  wrongLaneChecked: boolean;
  /** saiu da simulação (chegou ou foi removido) */
  done: boolean;
  /** tempo parado contínuo (s) — para detectar travamento */
  stuck: number;
  departT: number;
  /** dica de segmento para renderização */
  seg: number;
  /** motivo da última frenagem forte, para depuração/inspeção */
  reason: StopReason;
}

export type StopReason =
  | 'free' | 'leader' | 'red' | 'yellow' | 'yield' | 'stop_sign' | 'box' | 'park' | 'blocked' | 'distracted'
  | 'occupied' | 'looking';
