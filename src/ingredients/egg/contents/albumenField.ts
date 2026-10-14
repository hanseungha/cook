import { fbm } from "@/engine/textures/noise";

/**
 * 흰자 두께장 (three.js 비의존).
 *
 * 바닥(팬 조리면 등) 위의 격자마다 흰자 두께 h를 두고, 점성 액체의 얇은 막 흐름(윤활 근사)으로 퍼뜨린다:
 *   ∂h/∂t = ∇·( K·m·h³ ∇(바닥 + h) )
 * - 두꺼울수록 빨리 흐르고 얇아지면 거의 멈춘다 → 가장자리가 둥글게 부푼 채 퍼짐
 * - 항복 응력(τ): 흰자는 일정 기울기 이하에서 멈춘다. τ와 이동도 m에 저주파 노이즈를 주어
 *   가장자리가 매번 불규칙한 모양으로 멈춘다
 * - 바닥 높이를 포함하므로 팬 벽에 닿으면 되돌아와 평평한 바닥에 고인다
 */

/** 격자 해상도·크기 (렌더 메시도 같은 격자를 쓴다) */
// 팬 안 어디서 부어도 팬 전체(지름 28cm)가 격자 안에 들어오는 크기. 계산 비용은 흰자가 덮은 영역에만 비례한다
export const FIELD_GRID = { n: 190, size: 0.52 };

/** 이웃 격자와의 바닥 높이 차가 이보다 크면 절벽 (팬 테두리 → 유리, 유리 → 바닥). 팬 안쪽 벽의 가장 가파른 곳보다 크게 */
export const CLIFF = 0.012;

/** 절벽을 가로지르는 격자 변 위의 정확한 절벽 위치 */
export type CliffCrossing = {
  /** 높은 쪽 / 낮은 쪽 격자점 */
  hi: number;
  lo: number;
  /** 절벽 위치 (월드) */
  x: number;
  z: number;
  /** 절벽 위·아래 바닥 높이 */
  top: number;
  bottom: number;
};

/**
 * 절벽이 지나가는 격자 칸. edges는 둘레 순서(아래 → 오른쪽 → 위 → 왼쪽)의 네 변,
 * 절벽이 지나는 변에만 교차점이 있다. corners는 같은 순서의 네 격자점.
 */
export type CliffCell = { cell: number; corners: [number, number, number, number]; edges: Array<CliffCrossing | null> };

/** 흐름 계수 (≈ g / 3ν) — 1초 남짓 퍼지다 멈추도록 맞춘 값 */
const K = 9000;
/** 항복 응력에 해당하는 두께×기울기 (m) */
const YIELD = 2.6e-4;
/** 이보다 얇으면 흐르지 않는다 (m) */
const MIN_FLOW_H = 2e-5;
/** 이동도 계산 시 두께 상한 (떨어지는 순간 쌓인 덩어리 때문에 시간 간격이 너무 작아지지 않게) */
const MAX_FLOW_H = 0.007;

const NOISE_SIZE = 256;
const noiseCache = new Map<number, { lobes: Float32Array; fine: Float32Array }>();

/** 가장자리 불규칙성 노이즈 (위치와 무관 → 미리 만들어 둘 수 있다) */
export function albumenNoise(seed = 23) {
  let n = noiseCache.get(seed);
  if (!n) {
    n = {
      // 격자 한 변(52cm) 기준 주기 수. 계란(지름 10~14cm) 크기에서 몇 개의 큰 혀(파장 3~7cm)와
      // 잔 물결(파장 7~13mm)이 생기도록 — 너무 길면 계란 안에서는 한쪽으로 기운 기울기일 뿐이라 외곽이 동그래진다
      lobes: fbm(NOISE_SIZE, [[8, 1], [14, 0.7], [24, 0.4]], seed),
      fine: fbm(NOISE_SIZE, [[40, 1], [72, 0.5]], seed + 1),
    };
    noiseCache.set(seed, n);
  }
  return n;
}

export class AlbumenField {
  readonly n: number;
  readonly size: number;
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly ground: Float32Array;
  readonly h: Float32Array;
  private readonly mobility: Float32Array;
  private readonly yieldH: Float32Array;
  private readonly dh: Float32Array;
  /** 절벽이 지나가는 칸들 (바닥은 변하지 않으므로 한 번만 계산) */
  readonly cliffs: CliffCell[] = [];
  private readonly cliffCellSet = new Set<number>();
  /** 흰자가 지나간 자리: 지금까지의 최대 두께. 흘러간 뒤에도 얇은 젖은 막이 남는다 */
  readonly wet: Float32Array;
  private readonly eta: Float32Array;
  /** 흰자가 있는 영역(+여백)만 계산 */
  private box = { i0: 0, i1: -1, j0: 0, j1: -1 };
  /** 마지막으로 흰자가 더해진 뒤 경과 시간 (초) */
  private quiet = 0;
  /** 이번 프레임에 두께가 변했는지 (렌더 갱신 여부) */
  changed = false;
  settled = false;

  constructor(
    cx: number,
    cz: number,
    groundAt: (x: number, z: number) => number,
    { n = FIELD_GRID.n, size = FIELD_GRID.size, seed = 23 } = {},
  ) {
    this.n = n;
    this.size = size;
    this.cell = size / (n - 1);
    this.x0 = cx - size / 2;
    this.z0 = cz - size / 2;
    const count = n * n;
    this.ground = new Float32Array(count);
    this.h = new Float32Array(count);
    this.dh = new Float32Array(count);

    this.eta = new Float32Array(count);
    this.wet = new Float32Array(count);
    this.mobility = new Float32Array(count);
    this.yieldH = new Float32Array(count);
    // 노이즈 텍스처를 격자에 샘플
    const noiseSize = NOISE_SIZE;
    const { lobes, fine } = albumenNoise(seed);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        this.ground[k] = groundAt(this.x0 + i * this.cell, this.z0 + j * this.cell);
        const t = Math.floor((j / n) * noiseSize) * noiseSize + Math.floor((i / n) * noiseSize);
        const l = (lobes[t] - 0.5) * 2;
        const f = (fine[t] - 0.5) * 2;
        this.mobility[k] = 1 + l * 0.45 + f * 0.2;
        this.yieldH[k] = YIELD * Math.max(0.2, 1 - l * 0.65 + f * 0.3);
      }
    }
    this.findCliffs(groundAt);
  }

  /**
   * 절벽선 추출 (마칭 스퀘어): 바닥 높이가 크게 바뀌는 격자 변마다 실제 표면 함수로 이분 탐색해
   * 절벽 위치를 정확히 찾고, 한 칸 안의 두 교차점을 이어 끊김 없는 선을 만든다.
   */
  private findCliffs(groundAt: (x: number, z: number) => number) {
    const { n, ground, cell, x0, z0 } = this;
    const crossings = new Map<number, CliffCrossing>();
    // 변 id: 가로 변 = k*2, 세로 변 = k*2+1 (k = 시작 격자점)
    const crossing = (k: number, o: number, id: number) => {
      const cached = crossings.get(id);
      if (cached) return cached;
      const g0 = ground[k];
      const g1 = ground[k + o];
      const hi = g0 > g1 ? k : k + o;
      const lo = g0 > g1 ? k + o : k;
      const top = Math.max(g0, g1);
      const bottom = Math.min(g0, g1);
      const ax = x0 + (hi % n) * cell;
      const az = z0 + Math.floor(hi / n) * cell;
      const bx = x0 + (lo % n) * cell;
      const bz = z0 + Math.floor(lo / n) * cell;
      let t0 = 0;
      let t1 = 1;
      for (let it = 0; it < 10; it++) {
        const t = (t0 + t1) / 2;
        const g = groundAt(ax + (bx - ax) * t, az + (bz - az) * t);
        if (g > (top + bottom) / 2) t0 = t;
        else t1 = t;
      }
      const t = (t0 + t1) / 2;
      const c = { hi, lo, x: ax + (bx - ax) * t, z: az + (bz - az) * t, top, bottom };
      crossings.set(id, c);
      return c;
    };
    const isCliff = (a: number, b: number) => Math.abs(ground[a] - ground[b]) > CLIFF;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const k = j * n + i;
        // 둘레 순서: 아래(k→k+1), 오른쪽(k+1→k+1+n), 위(k+1+n→k+n), 왼쪽(k+n→k)
        const edges = [
          isCliff(k, k + 1) ? crossing(k, 1, k * 2) : null,
          isCliff(k + 1, k + 1 + n) ? crossing(k + 1, n, (k + 1) * 2 + 1) : null,
          isCliff(k + n, k + n + 1) ? crossing(k + n, 1, (k + n) * 2) : null,
          isCliff(k, k + n) ? crossing(k, n, k * 2 + 1) : null,
        ];
        if (edges.some(Boolean)) {
          this.cliffs.push({ cell: k, corners: [k, k + 1, k + 1 + n, k + n], edges });
          this.cliffCellSet.add(k);
        }
      }
    }
  }

  /**
   * 렌더용 삼각형 인덱스: 절벽을 가로지르는 삼각형은 뺀다
   * (세로로 늘어난 커튼이 되지 않도록 — 절벽은 흘러내리는 막이 따로 그린다)
   */
  surfaceIndex() {
    const { n, ground } = this;
    const out: number[] = [];
    const ok = (a: number, b: number, c: number) =>
      Math.max(ground[a], ground[b], ground[c]) - Math.min(ground[a], ground[b], ground[c]) <= CLIFF;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        // PlaneGeometry와 같은 분할
        const a = i + n * j;
        const b = i + n * (j + 1);
        const c = i + 1 + n * (j + 1);
        const d = i + 1 + n * j;
        // 절벽이 지나가는 칸은 따로 (절벽선에서 정확히 나눠) 그린다
        if (this.cliffCellSet.has(j * n + i)) continue;
        if (ok(a, b, d)) out.push(a, b, d);
        if (ok(b, c, d)) out.push(b, c, d);
      }
    }
    return out;
  }

  /** 월드 (x, z)의 격자 좌표 */
  private toGrid(x: number, z: number) {
    return [(x - this.x0) / this.cell, (z - this.z0) / this.cell] as const;
  }

  /** 두께 (쌍선형 보간) */
  heightAt(x: number, z: number) {
    const [gx, gz] = this.toGrid(x, z);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    if (i < 0 || j < 0 || i >= this.n - 1 || j >= this.n - 1) return 0;
    const tx = gx - i;
    const tz = gz - j;
    const k = j * this.n + i;
    const h = this.h;
    return (
      (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + this.n] * (1 - tx) + h[k + this.n + 1] * tx) * tz
    );
  }

  /** 바닥 높이 (쌍선형 보간) */
  groundAt(x: number, z: number) {
    const [gx, gz] = this.toGrid(x, z);
    const i = Math.min(this.n - 2, Math.max(0, Math.floor(gx)));
    const j = Math.min(this.n - 2, Math.max(0, Math.floor(gz)));
    const tx = Math.min(1, Math.max(0, gx - i));
    const tz = Math.min(1, Math.max(0, gz - j));
    const k = j * this.n + i;
    const g = this.ground;
    return (
      (g[k] * (1 - tx) + g[k + 1] * tx) * (1 - tz) + (g[k + this.n] * (1 - tx) + g[k + this.n + 1] * tx) * tz
    );
  }

  /** (x, z)에 부피 volume(m³)을 가우시안 모양으로 붓는다 */
  deposit(x: number, z: number, volume: number, radius: number) {
    const [gx, gz] = this.toGrid(x, z);
    const r = Math.max(1.5, radius / this.cell);
    const i0 = Math.max(1, Math.floor(gx - r * 2));
    const i1 = Math.min(this.n - 2, Math.ceil(gx + r * 2));
    const j0 = Math.max(1, Math.floor(gz - r * 2));
    const j1 = Math.min(this.n - 2, Math.ceil(gz + r * 2));
    if (i0 > i1 || j0 > j1) return;
    let sum = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) sum += Math.exp(-((i - gx) ** 2 + (j - gz) ** 2) / (r * r));
    const area = this.cell * this.cell;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const w = Math.exp(-((i - gx) ** 2 + (j - gz) ** 2) / (r * r)) / sum;
        const k = j * this.n + i;
        this.h[k] += (volume * w) / area;
        if (this.h[k] > this.wet[k]) this.wet[k] = this.h[k];
      }
    }
    this.grow(i0, i1, j0, j1);
    this.quiet = 0;
    this.settled = false;
    this.changed = true;
  }

  private grow(i0: number, i1: number, j0: number, j1: number) {
    const b = this.box;
    if (b.i1 < b.i0) Object.assign(b, { i0, i1, j0, j1 });
    else {
      b.i0 = Math.min(b.i0, i0);
      b.i1 = Math.max(b.i1, i1);
      b.j0 = Math.min(b.j0, j0);
      b.j1 = Math.max(b.j1, j1);
    }
  }

  /** 총 부피 (m³) — 검증용 */
  volume() {
    let v = 0;
    for (let k = 0; k < this.h.length; k++) v += this.h[k];
    return v * this.cell * this.cell;
  }

  /** 흰자가 덮은 면적 (m²) — 검증용 */
  coverage(minH = 2e-4) {
    let c = 0;
    for (let k = 0; k < this.h.length; k++) if (this.h[k] > minH) c++;
    return c * this.cell * this.cell;
  }

  /** dt(초)만큼 흐름을 진행. 멈췄으면 아무것도 하지 않는다 */
  step(dt: number) {
    this.changed = false;
    if (this.settled || this.box.i1 < this.box.i0) return;
    this.quiet += dt;

    const { n, h, ground, dh, mobility, yieldH, cell } = this;
    const b = this.box;
    // 계산 영역 = 흰자가 있는 영역 + 여백 2칸 (흰자가 새로 퍼져 들어갈 자리)
    const i0 = Math.max(1, b.i0 - 2);
    const i1 = Math.min(n - 2, b.i1 + 2);
    const j0 = Math.max(1, b.j0 - 2);
    const j1 = Math.min(n - 2, b.j1 + 2);
    const eta = this.eta;

    let hMax = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) hMax = Math.max(hMax, h[j * n + i]);
    hMax = Math.min(hMax, MAX_FLOW_H);
    // 명시적 적분 안정 조건
    const dtMax = (0.2 * cell * cell) / (K * 1.6 * hMax ** 3 + 1e-12);
    const steps = Math.min(48, Math.max(1, Math.ceil(dt / dtMax)));
    const h_ = dt / steps;

    let moved = 0;
    for (let s = 0; s < steps; s++) {
      for (let j = j0 - 1; j <= j1 + 1; j++) {
        dh.fill(0, j * n + i0, j * n + i1 + 1);
        for (let i = i0 - 1; i <= i1 + 1; i++) eta[j * n + i] = ground[j * n + i] + h[j * n + i];
      }
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = j * n + i;
          // 오른쪽(+x), 아래쪽(+z) 이웃과의 경계면만 계산 (각 경계 한 번씩, 영역 안쪽끼리)
          for (let d = 0; d < 2; d++) {
            if (d === 0 ? i === i1 : j === j1) continue;
            const c = d === 0 ? a + 1 : a + n;
            // 양쪽 다 흰자가 없으면 (영역 여백 대부분) 바로 건너뛴다
            if (h[a] < MIN_FLOW_H && h[c] < MIN_FLOW_H) continue;
            const diff = eta[a] - eta[c];
            const src = diff > 0 ? a : c;
            const hs = Math.min(h[src], MAX_FLOW_H);
            if (hs < MIN_FLOW_H) continue;
            const grad = Math.abs(diff) / cell;
            // 항복 판정은 경계면의 전체 기울기 크기로 (축 방향 성분만 쓰면 대각선 방향이 먼저 멈춰 네모나게 고인다)
            const t = d === 0 ? n : 1;
            const across = (eta[a + t] - eta[a - t] + eta[c + t] - eta[c - t]) / (4 * cell);
            // 제곱끼리 비교해 흐르지 않는 경계면(대부분)에서는 제곱근을 피한다 (Math.hypot은 느리다)
            const g2 = grad * grad + across * across;
            const tau = yieldH[src];
            if (hs * hs * g2 <= tau * tau) continue;
            const stress = hs * Math.sqrt(g2);
            // 빙엄 유체: 항복 응력을 넘는 만큼만 흐른다
            let q = K * mobility[src] * hs * hs * hs * grad * (1 - tau / stress) * (h_ / cell);
            q = Math.min(q, h[src] * 0.24);
            if (diff > 0) {
              dh[a] -= q;
              dh[c] += q;
            } else {
              dh[a] += q;
              dh[c] -= q;
            }
          }
        }
      }
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          if (dh[k] !== 0) {
            h[k] = Math.max(0, h[k] + dh[k]);
            moved += Math.abs(dh[k]);
            if (h[k] > this.wet[k]) this.wet[k] = h[k];
          }
        }
      }
    }

    // 여백까지 흰자가 퍼졌으면 영역 확장 (격자 끝에서는 멈춤)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (h[j * n + i] <= MIN_FLOW_H) continue;
        if (i < b.i0) b.i0 = i;
        if (i > b.i1) b.i1 = i;
        if (j < b.j0) b.j0 = j;
        if (j > b.j1) b.j1 = j;
      }
    }

    this.changed = moved > 0;
    // 거의 움직이지 않거나 충분히 오래 지나면 고정 (이후 비용 0)
    if (this.quiet > 0.5 && (moved * cell * cell < 1e-10 || this.quiet > 3.5)) this.settled = true;
  }

  /** 렌더 갱신용: 흰자가 있는 영역 (격자 인덱스) */
  get bounds() {
    return this.box;
  }
}
