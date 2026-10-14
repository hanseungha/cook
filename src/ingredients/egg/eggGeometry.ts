import * as THREE from "three";

/**
 * 계란 치수 (국내 특란 기준, m).
 * 길이 58mm, 최대 폭 44mm, 비대칭(뾰족한 쪽/둥근 쪽) 정도 w.
 */
export const EGG = {
  length: 0.058,
  breadth: 0.044,
  /** Hügelschäffer 비대칭 계수: 클수록 한쪽이 뾰족 */
  asymmetry: 0.0045,
  /** 옆으로 누운 계란의 중심~바닥 거리 (= 최대 반지름) */
  get restRadius() {
    return this.breadth / 2;
  },
} as const;

/**
 * Hügelschäffer 계란 곡선: 실제 계란 단면을 잘 근사하는 것으로 알려진 식.
 * r(y) = B/2 · sqrt((L² − 4y²) / (L² + 8wy + 4w²)),  y ∈ [−L/2, L/2]
 * w > 0 이면 +y 쪽이 뾰족해진다.
 */
export function eggRadius(y: number) {
  const { length: L, breadth: B, asymmetry: w } = EGG;
  const num = L * L - 4 * y * y;
  if (num <= 0) return 0;
  return (B / 2) * Math.sqrt(num / (L * L + 8 * w * y + 4 * w * w));
}

/**
 * 계란 메시: 프로파일을 회전(Lathe). 양 끝에서 촘촘하게 샘플해 극점이 뭉툭하지 않게 한다.
 * 장축이 Y, 뾰족한 쪽이 +Y.
 */
export function createEggGeometry(profileSteps = 96, radialSegments = 96) {
  const L = EGG.length;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= profileSteps; i++) {
    // 코사인 분포: 극점 근처 곡률이 큰 구간에 샘플을 더 배치
    const t = i / profileSteps;
    const y = -(L / 2) * Math.cos(t * Math.PI);
    pts.push(new THREE.Vector2(eggRadius(y), y));
  }
  // 극점 정확히 0 반지름
  pts[0].x = 0;
  pts[pts.length - 1].x = 0;
  return new THREE.LatheGeometry(pts, radialSegments);
}
