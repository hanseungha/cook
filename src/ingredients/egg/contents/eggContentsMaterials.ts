import * as THREE from "three";
import { COOKING_GLSL } from "@/engine/cooking/cookingShader";

/** 가열 표현에 쓰는 시간 uniform (기포가 숨쉬는 움직임). 재질마다 같은 객체를 공유한다 */
export type CookUniforms = {
  uCookTime: { value: number };
  /** 노른자 (x, z, 가로 반지름, 있음 0/1) — 흰자가 노른자 색을 머금고 맞닿은 곳에 그늘이 지게 */
  uYolk?: { value: THREE.Vector4 };
  /** 가열 중 0 ~ 1 (가장자리 기름 거품) */
  uHeating?: { value: number };
};

/**
 * 날흰자 재질.
 * 거의 투명한 젤 + 두꺼울수록 살짝 탁한 막. 반사는 투명도와 무관하게 유지해야
 * (유리처럼) 얇은 곳도 젖은 광택이 보인다 → 확산광만 투명도로 곱하고 반사광은 그대로 더한다
 * (premultiplied alpha 블렌딩: 결과 = 확산×a + 반사 + 배경×(1−a), 확산은 화면 색으로 바꾼 뒤 곱함).
 *
 * mode "field": 정점 속성 thick(두께, m)·milk(탁도)를 사용. 가장자리는 픽셀마다 두께로 판정하고
 *   미세 노이즈로 흔들어 격자 모양이 드러나지 않는 유기적인 경계를 만든다.
 *   표면에는 아주 낮은 물결(노멀만)을 더해 젖은 반사가 반짝이게 한다.
 * mode "collar": field + 정점 속성 fade(0~1) — 다른 흰자 위에 겹쳐 그려 경계 없이 녹아들어야 하는 층
 * mode "stream": 떨어지는 덩어리 — 일정한 탁도
 *
 * 익힘 (field 모드, 정점 속성 cook = (익힘, 갈변) — ThermalField에서 온다):
 *   날것(투명) → 뿌옇게 반투명 → 불투명한 흰색, 다 익은 얇은 가장자리는 노릇하게.
 *   위치마다 다른 값이 오고, 픽셀 단위 노이즈로 익는 경계가 얼룩지며 번진다.
 *   익는 동안 두꺼운 곳에서 기포가 생겼다 터진다 (노멀 + 반사).
 */
export function createAlbumenMaterial(mode: "field" | "collar" | "stream", uniforms?: CookUniforms) {
  const material = new THREE.MeshPhysicalMaterial({
    color: "#f2eedd",
    roughness: 0.05,
    metalness: 0,
    ior: 1.36,
    specularIntensity: 1,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
  });
  material.onBeforeCompile = (shader) => {
    const collar = mode === "collar";
    const field = mode === "field" || collar;
    shader.uniforms.uCookTime = uniforms?.uCookTime ?? { value: 0 };
    shader.uniforms.uYolk = uniforms?.uYolk ?? { value: new THREE.Vector4() };
    shader.uniforms.uHeating = uniforms?.uHeating ?? { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vCover;
varying float vMilk;
varying vec3 vWorld;
varying vec2 vCook;
varying float vFade;
${field ? "attribute float thick;\nattribute float milk;\nattribute vec2 cook;" : ""}
${collar ? "attribute float fade;" : ""}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vCover = ${field ? "thick" : "1.0"};
vMilk = ${field ? "milk" : "0.4"};
vCook = ${field ? "cook" : "vec2(0.0)"};
vFade = ${collar ? "fade" : "1.0"};
vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vCover;
varying float vMilk;
varying vec3 vWorld;
varying vec2 vCook;
varying float vFade;
uniform float uCookTime;
uniform vec4 uYolk;
uniform float uHeating;
${COOKING_GLSL}
float albHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float albNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(albHash(i), albHash(i + vec2(1, 0)), u.x), mix(albHash(i + vec2(0, 1)), albHash(i + vec2(1, 1)), u.x), u.y);
}
float albRipple(vec2 p) { return albNoise(p * 70.0) * 0.7 + albNoise(p * 160.0) * 0.3; }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
${
  field
    ? `// 픽셀 단위 가장자리 + 미세하게 들쭉날쭉한 경계
// 축에 맞춘 격자 무늬(네모 톱니)가 보이지 않도록 회전한 좌표에서 두 옥타브
vec2 albP = mat2(0.8, -0.6, 0.6, 0.8) * vWorld.xz;
float albEdge = vCover + (albNoise(albP * 210.0) * 0.65 + albNoise(albP * 470.0 + 13.7) * 0.35 - 0.5) * 0.00016;
float albCover = smoothstep(0.00010, 0.00042, albEdge);
if (albCover <= 0.001) discard;`
    : "float albCover = 1.0;"
}
albCover *= vFade;
float albAlpha = vMilk;
vec2 albBubble = vec2(0.0);
float albDone = 0.0;
float albBrown = 0.0;
float albGlow = 0.0;
${
  field
    ? `{
  // 익는 경계: 셀 값 + 얼룩 노이즈 (전체가 한 번에 바뀌지 않고 반점처럼 번지며 하얘진다)
  // 큰 얼룩(익는 경계가 고르지 않게 들쭉날쭉) + 잔 얼룩
  float d0 = vCook.x;
  d0 = clamp(d0 + (ckFbm(vWorld.xz * 38.0 + 5.0) - 0.5) * 0.45 * d0 * (1.0 - d0) * 4.0, 0.0, 1.0);
  float d = cookFront(d0, vWorld.xz, 230.0, 0.14);
  albDone = d;
  // 갈변: 가장자리의 바삭한 레이스 무늬 — 구간마다 진하기가 다르고, 거품 자국 사이사이가 먼저 진해진다
  float lace = ckFbm(vWorld.xz * 520.0);
  float brPatch = smoothstep(0.25, 0.75, ckFbm(vWorld.xz * 45.0 + 11.0));
  float b = vCook.y * (0.25 + 0.95 * brPatch) * (0.45 + 0.85 * lace);
  b = clamp(b, 0.0, 1.0) * 0.85;
  albBrown = b;
  // 날것(투명) → 뿌옇게(푸른빛이 도는 우윳빛 반투명) → 불투명한 흰색
  vec3 cloudy = vec3(0.76, 0.79, 0.8);
  vec3 cooked = vec3(0.87, 0.86, 0.82) * (0.98 + 0.04 * ckNoise(vWorld.xz * 180.0));
  vec3 col = mix(diffuseColor.rgb, cloudy, smoothstep(0.0, 0.4, d));
  col = mix(col, cooked, smoothstep(0.3, 0.95, d));
  diffuseColor.rgb = cookBrown(col, b);
  albAlpha = mix(vMilk, 0.42, smoothstep(0.0, 0.35, d));
  // 다 익어도 아주 얇은 가장자리는 팬이 살짝 비친다
  albAlpha = mix(albAlpha, mix(0.82, 0.985, smoothstep(0.0004, 0.0018, vCover)), smoothstep(0.35, 0.9, d));
  albAlpha = max(albAlpha, smoothstep(0.0, 0.3, b));
  // 노른자 곁: 노른자를 통과해 퍼진 빛이 흰자를 노르스름하게 물들이고(반투명일수록 강하게),
  // 맞닿은 바로 그곳은 노른자에 가려 그늘이 진다
  float yd = length(vWorld.xz - uYolk.xy) - uYolk.z;
  float glow = uYolk.w * exp(-max(yd, 0.0) / 0.0065);
  albGlow = uYolk.w * exp(-max(yd, 0.0) / 0.01);
  float contact = uYolk.w * exp(-abs(yd) / 0.0022);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.0, 0.8, 0.42), glow * mix(0.6, 0.1, smoothstep(0.3, 0.9, d)));
  diffuseColor.rgb *= 1.0 - 0.12 * contact;
  ${collar ? "// 노른자를 감싸 올라간 흰자: 노른자와 맞닿은 오목한 곳이라 빛을 덜 받는다 (밝은 받침 띠처럼 보이지 않게)\n  diffuseColor.rgb *= 1.0 - 0.32 * pow(vFade, 1.5);" : ""}
  albAlpha = mix(albAlpha, max(albAlpha, 0.35), glow * 0.3 * (1.0 - smoothstep(0.3, 0.9, d)));
  // 기포: 익어가는 두꺼운 곳에서 (작은 기포 많이 + 큰 기포 가끔)
  float dense = smoothstep(0.0008, 0.0026, vCover) * step(0.001, vCook.x);
  vec3 b1 = cookBubble(vWorld.xz, 0.0042, vCook.x, vec2(0.12, 0.75), 0.55 * dense, uCookTime);
  vec3 b2 = cookBubble(vWorld.xz + 0.37, 0.011, vCook.x, vec2(0.25, 0.8), 0.35 * dense, uCookTime);
  albBubble = b1.yz + b2.yz;
  // 가장자리 기름 거품: 얇은 가장자리를 따라 아주 작은 거품이 계속 생겼다 터진다 (가열 중에만)
  float rim = (1.0 - smoothstep(0.0005, 0.0019, vCover)) * step(0.01, vCook.x) * uHeating;
  vec3 fz1 = cookFizz(vWorld.xz, 0.0024, 0.6 * rim, uCookTime);
  vec3 fz2 = cookFizz(vWorld.xz + 0.13, 0.0038, 0.35 * rim, uCookTime * 0.8);
  albBubble += (fz1.yz + fz2.yz) * 0.8;
  // 거품 막은 빛을 받아 둘레가 밝게 맺힌다 (어두운 팬 위에서 작은 반짝임으로 보이게)
  float fzc = max(fz1.x, fz2.x);
  float fzRing = fzc * smoothstep(0.0, 0.6, length(fz1.yz + fz2.yz));
  albAlpha = mix(albAlpha, max(albAlpha, 0.7), fzc * 0.5);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), fzRing * 0.5);
  // 기포 막은 빛을 모아 살짝 더 하얗게 보인다
  albAlpha = mix(albAlpha, max(albAlpha, 0.5), max(b1.x, b2.x) * 0.6);
}`
    : ""
}
diffuseColor.a = albAlpha * albCover;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        // 익은 흰자는 매끈한 액체 광택을 잃고, 노릇한 가장자리는 더 거칠다
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.17, smoothstep(0.25, 1.0, albDone)) + albBrown * 0.35;
roughnessFactor = max(roughnessFactor, 0.17 * albGlow);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
${
  field
    ? `{
  // 표면의 아주 낮은 물결: 두꺼운 곳일수록 (얇은 막은 바닥에 붙어 매끈)
  float e = 0.001;
  float r0 = albRipple(vWorld.xz);
  vec2 g = vec2(albRipple(vWorld.xz + vec2(e, 0.0)) - r0, albRipple(vWorld.xz + vec2(0.0, e)) - r0) / e;
  // 익으면 물결 대신 굳은 표면의 잔잔한 요철
  float amp = mix(0.0011 * smoothstep(0.0008, 0.005, vCover), 0.0007, smoothstep(0.4, 1.0, albDone));
  vec3 tiltW = vec3(-g.x * amp + albBubble.x, 0.0, -g.y * amp + albBubble.y);
  // 굳은 흰자의 완만한 굴곡 (굳으며 살짝 부풀고 오그라든 자국) → 빛이 고르지 않게 맺힌다
  float ue = 0.002;
  float u0 = ckFbm(vWorld.xz * 34.0);
  vec2 ug = vec2(ckFbm((vWorld.xz + vec2(ue, 0.0)) * 34.0) - u0, ckFbm((vWorld.xz + vec2(0.0, ue)) * 34.0) - u0) / ue;
  tiltW.xz -= ug * 0.0035 * smoothstep(0.4, 1.0, albDone);
  normal = normalize(normal + (viewMatrix * vec4(tiltW, 0.0)).xyz);
}`
    : ""
}`,
      )
      .replace(
        "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
        // 가장자리에서 시야각이 낮을수록 반사가 강해지는 것은 물리 재질(Fresnel)이 처리한다
        // 노른자 곁의 볼록한 농후 흰자는 경사면이 밝은 조명을 정면으로 반사해 혼자 번쩍이는 고리가 된다 → 반사를 눌러 준다
        "vec3 albSpec = totalSpecular * albCover * (1.0 - 0.6 * albGlow);\nvec3 outgoingLight = totalDiffuse;",
      )
      // 투명도를 곱한(premultiplied) 색을 그대로 톤매핑·sRGB 변환하면, 둘 다 비선형이라 반투명한 곳이
      // 실제보다 밝아진다 (겹쳐 그린 흰자가 서서히 사라지는 곳이 밝은 고리로 보였던 원인).
      // → 확산광은 화면 색으로 바꾼 뒤 투명도를 곱하고, 반사광은 예전과 같은 밝기 증가분으로 더한다
      .replace(
        "#include <colorspace_fragment>",
        `#include <colorspace_fragment>
{
  vec3 base = totalDiffuse * diffuseColor.a;
  vec3 lit = base + albSpec;
  #ifdef TONE_MAPPING
  base = toneMapping(base);
  lit = toneMapping(lit);
  #endif
  vec3 specOut = linearToOutputTexel(vec4(lit, 1.0)).rgb - linearToOutputTexel(vec4(base, 1.0)).rgb;
  gl_FragColor.rgb = gl_FragColor.rgb * gl_FragColor.a + specOut;
}`,
      )
      .replace("#include <premultiplied_alpha_fragment>", "");
  };
  material.customProgramCacheKey = () => `albumen-${mode}`;
  return material;
}

/** 노른자 반지름 (EggContents.CONTENTS와 같은 값, 셰이더 상수용) */
const CONTENTS_YOLK_RADIUS = 0.0155;

/**
 * 노른자 재질: 진한 주황빛 노랑, 얇은 막의 매끈한 광택(클리어코트),
 * 가장자리로 갈수록 빛이 살짝 번져 밝아지는 느낌(시인)으로 속이 찬 액체감을 근사.
 *
 * 익힘 (uniform uYolkCook 0~1, 노른자 전체가 받은 열량):
 *   팬에 닿은 아래쪽부터 익는다 → 높이마다 다른 익힘. 익은 곳은 색이 옅고 노랗게,
 *   맑은 광택(클리어코트)이 흐려지며 표면에 잔주름 같은 무광 막이 생긴다.
 *   아래 둘레는 노른자를 감싼 얇은 흰자 막이 하얗게 익어 경계가 부드럽게 번진다.
 */
export function createYolkMaterial(uniforms?: CookUniforms & { uYolkCook: { value: number } }) {
  const material = new THREE.MeshPhysicalMaterial({
    color: "#f39a12",
    roughness: 0.3,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.16,
    sheen: 0.25,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color("#ffc74d"),
    specularIntensity: 0.4,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uYolkCook = uniforms?.uYolkCook ?? { value: 0 };
    shader.uniforms.uCookTime = uniforms?.uCookTime ?? { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vYolk;\nvarying vec3 vYolkWorld;")
      .replace(
        "#include <begin_vertex>",
        // 구의 로컬 좌표(찌그러지기 전) → 높이별 익힘, 월드 좌표 → 노이즈 (크기가 변해도 무늬가 늘어나지 않게)
        "#include <begin_vertex>\nvYolk = position;\nvYolkWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vYolk;
varying vec3 vYolkWorld;
uniform float uYolkCook;
uniform float uCookTime;
${COOKING_GLSL}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
// 높이 0(바닥) ~ 1(꼭대기): 바닥은 팬 열을 직접 받아 2배 가까이 빨리 익는다
float ykH = clamp(vYolk.y / ${CONTENTS_YOLK_RADIUS.toFixed(5)} * 0.5 + 0.5, 0.0, 1.0);
// 윗면은 공기에 닿아 반숙 프라이가 끝나도 거의 날것 그대로 (윤기 있는 주황 돔)
float ykLocal = uYolkCook * mix(1.9, 0.3, smoothstep(0.0, 0.7, ykH));
float ykDone = cookFront(clamp(ykLocal, 0.0, 1.0), vYolkWorld.xz, 260.0, 0.22);
// 익을수록 옅은 노랑 (진한 주황 → 파스텔 노랑)
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.6, 0.12), smoothstep(0.1, 0.9, ykDone));
// 아래 둘레를 감싼 흰자 막이 익어 하얗게 번진다
// (경계가 또렷하면 노른자가 흰 받침 위에 올라앉은 것처럼 보인다 → 위로 갈수록 서서히, 옅게)
float ykVeil = (1.0 - smoothstep(0.02, 0.4, ykH)) * smoothstep(0.05, 0.6, uYolkCook) * (0.6 + 0.4 * ckNoise(vYolkWorld.xz * 300.0));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.78, 0.55), ykVeil * 0.45);
// 흰자에 잠긴 아랫부분은 주변 흰자에 가려 조금 어둡고 붉다 (공중에 뜬 공처럼 보이지 않게)
diffuseColor.rgb *= mix(vec3(0.72, 0.6, 0.5), vec3(1.0), smoothstep(0.08, 0.42, ykH));
// 한 가지 색으로 칠한 공처럼 보이지 않게: 막 아래 노른자 알갱이가 만드는 옅은 얼룩
diffuseColor.rgb *= 0.95 + 0.1 * ckNoise(vYolkWorld.xz * 160.0 + vYolkWorld.y * 90.0);
// 날 노른자는 두꺼운 꼭대기가 밝은 황금빛, 둘레로 갈수록 짙은 주황 (익은 곳은 이미 옅은 노랑)
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.12, 1.05), smoothstep(0.55, 1.0, ykH) * (1.0 - ykDone));`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.5, smoothstep(0.3, 1.0, ykDone));`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  // 익은 막의 잔주름: 익힘에 비례하는 미세한 요철
  vec2 p = vYolkWorld.xz * 900.0 + vYolkWorld.y * 500.0;
  float e = 0.35;
  float n0 = ckNoise(p);
  vec2 g = vec2(ckNoise(p + vec2(e, 0.0)) - n0, ckNoise(p + vec2(0.0, e)) - n0) / e;
  vec3 tiltW = vec3(g.x, 0.0, g.y) * 0.12 * smoothstep(0.4, 1.0, ykDone);
  // 날것의 막도 완전히 매끈하지 않다: 덮인 흰자 막이 만드는 완만한 물결 → 반사광이 점이 아니라 일그러진 얼룩
  vec2 q = vYolkWorld.xz * 150.0 + vYolkWorld.y * 110.0;
  float m0 = ckNoise(q);
  tiltW += vec3(ckNoise(q + vec2(e, 0.0)) - m0, 0.0, ckNoise(q + vec2(0.0, e)) - m0) / e * 0.08;
  normal = normalize(normal + (viewMatrix * vec4(tiltW, 0.0)).xyz);
}`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        `#include <lights_physical_fragment>
// 맑은 막의 광택(클리어코트)이 흐려진다
material.clearcoat *= mix(1.0, 0.3, smoothstep(0.15, 0.9, ykDone));
material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.35, smoothstep(0.15, 1.0, ykDone));
material.sheenColor *= 1.0 - 0.6 * smoothstep(0.2, 1.0, ykDone);`,
      )
      .replace(
        "#include <opaque_fragment>",
        `// 둘레(비스듬히 보이는 곳)는 흰자에 잠기고 노른자 막이 두껍게 겹쳐 보여 오히려 진한 주황.
// 그대로 두면 광택이 흰 스튜디오를 비춰 둘레에 하얀 외곽선이 생긴다 → 둘레의 빛(반사 포함)을 줄인다
{
  float ykNV = abs(dot(normal, normalize(vViewPosition)));
  float ykRim = 1.0 - smoothstep(0.08, 0.5, ykNV);
  outgoingLight *= 1.0 - 0.38 * ykRim;
  outgoingLight = mix(outgoingLight, outgoingLight * vec3(1.0, 0.82, 0.62), ykRim * 0.5);
  // 속이 비치는 액체: 빛이 노른자 안에서 퍼져 그늘진 쪽도 따뜻하게 밝다 (단단한 공의 음영이 되지 않게)
  outgoingLight += diffuseColor.rgb * vec3(0.16, 0.08, 0.01) * (1.0 - 0.6 * ykRim) * (1.0 - 0.7 * ykDone);
}
#include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "yolk-cooking";
  return material;
}
