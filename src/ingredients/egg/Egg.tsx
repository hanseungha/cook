"use client";

import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { stepSpring } from "@/engine/interaction/spring";
import { warmUpPrograms } from "@/engine/rendering/warmUp";
import { createAlbumenMaterial, createYolkMaterial } from "./contents/eggContentsMaterials";
import { CRACK_Y0, createCrackPattern } from "./eggCrack";
import { EGG, createEggGeometry, eggRadius } from "./eggGeometry";
import { applyCrackShader, createCrackTexture, createCrackUniforms, updateCrackUniforms } from "./eggShellMaterial";
import { SHELL_THICKNESS, createShellHalfGeometry, shellHingePoint } from "./eggShellGeometry";
import { EggShellPieces, type ShellPieceStart } from "./EggShellPieces";
import type { GrabBounds } from "@/engine/interaction/Grabbable";
import { loadEggTextures } from "./eggTextures";

/** 껍데기 속에 남은 내용물: 흰자 비율 0 ~ 1, 노른자가 아직 안에 있는지 */
export type EggFill = { white: number; yolk: boolean };

export type EggProgress = {
  /** 균열 정도 0 ~ 1 (1 = 둘레 한 바퀴) */
  crack: number;
  /** 껍데기가 벌어진 정도 0 ~ 1 */
  open: number;
};

type EggProps = {
  /** 충격 지점의 둘레 좌표 (φ / 2π). null이면 아직 깨지지 않음 */
  impactU?: number | null;
  /** 매 프레임 읽는 목표 진행도 (화면은 이 값을 부드럽게 따라간다) */
  progress?: () => EggProgress;
  /** 다 벌어진 껍데기를 손에서 놓음 → 반쪽들이 아래로 떨어진다 */
  discarded?: boolean;
  /** 떨어진 껍데기가 놓일 표면 높이 */
  groundAt?: (x: number, z: number) => number;
  /** 떨어진 껍데기를 다시 집어 옮길 수 있는 범위 (월드 x, z) */
  pieceBounds?: GrabBounds;
  /**
   * 속에 남은 내용물 (없으면 그리지 않음). 껍데기가 벌어지면 틈으로 흰자·노른자가 보이고,
   * 흘러나가는 만큼 틈(아래쪽 균열선) 쪽으로 줄어든다
   */
  fill?: () => EggFill;
  /** 껍데기 속 노른자 위치 (계란 로컬: 장축 = Y, −X = 아래). 쏟아질 때 노른자가 떠나는 자리와 같아야 이어진다 */
  yolkAt?: THREE.Vector3;
};

/** 껍데기 속 내용물 치수 */
const FILL = {
  /** 흰자 겉면이 껍데기 안쪽 면에서 떨어진 거리 (m) — 안쪽 막 두께 + 여유 */
  inset: SHELL_THICKNESS + 0.0003,
  yolkRadius: 0.0155,
};

/** 흰자가 흘러나가는 틈 (아래쪽 균열선) — 남은 흰자는 이쪽으로 모이며 줄어든다 */
const GAP = new THREE.Vector3(-eggRadius(CRACK_Y0) * 0.9, CRACK_Y0, 0);
const DEFAULT_YOLK_AT = new THREE.Vector3(-EGG.breadth * 0.3 + FILL.yolkRadius * 0.55, CRACK_Y0, 0);

const NO_PROGRESS: EggProgress = { crack: 0, open: 0 };
const FLAT_GROUND = () => 0;

/** 화면 표현 파라미터 */
const LOOK = {
  /** 균열이 둘레를 따라 퍼지는 속도 (한 바퀴 / 초) */
  crackSpeed: 4,
  open: { omega: 11, zeta: 0.85 },
  /** 다 벌어졌을 때 반쪽의 회전각 (경첩 = 위쪽 균열선) */
  openAngle: 0.55,
  /** 반쪽이 장축 방향으로 벌어지는 거리 (m) */
  openSeparation: 0.0022,
};

/**
 * 갈색 날계란 껍데기. 옆으로 누운 자세(장축 = X축)로 모델링되어 있어
 * Grabbable 등에 그대로 넣으면 바닥에 누운 상태가 된다. 원점 = 계란 중심.
 *
 * 상태 표현 (조작 규칙은 모른다 — 진행도만 받아 그린다):
 * - 균열: 충격 지점에서 둘레를 따라 퍼지는 금 (통째 메시 + 균열 셰이더)
 * - 벌어짐: 미리 만든 균열선으로 나뉜 두 반쪽(바깥 껍데기·안쪽 막·단면)이 위쪽 경첩을 축으로 열린다
 */
export function Egg({ impactU = null, progress, discarded = false, groundAt = FLAT_GROUND, pieceBounds, fill, yolkAt = DEFAULT_YOLK_AT }: EggProps) {
  const { shell } = use(loadEggTextures());
  const scene = useThree((s) => s.scene);
  const pattern = useMemo(() => createCrackPattern(7), []);
  const intactGeometry = useMemo(() => createEggGeometry(), []);
  const uniforms = useMemo(() => createCrackUniforms(), []);

  const materials = useMemo(() => {
    // 둘레(u)가 장축(v)보다 약 1.8배 길어 u 방향 2회 반복 → 반점이 늘어나지 않음
    for (const t of [shell.map, shell.roughnessMap, shell.normalMap]) t?.repeat.set(2, 1);
    const outer = new THREE.MeshPhysicalMaterial({
      color: "#ffffff",
      map: shell.map,
      roughness: 1,
      roughnessMap: shell.roughnessMap,
      metalness: 0,
      normalMap: shell.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      // 껍데기의 은은한 광택: 넓고 약한 하이라이트
      specularIntensity: 0.55,
      // 얇은 껍데기를 통과한 빛이 경계부를 따뜻하게 밝히는 느낌 (가벼운 근사)
      sheen: 0.2,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color("#e8cbb0"),
    });
    applyCrackShader(outer, uniforms);
    // 안쪽: 흰 껍데기 속 + 얇고 촉촉한 난각막. 오목한 바닥은 정점 색으로 어둡게(주변광 차폐)
    const inner = new THREE.MeshPhysicalMaterial({
      color: "#f1e9dc",
      vertexColors: true,
      roughness: 0.42,
      sheen: 0.35,
      sheenRoughness: 0.4,
      sheenColor: new THREE.Color("#fffaf0"),
    });
    // 깨진 단면: 석회질의 거친 흰색
    const edge = new THREE.MeshStandardMaterial({ color: "#efe8dc", roughness: 0.9 });
    return { outer, inner, edge, halves: [outer, inner, edge] };
  }, [shell, uniforms]);

  // 껍데기 속 흰자: 껍데기 안쪽 면을 따라 조금 안으로 들인 계란 모양 + 그 속의 노른자
  const hasFill = !!fill;
  const fillAssets = useMemo(() => {
    if (!hasFill) return null;
    const geometry = createEggGeometry(48, 48);
    const pos = geometry.attributes.position;
    const nrm = geometry.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) - nrm.getX(i) * FILL.inset,
        pos.getY(i) - nrm.getY(i) * FILL.inset,
        pos.getZ(i) - nrm.getZ(i) * FILL.inset,
      );
    }
    return {
      white: geometry,
      yolk: new THREE.SphereGeometry(FILL.yolkRadius, 40, 24),
      whiteMaterial: createAlbumenMaterial("stream"),
      yolkMaterial: createYolkMaterial(),
    };
    // fill 함수가 바뀌어도 형상은 그대로 (있고 없음만 본다)
  }, [hasFill]);
  useEffect(
    () => () => {
      if (!fillAssets) return;
      fillAssets.white.dispose();
      fillAssets.yolk.dispose();
      fillAssets.whiteMaterial.dispose();
      fillAssets.yolkMaterial.dispose();
    },
    [fillAssets],
  );
  const fillWhite = useRef<THREE.Mesh>(null);
  const fillYolk = useRef<THREE.Mesh>(null);

  // 균열 텍스처는 처음 한 번 (충격 순간 끊김이 없도록 미리)
  const crackMap = useMemo(() => createCrackTexture(pattern), [pattern]);
  useLayoutEffect(() => {
    updateCrackUniforms(uniforms, { crackMap });
  }, [uniforms, crackMap]);

  // 반쪽 형상: 충격 지점이 정해지면 그 위치에 균열선이 오도록 만든다.
  // 충격 프레임이 끊기지 않도록 유휴 시간에 생성 (벌리기는 충격 후 잠시 뒤부터 가능하므로 충분히 이르다)
  type Halves = { impactU: number; blunt: THREE.BufferGeometry; pointy: THREE.BufferGeometry; hinge: THREE.Vector3 };
  const [built, setBuilt] = useState<Halves | null>(null);
  useEffect(() => {
    if (impactU === null) return;
    const build = () =>
      setBuilt({
        impactU,
        blunt: createShellHalfGeometry("blunt", pattern, impactU),
        pointy: createShellHalfGeometry("pointy", pattern, impactU),
        hinge: shellHingePoint(pattern, impactU),
      });
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(build, { timeout: 100 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(build, 0);
    return () => clearTimeout(id);
  }, [impactU, pattern]);
  const halves = built && built.impactU === impactU ? built : null;


  const intact = useRef<THREE.Mesh>(null);
  const bluntPivot = useRef<THREE.Group>(null);
  const pointyPivot = useRef<THREE.Group>(null);
  const bluntMesh = useRef<THREE.Mesh>(null);
  const pointyMesh = useRef<THREE.Mesh>(null);
  const anim = useRef({ crack: 0, open: 0, openV: 0 });
  const [pieces, setPieces] = useState<ShellPieceStart[] | null>(null);

  // 반쪽이 처음 벌어지는 순간 셰이더 첫 사용으로 끊기지 않도록, 만들어지자마자 유휴 시간에 미리 한 번 그려 둔다
  const get = useThree((st) => st.get);
  useEffect(() => {
    if (!halves) return;
    const warm = () => {
      const { gl, scene: root, camera } = get();
      for (const pivot of [bluntPivot.current, pointyPivot.current]) if (pivot) warmUpPrograms(gl, root, camera, pivot);
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 100 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 0);
    return () => clearTimeout(id);
  }, [halves, get]);

  useEffect(() => {
    if (impactU !== null) updateCrackUniforms(uniforms, { impactU });
  }, [uniforms, impactU]);

  // 손에서 놓은 순간의 반쪽 월드 자세를 넘겨받아, 장면 루트에서 떨어뜨린다
  useLayoutEffect(() => {
    if (!discarded || pieces || !halves || !bluntMesh.current || !pointyMesh.current) return;
    const capture = (mesh: THREE.Mesh, part: "blunt" | "pointy"): ShellPieceStart => {
      mesh.updateWorldMatrix(true, false);
      return { part, geometry: mesh.geometry, matrixWorld: mesh.matrixWorld.clone() };
    };
    setPieces([capture(bluntMesh.current, "blunt"), capture(pointyMesh.current, "pointy")]);
  }, [discarded, pieces, halves]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    const target = progress?.() ?? NO_PROGRESS;
    const a = anim.current;
    // 균열: 목표까지 일정한 속도로 번져 나감
    a.crack = Math.min(target.crack, a.crack + LOOK.crackSpeed * dt);
    [a.open, a.openV] = stepSpring(a.open, a.openV, target.open, LOOK.open.omega, LOOK.open.zeta, dt);
    const open = THREE.MathUtils.clamp(a.open, 0, 1);

    updateCrackUniforms(uniforms, {
      crackReach: a.crack,
      crackDark: 0.8 * (1 - 0.85 * THREE.MathUtils.smoothstep(open, 0, 0.3)),
    });

    const split = halves !== null && open > 0.002;
    // 속 내용물: 흘러나간 만큼 틈 쪽으로 모이며 줄어든다 (부피 ∝ 크기³). 다 나가면 감춘다 (그리기 목록에는 남김)
    const f = fill?.();
    if (f && fillWhite.current && fillYolk.current) {
      const k = Math.cbrt(Math.max(0, f.white));
      // 남은 흰자는 틈에 걸쳐 늘어져 있다가 거의 다 나가서야 사라진다 (틈이 빈 껍데기로 보이지 않게)
      const s = f.white > 0.03 ? 0.6 + 0.4 * k : 0;
      fillWhite.current.scale.setScalar(s);
      fillWhite.current.position.copy(GAP).multiplyScalar(1 - s);
      fillYolk.current.scale.setScalar(f.yolk ? 1 : 0);
    }
    if (intact.current) intact.current.visible = !split;
    if (!halves || !bluntPivot.current || !pointyPivot.current) return;
    bluntPivot.current.visible = pointyPivot.current.visible = split;
    // 경첩(위쪽 균열선)을 축으로 아래가 벌어지고, 장축 방향으로도 살짝 떨어진다
    const angle = LOOK.openAngle * open;
    const sep = LOOK.openSeparation * (0.6 * THREE.MathUtils.smoothstep(open, 0, 0.25) + 0.4 * open);
    bluntPivot.current.position.set(halves.hinge.x, halves.hinge.y - sep, halves.hinge.z);
    bluntPivot.current.rotation.z = angle;
    pointyPivot.current.position.set(halves.hinge.x, halves.hinge.y + sep, halves.hinge.z);
    pointyPivot.current.rotation.z = -angle;
  });

  useEffect(
    () => () => {
      intactGeometry.dispose();
      crackMap.dispose();
      materials.outer.dispose();
      materials.inner.dispose();
      materials.edge.dispose();
    },
    [intactGeometry, crackMap, materials],
  );
  useEffect(
    () => () => {
      built?.blunt.dispose();
      built?.pointy.dispose();
    },
    [built],
  );

  const inHand = !pieces;
  return (
    <>
      <group rotation-z={Math.PI / 2} visible={inHand}>
        <mesh ref={intact} name="egg" geometry={intactGeometry} material={materials.outer} />
        {fillAssets && (
          <>
            <mesh ref={fillYolk} name="egg-fill-yolk" geometry={fillAssets.yolk} material={fillAssets.yolkMaterial} position={yolkAt} />
            <mesh ref={fillWhite} name="egg-fill-white" geometry={fillAssets.white} material={fillAssets.whiteMaterial} renderOrder={2} />
          </>
        )}
        {halves && (
          <>
            <group ref={bluntPivot} visible={false}>
              <mesh
                ref={bluntMesh}
                name="egg-shell-blunt"
                geometry={halves.blunt}
                material={materials.halves}
                position={halves.hinge.clone().negate()}
              />
            </group>
            <group ref={pointyPivot} visible={false}>
              <mesh
                ref={pointyMesh}
                name="egg-shell-pointy"
                geometry={halves.pointy}
                material={materials.halves}
                position={halves.hinge.clone().negate()}
              />
            </group>
          </>
        )}
      </group>
      {pieces && createPortal(<EggShellPieces pieces={pieces} materials={materials.halves} groundAt={groundAt} bounds={pieceBounds} />, scene)}
    </>
  );
}
