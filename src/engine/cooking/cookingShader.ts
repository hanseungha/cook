/**
 * 가열 표현용 GLSL 공통 함수 (재질의 onBeforeCompile에서 `#include <common>` 뒤에 넣는다).
 * 음식별 셰이더는 위치별 익힘(doneness)·갈변(browning) 값을 받아 이 함수들로 표현을 만든다.
 *
 * - cookFront(d, p): 셀 단위 익힘 값에 노이즈를 더해 익는 경계가 얼룩덜룩 번지게
 * - cookBrown(base, b): 마이야르 갈변 색 (노릇 → 갈색 → 진갈색)
 * - cookBubble(...): 가열 중 표면에 생겼다 터지는 기포 (덮임 + 표면 기울기)
 * - cookFizz(...): 뜨거운 기름 속에서 끝없이 생겼다 터지는 아주 작은 거품 (시간으로 순환)
 * 모든 좌표는 월드 단위(m)이므로 물체 크기·메시 해상도와 무관하게 같은 크기로 보인다.
 */
export const COOKING_GLSL = /* glsl */ `
float ckHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 ckHash4(vec2 p) {
  return fract(sin(vec4(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)), dot(p, vec2(97.3, 41.1)))) * 43758.5453);
}
float ckNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ckHash(i), ckHash(i + vec2(1, 0)), u.x), mix(ckHash(i + vec2(0, 1)), ckHash(i + vec2(1, 1)), u.x), u.y);
}
float ckFbm(vec2 p) {
  return ckNoise(p) * 0.55 + ckNoise(p * 2.13 + 7.1) * 0.3 + ckNoise(p * 4.37 + 3.3) * 0.15;
}

// 익힘 경계: 값이 0이나 1에 가까운 곳은 그대로, 중간(익어가는 곳)일수록 크게 흔든다
float cookFront(float d, vec2 p, float freq, float amount) {
  float n = ckFbm(p * freq) - 0.5;
  return clamp(d + n * amount * (0.35 + 4.0 * d * (1.0 - d)), 0.0, 1.0);
}

// 갈변 (선형 색공간). b: 0 = 그대로, 0.4 = 노릇, 0.75 = 갈색, 1 = 진갈색
vec3 cookBrown(vec3 base, float b) {
  vec3 golden = vec3(0.72, 0.46, 0.17);
  vec3 brown = vec3(0.36, 0.17, 0.05);
  vec3 dark = vec3(0.14, 0.06, 0.02);
  vec3 c = mix(base, golden, smoothstep(0.0, 0.45, b));
  c = mix(c, brown, smoothstep(0.35, 0.8, b));
  return mix(c, dark, smoothstep(0.8, 1.0, b));
}

// 기포 한 층. p: 월드 좌표, cell: 격자 크기(m), d: 이 위치의 익힘, birth: 기포가 생기는 익힘 범위,
// density: 칸마다 기포가 있을 확률, time: 초 (기포가 살짝 떨리며 숨쉬는 움직임)
// 반환: x = 덮임 0..1, yz = 법선을 기울일 양 (= −∇돔 높이, 월드 수평 성분)
vec3 cookBubble(vec2 p, float cell, float d, vec2 birth, float density, float time) {
  vec2 g = floor(p / cell);
  vec2 f = p / cell - g;
  vec4 r = ckHash4(g);
  if (r.x > density) return vec3(0.0);
  float rMax = mix(0.16, 0.4, r.y);
  vec2 c = rMax + (1.0 - 2.0 * rMax) * r.zw;
  float b = mix(birth.x, birth.y, fract(r.y * 7.13 + r.z * 3.1));
  float life = 0.1 + 0.16 * fract(r.w * 5.7 + r.x * 2.3);
  float ph = (d - b) / life;
  if (ph <= 0.0 || ph >= 1.0) return vec3(0.0);
  // 자라다가 → 꺼지며 터진다
  float rad = rMax * smoothstep(0.0, 0.3, ph) * (1.0 + 0.06 * sin(time * (5.0 + 4.0 * r.z) + r.w * 40.0));
  float height = 0.55 * (1.0 - smoothstep(0.82, 1.0, ph));
  vec2 v = (f - c) / max(rad, 1e-3);
  float q = dot(v, v);
  if (q >= 1.0) return vec3(0.0);
  float h = sqrt(1.0 - q);
  return vec3(smoothstep(1.0, 0.8, q), height * v / max(h, 0.25));
}

// 끓는 기름 거품 한 층. activity: 칸마다 거품이 있을 확률 (0이면 없음), time: 초.
// 거품마다 수명이 달라 자라다 터지고, 터진 자리 근처에서 다시 생긴다.
// 반환: x = 덮임, yz = 법선을 기울일 양
vec3 cookFizz(vec2 p, float cell, float activity, float time) {
  vec2 g = floor(p / cell);
  vec2 f = p / cell - g;
  vec4 r = ckHash4(g + 17.0);
  if (r.x > activity) return vec3(0.0);
  float life = 0.25 + 0.55 * r.y;
  float cyc = time / life + r.z;
  float ph = fract(cyc);
  float n = floor(cyc);
  float rMax = mix(0.16, 0.36, r.w);
  vec2 c = rMax + (1.0 - 2.0 * rMax) * fract(r.zw * 7.31 + n * vec2(0.618, 0.382));
  float rad = rMax * smoothstep(0.0, 0.6, ph);
  float height = 0.7 * (1.0 - smoothstep(0.85, 1.0, ph));
  vec2 v = (f - c) / max(rad, 1e-3);
  float q = dot(v, v);
  if (q >= 1.0) return vec3(0.0);
  float h = sqrt(1.0 - q);
  return vec3(smoothstep(1.0, 0.75, q), height * v / max(h, 0.25));
}
`;
