import * as THREE from "three";
import { CRACK_CIRCUMFERENCE, CRACK_Y0, type CrackPattern } from "./eggCrack";
import { EGG } from "./eggGeometry";

const EGG_HALF_BREADTH = EGG.breadth / 2;

/** 균열 텍스처: 가로 = 둘레 한 바퀴(w), 세로 = 균열선 주변 장축 띠. 픽셀이 정사각형이 되도록 맞춘다 */
const TEX_W = 2048;
const TEX_H = 256;
const PX = CRACK_CIRCUMFERENCE / TEX_W;
export const CRACK_BAND = TEX_H * PX;

/**
 * 균열 마스크 텍스처 (R = 갈라진 틈(어두움), G = 틈 양옆으로 드러난 흰 단면·잔금 번짐).
 * 갈색 껍데기의 금은 가운데가 어둡고 가장자리가 하얗게 보인다 (껍데기 속은 흰색).
 */
export function createCrackTexture(pattern: CrackPattern) {
  const toPx = (w: number, y: number): [number, number] => [w * TEX_W, (0.5 - (y - CRACK_Y0) / CRACK_BAND) * TEX_H];
  const n = pattern.main.length;
  const mainLine: Array<[number, number]> = [];
  for (let k = 0; k <= n; k++) mainLine.push([k / n, pattern.main[k % n]]);

  const layer = (draw: (ctx: CanvasRenderingContext2D) => void, blur: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = TEX_W;
    canvas.height = TEX_H;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    if (blur) ctx.filter = `blur(${blur}px)`;
    ctx.strokeStyle = "#fff";
    ctx.lineJoin = "miter";
    ctx.lineCap = "round";
    draw(ctx);
    return ctx.getImageData(0, 0, TEX_W, TEX_H).data;
  };

  const stroke = (ctx: CanvasRenderingContext2D, line: Array<[number, number]>, width: number) => {
    // 둘레 방향으로 이어지도록 좌우로 한 번씩 더 그린다
    for (const shift of [-1, 0, 1]) {
      ctx.lineWidth = width;
      ctx.beginPath();
      line.forEach(([w, y], i) => {
        const [x, py] = toPx(w + shift, y);
        if (i === 0) ctx.moveTo(x, py);
        else ctx.lineTo(x, py);
      });
      ctx.stroke();
    }
  };

  // 잔금은 끝으로 갈수록 가늘어진다 → 굵기를 줄여 가며 구간별로 그림
  const strokeTapered = (ctx: CanvasRenderingContext2D, line: Array<[number, number]>, width: number) => {
    for (let i = 1; i < line.length; i++) {
      stroke(ctx, [line[i - 1], line[i]], Math.max(1, width * (1 - i / line.length)));
    }
  };

  const core = layer((ctx) => {
    stroke(ctx, mainLine, 6);
    for (const b of pattern.branches) strokeTapered(ctx, b, 3.5);
  }, 0);
  const halo = layer((ctx) => {
    stroke(ctx, mainLine, 13);
    for (const b of pattern.branches) strokeTapered(ctx, b, 7);
    // 충격 지점: 미세하게 부서져 하얗게 보이는 자리
    ctx.fillStyle = "#fff";
    const [cx, cy] = toPx(0, pattern.main[0]);
    for (const shift of [0, TEX_W]) {
      ctx.beginPath();
      ctx.ellipse(cx + shift, cy, 22, 26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }, 4);

  const data = new Uint8Array(TEX_W * TEX_H * 4);
  for (let i = 0; i < TEX_W * TEX_H; i++) {
    data[i * 4] = core[i * 4 + 1];
    data[i * 4 + 1] = halo[i * 4 + 1];
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, TEX_W, TEX_H, THREE.RGBAFormat);
  // DataTexture는 아래쪽 행부터 → 캔버스(위쪽 행부터)와 맞춘다
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export type CrackUniforms = {
  crackMap: { value: THREE.Texture | null };
  /** 충격 지점의 둘레 좌표 (φ / 2π) */
  impactU: { value: number };
  /** 균열이 퍼진 정도: 0 = 없음, 1 = 한 바퀴 */
  crackReach: { value: number };
  /** 틈의 어두움 (반쪽이 벌어지면 단면이 드러나므로 줄인다) */
  crackDark: { value: number };
};

export function createCrackUniforms(): CrackUniforms {
  return {
    crackMap: { value: null },
    impactU: { value: 0 },
    crackReach: { value: 0 },
    crackDark: { value: 0.8 },
  };
}

/** 균열 uniform 갱신 (매 프레임) */
export function updateCrackUniforms(
  u: CrackUniforms,
  v: Partial<{ crackMap: THREE.Texture; impactU: number; crackReach: number; crackDark: number }>,
) {
  if (v.crackMap !== undefined) u.crackMap.value = v.crackMap;
  if (v.impactU !== undefined) u.impactU.value = v.impactU;
  if (v.crackReach !== undefined) u.crackReach.value = v.crackReach;
  if (v.crackDark !== undefined) u.crackDark.value = v.crackDark;
}

/**
 * 껍데기 재질에 균열을 입힌다 (onBeforeCompile).
 * 계란 로컬 좌표에서 둘레각·장축 위치를 직접 계산하므로 통째 계란과 반쪽 메시가 같은 재질을 공유한다.
 * 균열은 충격 지점에서 양방향으로 퍼진다 (crackReach).
 */
export function applyCrackShader(material: THREE.MeshPhysicalMaterial, uniforms: CrackUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vEggLocal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEggLocal = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vEggLocal;
uniform sampler2D crackMap;
uniform float impactU;
uniform float crackReach;
uniform float crackDark;`,
      )
      .replace(
        "#include <map_fragment>",
        `// 극점: Lathe UV가 한 점으로 모여 텍스처가 바람개비처럼 보인다 → 흐린 밉으로 샘플하고 노멀을 약하게
float eggPole = smoothstep(0.05, 0.4, length(vEggLocal.xz) / ${(EGG_HALF_BREADTH).toFixed(4)});
#ifdef USE_MAP
diffuseColor *= texture2D(map, vMapUv, (1.0 - eggPole) * 5.0);
#endif
vec2 crack = vec2(0.0);
if (crackReach > 0.0) {
  float w = fract(atan(vEggLocal.x, vEggLocal.z) / 6.28318530718 - impactU);
  vec2 cuv = vec2(w, 0.5 - (vEggLocal.y - ${CRACK_Y0.toFixed(6)}) / ${CRACK_BAND.toFixed(6)});
  // 둘레 이음매(w: 1 → 0)에서 밉맵 선택이 튀지 않도록, 연속인 좌표의 미분을 사용
  vec2 cuv2 = vec2(fract(w + 0.5), cuv.y);
  vec2 dx = dFdx(cuv), dy = dFdy(cuv);
  vec2 dx2 = dFdx(cuv2), dy2 = dFdy(cuv2);
  if (abs(dx2.x) + abs(dy2.x) < abs(dx.x) + abs(dy.x)) { dx = dx2; dy = dy2; }
  crack = textureGrad(crackMap, cuv, dx, dy).rg;
  // 충격 지점에서의 거리(0 ~ 1)가 crackReach 안쪽인 곳만 드러남
  float d = min(w, 1.0 - w) * 2.0;
  crack *= 1.0 - smoothstep(crackReach - 0.06, crackReach, d);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.82, 0.75), crack.g * 0.6);
  diffuseColor.rgb *= 1.0 - crack.r * crackDark;
}`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        THREE.ShaderChunk.normal_fragment_maps.replace("mapN.xy *= normalScale;", "mapN.xy *= normalScale * eggPole;"),
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.85, crack.g * 0.6);`,
      );
  };
  material.customProgramCacheKey = () => "egg-shell-crack";
}
