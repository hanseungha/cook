"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { COOKING_GLSL } from "@/engine/cooking/cookingShader";
import { excludeFromReflections } from "@/engine/rendering/renderConfig";

type SteamProps = {
  /** 김이 피어오르는 곳 (음식 중심, 월드). null이면 김 없음 */
  origin: (out: THREE.Vector3) => boolean;
  /** 음식 크기 (m) — 김이 퍼지는 폭 */
  radius: number;
  /** 세기 0 ~ 1 (물기·온도). 0이면 서서히 사라진다 */
  intensity: () => number;
};

/** 김 한 가닥 = 카메라를 향해 세운 판 하나. 겹쳐 보이도록 몇 장만 */
const WISPS = [
  { dx: -0.3, dz: 0.1, w: 1.0, h: 1.0, seed: 1.3, speed: 1.0 },
  { dx: 0.25, dz: -0.2, w: 0.85, h: 1.2, seed: 4.7, speed: 0.8 },
  { dx: 0.05, dz: 0.3, w: 1.15, h: 0.9, seed: 8.1, speed: 1.15 },
  { dx: -0.1, dz: -0.35, w: 0.9, h: 1.1, seed: 2.9, speed: 0.9 },
];

/**
 * 조리 중 은은하게 올라오는 김.
 * 파티클 대신 몇 장의 반투명 판에 위로 흘러가는 노이즈를 그린다 → 가늘게 꼬이며 흩어지는 김.
 * 밝은 배경에서는 거의 보이지 않고 어두운 팬 위에서만 희미하게 보인다 (실제 촬영처럼 절제).
 */
export function Steam({ origin, radius, intensity }: SteamProps) {
  const group = useRef<THREE.Group>(null);
  const level = useRef(0);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uLevel: { value: 0 } }), []);
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1, 1, 1).translate(0, 0.5, 0), []);
  const materials = useMemo(
    () =>
      WISPS.map(
        (w) =>
          new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: { ...uniforms, uSeed: { value: w.seed }, uSpeed: { value: w.speed } },
            vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
            fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uLevel;
uniform float uSeed;
uniform float uSpeed;
${COOKING_GLSL}
void main() {
  float t = uTime * uSpeed;
  vec2 uv = vUv;
  // 올라갈수록 옆으로 흔들리며 넓게 퍼진다
  float sway = (ckNoise(vec2(uv.y * 2.0 - t * 0.4, uSeed)) - 0.5) * 0.5 * uv.y;
  float x = (uv.x - 0.5 - sway) / (0.25 + 0.45 * uv.y);
  // 위로 흘러가는 노이즈 (영역을 비틀어 가는 가닥으로)
  vec2 p = vec2(x * 1.6 + uSeed, uv.y * 2.4 - t * 0.55);
  p.x += (ckFbm(p * 1.3 + 7.0) - 0.5) * 1.2;
  float n = ckFbm(p * 1.8);
  float wisp = smoothstep(0.48, 0.8, n);
  float mask = exp(-x * x * 2.2) * smoothstep(0.0, 0.18, uv.y) * (1.0 - smoothstep(0.45, 1.0, uv.y));
  float a = wisp * mask * uLevel * 0.085;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vec3(0.93, 0.94, 0.95), a);
}`,
          }),
      ),
    [uniforms],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      materials.forEach((m) => m.dispose());
    },
    [geometry, materials],
  );

  // 처음 피어오를 때 셰이더 컴파일로 끊기지 않도록 미리
  const get = useThree((st) => st.get);
  useEffect(() => {
    const g = group.current;
    if (!g) return;
    // 옅은 김은 유리 반사에서 보이지 않는다 → 반사 패스에서 빼기
    excludeFromReflections(g);
    const { gl, scene, camera } = get();
    gl.compile(g, camera, scene);
  }, [get]);

  const at = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }, rawDt) => {
    const g = group.current;
    if (!g) return;
    const dt = Math.min(rawDt, 1 / 20);
    const has = origin(at);
    // 김은 천천히 짙어지고 천천히 사라진다
    const target = has ? intensity() : 0;
    level.current += (target - level.current) * Math.min(1, dt * (target > level.current ? 0.8 : 0.5));
    // 김이 없을 때도 그리기 목록에는 남겨 둔다 (크기 0) → 처음 피어오르는 순간 셰이더 준비로 끊기지 않는다
    const on = level.current > 0.01;
    g.scale.setScalar(on ? 1 : 0);
    if (!on) return;
    g.position.copy(at);
    // 세로로 선 채 카메라 쪽을 향한다
    const yaw = Math.atan2(camera.position.x - at.x, camera.position.z - at.z);
    g.rotation.set(0, yaw, 0);
    const u = (g.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    u.uniforms.uTime.value += dt;
    u.uniforms.uLevel.value = level.current;
  });

  return (
    <group ref={group} name="steam" scale={0}>
      {WISPS.map((w, i) => (
        <mesh
          key={i}
          geometry={geometry}
          material={materials[i]}
          position={[w.dx * radius, 0.004, w.dz * radius]}
          scale={[radius * 2.2 * w.w, radius * 3.2 * w.h, 1]}
          renderOrder={5}
          frustumCulled={false}
        />
      ))}
    </group>
  );
}
