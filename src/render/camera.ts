// Câmera 2D: `scale` em pixels por metro, (cx, cy) é o ponto do mundo no centro da tela.
export class Camera {
  cx = 0;
  cy = 0;
  scale = 0.2;
  width = 1;
  height = 1;
  static MIN_SCALE = 0.02;
  static MAX_SCALE = 40;

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  fit(x0: number, y0: number, x1: number, y1: number, padding = 0.95) {
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.scale = clamp(
      Math.min(this.width / (x1 - x0), this.height / (y1 - y0)) * padding,
      Camera.MIN_SCALE,
      Camera.MAX_SCALE,
    );
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [
      this.cx + (sx - this.width / 2) / this.scale,
      this.cy + (sy - this.height / 2) / this.scale,
    ];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [
      (wx - this.cx) * this.scale + this.width / 2,
      (wy - this.cy) * this.scale + this.height / 2,
    ];
  }

  panBy(dxPx: number, dyPx: number) {
    this.cx -= dxPx / this.scale;
    this.cy -= dyPx / this.scale;
  }

  /** Zoom mantendo fixo o ponto do mundo sob (sx, sy) */
  zoomAt(sx: number, sy: number, factor: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = clamp(this.scale * factor, Camera.MIN_SCALE, Camera.MAX_SCALE);
    this.cx = wx - (sx - this.width / 2) / this.scale;
    this.cy = wy - (sy - this.height / 2) / this.scale;
  }

  /** Retângulo visível em coordenadas do mundo */
  viewport(): [number, number, number, number] {
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.width, this.height);
    return [x0, y0, x1, y1];
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
