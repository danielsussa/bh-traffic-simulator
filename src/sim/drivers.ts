// Perfis de motorista. O "caos" da simulação é a fração de motoristas que não são normais.
import type { Rng } from './rng';

export type DriverStyle = 'normal' | 'apressado' | 'barbeiro';

export interface DriverProfile {
  style: DriverStyle;
  /** IDM */
  v0f: number;
  T: number;
  amax: number;
  bcomf: number;
  s0: number;
  /** aceleração lateral aceita em curvas (m/s²) */
  alat: number;
  /** tempo de reação para arrancar quando a frente libera (s) */
  reaction: number;
  /** chance, em cada cruzamento, de entrar mesmo sem espaço do outro lado (fecha o cruzamento) */
  blockBox: number;
  /** chance de avançar o vermelho que acabou de abrir (≤ 1,5 s) */
  runRed: number;
  /** desaceleração máxima que aceita para parar no amarelo (m/s²); acima disso, passa */
  yellowDecel: number;
  /** multiplica a brecha exigida para entrar num cruzamento sem semáforo */
  gapFactor: number;
  /** chance, em cada cruzamento, de não dar a preferência */
  ignoreYield: number;
  /** distrações por minuto (freia/desacelera do nada) */
  distractions: number;
  /** semáforo apagado: tempo olhando antes de seguir (s) e velocidade com que chega
   *  na linha (0 = para de verdade; o apressado só reduz) */
  lookTime: number;
  rollSpeed: number;
  /** troca de faixa: ganho mínimo, frenagem que aceita impor a quem vem atrás, folga, intervalo */
  lcThreshold: number;
  lcSafeDecel: number;
  lcMinGap: number;
  lcCooldown: number;
}

const between = (r: Rng, a: number, b: number) => a + (b - a) * r();

export function makeDriver(style: DriverStyle, r: Rng): DriverProfile {
  switch (style) {
    case 'apressado':
      return {
        style,
        v0f: between(r, 1.05, 1.3),
        T: between(r, 0.5, 0.8),
        amax: between(r, 2.3, 3.2),
        bcomf: between(r, 3, 4),
        s0: between(r, 1, 1.5),
        alat: between(r, 3.5, 4.5),
        reaction: between(r, 0.1, 0.3),
        blockBox: 0.6,
        runRed: 0.35,
        yellowDecel: 7,
        gapFactor: 0.55,
        ignoreYield: 0.1,
        distractions: 0,
        lookTime: between(r, 0.3, 0.8),
        rollSpeed: 4, // ~15 km/h
        lcThreshold: 0.1,
        lcSafeDecel: 4.5,
        lcMinGap: 0.8,
        lcCooldown: 1.5,
      };
    case 'barbeiro':
      return {
        style,
        v0f: between(r, 0.75, 1.0),
        T: between(r, 1.0, 1.8),
        amax: between(r, 1.0, 1.8),
        bcomf: between(r, 1.5, 2.5),
        s0: between(r, 1.5, 3),
        alat: between(r, 1.8, 3),
        reaction: between(r, 1, 3),
        blockBox: 0.35, // calcula mal o espaço
        runRed: 0.05,
        yellowDecel: between(r, 2, 6), // indeciso: às vezes freia forte, às vezes passa
        gapFactor: between(r, 0.6, 1.4),
        ignoreYield: 0.2,
        distractions: 1.5,
        lookTime: between(r, 2, 4),
        rollSpeed: 0,
        lcThreshold: 0.3,
        lcSafeDecel: 5, // troca em cima da hora, sem olhar direito
        lcMinGap: 0.6,
        lcCooldown: 3,
      };
    default:
      return {
        style: 'normal',
        v0f: between(r, 0.85, 1.1),
        T: between(r, 0.9, 1.4),
        amax: between(r, 1.5, 2.3),
        bcomf: between(r, 2, 2.8),
        s0: between(r, 1.6, 2.2),
        alat: between(r, 2.2, 3.4),
        reaction: between(r, 0.3, 0.8),
        blockBox: 0,
        runRed: 0,
        yellowDecel: 3.5,
        gapFactor: 1,
        ignoreYield: 0,
        distractions: 0,
        lookTime: between(r, 1, 2),
        rollSpeed: 0,
        lcThreshold: 0.35,
        lcSafeDecel: 3,
        lcMinGap: 1.5,
        lcCooldown: 4,
      };
  }
}

/** Sorteia o estilo: `chaos` é a fração de motoristas ruins (60% apressados, 40% barbeiros) */
export function pickStyle(chaos: number, r: Rng): DriverStyle {
  const x = r();
  if (x >= chaos) return 'normal';
  return x < chaos * 0.6 ? 'apressado' : 'barbeiro';
}
