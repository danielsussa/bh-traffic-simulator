# BH Traffic Simulator

Simulador de trânsito **microscópico** do centro de Belo Horizonte: cada carro é um agente com rota, faixa, motorista e decisões próprias, andando sobre a malha viária real (OpenStreetMap), com semáforos, preferência nos cruzamentos e motoristas que dirigem mal. A demanda é calibrada com contagens e radares da BHTrans.

**▶ Rodar no navegador:** https://danielsussa.github.io/bh-traffic-simulator/
(cidade inteira: [`?mapa=cidade`](https://danielsussa.github.io/bh-traffic-simulator/?mapa=cidade))

## O que dá para fazer

- Ver ~5–6 mil carros circulando **dentro da Av. do Contorno** às 10h de um dia útil (1×, 5×, 10×, 30×).
- **Apagão**: desligar todos os semáforos (amarelo piscante) e ver os cruzamentos funcionando na preferência — todo mundo freia, olha e vai.
- **Caos**: escolher a fração de motoristas apressados e "barbeiros" que fecham cruzamento, avançam o sinal e furam a preferência.
- Ajustar a **demanda** (100% = viagens da cidade que passam pela Contorno).
- Clicar numa via para ver faixas, limite, fluxo, semáforo (fase, ciclo, tempo restante) e se o semáforo veio do OSM ou foi estimado.
- Camada de **trânsito** (vias coloridas pela velocidade) e halos nos cruzamentos fechados.

## Como funciona

### Rede viária
`scripts/build-map.mjs` converte o extrato do OpenStreetMap (`data/raw/`) num grafo: nós = cruzamentos, semáforos e placas de PARE; arestas = trechos com geometria, faixas por sentido, limite de velocidade, viadutos. Semáforos vêm do OSM (incluindo faixas de pedestre semaforizadas); cruzamentos de avenida dentro da Contorno sem dado ganham um semáforo **estimado** (marcado no mapa). Praças circulares sem a tag de rotatória (ex.: Raul Soares) são detectadas pela geometria.

### Semáforos
Pontos próximos viram um cruzamento controlado; as aproximações são agrupadas em fases pela direção. Tempo fixo: verde proporcional ao porte das vias, amarelo 3 s, vermelho geral 2 s, defasagem aleatória entre cruzamentos (sem onda verde).

### Demanda (de onde vêm e para onde vão os carros)
1. **Cidade** (`src/sim/demand.ts`, `src/sim/calibration.ts`): portões nas vias que saem do mapa com fluxos dos **radares da BHTrans (set/2023, 10h)** ou, sem radar, contagens do Diagnóstico de Mobilidade 2017 ajustadas; destinos e mix de viagens pela **Pesquisa Origem-Destino 2012**; curva horária medida nos radares (às 10h o tráfego é 87% do pico das 7h). Há um *cenário* explícito com mais travessias do centro.
2. **Recorte da Contorno** (`scripts/build-subarea.ts`, `src/sim/cordon.ts`): a cidade inteira é simulada por 30 min, e com os tempos de percurso congestionados cada viagem é roteada; registra-se onde ela entra/sai da Contorno (ou nasce/estaciona dentro). O resultado é a matriz origem-destino do recorte.

### Decisão de cada carro

Três níveis, com frequências diferentes:

**Rota (ao nascer e quando trava)** — A\* minimizando o tempo esperado: tempo observado do trecho × ruído pessoal (0,85–1,35) × preferência por hierarquia (local ×1,4, coletora ×1,15) + espera no semáforo (Webster, `(ciclo − verde)² / 2·ciclo`) ou PARE + penalidade de conversão/retorno. Recalcula se os próximos trechos acumulam > 60 s de atraso, se fica > 20 s bloqueado esperando espaço numa saída, ou se chega na faixa errada perto do cruzamento.

**Faixa (a cada ~1 s)** — faixas válidas dependem das saídas do nó (a continuação usa todas; um ramo usa as faixas do seu lado, quantas ele tiver). Na conversão a ordem das faixas é mantida. Troca de faixa estilo MOBIL: obrigatória (posicionar para a conversão, inclusive a conversão depois de um trecho curto) ou por vantagem de aceleração, com viés para a direita, só com folga segura atrás e à frente.

**Aceleração (a cada 0,25 s)** — modelo IDM (*Intelligent Driver Model*):

```
a = a_max · [ 1 − (v/v₀)⁴ − (s*/s)² ]      s* = s₀ + v·T + v·Δv / (2√(a_max·b))
```

A aceleração final é a menor entre: andar livre até `v₀` (limite × atrito urbano × gosto do motorista); **curvas** (`v ≤ √(a_lateral·R)`, freando só o necessário e acelerando a partir do ápice); o **carro da frente** (ou o último da faixa de destino, do outro lado do cruzamento); e a **linha de retenção**, quando ele é o primeiro da fila, checando em ordem:

1. cruzamento fechado por alguém parado no miolo (vindo de direção que cruza) → espera, mesmo no verde;
2. não cabe inteiro do outro lado → espera ("não bloqueie o cruzamento") — apressados/barbeiros às vezes entram mesmo assim e **fecham o cruzamento**;
3. semáforo: verde passa; amarelo passa se não conseguir parar com a frenagem que aceita; vermelho recém-aberto o apressado às vezes avança;
4. semáforo apagado: para, olha e segue (o apressado só reduz a ~15 km/h);
5. miolo ocupado por quem atravessa num cruzamento sem semáforo → espera;
6. PARE → para totalmente;
7. preferência (via principal, quem vem da direita, quem está na rotatória): cede se alguém com preferência chega em < ~3,5 s (1,6 s numa confluência); após 12 s força a passagem.

Por fim, fatores humanos: tempo de reação para arrancar e distrações (o barbeiro freia do nada). Uma trava física impede sobreposição; quem fica > 4 min parado desiste (é removido).

### Perfis de motorista

| | Normal | Apressado | Barbeiro |
|---|---|---|---|
| Distância do carro da frente (T) | 0,9–1,4 s | 0,5–0,8 s | 1,0–1,8 s |
| Velocidade desejada × limite | 0,85–1,1 | 1,05–1,3 | 0,75–1,0 |
| Reação para arrancar | 0,3–0,8 s | 0,1–0,3 s | 1–3 s |
| Fecha o cruzamento | nunca | 60% | 35% (sem querer) |
| Avança vermelho recém-aberto | nunca | 35% | 5% |
| Fura a preferência | nunca | 10% | 20% |
| Semáforo apagado | para e olha 1–2 s | reduz e olha 0,3–0,8 s | para e olha 2–4 s |

O controle **Caos** é a fração de motoristas ruins (60% apressados, 40% barbeiros).

## Validação

Velocidade mediana de automóveis às 10h nos radares dentro da Contorno (real × simulado, demanda 70%): erro máximo de ~11 km/h, contra até 29 km/h antes da calibração de atrito urbano e das rotas congestionadas. Ainda mais rápidos que o real: Bias Fortes e Contorno perto da Savassi (faltam ônibus e pedestres). Detalhes: `npm run validate:speeds -- 0.7`.

## Rodando localmente

```bash
npm install
npm run dev            # http://localhost:5173 (?mapa=cidade para o recorte grande)
```

Scripts úteis (`npx tsx scripts/<nome>.ts`):

| Script | Para quê |
|---|---|
| `build-map.mjs` | regenera o grafo a partir do OSM (`npm run map:build`) |
| `build-subarea.ts` | recorte da Contorno + matriz OD com trânsito simulado (~6 min) |
| `bench.ts` | simula sem navegador (`MAPA=contorno PREFILL=1 SEMAFOROS=0 CHAOS=0.5`) |
| `compare-speeds.ts` | velocidade simulada × radares |
| `validate-radars.ts` | fluxo simulado × radares (mapa da cidade) |
| `hotspots.ts` | vias com mais carros parados |
| `demand-report.ts`, `trip-report.ts` | demanda por portão/categoria, distância das viagens |
| `check-overlap.ts`, `check-turns.ts`, `saturation.ts` | testes de sanidade do modelo |

## Estrutura

```
src/map/network.ts        grafo viário (carregamento, busca espacial)
src/sim/graph.ts          links por sentido, faixas, conversões, raios de curva, rotatórias
src/sim/signals.ts        semáforos (agrupamento, fases, tempos, estimados)
src/sim/router.ts         A* por tempo de viagem
src/sim/demand.ts         demanda calibrada da cidade
src/sim/cordon.ts         demanda do recorte (matriz OD)
src/sim/drivers.ts        perfis de motorista
src/sim/simulation.ts     motor: IDM, cruzamentos, faixas, reroteamento
src/render/*              desenho em Canvas (mapa, carros, semáforos)
```

## Fontes e licenças dos dados

- Malha viária: © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright), licença ODbL.
- BHTRANS, [Diagnóstico da Mobilidade Urbana 2017](https://prefeitura.pbh.gov.br/sites/default/files/estrutura-de-governo/bhtrans/Diagnostico%202017.05.08.pdf) (contagens 2015, Pesquisa OD 2012).
- BHTRANS, [Contagens Volumétricas de Radares](https://dados.pbh.gov.br/dataset/contagens-volumetricas-de-radares) — Portal de Dados Abertos da PBH (agregados em `data/radar/`).
