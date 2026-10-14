"use client";

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { mulberry32 } from "@/engine/textures/noise";
import { DropShadow } from "@/engine/rendering/DropShadow";
import { useGrabStore } from "@/engine/interaction/grabStore";
import type { GrabBounds } from "@/engine/interaction/Grabbable";

export type ShellPieceStart = {
  part: "blunt" | "pointy";
  geometry: THREE.BufferGeometry;
  /** 손에서 놓은 순간의 월드 행렬 (geometry 좌표계 기준) */
  matrixWorld: THREE.Matrix4;
};

type PieceMotion = {
  centroid: THREE.Vector3;
  /** 가장 낮은·높은 정점 (안정 자세 기준, 중심에서의 높이) */
  lowest: number;
  highest: number;
  /** 안정 자세에서 중심으로부터 가장 먼 수평 거리 (다른 반쪽과 겹치지 않게) */
  radius: number;
  fromPos: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  toPos: THREE.Vector3;
  toQuat: THREE.Quaternion;
  wobbleAxis: THREE.Vector3;
  duration: number;
  /** 이번 낙하가 시작된 시각 (초) */
  start: number;
  /** 손에 들려 있는 동안: 목표점·운반 평면 높이·잡은 지점 오프셋 */
  held: null | { target: THREE.Vector3; planeY: number; offset: THREE.Vector2; pointerId: number };
};

const GRAVITY = 9.8;
const UP = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

/** 껍데기 반쪽이 차지하는 반경 (이 안이 평평해야 벽·모서리를 파고들지 않는다) */
const FOOT = 0.03;

/**
 * 경사(팬 벽 등)에 걸치면 벽을 파고들므로, 주변이 평평해질 때까지 낮은 쪽으로 미끄러뜨린다.
 */
function settleOnFlat(p: THREE.Vector3, groundAt: (x: number, z: number) => number) {
  for (let iter = 0; iter < 30; iter++) {
    const h0 = groundAt(p.x, p.z);
    let dx = 0;
    let dz = 0;
    let uneven = false;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const d = groundAt(p.x + Math.cos(a) * FOOT, p.z + Math.sin(a) * FOOT) - h0;
      if (Math.abs(d) >= 0.002) uneven = true;
      // 높은 쪽에서 멀어지고 낮은 쪽으로 (내리막 방향)
      dx -= Math.cos(a) * d;
      dz -= Math.sin(a) * d;
    }
    const len = Math.hypot(dx, dz);
    if (!uneven || len < 1e-9) return;
    p.x += (dx / len) * 0.006;
    p.z += (dz / len) * 0.006;
  }
}

/** 집어 든 껍데기를 표면 위로 들어 올리는 높이 */
const LIFT = 0.05;
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

/** 커서 광선과 높이 y 수평면의 교점 (없으면 null) */
function rayAtHeight(ray: THREE.Ray, y: number) {
  plane.constant = -y;
  return ray.intersectPlane(plane, hit);
}

/** 지금 위치(m.fromPos, m.fromQuat)에서 (aim.x, aim.z) 아래 표면으로 떨어지는 낙하를 새로 시작한다 */
/** 다른 반쪽과의 수평 간격 여유 (착지 후 흔들림 몫) */
const GAP = 0.003;

/**
 * 지금 위치(m.fromPos, m.fromQuat)에서 (aim.x, aim.z) 아래 표면으로 떨어지는 낙하를 새로 시작한다.
 * 다른 반쪽(others)이 놓인 자리와 겹치면 옆으로 비켜 내려앉는다 (서로 관통하지 않게)
 */
function dropFrom(
  m: PieceMotion,
  aim: THREE.Vector3,
  groundAt: (x: number, z: number) => number,
  now: number,
  others: PieceMotion[] = [],
  bounds?: GrabBounds,
) {
  m.toPos.copy(aim);
  for (let iter = 0; iter < 12; iter++) {
    settleOnFlat(m.toPos, groundAt);
    let moved = false;
    for (const o of others) {
      if (o === m) continue;
      const dx = m.toPos.x - o.toPos.x;
      const dz = m.toPos.z - o.toPos.z;
      const d = Math.hypot(dx, dz);
      const min = m.radius + o.radius + GAP;
      if (d >= min) continue;
      // 겹친 만큼 바깥으로 (거의 같은 자리면 팬 바깥 쪽이 아니라 임의의 고정 방향)
      const [ux, uz] = d > 1e-5 ? [dx / d, dz / d] : [0.8, 0.6];
      m.toPos.x = o.toPos.x + ux * min;
      m.toPos.z = o.toPos.z + uz * min;
      if (bounds) {
        m.toPos.x = THREE.MathUtils.clamp(m.toPos.x, bounds.minX, bounds.maxX);
        m.toPos.z = THREE.MathUtils.clamp(m.toPos.z, bounds.minZ, bounds.maxZ);
      }
      moved = true;
    }
    if (!moved) break;
  }
  m.toPos.y = groundAt(m.toPos.x, m.toPos.z) - m.lowest + 0.0006;
  const h = Math.max(0.005, m.fromPos.y - m.toPos.y);
  m.duration = THREE.MathUtils.clamp(Math.sqrt((2 * h) / GRAVITY) * 1.25, 0.22, 0.55);
  m.start = now;
}

/**
 * 손에서 놓은 빈 껍데기 반쪽들이 아래 표면으로 떨어져 엎어지지 않고 컵처럼 놓이는 연출.
 * 물리 시뮬레이션 대신 시작 자세 → 안정 자세(입구가 위, 살짝 기울어짐)를 낙하 곡선으로 잇고
 * 착지 후 짧게 흔들리게 한다.
 * 내려앉은 반쪽은 다시 집어(드래그) 옮기고 놓을 수 있다 → 다른 곳으로 떨어진다.
 */
export function EggShellPieces({
  pieces,
  materials,
  groundAt,
  bounds,
}: {
  pieces: ShellPieceStart[];
  materials: THREE.Material[];
  groundAt: (x: number, z: number) => number;
  bounds?: GrabBounds;
}) {
  const motions = useMemo<PieceMotion[]>(() => {
    const rand = mulberry32(31);
    const list = pieces.map((p) => {
      const g = p.geometry;
      g.computeBoundingBox();
      const centroid = g.boundingBox!.getCenter(new THREE.Vector3());
      const fromQuat = new THREE.Quaternion();
      const fromPos = new THREE.Vector3();
      p.matrixWorld.decompose(fromPos, fromQuat, tmpV);
      fromPos.copy(centroid).applyMatrix4(p.matrixWorld);

      // 안정 자세: 극점이 아래, 깨진 입구가 위 (blunt는 로컬 +Y, pointy는 로컬 −Y가 위로)
      const align = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, p.part === "blunt" ? 1 : -1, 0),
        UP,
      );
      const yaw = new THREE.Quaternion().setFromAxisAngle(UP, rand() * Math.PI * 2);
      const tiltAxis = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5).normalize();
      // 뾰족한 쪽은 무게중심이 높아 더 기울어 눕는다
      const tilt = new THREE.Quaternion().setFromAxisAngle(tiltAxis, p.part === "blunt" ? 0.22 : 0.55);
      const toQuat = tilt.multiply(yaw).multiply(align);

      // 장축 방향으로 서로 조금 멀어지며 떨어진다
      const away = new THREE.Vector3(0, p.part === "blunt" ? -1 : 1, 0).applyQuaternion(fromQuat);
      away.y = 0;
      away.normalize().multiplyScalar(0.022 + rand() * 0.01);
      // 기울어진 자세에서 가장 낮은 정점 (표면에 닿는 높이 계산용)
      const pos = g.attributes.position;
      let lowest = Infinity;
      let highest = -Infinity;
      let radius = 0;
      for (let i = 0; i < pos.count; i++) {
        tmpV.fromBufferAttribute(pos, i).sub(centroid).applyQuaternion(toQuat);
        lowest = Math.min(lowest, tmpV.y);
        highest = Math.max(highest, tmpV.y);
        radius = Math.max(radius, Math.hypot(tmpV.x, tmpV.z));
      }
      const m: PieceMotion = {
        centroid,
        lowest,
        highest,
        radius,
        fromPos,
        fromQuat,
        toPos: new THREE.Vector3(),
        toQuat,
        wobbleAxis: tiltAxis.clone().cross(UP).normalize(),
        duration: 0,
        start: 0,
        held: null,
      };
      return { m, aim: fromPos.clone().add(away) };
    });
    // 먼저 정해진 반쪽을 피해 다음 반쪽이 내려앉는다
    const all = list.map((l) => l.m);
    list.forEach(({ m, aim }, i) => dropFrom(m, aim, groundAt, 0, all.slice(0, i), bounds));
    return all;
  }, [pieces, groundAt, bounds]);

  const clock = useRef(0);
  const groups = useRef<Array<THREE.Group | null>>([]);
  const shadows = useRef<Array<THREE.Mesh | null>>([]);
  const get = useThree((st) => st.get);
  const grab = useGrabStore;
  const idOf = (i: number) => `egg-shell:${pieces[i].part}`;
  const setCursor = (c: string) => {
    get().gl.domElement.style.cursor = c;
  };

  /** 커서 광선 → 운반 평면 위 목표점 */
  const aim = (m: PieceMotion, ray: THREE.Ray) => {
    const held = m.held!;
    if (!rayAtHeight(ray, held.planeY)) return;
    held.target.x = hit.x + held.offset.x;
    held.target.z = hit.z + held.offset.y;
    if (bounds) {
      held.target.x = THREE.MathUtils.clamp(held.target.x, bounds.minX, bounds.maxX);
      held.target.z = THREE.MathUtils.clamp(held.target.z, bounds.minZ, bounds.maxZ);
    }
  };

  const onPointerDown = (i: number) => (e: ThreeEvent<PointerEvent>) => {
    const m = motions[i];
    const group = groups.current[i];
    // 떨어지는 중에는 잡지 않는다 (착지한 뒤에만)
    if (!group || e.button !== 0 || grab.getState().grabbedId || clock.current - m.start < m.duration) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const planeY = group.position.y + LIFT;
    const offset = new THREE.Vector2();
    if (rayAtHeight(e.ray, planeY)) offset.set(group.position.x - hit.x, group.position.z - hit.z);
    m.held = { target: group.position.clone(), planeY, offset, pointerId: e.pointerId };
    aim(m, e.ray);
    grab.getState().setGrabbed(idOf(i));
    setCursor("grabbing");
  };

  const onPointerMove = (i: number) => (e: ThreeEvent<PointerEvent>) => {
    const m = motions[i];
    if (!m.held) return;
    e.stopPropagation();
    aim(m, e.ray);
  };

  const release = (i: number) => (e: ThreeEvent<PointerEvent>) => {
    const m = motions[i];
    const group = groups.current[i];
    if (!m.held || !group) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    m.held = null;
    // 지금 자세에서 아래 표면으로 다시 떨어진다
    m.fromPos.copy(group.position);
    m.fromQuat.copy(group.quaternion);
    dropFrom(m, group.position, groundAt, clock.current, motions, bounds);
    grab.getState().setGrabbed(null);
    setCursor(grab.getState().hoveredId === idOf(i) ? "grab" : "");
  };

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    clock.current += dt;
    const t = clock.current;
    motions.forEach((m, i) => {
      const group = groups.current[i];
      if (!group) return;
      if (m.held) {
        // 손에 든 채: 목표점을 부드럽게 따라가고, 주변 표면(팬 테두리 등)보다 높이 들려 넘어간다
        const held = m.held;
        let clear = -Infinity;
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * Math.PI * 2;
          clear = Math.max(clear, groundAt(group.position.x + Math.cos(th) * (FOOT + 0.01), group.position.z + Math.sin(th) * (FOOT + 0.01)));
        }
        held.target.y = Math.max(held.planeY, clear - m.lowest + LIFT * 0.6);
        // 다른 반쪽 위를 지날 때는 그 위로 넘어간다 (관통하지 않게)
        motions.forEach((o, j) => {
          const og = groups.current[j];
          if (o === m || !og) return;
          const d = Math.hypot(group.position.x - og.position.x, group.position.z - og.position.z);
          if (d < m.radius + o.radius + 0.01) held.target.y = Math.max(held.target.y, og.position.y + o.highest - m.lowest + 0.008);
        });
        const prevX = group.position.x;
        const prevZ = group.position.z;
        group.position.lerp(held.target, 1 - Math.exp(-18 * dt));
        // 안정 자세로 돌아오며, 움직이는 방향으로 살짝 기운다 (손에 매달린 느낌)
        const vx = (group.position.x - prevX) / Math.max(dt, 1e-4);
        const vz = (group.position.z - prevZ) / Math.max(dt, 1e-4);
        tmpQ.setFromEuler(new THREE.Euler(THREE.MathUtils.clamp(vz * 0.5, -0.4, 0.4), 0, THREE.MathUtils.clamp(-vx * 0.5, -0.4, 0.4)));
        tmpQ.multiply(m.toQuat);
        group.quaternion.slerp(tmpQ, 1 - Math.exp(-10 * dt));
      } else {
        const tau0 = t - m.start;
        const k = Math.min(1, tau0 / m.duration);
        // 수평: 감속, 수직: 가속 낙하, 회전: 떨어지는 동안 안정 자세로
        const ease = 1 - Math.pow(1 - k, 3);
        group.position.lerpVectors(m.fromPos, m.toPos, ease);
        group.position.y = m.fromPos.y + (m.toPos.y - m.fromPos.y) * k * k;
        group.quaternion.slerpQuaternions(m.fromQuat, m.toQuat, 0.5 - 0.5 * Math.cos(Math.PI * k));
        if (k >= 1) {
          // 착지 후: 작게 튀고 흔들리다 멈춤
          const tau = tau0 - m.duration;
          group.position.y += 0.003 * Math.exp(-9 * tau) * Math.abs(Math.sin(22 * tau));
          tmpQ.setFromAxisAngle(m.wobbleAxis, 0.2 * Math.exp(-5 * tau) * Math.sin(17 * tau));
          group.quaternion.premultiply(tmpQ);
        }
      }
      const shadow = shadows.current[i];
      if (shadow) {
        const ground = groundAt(group.position.x, group.position.z);
        const h = Math.max(0, group.position.y + m.lowest - ground);
        shadow.position.set(group.position.x + 0.003, ground + 0.0003, group.position.z + 0.002);
        shadow.scale.setScalar(1 + h * 5);
        (shadow.material as THREE.MeshBasicMaterial).opacity = 0.6 * THREE.MathUtils.clamp(1 - h / 0.12, 0.25, 1);
      }
    });
  });

  return (
    <>
      {motions.map((m, i) => (
        <group
          key={i}
          ref={(g) => {
            groups.current[i] = g;
          }}
          position={m.fromPos.clone()}
          quaternion={m.fromQuat.clone()}
          name={`egg-shell-piece:${pieces[i].part}`}
          // 검증용: 안정 자세의 수평 반지름
          userData={{ radius: m.radius }}
          onPointerDown={onPointerDown(i)}
          onPointerMove={onPointerMove(i)}
          onPointerUp={release(i)}
          onPointerCancel={release(i)}
          onPointerOver={(e) => {
            e.stopPropagation();
            grab.getState().setHovered(idOf(i));
            if (!m.held && !grab.getState().grabbedId) setCursor("grab");
          }}
          onPointerOut={() => {
            if (grab.getState().hoveredId === idOf(i)) grab.getState().setHovered(null);
            if (!m.held && !grab.getState().grabbedId) setCursor("");
          }}
        >
          <mesh geometry={pieces[i].geometry} material={materials} position={m.centroid.clone().negate()} />
        </group>
      ))}
      {motions.map((m, i) => (
        <DropShadow
          key={i}
          ref={(mesh) => {
            shadows.current[i] = mesh;
          }}
          size={[0.04, 0.04]}
          depthOffset={false}
          name={`egg-shell-shadow:${pieces[i].part}`}
        />
      ))}
    </>
  );
}
