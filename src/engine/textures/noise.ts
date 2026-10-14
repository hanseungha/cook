/**
 * 절차적 텍스처용 노이즈 유틸 (three.js·DOM 비의존 → Web Worker에서 사용 가능).
 * 시드 고정 PRNG로 매번 같은 결과를 만든다 (스크린샷 비교 테스트용).
 */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 타일링 가능한 value noise (격자 cell 단위 보간) */
export function tileableNoise(size: number, cells: number, rand: () => number) {
  const grid = new Float32Array(cells * cells).map(() => rand());
  const out = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * cells;
    const y0 = Math.floor(gy);
    const ty = smooth(gy - y0);
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const ix0 = x0 % cells;
      const ix1 = (x0 + 1) % cells;
      const r0 = (y0 % cells) * cells;
      const r1 = ((y0 + 1) % cells) * cells;
      const g00 = grid[r0 + ix0];
      const g10 = grid[r0 + ix1];
      const g01 = grid[r1 + ix0];
      const g11 = grid[r1 + ix1];
      const a = g00 + (g10 - g00) * tx;
      const b = g01 + (g11 - g01) * tx;
      out[y * size + x] = a + (b - a) * ty;
    }
  }
  return out;
}

export function fbm(size: number, octaves: [cells: number, weight: number][], seed: number) {
  const rand = mulberry32(seed);
  const out = new Float32Array(size * size);
  let total = 0;
  for (const [cells, w] of octaves) {
    const n = tileableNoise(size, cells, rand);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * w;
    total += w;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** 높이맵(0..1) → 탄젠트 공간 노멀맵 RGBA */
export function heightToNormal(h: Float32Array, size: number, strength: number) {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) =>
    h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return data;
}

