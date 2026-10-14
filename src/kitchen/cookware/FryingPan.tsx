"use client";

import { use, useEffect, useMemo, useRef } from "react";
import { addSupportSurface } from "@/engine/interaction/supportSurfaces";
import { addCollider, ringCollider } from "@/engine/interaction/colliders";
import { addHeatSource } from "@/engine/cooking/heatSources";
import * as THREE from "three";
import type { ThreeElements } from "@react-three/fiber";
import {
  createBaseDiscGeometry,
  createExteriorGeometry,
  createHandleGeometry,
  createInteriorGeometry,
  createRimGeometry,
  cookingSurfaceHeightAt,
  outerRadiusAt,
  PAN,
  exteriorOcclusionProfile,
  rivetTransforms,
} from "./fryingPanGeometry";
import { loadPanTextures } from "../textures/proceduralTextures";

type FryingPanProps = ThreeElements["group"] & {
  /** 불 세기 0 ~ 1 (인덕션 출력) */
  heat?: number;
};

/**
 * 조리면의 상대 온도 (반경 r, m).
 * 인덕션 코일은 고리 모양이라 중심에서 약간 벗어난 곳이 가장 뜨겁고, 평평한 바닥 밖(옆벽)으로 갈수록
 * 코일에서 멀어져 식는다. 테두리 윗면은 미지근한 정도.
 */
export function panSurfaceHeat(r: number) {
  const { flatRadius: F, rimRadius: R } = PAN;
  if (r > R) return 0;
  const ring = 0.84 + 0.16 * Math.exp(-(((r - 0.05) / 0.028) ** 2));
  if (r <= F) return ring * (1 - 0.08 * THREE.MathUtils.smoothstep(r, 0.065, F));
  return THREE.MathUtils.lerp(0.76, 0.1, THREE.MathUtils.smoothstep(r, F, R));
}

/** Lathe UV의 v 방향으로만 변하는 1D AO 텍스처 (R 채널) */
function createProfileAoTexture(profile: number[]) {
  const data = new Uint8Array(profile.length * 4);
  profile.forEach((ao, i) => {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(ao * 255);
    data[i * 4 + 3] = 255;
  });
  const tex = new THREE.DataTexture(data, 1, profile.length, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 검은 논스틱 코팅 프라이팬 + 헤어라인 스테인리스 손잡이.
 * 원점은 팬 바닥 중심, 손잡이는 +X 방향.
 */
export function FryingPan({ heat = 1, ...props }: FryingPanProps) {
  // 워커에서 생성 중이면 Suspense로 대기 (장면은 텍스처가 준비된 뒤 한 번에 나타난다)
  const { coating, enamel, steel } = use(loadPanTextures());
  const group = useRef<THREE.Group>(null);
  const heatRef = useRef(heat);
  useEffect(() => {
    heatRef.current = heat;
  }, [heat]);

  // 조리면 = "내려놓을 수 있는 표면", 테두리 = 계란을 부딪혀 깰 수 있는 장애물.
  // 팬이 움직여도 현재 월드 위치 기준으로 계산한다.
  useEffect(() => {
    const pan = group.current;
    if (!pan) return;
    const center = new THREE.Vector3();
    const removeSurface = addSupportSurface({
      name: "frying-pan",
      heightAt(x, z) {
        pan.getWorldPosition(center);
        const h = cookingSurfaceHeightAt(Math.hypot(x - center.x, z - center.z));
        return h === null ? null : center.y + h;
      },
      // 테두리 아래 바깥벽: 아래로 갈수록 안쪽으로 오므라드는 곡면
      sideAt(x, z, y) {
        pan.getWorldPosition(center);
        const dx = x - center.x;
        const dz = z - center.z;
        const r = Math.hypot(dx, dz);
        if (r < PAN.rimRadius - 0.01 || r > PAN.rimRadius + 0.01 || y > center.y + PAN.height + 0.002) return null;
        const k = outerRadiusAt(Math.max(0, y - center.y)) / r;
        return [center.x + dx * k, center.z + dz * k];
      },
    });
    // 둥근 립 단면의 중심선 원
    const removeRim = addCollider(
      ringCollider(
        "frying-pan-rim",
        (out) => {
          pan.getWorldPosition(out);
          out.y += PAN.height;
        },
        PAN.rimRadius - PAN.wall / 2,
        PAN.wall / 2,
      ),
    );
    // 조리면에 닿아 있는 음식만 열을 받는다 (팬 위에 떠 있거나 팬 밖이면 0)
    const removeHeat = addHeatSource({
      name: "frying-pan",
      heatAt(x, y, z) {
        pan.getWorldPosition(center);
        const r = Math.hypot(x - center.x, z - center.z);
        const h = cookingSurfaceHeightAt(r);
        if (h === null || Math.abs(y - (center.y + h)) > 0.004) return 0;
        return panSurfaceHeat(r) * heatRef.current;
      },
    });
    return () => {
      removeSurface();
      removeRim();
      removeHeat();
    };
  }, []);
  const geo = useMemo(
    () => ({
      interior: createInteriorGeometry(),
      exterior: createExteriorGeometry(),
      rim: createRimGeometry(),
      base: createBaseDiscGeometry(),
      handle: createHandleGeometry(),
      rivets: rivetTransforms(),
    }),
    [],
  );

  const mat = useMemo(() => {

    // 조리면: 금속 입자가 섞인 코팅. 얇은 광택층(클리어코트)은 약하고 약간 거칠게 —
    // 강하고 매끈한 클리어코트가 플라스틱 느낌의 주원인이었다.
    const interior = new THREE.MeshPhysicalMaterial({
      color: "#ffffff",
      map: coating.map,
      roughness: 1,
      roughnessMap: coating.roughnessMap,
      metalness: 1,
      metalnessMap: coating.metalnessMap,
      normalMap: coating.normalMap,
      normalScale: new THREE.Vector2(0.22, 0.22),
      clearcoat: 0.3,
      clearcoatRoughness: 0.22,
      specularIntensity: 0.5,
    });

    // 외부: 짙은 차콜 메탈릭 법랑 + 아래쪽 검은 유리에 의한 환경광 차폐
    const exterior = new THREE.MeshStandardMaterial({
      aoMap: createProfileAoTexture(exteriorOcclusionProfile()),
      color: "#141415",
      roughness: 1,
      roughnessMap: enamel.roughnessMap,
      metalness: 1,
      metalnessMap: enamel.metalnessMap,
      normalMap: enamel.normalMap,
      normalScale: new THREE.Vector2(0.2, 0.2),
    });

    // 테두리: 코팅 없는 알루미늄 단면
    const rim = new THREE.MeshStandardMaterial({
      color: "#8e8e8c",
      metalness: 1,
      roughness: 0.45,
    });

    const handle = new THREE.MeshPhysicalMaterial({
      color: "#e6e6e3",
      metalness: 1,
      roughness: 0.75,
      roughnessMap: steel.roughnessMap,
      normalMap: steel.normalMap,
      normalScale: new THREE.Vector2(0.08, 0.08),
      anisotropy: 0.6,
    });

    const baseDisc = new THREE.MeshStandardMaterial({
      color: "#b8b8b6",
      metalness: 1,
      roughness: 0.35,
    });

    const rivet = new THREE.MeshStandardMaterial({
      color: "#cfcfcd",
      metalness: 1,
      roughness: 0.22,
    });

    return { interior, exterior, rim, handle, baseDisc, rivet };
  }, [coating, enamel, steel]);

  useEffect(
    () => () => {
      Object.values(geo).forEach((g) => g instanceof THREE.BufferGeometry && g.dispose());
      Object.values(mat).forEach((m) => {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      });
    },
    [geo, mat],
  );

  return (
    <group ref={group} name="frying-pan" {...props}>
      <mesh geometry={geo.interior} material={mat.interior} castShadow receiveShadow />
      <mesh geometry={geo.exterior} material={mat.exterior} castShadow receiveShadow />
      <mesh geometry={geo.rim} material={mat.rim} castShadow />
      <mesh geometry={geo.base} material={mat.baseDisc} />
      <mesh geometry={geo.handle} material={mat.handle} castShadow receiveShadow />
      {geo.rivets.map((r, i) => (
        <mesh
          key={i}
          position={r.position}
          rotation-y={r.rotationY}
          scale={[0.0016, 0.0042, 0.0042]}
          material={mat.rivet}
          castShadow
        >
          <sphereGeometry args={[1, 24, 16]} />
        </mesh>
      ))}
    </group>
  );
}
