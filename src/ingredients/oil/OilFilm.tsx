"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { COOKING_GLSL } from "@/engine/cooking/cookingShader";
import { excludeFromReflections } from "@/engine/rendering/renderConfig";

type OilFilmProps = {
  /** 기름이 깔린 바닥 중심 (월드) */
  position: [number, number, number];
  /** 기름이 퍼진 반경 (m) */
  radius: number;
  /** 가열 세기 0 ~ 1 (대류로 표면이 일렁이는 정도) */
  heat: () => number;
};

/**
 * 팬 바닥에 얇게 두른 식용유.
 * 기름 자체는 거의 투명하고 색이 없다 → 확산광은 내지 않고 (바닥을 살짝 젖은 듯 어둡게 할 뿐)
 * 매끈한 표면의 반사만 더한다. 고르게 펴지지 않아 곳곳에 고인 곳과 얇은 곳이 있고,
 * 가열되면 대류로 표면이 아주 미세하게 일렁여 반사가 살아 움직인다 (열기 표현).
 */
export function OilFilm({ position, radius, heat }: OilFilmProps) {
  const mesh = useRef<THREE.Mesh>(null);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uHeat: { value: 0 }, uRadius: { value: radius } }), [radius]);
  const material = useMemo(() => {
    const m = new THREE.MeshPhysicalMaterial({
      color: "#000000",
      roughness: 0.04,
      metalness: 0,
      ior: 1.47,
      specularIntensity: 1,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
    });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vLocal;\nvarying vec2 vOilWorld;\nvarying vec3 vOilPos;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvLocal = position.xz;\nvOilPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvOilWorld = vOilPos.xz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec2 vLocal;
varying vec2 vOilWorld;
varying vec3 vOilPos;
uniform float uTime;
uniform float uHeat;
uniform float uRadius;
${COOKING_GLSL}`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
// 덮임: 가운데는 고르게, 가장자리는 들쭉날쭉 끊기고, 군데군데 고인 곳(더 매끈하고 진한 반사)
float oilR = length(vLocal) / uRadius;
float oilEdge = 1.0 - smoothstep(0.78, 1.0, oilR + (ckFbm(vOilWorld * 30.0) - 0.5) * 0.35);
float oilPool = smoothstep(0.35, 0.75, ckFbm(vOilWorld * 18.0 + 4.0));
float oilCover = oilEdge * (0.55 + 0.45 * oilPool);
if (oilCover < 0.01) discard;`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
// 얇은 곳은 바닥 코팅의 결이 비쳐 조금 덜 매끈하다
roughnessFactor = mix(0.12, 0.03, oilPool);`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
{
  // 대류: 느리게 흐르는 큰 일렁임 + 가열될수록 빨라지는 잔떨림
  float t = uTime;
  float e = 0.0015;
  vec2 p1 = vOilWorld * 24.0 + vec2(t * 0.05, -t * 0.04);
  vec2 p2 = vOilWorld * 90.0 + vec2(-t * 0.35, t * 0.3);
  float n0 = ckFbm(p1) * 0.7 + ckNoise(p2) * 0.3 * uHeat;
  vec2 g = vec2(
    ckFbm(p1 + vec2(e * 24.0, 0.0)) * 0.7 + ckNoise(p2 + vec2(e * 90.0, 0.0)) * 0.3 * uHeat - n0,
    ckFbm(p1 + vec2(0.0, e * 24.0)) * 0.7 + ckNoise(p2 + vec2(0.0, e * 90.0)) * 0.3 * uHeat - n0
  ) / e;
  vec3 tiltW = vec3(-g.x, 0.0, -g.y) * (0.00035 + 0.0004 * uHeat);
  normal = normalize(normal + (viewMatrix * vec4(tiltW, 0.0)).xyz);
}`,
        )
        .replace(
          "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
          // 반사만 더하고, 아래 코팅은 기름에 젖어 살짝 어둡게 (알파 = 가리는 정도)
          `// 촬영용 소프트박스(팬 뒤 위쪽)가 기름에 비친 넓은 반사: 일렁임 때문에 잘게 부서져 반짝인다
vec3 oilN = inverseTransformDirection(normal, viewMatrix);
vec3 oilV = normalize(cameraPosition - vOilPos);
vec3 oilRefl = reflect(-oilV, oilN);
float oilBox = smoothstep(0.978, 0.998, dot(oilRefl, normalize(vec3(0.24, 0.72, -0.65))));
// 고인 곳만 맑게 비친다 (얇은 곳은 바닥 결에 흩어짐) → 넓은 안개가 아니라 군데군데 맺히는 반사
vec3 outgoingLight = (totalSpecular + vec3(0.16) * oilBox * oilPool * oilPool) * oilCover;
diffuseColor.a = 0.12 * oilCover;`,
        )
        .replace("#include <premultiplied_alpha_fragment>", "");
    };
    m.customProgramCacheKey = () => "oil-film";
    return m;
  }, [uniforms]);
  const geometry = useMemo(() => new THREE.CircleGeometry(radius, 96).rotateX(-Math.PI / 2), [radius]);
  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry],
  );

  // 팬 바닥의 기름은 유리에 비치지 않는다
  useEffect(() => {
    if (mesh.current) excludeFromReflections(mesh.current);
  }, []);

  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    const u = (m.material as THREE.Material).userData.uniforms as typeof uniforms | undefined;
    if (!u) return;
    u.uTime.value += Math.min(dt, 1 / 20) * (0.4 + heat());
    u.uHeat.value += (heat() - u.uHeat.value) * Math.min(1, dt);
  });

  return (
    <mesh
      ref={mesh}
      name="oil-film"
      position={position}
      geometry={geometry}
      material={material}
      renderOrder={1}
      onUpdate={(m) => {
        (m.material as THREE.Material).userData.uniforms = uniforms;
      }}
    />
  );
}
