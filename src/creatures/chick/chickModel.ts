import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * 갓 깬 병아리 (키 약 7cm, 솜털 포함). 로컬 좌표: 앞 = +Z, 위 = +Y, 원점 = 발바닥.
 * 실제 사진 기준 비율:
 * - 선 자세: 큰 머리가 몸통 앞쪽 위에 얹히고, 몸통은 아래가 넓은 물방울 모양 (등은 꽁지 쪽으로 처진다)
 * - 다리가 길고(키의 약 1/4) 굵으며 발가락이 길게 벌어진다
 * - 가슴·배는 크림색, 머리 위·등은 진한 노랑. 솜털은 길고 가늘어 아래·뒤로 흐른다
 * - 큰 검은 눈 둘레에 맨살 테두리, 작고 뾰족한 분홍빛 주황 부리
 *
 * 솜털은 껍질 겹(shell) 기법: 표면을 법선 방향으로 조금씩 부풀린 겹을 여러 장 겹쳐 그리고,
 * 겹마다 털 가닥이 있는 곳만 남긴다 → 털끝으로 갈수록 가늘어지는 가닥이 모여 보송한 윤곽이 된다.
 * 겹들은 인스턴스 1번 그리기로 그린다 (부위당 그리기 1번).
 */
export const CHICK = {
  /** 몸통 타원체 반지름 (x, y, z)와 중심 */
  body: { r: [0.0155, 0.0175, 0.0185] as const, c: [0, 0.031, -0.004] as const },
  /** 머리 반지름 (x, y, z)과 중심 (발바닥 기준) */
  head: { r: [0.0122, 0.0125, 0.0135] as const, c: [0, 0.054, 0.006] as const },
  /** 목 관절: 머리가 이 점을 중심으로 끄덕인다 */
  neck: [0, 0.045, 0.002] as const,
  /** 엉덩이 관절 (다리가 매달린 곳) */
  hip: { x: 0.0062, y: 0.017 },
  /** 솜털 길이 (m, 몸통 / 머리)와 겹 수 */
  fur: { body: 0.003, head: 0.0023, layers: 14 },
};

const CREAM = new THREE.Color("#f7edcb");
const YELLOW = new THREE.Color("#f6d978");
const DEEP = new THREE.Color("#efc35a");
const SKIN = new THREE.Color("#ecd189");
const LEG = new THREE.Color("#f0b257");

function ellipsoid(r: readonly [number, number, number], c: readonly [number, number, number], seg = 40) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7));
  // 축척은 법선도 함께 변환한다 (이음매 법선이 갈라지지 않게 다시 계산하지 않는다)
  g.scale(r[0], r[1], r[2]);
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** 솜털 겹: 겹 번호(0 ~ 1)는 인스턴스 속성으로 */
function furGeometry(base: THREE.BufferGeometry) {
  const g = base.clone();
  g.deleteAttribute("uv");
  const layers = CHICK.fur.layers;
  const layer = new Float32Array(layers);
  for (let i = 0; i < layers; i++) layer[i] = (i + 1) / layers;
  g.setAttribute("furLayer", new THREE.InstancedBufferAttribute(layer, 1));
  return g;
}

/** 털이 없거나 짧아지는 곳 (눈 둘레, 부리 뿌리): 중심과 반지름 */
type Bald = { at: THREE.Vector3; r: number };

/**
 * 솜털 재질
 * - 가닥: 0.45mm 셀마다 하나, 길이·굵기 제각각. 위치는 원래 표면 좌표의 3D 셀 해시 (UV 이음매·극점 왜곡 없음)
 * - 흐름: 털끝으로 갈수록 아래·뒤로 눕는다 (빗은 듯한 결)
 * - 색: 몸 위치에 따라 크림(가슴·배) → 노랑 → 진노랑(머리 위·등), 뿌리는 서로 가려 어둡고 끝은 밝다
 * - 역광: 비스듬히 보이는 털끝은 빛이 비쳐 환하게 (솜털 윤곽의 옅은 빛무리)
 * origin: 이 형상의 좌표 원점을 병아리 좌표로 옮기는 값 (머리는 목 관절 기준이라)
 */
function furMaterial(length: number, origin: THREE.Vector3, balds: Bald[]) {
  const m = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95 });
  const bald = Array.from({ length: 3 }, (_, i) => {
    const b = balds[i];
    return b ? new THREE.Vector4(b.at.x, b.at.y, b.at.z, b.r) : new THREE.Vector4(1, 1, 1, 0);
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFurLength = { value: length };
    shader.uniforms.uOrigin = { value: origin };
    shader.uniforms.uBald = { value: bald };
    shader.uniforms.uCream = { value: CREAM };
    shader.uniforms.uYellow = { value: YELLOW };
    shader.uniforms.uDeep = { value: DEEP };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float furLayer;
        uniform float uFurLength;
        varying float vLayer;
        varying vec3 vBase;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vLayer = furLayer;
        vBase = position;
        // 바깥 겹일수록 법선 방향으로, 털끝은 아래·뒤로 눕는다
        transformed += normal * furLayer * uFurLength;
        transformed += vec3(0.0, -0.45, -0.85) * uFurLength * 0.8 * furLayer * furLayer;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec3 uOrigin;
        uniform vec4 uBald[3];
        uniform vec3 uCream;
        uniform vec3 uYellow;
        uniform vec3 uDeep;
        varying float vLayer;
        varying vec3 vBase;
        vec3 furHash(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.xxy + p.yxx) * p.zyx);
        }`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        {
          // 눈 둘레·부리 뿌리는 털이 짧아지다가 없어진다
          float reach = 1.0;
          for (int i = 0; i < 3; i++) {
            if (uBald[i].w <= 0.0) continue;
            reach = min(reach, smoothstep(uBald[i].w, uBald[i].w * 2.0, distance(vBase, uBald[i].xyz)));
          }
          if (vLayer > reach) discard;
          vec3 c = vBase * 2300.0;
          vec3 id = floor(c);
          vec3 f = fract(c);
          float keep = 0.0;
          for (int i = -1; i <= 1; i++)
          for (int j = -1; j <= 1; j++)
          for (int k = -1; k <= 1; k++) {
            vec3 n = vec3(float(i), float(j), float(k));
            vec3 h = furHash(id + n + 17.0);
            float len = 0.62 + 0.38 * h.z;
            if (vLayer > len) continue;
            float radius = 0.85 * pow(1.0 - vLayer / len, 0.5);
            keep = max(keep, radius - length(n + h - f));
          }
          if (keep <= 0.0) discard;
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec3 p = vBase + uOrigin;
          // 가슴·배(앞 아래)는 크림, 머리 위·등은 진하게
          float belly = smoothstep(0.046, 0.02, p.y) * smoothstep(-0.012, 0.012, p.z);
          float top = smoothstep(0.052, 0.07, p.y) + 0.6 * smoothstep(0.0, -0.02, p.z) * smoothstep(0.02, 0.04, p.y);
          vec3 col = mix(uYellow, uDeep, clamp(top, 0.0, 1.0));
          col = mix(col, uCream, belly * 0.85);
          diffuseColor.rgb = col * mix(0.72, 1.06, vLayer);
        }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          float rim = 1.0 - abs(dot(normal, normalize(vViewPosition)));
          totalEmissiveRadiance += diffuseColor.rgb * 0.22 * rim * rim * vLayer;
        }`,
      );
  };
  m.customProgramCacheKey = () => "chick-fur";
  return m;
}

/** 축을 따라 색이 변하는 정점 색 (부리: 뿌리 → 끝, 다리: 위 → 아래) */
function gradient(g: THREE.BufferGeometry, axis: "y" | "z", from: number, to: number, a: THREE.Color, b: THREE.Color) {
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const v = axis === "y" ? pos.getY(i) : pos.getZ(i);
    c.copy(a).lerp(b, THREE.MathUtils.clamp((v - from) / (to - from), 0, 1));
    c.toArray(col, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

export type ChickAssets = ReturnType<typeof createChickAssets>;

export function createChickAssets() {
  const { body, head, hip, fur } = CHICK;
  const neck = new THREE.Vector3(...CHICK.neck);
  const headC = new THREE.Vector3(...head.c);

  // 몸통: 아래가 넓은 물방울 + 등은 꽁지 쪽으로 처진다
  const torso = ellipsoid(body.r, [0, 0, 0], 48);
  {
    const pos = torso.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / body.r[1];
      const wide = 1 + 0.12 * Math.max(0, -y) - 0.08 * Math.max(0, y);
      pos.setX(i, pos.getX(i) * wide);
      pos.setZ(i, pos.getZ(i) * wide);
    }
    torso.computeVertexNormals();
    torso.rotateX(-0.3);
    torso.translate(body.c[0], body.c[1], body.c[2]);
  }
  // 목: 머리와 몸통 사이를 메워 한 덩어리로
  const neckBlob = ellipsoid([0.0102, 0.0105, 0.0102], [0, 0.044, 0.003], 24);
  const wing = (side: number) => {
    // 몸통에 붙어 접힌 작은 날개: 납작하게, 끝은 뒤 아래로
    const g = ellipsoid([0.0028, 0.0075, 0.0115], [0, 0, 0], 20);
    g.rotateX(-0.45);
    g.rotateZ(side * 0.1);
    g.translate(side * 0.0136, 0.032, -0.008);
    return g;
  };
  const tail = ellipsoid([0.0048, 0.0042, 0.005], [0, 0.03, -0.0215], 16);
  const bodyGeo = mergeGeometries([torso, neckBlob, wing(1), wing(-1), tail].map((g) => g.toNonIndexed()));

  // 머리 (목 관절 기준 좌표)
  const headGeo = ellipsoid(head.r, [headC.x - neck.x, headC.y - neck.y, headC.z - neck.z]);

  // 눈: 머리 옆 약간 앞쪽, 반쯤 묻힌 검은 구슬 + 맨살 테두리
  const eyeR = 0.0026;
  const eyeDir = new THREE.Vector3(0.8, 0.14, 0.58).normalize();
  const eyes = [-1, 1].map((side) => {
    const dir = new THREE.Vector3(side * eyeDir.x, eyeDir.y, eyeDir.z);
    // 타원체 표면까지의 거리
    const surf = 1 / Math.sqrt((dir.x / head.r[0]) ** 2 + (dir.y / head.r[1]) ** 2 + (dir.z / head.r[2]) ** 2);
    const at = dir.clone().multiplyScalar(surf - 0.0009).add(headC).sub(neck);
    const ringAt = dir.clone().multiplyScalar(surf + 0.0002).add(headC).sub(neck);
    const facing = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    return { at, ringAt, facing, surfaceAt: dir.clone().multiplyScalar(surf).add(headC).sub(neck) };
  });

  // 부리: 머리 앞 조금 아래에서 앞으로 뾰족, 끝이 살짝 아래로. 뿌리는 분홍빛, 끝은 연한 주황
  const beakLen = 0.0068;
  const beakGeo = new THREE.ConeGeometry(0.0021, beakLen, 20);
  beakGeo.rotateX(Math.PI / 2);
  beakGeo.translate(0, 0, beakLen / 2);
  beakGeo.scale(1, 0.78, 1);
  gradient(beakGeo, "z", 0, beakLen, new THREE.Color("#e08a6b"), new THREE.Color("#f2c27e"));
  beakGeo.rotateX(0.22);
  const beakBase = new THREE.Vector3(0, headC.y - 0.0028, headC.z + head.r[2] * 0.9).sub(neck);
  beakGeo.translate(beakBase.x, beakBase.y, beakBase.z);
  const eyeGeo = new THREE.SphereGeometry(eyeR, 20, 14);
  const ringGeo = new THREE.TorusGeometry(eyeR * 0.98, 0.00045, 8, 24);

  // 다리: 굵은 정강이 + 길게 벌어진 발가락 셋, 뒤로 짧은 하나
  const legParts: THREE.BufferGeometry[] = [];
  const shinLen = hip.y - 0.0011;
  const shin = new THREE.CylinderGeometry(0.0017, 0.0014, shinLen, 10);
  shin.translate(0, -shinLen / 2, 0);
  legParts.push(shin);
  for (const [yaw, len] of [
    [-0.5, 0.0095],
    [0, 0.0112],
    [0.5, 0.0095],
    [Math.PI, 0.005],
  ] as const) {
    const toe = new THREE.CylinderGeometry(0.0006, 0.001, len, 8);
    toe.rotateX(Math.PI / 2);
    toe.translate(0, 0, len / 2);
    toe.rotateX(0.06); // 끝이 바닥에 닿게
    toe.rotateY(yaw);
    toe.translate(0, -shinLen, 0);
    legParts.push(toe);
    const knuckle = new THREE.SphereGeometry(0.0011, 8, 6);
    knuckle.translate(0, -shinLen, 0);
    if (yaw === 0) legParts.push(knuckle);
  }
  const legGeo = mergeGeometries(legParts.map((g) => (g.index ? g.toNonIndexed() : g)));
  gradient(legGeo, "y", -shinLen, 0, LEG, new THREE.Color("#f3c77a"));

  const furBody = furGeometry(bodyGeo);
  const furHead = furGeometry(headGeo);
  const balds: Bald[] = [
    ...eyes.map((e) => ({ at: e.surfaceAt, r: eyeR * 1.25 })),
    { at: beakBase, r: 0.0017 },
  ];

  const skin = new THREE.MeshStandardMaterial({ color: SKIN.clone().multiplyScalar(0.8), roughness: 1 });
  const eyeSkin = new THREE.MeshStandardMaterial({ color: "#cfae72", roughness: 0.8 });
  const furBodyMat = furMaterial(fur.body, new THREE.Vector3(), []);
  const furHeadMat = furMaterial(fur.head, neck, balds);
  const beak = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 });
  const leg = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.5 });
  const eye = new THREE.MeshPhysicalMaterial({ color: "#0a0705", roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02 });

  return {
    neck,
    eyes,
    geometries: { body: bodyGeo, head: headGeo, furBody, furHead, beak: beakGeo, eye: eyeGeo, ring: ringGeo, leg: legGeo },
    materials: { skin, eyeSkin, furBody: furBodyMat, furHead: furHeadMat, beak, leg, eye },
    dispose() {
      for (const g of Object.values(this.geometries)) g.dispose();
      for (const m of Object.values(this.materials)) m.dispose();
    },
  };
}
