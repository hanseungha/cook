/**
 * 감쇠 스프링 (프레임레이트 무관 — 큰 dt는 잘게 나눠 적분).
 * omega: 고유 진동수(rad/s, 클수록 빠르게 따라감), zeta: 감쇠비(1 = 임계감쇠, <1 = 살짝 출렁임).
 * 응답 지연은 대략 1/omega 초.
 */
export function stepSpring(
  value: number,
  velocity: number,
  target: number,
  omega: number,
  zeta: number,
  dt: number,
): [number, number] {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  let x = value;
  let v = velocity;
  for (let i = 0; i < steps; i++) {
    const a = omega * omega * (target - x) - 2 * zeta * omega * v;
    v += a * h;
    x += v * h;
  }
  return [x, v];
}
