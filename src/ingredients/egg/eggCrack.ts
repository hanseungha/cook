import { mulberry32 } from "@/engine/textures/noise";
import { EGG, eggRadius } from "./eggGeometry";

/**
 * 계란 균열 경로 (three.js·DOM 비의존).
 *
 * 좌표: w ∈ [0, 1) = 충격 지점에서부터 장축을 감아 도는 둘레 위치 (w = 0이 충격 지점),
 *       y = 장축 위치 (m, 계란 로컬 좌표).
 * 테두리에 부딪힌 계란은 가장 굵은 둘레를 따라 한 바퀴 금이 가고,
 * 충격 지점에는 짧은 잔금이 방사형으로 생긴다.
 */

/** 가장 굵은 둘레의 장축 위치 (둥근 쪽으로 살짝 치우침) */
export const CRACK_Y0 = (() => {
  let best = 0;
  let bestR = 0;
  for (let i = 0; i <= 400; i++) {
    const y = -EGG.length / 4 + (i / 400) * (EGG.length / 2);
    const r = eggRadius(y);
    if (r > bestR) {
      bestR = r;
      best = y;
    }
  }
  return best;
})();

/** 둘레 길이 (m) — 균열 텍스처의 가로 축척 */
export const CRACK_CIRCUMFERENCE = Math.PI * EGG.breadth;

export type CrackPolyline = Array<[w: number, y: number]>;

export type CrackPattern = {
  /** 주 균열: w = k / samples 에서의 y (닫힌 곡선) */
  main: Float32Array;
  /** 잔금 (충격 지점 방사형 + 주 균열에서 갈라지는 가지) */
  branches: CrackPolyline[];
};

/** 주 균열의 y를 w에서 선형 보간 */
export function crackYAt(main: Float32Array, w: number) {
  const n = main.length;
  const f = (((w % 1) + 1) % 1) * n;
  const i = Math.floor(f);
  const t = f - i;
  return main[i % n] * (1 - t) + main[(i + 1) % n] * t;
}

/**
 * 시드 고정 균열 패턴.
 * 실제 껍데기 균열처럼 1~2.5mm 길이의 직선 조각이 꺾이며 이어지는 지그재그.
 */
export function createCrackPattern(seed = 7, samples = 1024): CrackPattern {
  const rand = mulberry32(seed);
  const C = CRACK_CIRCUMFERENCE;

  // 1) 지그재그 랜덤 워크 (m 단위로 걷고 w로 환산)
  const pts: Array<[number, number]> = [[0, 0]];
  let s = 0;
  let y = 0;
  while (s < C) {
    const step = 0.0012 + rand() * 0.0016;
    // 기울기: 대부분 완만, 가끔 가파르게 꺾임 + 중심선으로 되돌아오려는 경향
    const steep = rand() < 0.25 ? 1.3 : 0.55;
    y += (rand() * 2 - 1) * steep * step - y * 0.18;
    s = Math.min(C, s + step);
    pts.push([s / C, y]);
  }
  // 닫힌 곡선이 되도록 끝점 오차를 선형으로 분배
  const drift = pts[pts.length - 1][1];
  for (const p of pts) p[1] -= drift * p[0];

  // 2) 균일 샘플로 변환 (형상·텍스처가 같은 곡선을 공유)
  const main = new Float32Array(samples);
  let j = 0;
  for (let k = 0; k < samples; k++) {
    const w = k / samples;
    while (j < pts.length - 2 && pts[j + 1][0] < w) j++;
    const [w0, y0] = pts[j];
    const [w1, y1] = pts[j + 1];
    const t = w1 > w0 ? (w - w0) / (w1 - w0) : 0;
    main[k] = CRACK_Y0 + y0 + (y1 - y0) * t;
  }

  // 3) 잔금
  const branches: CrackPolyline[] = [];
  const jagged = (w: number, yy: number, angle: number, length: number) => {
    const line: CrackPolyline = [[w, yy]];
    let cw = w;
    let cy = yy;
    let a = angle;
    let left = length;
    while (left > 0) {
      const step = Math.min(left, 0.0006 + rand() * 0.0009);
      a += (rand() * 2 - 1) * 0.6;
      cw += (Math.cos(a) * step) / C;
      cy += Math.sin(a) * step;
      line.push([cw, cy]);
      left -= step;
    }
    return line;
  };

  // 충격 지점: 눌린 자리에서 사방으로 짧은 잔금
  const impactY = crackYAt(main, 0);
  const rays = 7;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + rand() * 0.6;
    branches.push(jagged(0, impactY, a, 0.0018 + rand() * 0.0035));
  }
  // 주 균열에서 갈라지는 가지 (충격 지점 근처에 많고 멀수록 드묾)
  for (let i = 0; i < 9; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const w = side * Math.pow(rand(), 1.6) * 0.32;
    const up = rand() < 0.5 ? -1 : 1;
    const a = up * (0.6 + rand() * 0.8) + (side < 0 ? Math.PI : 0) * (rand() < 0.5 ? 1 : 0);
    branches.push(jagged(w, crackYAt(main, w), a, 0.0015 + rand() * 0.004));
  }
  return { main, branches };
}
