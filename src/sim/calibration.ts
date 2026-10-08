// Calibração da demanda com dados reais de Belo Horizonte.
//
// Fontes:
//  [1] BHTRANS, Diagnóstico da Mobilidade Urbana (revisão do PlanMob-BH), 2017 —
//      Figuras 94 e 95: contagens de tráfego na hora pico da manhã (HPM), 2015, em UVP/h,
//      em pontos ao longo dos corredores (em geral mais longe do centro que os portões do mapa)
//      (unidade de veículo padrão: auto = 1; moto 0,3; ônibus 2,25; caminhão 2,0).
//      https://prefeitura.pbh.gov.br/sites/default/files/estrutura-de-governo/bhtrans/Diagnostico%202017.05.08.pdf
//  [2] Pesquisa Origem-Destino RMBH 2012 (no mesmo Diagnóstico): Tabela 16 (pares OD entre
//      regionais: Centro participa de 31% das viagens internas de BH; o par Centro/Sul é o
//      maior, 12%), Figura 51 (motivos por hora: às 10h, 40% volta para casa, 19% trabalho,
//      o resto negócios/compras/saúde/lazer) e seção 5.4 (tráfego de passagem chega a 58%
//      do volume nas vias principais do Hipercentro).
//  [3] BHTRANS, Contagens Volumétricas de Radares (dados abertos PBH), registros por veículo,
//      set/2023 — https://dados.pbh.gov.br/dataset/contagens-volumetricas-de-radares
//      Agregado em data/radar/radares-set2023-6a12h.json (média de ter–qui 12–14/set, 6h–12h).
//
// Como a simulação não tem ônibus nem motos, a contagem em UVP entra inteira como carros
// (ocupa a via de forma equivalente).

/** hora de referência dos fluxos abaixo */
export const REF_HOUR = 10;

/**
 * Razão média radar 2023 (no portão, 10h) / contagem 2015 (ponto mais distante, pico × 0,87)
 * nos corredores que têm as duas medições: AC 0,73 · JK 0,57 · Amazonas 0,41 · N.S. Carmo 0,69
 * · Andradas 0,44 → média 0,57. Aplicada aos corredores que só têm a contagem de 2015.
 */
const COUNT_TO_GATE = 0.57;
const from2015 = (peak: number) => Math.round(peak * 0.87 * COUNT_TO_GATE);

export interface Corridor {
  /** nome da via no OSM (ou chave especial) */
  name: string;
  /** fluxo às 10h entrando (sentido centro) e saindo (sentido bairro), UVP/h */
  in10: number;
  out10: number;
  source: string;
}

export const CORRIDORS: Corridor[] = [
  // Radares no próprio portão [3] (média ter–qui, 10h–11h, UVP)
  { name: 'Avenida Presidente Antônio Carlos', in10: 2709, out10: from2015(3800), source: 'radar 190 (nº 1089) / [1] pt 8' },
  { name: 'Avenida Presidente Juscelino Kubitschek', in10: 2467, out10: 0, source: 'radar 254 (nº 4333); sentido bairro não existe no recorte' },
  { name: 'Avenida Amazonas', in10: 1165, out10: 1668, source: 'radar 199 (nº 5400)' },
  { name: '@sul-motorway', in10: 2386, out10: 3018, source: 'radares 253/252 (N. S. do Carmo nº 1900–1925)' },
  { name: 'Avenida dos Andradas', in10: 1168, out10: 1041, source: 'radar 228 (nº 4020)' },
  { name: 'Avenida Cristiano Machado', in10: 4056, out10: 2310, source: 'radares 222 (nº 673) / 195 (R. Pitangui)' },
  // A JK deságua na Tereza Cristina: aqui só a saída (radar 216, nº 2350, sentido bairro)
  { name: 'Avenida Teresa Cristina', in10: 0, out10: 3237, source: 'radar 216 (nº 2350)' },
  // Só contagem de 2015 [1] → × 0,87 (10h) × 0,57
  { name: 'Avenida Presidente Carlos Luz', in10: from2015(4000), out10: from2015(2450), source: '[1] pt 18' },
  { name: 'Avenida Dom Pedro II', in10: from2015(2950), out10: from2015(1850), source: '[1] pt 41' },
  { name: 'Avenida Raja Gabaglia', in10: from2015(2100), out10: from2015(3350), source: '[1] pt 25' },
  { name: 'Avenida Barão Homem de Melo', in10: from2015(1450), out10: from2015(1550), source: '[1] pt 27' },
  // Anel Rodoviário (DNIT) não tem contagem: ESTIMATIVA simétrica
  { name: 'Anel Rodoviário Celso Mello de Azevedo', in10: 750, out10: 750, source: 'estimado' },
];

/**
 * Portões sem medição (ruas menores): ESTIMATIVA por faixa às 10h, conforme a hierarquia.
 */
export const DEFAULT_PER_LANE: Record<number, number> = {
  7: 450, // motorway
  6: 400, // trunk
  5: 300, // primary
  4: 200, // secondary
  3: 125, // tertiary
};

/**
 * Tráfego da hora em relação à hora pico da manhã (7h), medido: soma dos 78 radares/sentidos
 * da BHTrans em ter–qui 12–14/set/2023, em UVP (fonte [3]). O tráfego fica perto do pico a
 * manhã toda — às 10h ainda é 87% das 7h.
 */
export const HOUR_FACTOR: [number, number][] = [
  [6, 0.8], [7, 1.0], [8, 0.93], [9, 0.89], [10, 0.87], [11, 0.87], [12, 0.9],
];

/**
 * Destino de quem entra pelos portões às 10h. Passagem alta por causa da malha radial
 * ([2], seção 5.4: até 58% nas vias principais); o resto vai para o centro (dentro do
 * Contorno: trabalho, negócios, compras, saúde) ou para bairros dentro do mapa.
 */
export const GATE_IN_SPLIT = { centro: 0.4, bairro: 0.15, through: 0.45 };

/**
 * Viagens locais (origem e destino dentro do mapa) em relação às trocas centro↔portões.
 * [2] Tabela 16: Centro/Sul (12%) vs. Centro com as demais regionais (~20%) → ~0,6.
 * Divisão: às 10h 40% das viagens são volta para casa ([2] Fig. 51).
 */
export const LOCAL_RATIO = 0.6;
export const LOCAL_SPLIT = { bairroToCentro: 0.35, centroToBairro: 0.35, centroToCentro: 0.15, bairroToBairro: 0.15 };

/**
 * CENÁRIO (pedido, acima do que os dados indicam): mais gente cruzando o centro de um lado
 * a outro da cidade e mais gente saindo do centro. Multiplica as categorias calibradas.
 */
export const SCENARIO = {
  /** passagem: entra por um portão e sai do outro lado da cidade (atravessa o centro) */
  throughBoost: 1.4,
  /** do centro para fora (portões) e do centro para os bairros */
  outboundBoost: 1.4,
  /** ângulo mínimo (em torno da Praça Sete) entre entrada e saída da passagem, em graus */
  throughMinAngle: 110,
};

/**
 * Atrito urbano: dentro da Contorno o carro não anda no limite entre um cruzamento e outro
 * (ônibus parando, motos, gente estacionando, pedestres). Fração do limite de velocidade
 * usada como velocidade desejada, por hierarquia (rank) da via. Calibrado com a velocidade
 * de automóveis nos radares dentro da Contorno às 10h (mediana 29–46 km/h em vias de 60).
 */
export const URBAN_FRICTION: Record<number, number> = {
  7: 0.8, 6: 0.75, 5: 0.72, 4: 0.72, 3: 0.8, 2: 0.9, 1: 0.9,
};
/** distância além do casco da Contorno em que o atrito ainda vale (m) — inclui a própria avenida */
export const FRICTION_BUFFER = 150;
