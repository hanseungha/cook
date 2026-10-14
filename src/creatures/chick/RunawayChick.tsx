"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { DropShadow } from "@/engine/rendering/DropShadow";
import { warmUpPrograms } from "@/engine/rendering/warmUp";
import { excludeFromReflections } from "@/engine/rendering/renderConfig";
import { CHICK, createChickAssets } from "./chickModel";

/** 움직임 규칙 */
const RUN = {
  /** 튀어나올 때 위로 솟는 속도 (m/s) */
  popUp: 0.32,
  /** 튀어나올 때 달아날 쪽으로 나가는 속도 (m/s) */
  popOut: 0.12,
  /** 내려앉은 뒤 두리번거리는 시간 (s) */
  look: 0.35,
  /** 최고 달리기 속도 (m/s)와 가속 */
  speed: 0.5,
  accel: 2.2,
  /** 한 걸음 길이 (m) */
  stride: 0.016,
  /** 앞쪽 바닥이 이만큼 높으면 뛰어오른다 (m) */
  step: 0.004,
  /** 뛰어넘을 때 장애물 위로 남기는 여유 (m) */
  clearance: 0.012,
  /** 뛰어넘을 장애물을 찾는 앞쪽 거리 (m) */
  lookAhead: 0.09,
  /** 뛰어넘을 때 최고 수평 속도 (m/s) */
  maxLeapSpeed: 0.9,
  gravity: 9.8,
  /** 이 시간이 지나면 어디 있든 사라진다 (안전장치, s) */
  maxTime: 8,
};

const ndc = new THREE.Vector3();

type Motion = {
  phase: "pop" | "look" | "run";
  pos: THREE.Vector3;
  vy: number;
  grounded: boolean;
  dir: THREE.Vector2;
  speed: number;
  yaw: number;
  t: number;
  phaseT: number;
  gait: number;
  nextPeep: number;
  stuck: number;
  /** 뛰어오를 때 정한 공중 수평 속도 */
  airSpeed: number;
};

/** 앞길(lookAhead 안)에서 가장 높은 바닥과 거기까지 거리. 바로 다음 걸음(near)은 걸어서 오를 수 있는지 따로 본다 */
function highestAhead(groundAt: (x: number, z: number) => number, pos: THREE.Vector3, dir: THREE.Vector2, near: number) {
  let height = -Infinity;
  let distance = 0;
  // 3mm 간격으로 훑는다: 바로 앞이 걸어 오를 만큼 완만하면(첫 1.2cm) 아직 뛸 필요 없다
  const firstBlock = groundAt(pos.x + dir.x * Math.max(near, 0.012), pos.z + dir.y * Math.max(near, 0.012));
  if (firstBlock <= pos.y + RUN.step) return { height: -Infinity, distance: 0 };
  for (let d = 0.003; d <= RUN.lookAhead; d += 0.003) {
    const h = groundAt(pos.x + dir.x * d, pos.z + dir.y * d);
    if (h > height) {
      height = h;
      distance = d;
    }
  }
  return { height, distance };
}

/**
 * 계란에서 튀어나와 화면 밖으로 달아나는 병아리.
 * 1. 틈(source)에서 솟아올라 아래 표면에 떨어진다
 * 2. 잠깐 카메라 쪽을 보고 두리번거리다가
 * 3. 가까운 화면 가장자리 쪽으로 종종걸음 (앞이 높으면 폴짝 뛰어넘는다: 팬 벽·인덕션 턱)
 * 4. 화면 밖으로 나가면 onGone
 */
export function RunawayChick({
  active,
  source,
  center,
  groundAt,
  onPeep,
  onGone,
}: {
  /** true가 되는 순간 튀어나온다 (그 전에는 숨긴 채 셰이더만 미리 준비) */
  active: boolean;
  /** 튀어나올 곳 (월드) */
  source: (out: THREE.Vector3) => void;
  /** 이곳에서 멀어지는 쪽으로 달아난다 (x, z) */
  center: [number, number];
  groundAt: (x: number, z: number) => number;
  onPeep: (excited: number) => void;
  onGone: () => void;
}) {
  const get = useThree((s) => s.get);
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const motion = useRef<Motion | null>(null);
  const assets = useMemo(() => createChickAssets(), []);
  useEffect(() => () => assets.dispose(), [assets]);

  // 처음 튀어나오는 프레임이 셰이더 컴파일로 끊기지 않게 미리
  useEffect(() => {
    const warm = () => {
      const g = root.current;
      if (!g) return;
      excludeFromReflections(g);
      const { gl, scene, camera } = get();
      warmUpPrograms(gl, scene, camera, g);
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 0);
    return () => clearTimeout(id);
  }, [get]);

  useFrame(({ camera }, rawDt) => {
    const g = root.current;
    if (!g) return;
    if (!active) {
      g.visible = false;
      if (shadow.current) shadow.current.visible = false;
      return;
    }
    // 개발 모드: window.__cookChickSlow (0 ~ 1)로 느리게 (촬영·확인용)
    const slow = process.env.NODE_ENV === "development" ? ((window as { __cookChickSlow?: number }).__cookChickSlow ?? 1) : 1;
    const dt = Math.min(rawDt, 1 / 30) * slow;
    let m = motion.current;
    if (!m) {
      const pos = new THREE.Vector3();
      source(pos);
      // 팬 중심에서 멀어지는 쪽 (중심 가까이면 아무 쪽) + 조금 흔들어서
      const dir = new THREE.Vector2(pos.x - center[0], pos.z - center[1]);
      let a = (dir.lengthSq() > 1e-4 ? Math.atan2(dir.y, dir.x) : Math.random() * Math.PI * 2) + (Math.random() - 0.5) * 0.9;
      // 개발 모드: window.__cookChickDir (라디안, x→z)로 달아날 방향 고정 (검증용)
      const forcedDir = process.env.NODE_ENV === "development" ? (window as { __cookChickDir?: number }).__cookChickDir : undefined;
      if (forcedDir !== undefined) a = forcedDir;
      dir.set(Math.cos(a), Math.sin(a));
      m = motion.current = {
        phase: "pop",
        pos,
        vy: RUN.popUp,
        grounded: false,
        dir,
        speed: RUN.popOut,
        yaw: Math.atan2(dir.x, dir.y) + Math.PI,
        t: 0,
        phaseT: 0,
        gait: 0,
        nextPeep: 0.12,
        stuck: 0,
        airSpeed: 0,
      };
      onPeep(0.4);
      g.visible = true;
    }
    m.t += dt;
    m.phaseT += dt;

    // 수평 이동: 앞 바닥이 높으면 뛰어오르고, 벽에 막히면 멈춘다
    if (m.phase === "run") m.speed = Math.min(RUN.speed, m.speed + RUN.accel * dt);
    else if (m.phase === "look") m.speed = 0;
    // 앞길에 걸어 오를 수 없는 턱·벽이 있으면 가장 높은 곳까지 한 번에 폴짝 뛰어넘는다.
    // (바로 앞만 보면 팬 벽 꼭대기에서 "테두리 너머가 낮다"고 착각해 벽에 막힌다)
    if (m.grounded && m.phase === "run") {
      const obstacle = highestAhead(groundAt, m.pos, m.dir, m.speed * dt * 1.5);
      if (obstacle.height > m.pos.y + RUN.step) {
        m.vy = Math.sqrt(2 * RUN.gravity * (obstacle.height - m.pos.y + RUN.clearance));
        // 꼭대기에 오를 때쯤 장애물 위에 닿도록 앞으로 나가는 속도
        m.airSpeed = Math.max(m.speed, Math.min(RUN.maxLeapSpeed, (obstacle.distance + 0.01) / (m.vy / RUN.gravity)));
        m.grounded = false;
        onPeep(1);
      }
    }
    const v = m.grounded ? m.speed : Math.max(m.speed, m.airSpeed);
    const nx = m.pos.x + m.dir.x * v * dt;
    const nz = m.pos.z + m.dir.y * v * dt;
    const next = groundAt(nx, nz);
    if (next <= m.pos.y + RUN.step * 0.5) {
      m.pos.x = nx;
      m.pos.z = nz;
      m.stuck = 0;
    } else if (m.phase === "run") {
      m.stuck += dt;
      // 안전장치: 그래도 막히면 높이 뛴다
      if (m.stuck > 0.25 && m.grounded) {
        m.vy = 1.2;
        m.airSpeed = RUN.speed;
        m.grounded = false;
      }
    }
    // 수직: 떨어지는 중이면 중력, 걷는 중이면 바닥을 따라간다 (턱 아래로는 떨어진다)
    const ground = groundAt(m.pos.x, m.pos.z);
    if (m.grounded && ground < m.pos.y - 0.003) m.grounded = false;
    if (!m.grounded) {
      m.vy -= RUN.gravity * dt;
      m.pos.y += m.vy * dt;
      if (m.pos.y <= ground && m.vy <= 0) {
        m.pos.y = ground;
        m.vy = 0;
        m.grounded = true;
        m.airSpeed = 0;
        if (m.phase === "pop") {
          m.phase = "look";
          m.phaseT = 0;
        }
      }
    } else {
      m.pos.y = ground;
    }
    if (m.phase === "look" && m.phaseT > RUN.look) {
      m.phase = "run";
      m.phaseT = 0;
      onPeep(0.9);
      m.nextPeep = m.t + 0.2;
    }

    // 방향: 두리번거릴 때는 카메라 쪽을 보다가, 달릴 때는 달아나는 쪽
    let targetYaw = Math.atan2(m.dir.x, m.dir.y);
    if (m.phase !== "run") {
      targetYaw = Math.atan2(camera.position.x - m.pos.x, camera.position.z - m.pos.z) + Math.sin(m.phaseT * 18) * 0.35;
    }
    const dy = Math.atan2(Math.sin(targetYaw - m.yaw), Math.cos(targetYaw - m.yaw));
    m.yaw += dy * Math.min(1, dt * (m.phase === "run" ? 14 : 10));

    // 걸음: 다리를 번갈아 젓고, 몸이 통통 튀며 좌우로 뒤뚱
    m.gait += (m.speed / RUN.stride) * Math.PI * dt;
    const swing = Math.min(1, m.speed / 0.15);
    const airborne = !m.grounded && m.phase === "run";
    if (legL.current && legR.current) {
      const s = airborne ? -0.6 : Math.sin(m.gait) * 0.85 * swing;
      legL.current.rotation.x = s;
      legR.current.rotation.x = airborne ? -0.6 : -s;
    }
    if (body.current) {
      body.current.position.y = Math.abs(Math.sin(m.gait)) * 0.0022 * swing;
      body.current.rotation.z = Math.sin(m.gait) * 0.09 * swing;
      body.current.rotation.x = 0.18 * swing; // 달릴 때는 앞으로 숙인다
    }
    if (headRef.current) {
      const look = m.phase === "look" ? Math.sin(m.phaseT * 22) * 0.12 : 0;
      headRef.current.rotation.x = -0.12 * swing + Math.sin(m.gait * 2) * 0.08 * swing + look;
    }
    // 튀어나올 때 웅크렸다 펴지듯
    const grow = THREE.MathUtils.smoothstep(m.t, 0, 0.18);
    g.scale.setScalar(0.7 + 0.3 * grow);
    g.position.copy(m.pos);
    g.rotation.y = m.yaw + (process.env.NODE_ENV === "development" ? ((window as { __cookChickYaw?: number }).__cookChickYaw ?? 0) : 0);

    if (shadow.current) {
      const h = Math.max(0, m.pos.y - ground);
      shadow.current.visible = true;
      shadow.current.position.set(m.pos.x + 0.003, ground + 0.0004, m.pos.z + 0.002);
      shadow.current.scale.setScalar(1 + h * 8);
      (shadow.current.material as THREE.MeshBasicMaterial).opacity = 0.42 * THREE.MathUtils.clamp(1 - h / 0.1, 0.2, 1);
    }

    // 달아나며 쉴 새 없이 삐약
    if (m.phase === "run" && m.t > m.nextPeep) {
      onPeep(1);
      m.nextPeep = m.t + 0.18 + Math.random() * 0.22;
    }
    // 화면 밖(몸 전체가 가장자리를 넘음)이면 끝
    ndc.set(m.pos.x, m.pos.y + 0.03, m.pos.z).project(camera);
    if (m.phase === "run" && (Math.abs(ndc.x) > 1.15 || Math.abs(ndc.y) > 1.15 || m.t > RUN.maxTime)) {
      g.visible = false;
      shadow.current!.visible = false;
      onGone();
    }
  });

  const { geometries: geo, materials: mat, neck, eyes } = assets;
  const { hip, fur } = CHICK;
  return (
    <>
      <group ref={root} visible={false} name="chick">
        <group ref={body}>
          <mesh geometry={geo.body} material={mat.skin} />
          <instancedMesh args={[geo.furBody, mat.furBody, fur.layers]} frustumCulled={false} />
          <group ref={headRef} position={neck}>
            <mesh geometry={geo.head} material={mat.skin} />
            <instancedMesh args={[geo.furHead, mat.furHead, fur.layers]} frustumCulled={false} />
            <mesh geometry={geo.beak} material={mat.beak} />
            {eyes.map((e, i) => (
              <group key={i}>
                <mesh geometry={geo.eye} material={mat.eye} position={e.at} />
                <mesh geometry={geo.ring} material={mat.eyeSkin} position={e.ringAt} quaternion={e.facing} />
              </group>
            ))}
          </group>
        </group>
        <group ref={legL} position={[hip.x, hip.y, -0.002]}>
          <mesh geometry={geo.leg} material={mat.leg} />
        </group>
        <group ref={legR} position={[-hip.x, hip.y, -0.002]}>
          <mesh geometry={geo.leg} material={mat.leg} />
        </group>
      </group>
      <DropShadow ref={shadow} size={[0.055, 0.055]} name="chick-shadow" />
    </>
  );
}
