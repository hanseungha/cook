"use client";

import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import {
  Grabbable,
  type GrabBounds,
  type GrabImpact,
} from "@/engine/interaction/Grabbable";
import { nearestColliderPoint } from "@/engine/interaction/colliders";
import { useGrabStore } from "@/engine/interaction/grabStore";
import { stepSpring } from "@/engine/interaction/spring";
import { supportHeightAt, supportSideAt } from "@/engine/interaction/supportSurfaces";
import { Egg, type EggFill, type EggProgress } from "@/ingredients/egg/Egg";
import { EGG } from "@/ingredients/egg/eggGeometry";
import { CRACK_Y0 } from "@/ingredients/egg/eggCrack";
import { EggContents } from "@/ingredients/egg/contents/EggContents";
import { useEggContentsStore } from "./eggContentsStore";
import { useEggShellStore } from "./eggShellStore";
import { useEggCookingStore } from "./eggCookingStore";
import { useCookingClock } from "@/engine/cooking/cookingProgress";
import { EggSounds, eggSoundCues } from "./EggSounds";
import { PAN_ORIGIN } from "@/kitchen/StoveSetup";
import { RunawayChick } from "@/creatures/chick/RunawayChick";
import { playPeep } from "@/engine/audio/proceduralSounds";
import { useChickStore } from "./chickStore";

const ID = "egg";
/** 테두리에 가까워지면 옆면이 테두리를 향하도록 계란을 돌리는 범위 (m) */
const ALIGN_RANGE = 0.16;
const YAW = { omega: 9, zeta: 0.9 };

/** 껍데기 틈과 흘러나오는 흰자 */
const POUR_GATE = {
  /** 이만큼 벌어지면(0 ~ 1) 흰자가 흘러나오기 시작한다 */
  start: 0.25,
  /** 이보다 좁아지면(다시 맞물리면) 멈춘다 */
  stop: 0.08,
  /**
   * 틈이 팬 중심에서 이 거리(m) 안에 있어야 벌릴 수 있다. 팬 바닥 반지름(8.5cm)보다 조금 안쪽:
   * 흰자가 퍼져도(반지름 약 6cm) 팬 안에 머물고, 벽을 조금 타오르는 정도
   */
  floorRadius: 0.075,
};
const dragPoint = new THREE.Vector3();
const FULL: EggFill = { white: 1, yolk: true };
const EMPTY: EggFill = { white: 0, yolk: false };
const PAN_CENTER: [number, number] = [PAN_ORIGIN[0], PAN_ORIGIN[2]];
const onChickGone = () => useChickStore.getState().leave();

/**
 * 이 계란에 병아리가 들었는지: 주소에 ?chick=1 / ?chick=0 이 있으면 그대로,
 * 자동화 브라우저(테스트·데모 스크립트)에서는 결과가 흔들리지 않게 보통 계란, 그 밖에는 확률
 */
function chickOverride() {
  const q = new URLSearchParams(window.location.search).get("chick");
  if (q !== null) return q !== "0";
  return navigator.webdriver ? false : undefined;
}

/** 팬 속 흰자·노른자 윗면 (EggContents가 채운다) */
const contentsSurface: { topAt: ((x: number, z: number) => number | null) | null } = { topAt: null };
/** 버린 껍데기가 놓일 높이: 아래 표면과 흰자·노른자 윗면 중 높은 쪽 (흰자를 뚫고 팬 바닥에 박히지 않게) */
const setContentsSurface = (topAt: (x: number, z: number) => number | null) => {
  contentsSurface.topAt = topAt;
};
const shellGroundAt = (x: number, z: number) => Math.max(supportHeightAt(x, z), contentsSurface.topAt?.(x, z) ?? -Infinity);

const local = new THREE.Vector3();
const nearest = new THREE.Vector3();
const world = new THREE.Vector3();

declare global {
  interface Window {
    /** 개발 모드 전용: 계란 껍데기 상태 스토어 */
    __cookEggShell?: unknown;
    /** 개발 모드 전용: 계란 내용물 상태 스토어 */
    __cookEggContents?: unknown;
    /** 개발 모드 전용: 조리 진행도 스토어 */
    __cookEggCooking?: unknown;
    /** 개발 모드 전용: 병아리 스토어 */
    __cookChick?: unknown;
  }
}

/**
 * 팬 테두리에 부딪혀 깨는 계란 (조작 규칙 ↔ 껍데기 표현 연결).
 * 1. 잡고 테두리로 가져가면, 옆면이 테두리를 향하도록 손목을 돌리듯 회전
 * 2. 테두리에 부딪힌 속도만큼 금이 간다 (약하면 짧게, 여러 번 부딪히면 누적)
 * 3. 금이 한 바퀴 다 가면, 더 드래그하는 만큼 두 반쪽이 벌어진다 → OPENED
 * 4. 다 벌어진 껍데기를 놓으면 빈 반쪽들이 떨어진다
 */
export function CrackableEgg({
  initial,
  bounds,
}: {
  initial: [number, number];
  bounds: GrabBounds;
}) {
  const impactU = useEggShellStore((s) => s.impactU);
  const discarded = useEggShellStore((s) => s.discarded);
  const pouring = useEggContentsStore((s) => s.state !== "IN_SHELL");
  const chickOut = useChickStore((s) => s.phase === "out");
  const lastSource = useRef(new THREE.Vector3());
  const yawGroup = useRef<THREE.Group>(null);
  const shellRef = useRef<THREE.Group>(null);
  const yaw = useRef({ value: 0, velocity: 0 });

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    window.__cookEggShell = useEggShellStore;
    window.__cookEggContents = useEggContentsStore;
    window.__cookEggCooking = useEggCookingStore;
    window.__cookChick = useChickStore;
    return () => {
      delete window.__cookChick;
      delete window.__cookEggShell;
      delete window.__cookEggContents;
      delete window.__cookEggCooking;
    };
  }, []);

  const onImpact = useCallback((e: GrabImpact) => {
    const shell = shellRef.current;
    if (!shell) return;
    // 접점을 계란 로컬(장축 = Y) 좌표로 → 둘레각
    shell.updateWorldMatrix(true, false);
    shell.worldToLocal(local.copy(e.point));
    const u = THREE.MathUtils.euclideanModulo(
      Math.atan2(local.x, local.z) / (Math.PI * 2),
      1,
    );
    eggSoundCues.impact(e.speed);
    useEggShellStore.getState().impact(e.speed, u);
  }, []);


  // 계란마다 처음에 한 번: 병아리가 들었나
  useEffect(() => useChickStore.getState().roll(chickOverride()), []);

  // 껍데기가 벌어지기 시작하면(틈이 생기면) 바로 흰자가 흘러나오기 시작한다.
  // 틈이 좁을 때는 천천히, 다 벌어지면 왈칵. 노른자는 틈이 충분히 벌어져야 빠져나온다.
  // 병아리가 든 계란은 흰자·노른자 대신 병아리가 튀어나온다
  useEffect(
    () =>
      useEggShellStore.subscribe((s) => {
        if (s.open < POUR_GATE.start && s.state !== "OPENED") return;
        const chick = useChickStore.getState();
        if (chick.phase === "none") useEggContentsStore.getState().pour();
        else chick.hatch();
      }),
    [],
  );
  const flow = useCallback(() => {
    const s = useEggShellStore.getState();
    if (s.discarded || s.state === "OPENED") return 1;
    if (s.open < POUR_GATE.stop) return 0;
    const k = THREE.MathUtils.clamp((s.open - POUR_GATE.start) / (1 - POUR_GATE.start), 0, 1);
    return 0.15 + 0.85 * k * k;
  }, []);
  // 껍데기 속에 남은 내용물 (벌어진 틈으로 보인다)
  const fill = useCallback((): EggFill => {
    if (useChickStore.getState().phase !== "none") return EMPTY;
    const c = useEggContentsStore.getState();
    if (c.state === "IN_SHELL") return FULL;
    return { white: 1 - c.white, yolk: c.yolk === "inShell" };
  }, []);

  // 달군 팬에 흰자가 닿기 시작하면 가열(조리 진행도 증가) 시작
  useEffect(() => {
    if (pouring) useEggCookingStore.getState().startHeating();
  }, [pouring]);
  useCookingClock(useEggCookingStore);
  const cookingProgress = useCallback(() => useEggCookingStore.getState().progress, []);

  /** 쏟아지는 곳: 벌어진 균열선의 아래쪽 (계란 로컬 −X = 아래) */
  const source = useCallback((out: THREE.Vector3) => {
    const shell = shellRef.current;
    // 껍데기를 놓은 뒤에는 마지막 위치에서 마저 떨어진다
    if (shell && !useEggShellStore.getState().discarded) {
      shell.updateWorldMatrix(true, false);
      lastSource.current.copy(
        shell.localToWorld(out.set(-EGG.breadth * 0.3, CRACK_Y0, 0)),
      );
    }
    out.copy(lastSource.current);
  }, []);

  // 벌리기는 쏟아질 곳(틈)이 팬 바닥 위에 있을 때만: 테두리 위나 팬 밖에서 벌리면 흰자·노른자가 팬 밖으로 흘러넘친다.
  // 그 밖에서는 금이 간 채로 맞물려 있고, 덜 벌린 채 팬 밖으로 옮기면 다시 맞물린다
  const onDrag = useCallback(
    (distance: number, touching: boolean) => {
      const shell = useEggShellStore.getState();
      source(dragPoint);
      const overFloor = Math.hypot(dragPoint.x - PAN_ORIGIN[0], dragPoint.z - PAN_ORIGIN[2]) < POUR_GATE.floorRadius;
      if (!overFloor && shell.state === "CRACKED" && shell.open > 0) shell.release();
      shell.drag(distance, touching || !overFloor);
    },
    [source],
  );

  const onSettled = useCallback(
    () => useEggContentsStore.getState().settle(),
    [],
  );
  const onProgress = useCallback(
    (p: Parameters<ReturnType<typeof useEggContentsStore.getState>["progress"]>[0]) =>
      useEggContentsStore.getState().progress(p),
    [],
  );

  const onRelease = useCallback(
    () => useEggShellStore.getState().release(),
    [],
  );

  const progress = useCallback((): EggProgress => {
    const s = useEggShellStore.getState();
    return { crack: s.crack, open: s.open };
  }, []);

  // 손목 회전: 잡고 있는 동안 가장 가까운 테두리 접선 방향으로 장축을 맞춘다
  useFrame((_, rawDt) => {
    const g = yawGroup.current;
    if (!g) return;
    const dt = Math.min(rawDt, 1 / 20);
    const y = yaw.current;
    if (useGrabStore.getState().grabbedId === ID) {
      g.getWorldPosition(world);
      const d = nearestColliderPoint(world, nearest);
      if (d < ALIGN_RANGE) {
        // 장축 (−cosψ, 0, sinψ) ⟂ 테두리 방향 (dx, dz) → ψ = atan2(dx, dz) (+ kπ: 가까운 쪽)
        const target = Math.atan2(nearest.x - world.x, nearest.z - world.z);
        const k = Math.round((y.value - target) / Math.PI);
        [y.value, y.velocity] = stepSpring(
          y.value,
          y.velocity,
          target + k * Math.PI,
          YAW.omega,
          YAW.zeta,
          dt,
        );
      }
    } else {
      y.velocity = 0;
    }
    g.rotation.y = y.value;
  });

  return (
    <>
      <EggContents
        active={pouring}
        flow={flow}
        onSurface={setContentsSurface}
        source={source}
        groundAt={supportHeightAt}
        sideAt={supportSideAt}
        onSettled={onSettled}
        onProgress={onProgress}
        cookingProgress={cookingProgress}
        onLand={eggSoundCues.land}
      />
      <EggSounds />
      <RunawayChick
        active={chickOut}
        source={source}
        center={PAN_CENTER}
        groundAt={supportHeightAt}
        onPeep={playPeep}
        onGone={onChickGone}
      />
      <Grabbable
        id={ID}
        initial={initial}
        restRadius={EGG.restRadius}
        footprintRadius={0.016}
        // 유리 위 운반 높이 ≈ 팬 테두리 높이 → 휘두르면 옆면이 테두리에 정면으로 부딪힌다
        liftHeight={0.045}
        bounds={bounds}
        shadowSize={[EGG.length * 1.5, EGG.breadth * 1.5]}
        shadowOpacity={0.75}
        shadowOffset={[0.004, 0.003]}
        onImpact={onImpact}
        onDrag={onDrag}
        onRelease={onRelease}
        disabled={discarded}
      >
        <group ref={yawGroup}>
          {/* 계란 로컬 좌표계(장축 = Y)를 가리키는 기준점 */}
          <group ref={shellRef} rotation-z={Math.PI / 2} />
          <Egg
            impactU={impactU}
            progress={progress}
            discarded={discarded}
            groundAt={shellGroundAt}
            pieceBounds={bounds}
            fill={fill}
          />
        </group>
      </Grabbable>
    </>
  );
}
