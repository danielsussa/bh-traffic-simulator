import { Camera } from './render/camera';
import { MapRenderer, type RenderOptions } from './render/mapRenderer';
import { RoadNetwork, type Edge } from './map/network';
import { SimRenderer, type SimRenderOptions } from './render/simRenderer';
import { DT, Simulation } from './sim/simulation';
import { CordonDemand, type CordonOD } from './sim/cordon';

const START_CLOCK = 9 * 3600 + 47 * 60; // 09:47: começa a quente e assenta até 09:50
const WARMUP = 3 * 60;
/** carros já na rua no início ≈ demanda/h × duração média da viagem (~12 min) */
const PREFILL_HOURS = 0.2;

const CLASS_LABEL: Record<string, string> = {
  motorway: 'Via expressa',
  trunk: 'Via de trânsito rápido',
  primary: 'Arterial',
  secondary: 'Coletora principal',
  tertiary: 'Coletora',
  residential: 'Local',
  unclassified: 'Local',
  living_street: 'Via compartilhada',
};

/**
 * Mapas: `contorno` (padrão) = só dentro da Av. do Contorno, com demanda extraída do modelo
 * da cidade; `cidade` = recorte grande com a demanda calibrada. Troca com ?mapa=cidade
 */
const MAP = new URLSearchParams(location.search).get('mapa') === 'cidade' ? 'cidade' : 'contorno';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main() {
  const canvas = $<HTMLCanvasElement>('map');
  // BASE_URL: '/' no dev, '/bh-traffic-simulator/' no GitHub Pages
  const data = (f: string) => `${import.meta.env.BASE_URL}data/${f}`;
  const net = await RoadNetwork.load(data(MAP === 'cidade' ? 'bh.json' : 'bh-contorno.json'));
  const od: CordonOD | null = MAP === 'contorno' ? await (await fetch(data('bh-contorno-od.json'))).json() : null;
  const camera = new Camera();
  const renderer = new MapRenderer(canvas, net, camera);
  const sim = new Simulation(net, 42, START_CLOCK, od ? (g) => new CordonDemand(g, od) : undefined);
  // No recorte, 100% = todas as viagens da cidade que passam por aqui com rotas de fluxo
  // livre; parte delas desviaria pelo Anel/Via Expressa com o centro travado. 70% deixa o
  // centro bem congestionado sem colapsar.
  if (MAP === 'contorno') sim.demandScale = 0.7;
  // Vista inicial: a região inteira do mapa (a cidade abre centrada no Contorno)
  const HOME_VIEW: [number, number, number, number] =
    MAP === 'cidade' ? [-3400, -2700, 3400, 2900] : [net.bounds[0] - 100, net.bounds[1] - 100, net.bounds[2] + 100, net.bounds[3] + 100];
  const simRenderer = new SimRenderer(canvas, sim, camera);
  const simOpts: SimRenderOptions = { cars: true, signals: true, traffic: false };
  let playing = true;
  let speed = 1;

  const opts: RenderOptions = { labels: true, lanes: true, arrows: true, nodes: false };
  let dirty = true;
  const requestRender = () => (dirty = true);

  /** Enquadra a região na parte da tela livre da coluna lateral (~284 px à esquerda) */
  function fitHome() {
    const side = window.innerWidth > 700 ? 284 : 0;
    camera.resize(window.innerWidth - side, window.innerHeight);
    camera.fit(...HOME_VIEW, 0.95);
    camera.resize(window.innerWidth, window.innerHeight);
    camera.panBy(side / 2, 0);
  }

  // ---- tamanho / DPI ----
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    camera.resize(window.innerWidth, window.innerHeight);
    requestRender();
  }
  window.addEventListener('resize', resize);
  resize();
  fitHome();

  // ---- painel ----
  $('map-name').textContent = net.name;
  const km = net.edges.reduce((s, e) => s + e.length, 0) / 1000;
  const crossings = net.nodes.filter((n) => n.edges.length >= 3).length;
  $('stats').textContent =
    `${net.edges.length.toLocaleString('pt-BR')} trechos · ` +
    `${crossings.toLocaleString('pt-BR')} cruzamentos · ${km.toFixed(0)} km`;
  $('attribution').textContent = net.source;
  document.querySelector('#sim-panel .slider .hint')!.textContent =
    MAP === 'cidade'
      ? '100% = radares BHTrans 2023 + cenário com mais travessias do centro'
      : '100% = viagens da cidade que passam pela Contorno (rotas com o trânsito simulado); 70% bate com os radares';
  const sw = $<HTMLAnchorElement>('map-switch');
  sw.href = MAP === 'cidade' ? '?' : '?mapa=cidade';
  sw.textContent = MAP === 'cidade' ? 'Simular só dentro da Contorno' : 'Simular a cidade (recorte grande)';

  const names = [...new Set(net.edges.map((e) => e.name).filter(Boolean) as string[])].sort();
  $('street-names').innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">`).join('');
  $<HTMLInputElement>('search').addEventListener('change', (ev) => {
    const q = (ev.target as HTMLInputElement).value.trim();
    const matches = net.edges.filter((e) => e.name === q);
    renderer.selectedName = matches.length ? q : null;
    if (matches.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const e of matches) {
        x0 = Math.min(x0, e.bbox[0]); y0 = Math.min(y0, e.bbox[1]);
        x1 = Math.max(x1, e.bbox[2]); y1 = Math.max(y1, e.bbox[3]);
      }
      camera.fit(x0 - 150, y0 - 150, x1 + 150, y1 + 150, 0.8);
    }
    requestRender();
  });

  for (const key of ['labels', 'lanes', 'arrows', 'nodes'] as const) {
    const el = $<HTMLInputElement>(`opt-${key}`);
    el.checked = opts[key];
    el.addEventListener('change', () => {
      opts[key] = el.checked;
      requestRender();
    });
  }
  for (const key of ['cars', 'signals', 'traffic'] as const) {
    const el = $<HTMLInputElement>(`opt-${key}`);
    el.checked = simOpts[key];
    el.addEventListener('change', () => {
      simOpts[key] = el.checked;
      requestRender();
    });
  }
  const playBtn = $<HTMLButtonElement>('play');
  const setPlaying = (p: boolean) => {
    playing = p;
    playBtn.textContent = p ? '⏸' : '▶';
  };
  playBtn.addEventListener('click', () => setPlaying(!playing));
  const speedBtns = [...document.querySelectorAll<HTMLButtonElement>('#speeds button')];
  const setSpeed = (v: number) => {
    speed = v;
    speedBtns.forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === v));
  };
  speedBtns.forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
  setSpeed(1);
  const demandEl = $<HTMLInputElement>('demand');
  demandEl.value = String(Math.round(sim.demandScale * 100));
  const showDemand = () => {
    const pct = Math.round(sim.demandScale * 100);
    $('demand-label').textContent = `${pct}% · ${(sim.demandPerHour() / 1000).toFixed(1)} mil/h`;
  };
  demandEl.addEventListener('input', () => {
    sim.demandScale = Number(demandEl.value) / 100;
    showDemand();
  });
  showDemand();
  const sigBtn = $<HTMLButtonElement>('signals-toggle');
  const showSignals = () => {
    sigBtn.textContent = sim.signalsOn ? '🚦 Semáforos funcionando' : '⚠️ Apagão: semáforos desligados';
    sigBtn.classList.toggle('off', !sim.signalsOn);
  };
  sigBtn.addEventListener('click', () => {
    sim.setSignals(!sim.signalsOn);
    showSignals();
    updateSimPanel(true);
    requestRender();
  });
  showSignals();
  const chaosEl = $<HTMLInputElement>('chaos');
  chaosEl.value = String(Math.round(sim.chaos * 100));
  const showChaos = () => ($('chaos-label').textContent = `${Math.round(sim.chaos * 100)}% dos motoristas`);
  chaosEl.addEventListener('input', () => {
    sim.chaos = Number(chaosEl.value) / 100;
    showChaos();
  });
  showChaos();

  $('reset-view').addEventListener('click', () => {
    fitHome();
    renderer.selectedName = null;
    $<HTMLInputElement>('search').value = '';
    requestRender();
  });

  // ---- interação: arrastar, zoom, hover, clique ----
  let drag: { x: number; y: number; moved: boolean } | null = null;
  let pinned: Edge | null = null;

  canvas.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, moved: false };
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (drag.moved || Math.hypot(dx, dy) > 3) {
        drag.moved = true;
        canvas.classList.add('dragging');
        camera.panBy(dx, dy);
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        requestRender();
      }
      return;
    }
    if (pinned) return;
    const edge = pick(ev.clientX, ev.clientY);
    if (edge !== renderer.highlighted) {
      renderer.highlighted = edge;
      showInfo(edge, false);
      requestRender();
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    const wasClick = drag && !drag.moved;
    drag = null;
    canvas.classList.remove('dragging');
    if (!wasClick) return;
    const edge = pick(ev.clientX, ev.clientY);
    pinned = edge;
    renderer.highlighted = edge;
    showInfo(edge, !!edge);
    requestRender();
  });
  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      camera.zoomAt(ev.clientX, ev.clientY, factor);
      requestRender();
    },
    { passive: false },
  );
  window.addEventListener('keydown', (ev) => {
    if (ev.key === ' ' && document.activeElement?.tagName !== 'INPUT') {
      ev.preventDefault();
      setPlaying(!playing);
    }
    if (ev.key === 'Escape') {
      pinned = null;
      renderer.highlighted = null;
      renderer.selectedName = null;
      showInfo(null, false);
      requestRender();
    }
  });

  function pick(sx: number, sy: number): Edge | null {
    const [wx, wy] = camera.toWorld(sx, sy);
    return net.pickEdge(wx, wy, Math.max(4, 8 / camera.scale));
  }

  function showInfo(e: Edge | null, isPinned: boolean) {
    const box = $('info');
    if (!e) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const dir = e.lanesBwd === 0
      ? `Mão única · ${e.lanesFwd} faixa${e.lanesFwd > 1 ? 's' : ''}`
      : `Mão dupla · ${e.lanesFwd} + ${e.lanesBwd} faixas`;
    box.innerHTML = `
      <h2>${escapeHtml(e.name ?? '(sem nome)')}</h2>
      <dl>
        <dt>Tipo</dt><dd>${CLASS_LABEL[e.cls] ?? e.cls}${e.isLink ? ' (alça)' : ''}${e.roundabout ? ' · rotatória' : ''}</dd>
        <dt>Sentido</dt><dd>${dir}</dd>
        <dt>Velocidade</dt><dd>${e.maxSpeed} km/h</dd>
        <dt>Comprimento</dt><dd>${e.length.toFixed(0)} m</dd>
        ${e.layer ? `<dt>Nível</dt><dd>${e.layer > 0 ? 'viaduto' : 'túnel/trincheira'}</dd>` : ''}
        ${linkInfo(e)}
        <dt>Trecho</dt><dd>#${e.id} (nó ${e.from} → ${e.to})</dd>
        <dt>OSM</dt><dd><a href="https://www.openstreetmap.org/way/${e.osmId}" target="_blank">way/${e.osmId}</a></dd>
      </dl>
      <div class="hint">${isPinned ? 'Fixado — Esc para soltar' : 'Clique para fixar'}</div>`;
  }

  function linkInfo(e: Edge): string {
    const rows: string[] = [];
    for (const l of sim.graph.links.filter((l) => l.edge === e)) {
      const cars = l.lanes.reduce((n, la) => n + la.vehicles.length, 0);
      const dir = e.lanesBwd === 0 ? '' : l.forward ? ' (→)' : ' (←)';
      rows.push(`<dt>Carros${dir}</dt><dd>${cars} · ${(l.speedRatio * 100).toFixed(0)}% da vel.</dd>`);
      if (l.signal) {
        const c = sim.signals.controllers[l.signal.controller];
        const st = sim.signals.state(c.id, l.signal.phase, sim.t);
        const name = sim.signalsOn ? { green: '🟢 verde', yellow: '🟡 amarelo', red: '🔴 vermelho' }[st.state] : '🟡 apagado (piscante)';
        rows.push(`<dt>Semáforo${dir}</dt><dd>${name} · ${Math.ceil(st.remaining)}s</dd>`);
        rows.push(`<dt>Fonte</dt><dd>${c.inferred ? 'estimado (sem dado no OSM)' : 'OpenStreetMap'}</dd>`);
        rows.push(`<dt>Ciclo</dt><dd>${c.cycle}s · ${c.phases.length} fase${c.phases.length > 1 ? 's' : ''}${c.pedestrian ? ' + pedestres' : ''} · verde ${c.phases[l.signal.phase].green}s</dd>`);
      } else if (l.control === 'stop') rows.push(`<dt>Controle${dir}</dt><dd>placa PARE</dd>`);
    }
    return rows.join('');
  }

  // ---- simulação ----
  const clockEl = $('clock');
  const fmtClock = (t: number) =>
    [Math.floor(t / 3600), Math.floor((t % 3600) / 60), Math.floor(t % 60)].map((n) => String(n).padStart(2, '0')).join(':');
  let lastStats = 0;
  const signalsInferred = sim.signals.controllers.filter((c) => c.inferred).length;
  const signalsOsm = sim.signals.controllers.length - signalsInferred;
  function updateSimPanel(force = false) {
    clockEl.textContent = fmtClock(sim.t);
    const now = performance.now();
    if (!force && now - lastStats < 500) return;
    lastStats = now;
    showDemand();
    const st = sim.getStats();
    const fmt = (n: number) => Math.round(n).toLocaleString('pt-BR');
    $('sim-stats').innerHTML = `
      <dt>Carros na rua</dt><dd>${fmt(st.active)}</dd>
      <dt>Velocidade média</dt><dd>${st.meanSpeedKmh.toFixed(0)} km/h</dd>
      <dt>Parados</dt><dd>${st.stoppedPct.toFixed(0)}% (${fmt(st.atRed)} no vermelho)</dd>
      <dt>Chegaram</dt><dd>${fmt(st.arrived)}</dd>
      <dt>Viagem média</dt><dd>${st.avgTripMin.toFixed(1)} min</dd>
      <dt>Esperando p/ entrar</dt><dd>${fmt(st.waitingToEnter)}</dd>
      <dt>Fechando cruzamento</dt><dd>${fmt(st.blockingNow)} agora</dd>
      <dt>Avançaram o sinal</dt><dd>${fmt(st.ranRed)}</dd>
      <dt>Apressados / barbeiros</dt><dd>${fmt(st.byStyle.apressado)} / ${fmt(st.byStyle.barbeiro)}</dd>
      <dt>Semáforos</dt><dd>${sim.signalsOn ? `${fmt(signalsOsm)} OSM + ${fmt(signalsInferred)} estimados` : 'apagados (amarelo piscante)'}</dd>`;
    if (pinned) showInfo(pinned, true);
  }

  async function warmup() {
    const box = $('loading');
    box.hidden = false;
    $('loading-text').textContent = 'colocando os carros na rua…';
    await new Promise((r) => setTimeout(r, 0));
    sim.prefill(Math.round(sim.demandPerHour() * PREFILL_HOURS));
    const end = sim.t + WARMUP;
    const total = WARMUP;
    while (sim.t < end) {
      const t0 = performance.now();
      while (sim.t < end && performance.now() - t0 < 60) sim.step(DT);
      $('loading-text').textContent = `${fmtClock(sim.t)} · ${sim.vehicles.length.toLocaleString('pt-BR')} carros`;
      $('progress-bar').style.width = `${(100 * (total - (end - sim.t))) / total}%`;
      await new Promise((r) => setTimeout(r, 0));
    }
    box.hidden = true;
  }

  // ---- escala ----
  function updateScaleBar() {
    const targetPx = 100;
    const meters = targetPx / camera.scale;
    const pow = 10 ** Math.floor(Math.log10(meters));
    const nice = [1, 2, 5, 10].map((m) => m * pow).filter((m) => m <= meters).pop() ?? pow;
    const el = $('scale');
    (el.querySelector('.bar') as HTMLElement).style.width = `${nice * camera.scale}px`;
    el.querySelector('span')!.textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  }

  let lastFrame = performance.now();
  let simDebt = 0;
  function frame(now: number) {
    const realDt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (playing) {
      simDebt += realDt * speed;
      const t0 = performance.now();
      // Orçamento de ~25ms por quadro; se não der conta, a simulação desacelera
      while (simDebt >= DT && performance.now() - t0 < 25) {
        sim.step(DT);
        simDebt -= DT;
      }
      if (simDebt > DT * 4) simDebt = DT * 4;
      dirty = true;
      updateSimPanel();
    }
    if (!sim.signalsOn && simOpts.signals) dirty = true; // pisca mesmo pausado
    if (dirty) {
      dirty = false;
      renderer.render(opts, () => simRenderer.render(simOpts));
      updateScaleBar();
    }
    requestAnimationFrame(frame);
  }
  updateSimPanel(true);
  renderer.render(opts, () => simRenderer.render(simOpts));
  await warmup();
  updateSimPanel(true);
  requestAnimationFrame(frame);

  // Exposto para depuração no console
  Object.assign(window, { net, camera, renderer, sim, setSpeed, setPlaying });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

main().catch((err) => {
  console.error(err);
  document.getElementById('map-name')!.textContent = `Erro: ${err.message}`;
});
