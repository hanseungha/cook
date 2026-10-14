"use client";

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { DropShadow } from "../rendering/DropShadow";
import { useGrabStore, type GrabPhase } from "./grabStore";
import { stepSpring } from "./spring";
import { sphereContact, type Contact } from "./colliders";
import { footprintSupportHeight, supportHeightAt } from "./supportSurfaces";

export type GrabBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** 잡고 있는 물체가 장애물(예: 팬 테두리)에 부딪힌 순간 */
export type GrabImpact = {
  collider: string;
  /** 장애물 쪽으로 다가가던 속도 성분 (m/s) */
  speed: number;
  /** 접점 (월드) */
  point: THREE.Vector3;
  /** 장애물 → 물체 방향 */
  normal: THREE.Vector3;
};

type GrabbableProps = {
  id: string;
  /** 처음 놓일 위치 (x, z). 높이는 지지 표면에서 계산 */
  initial: [number, number];
  /** 놓인 상태에서 물체 원점 ~ 바닥 거리 */
  restRadius: number;
  /** 바닥 footprint 반지름 (벽에 파고들지 않도록 지지 높이를 샘플) */
  footprintRadius?: number;
  /** 집었을 때 지지면 위로 들어 올리는 높이 */
  liftHeight?: number;
  bounds: GrabBounds;
  /** 접지 그림자 크기 (x, z) */
  shadowSize: [number, number];
  shadowOpacity?: number;
  /** 키 라이트 반대 방향으로의 그림자 치우침 (x, z) */
  shadowOffset?: [number, number];
  /** 장애물 충돌용 구 반지름 (기본 restRadius) */
  collisionRadius?: number;
  /** 잡은 채 장애물에 부딪혔을 때 */
  onImpact?: (impact: GrabImpact) => void;
  /** 잡은 채 커서를 움직일 때마다: 목표점 이동 거리(m), 장애물에 닿아 있는지 */
  onDrag?: (distance: number, touching: boolean) => void;
  /** 놓았을 때 */
  onRelease?: () => void;
  /** true면 잡을 수 없고 접지 그림자도 숨긴다 (예: 내용물이 다른 물체로 바뀐 뒤) */
  disabled?: boolean;
  children: ReactNode;
};

/** 조작감 파라미터 */
const FEEL = {
  /** 위치 추종: 지연 ≈ 1/omega ≈ 40ms, 살짝 출렁여 관성이 느껴지게 */
  follow: { omega: 25, zeta: 0.78 },
  lift: { omega: 16, zeta: 0.9 },
  /** 이동 속도(m/s) → 기울기(rad). 손에 매달린 듯 아래쪽이 뒤처진다 */
  leanPerSpeed: 0.55,
  maxLean: 0.42,
  /** 기울기 진자 스프링: 멈추면 한두 번 흔들리다 선다 */
  lean: { omega: 13, zeta: 0.42 },
  gravity: 9.8,
  /** 착지 반발 (계란·채소는 거의 튀지 않는다) */
  restitution: 0.18,
  /** 놓을 때 손의 속도를 얼마나 이어받는지 */
  throwCarry: 0.45,
  airDrag: 2.5,
  /** 장애물에 부딪혔을 때의 반발 */
  impactRestitution: 0.3,
  /** 충돌 순간 접선 방향 속도 유지율 */
  impactFriction: 0.5,
  /** 이보다 느린 접촉은 충격으로 보지 않는다 (m/s) */
  minImpactSpeed: 0.03,
} as const;

type Motion = {
  phase: GrabPhase;
  placed: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  planeY: number;
  offset: THREE.Vector2;
  lean: { x: number; vx: number; z: number; vz: number };
  touching: boolean;
};

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
const impactPoint = new THREE.Vector3();
const impactNormal = new THREE.Vector3();
const contact: Contact = {
  collider: null as never,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  depth: 0,
};

/**
 * 재사용 가능한 "집어서 옮기기" 인터랙션.
 * - 선택: R3F 레이캐스팅(자식 메시에 포인터가 닿으면) + Pointer Capture로 화면 밖까지 추적
 * - 이동: 커서 광선과 "들어 올린 높이의 수평면" 교차점 → 3D 목표점 (잡은 지점 오프셋 유지)
 * - 조작감: 스프링 추종(관성) + 속도에 따른 진자 기울기
 * - 충돌: 잡은 채 장애물(useCollider)에 부딪히면 밀려나고 onImpact로 충격 속도를 알린다
 * - 놓기: 중력 낙하 → 지지 표면에 착지, 약한 반발 + 흔들림 감쇠
 * 자식은 "놓인 자세"로 모델링해 넘긴다 (Grabbable은 위치와 기울기만 다룬다).
 */
export function Grabbable({
  id,
  initial,
  restRadius,
  footprintRadius = restRadius * 0.8,
  liftHeight = 0.07,
  bounds,
  shadowSize,
  shadowOpacity = 0.55,
  shadowOffset = [0, 0],
  collisionRadius = restRadius,
  onImpact,
  onDrag,
  onRelease,
  disabled = false,
  children,
}: GrabbableProps) {
  const root = useRef<THREE.Group>(null);
  const leanGroup = useRef<THREE.Group>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const get = useThree((s) => s.get);
  const setGrabbed = useGrabStore((s) => s.setGrabbed);
  const setHovered = useGrabStore((s) => s.setHovered);
  const report = useGrabStore((s) => s.report);

  const m = useRef<Motion>({
    phase: "rest",
    placed: false,
    pos: new THREE.Vector3(initial[0], 0, initial[1]),
    vel: new THREE.Vector3(),
    target: new THREE.Vector3(),
    planeY: 0,
    offset: new THREE.Vector2(),
    lean: { x: 0, vx: 0, z: 0, vz: 0 },
    touching: false,
  });

  // 움직이는 물체는 정적 그림자 맵(VSM)에 참여하면 안 된다:
  // VSM은 receiveShadow 물체도 맵에 그리므로, 처음 위치에 그림자 잔상이 남는다.
  // 그림자는 DropShadow가 담당한다.
  useLayoutEffect(() => {
    leanGroup.current?.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
  }, [children]);

  const restY = (x: number, z: number) => footprintSupportHeight(x, z, footprintRadius) + restRadius;

  const setCursor = (c: string) => {
    get().gl.domElement.style.cursor = c;
  };

  const setPhase = (phase: GrabPhase) => {
    const s = m.current;
    s.phase = phase;
    report(id, phase, s.pos.toArray().map((v) => +v.toFixed(4)) as [number, number, number]);
  };

  /** 커서 광선 → 운반 평면 위의 목표점 (경계 안으로 제한) */
  const aim = (ray: THREE.Ray) => {
    const s = m.current;
    plane.constant = -s.planeY;
    if (!ray.intersectPlane(plane, hit)) return false;
    s.target.x = THREE.MathUtils.clamp(hit.x + s.offset.x, bounds.minX, bounds.maxX);
    s.target.z = THREE.MathUtils.clamp(hit.z + s.offset.y, bounds.minZ, bounds.maxZ);
    return true;
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (disabled || e.button !== 0 || useGrabStore.getState().grabbedId) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const s = m.current;
    s.planeY = restY(s.pos.x, s.pos.z) + liftHeight;
    plane.constant = -s.planeY;
    if (e.ray.intersectPlane(plane, hit)) s.offset.set(s.pos.x - hit.x, s.pos.z - hit.z);
    aim(e.ray);
    setPhase("held");
    setGrabbed(id);
    setCursor("grabbing");
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const s = m.current;
    if (s.phase !== "held") return;
    e.stopPropagation();
    const px = s.target.x;
    const pz = s.target.z;
    if (aim(e.ray)) onDrag?.(Math.hypot(s.target.x - px, s.target.z - pz), s.touching);
  };

  const release = (e: ThreeEvent<PointerEvent>) => {
    const s = m.current;
    if (s.phase !== "held") return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    s.vel.multiplyScalar(FEEL.throwCarry);
    s.touching = false;
    setPhase("falling");
    setGrabbed(null);
    setCursor(useGrabStore.getState().hoveredId === id ? "grab" : "");
    onRelease?.();
  };

  useFrame((_, rawDt) => {
    const s = m.current;
    const dt = Math.min(rawDt, 1 / 20);
    const { lean } = s;

    if (!s.placed) {
      // 지지 표면들이 등록된 뒤 첫 프레임에 바닥에 올려놓는다
      s.pos.y = restY(s.pos.x, s.pos.z);
      s.placed = true;
      setPhase("rest");
    }

    const settled =
      s.phase === "rest" &&
      Math.abs(lean.x) + Math.abs(lean.z) + Math.abs(lean.vx) + Math.abs(lean.vz) < 1e-4;

    if (!settled) {
      let leanTx = 0;
      let leanTz = 0;

      if (s.phase === "held") {
        // 빠르게 휘두르면 한 프레임에 수 cm를 움직인다 → 잘게 나눠 적분해야 테두리를 뚫고 지나가지 않는다
        const reach = Math.max(s.vel.length(), s.pos.distanceTo(s.target) * FEEL.follow.omega) * dt;
        const steps = Math.min(24, Math.max(1, Math.ceil(reach / 0.004)));
        const h = dt / steps;
        let impact = 0;
        s.touching = false;
        for (let i = 0; i < steps; i++) {
          // 운반 높이: 물체 "주변"의 가장 높은 표면 위로 충분히 들어 올린다.
          // 목표점이 아닌 현재 위치 기준이라, 천천히 다가가면 테두리 앞에서 미리 들려 넘어가고
          // 빠르게 휘두르면 들리기 전에 옆면이 테두리에 부딪힌다.
          const clearance = footprintSupportHeight(s.pos.x, s.pos.z, collisionRadius + 0.01);
          s.target.y = Math.max(s.planeY, clearance + restRadius + liftHeight * 0.6);
          [s.pos.x, s.vel.x] = stepSpring(s.pos.x, s.vel.x, s.target.x, FEEL.follow.omega, FEEL.follow.zeta, h);
          [s.pos.z, s.vel.z] = stepSpring(s.pos.z, s.vel.z, s.target.z, FEEL.follow.omega, FEEL.follow.zeta, h);
          [s.pos.y, s.vel.y] = stepSpring(s.pos.y, s.vel.y, s.target.y, FEEL.lift.omega, FEEL.lift.zeta, h);
          // 장애물(팬 테두리 등): 밀어내고, 다가가던 속도 성분을 반발시킨다
          if (sphereContact(s.pos, collisionRadius, contact)) {
            s.touching = true;
            const n = contact.normal;
            s.pos.addScaledVector(n, contact.depth);
            const vn = s.vel.dot(n);
            if (vn < 0) {
              s.vel.addScaledVector(n, -vn);
              // 세게 부딪히면 손도 멈칫한다: 미끄러지는 성분을 줄이고 튕겨낸다
              if (-vn > FEEL.minImpactSpeed) s.vel.multiplyScalar(FEEL.impactFriction);
              s.vel.addScaledVector(n, -FEEL.impactRestitution * vn);
              if (-vn > Math.max(impact, FEEL.minImpactSpeed)) {
                impact = -vn;
                impactPoint.copy(contact.point);
                impactNormal.copy(n);
              }
            }
          }
          // 아래 표면을 파고들지 않게 (중심 기준 — 테두리 근처는 위의 장애물 충돌이 담당)
          const floor = supportHeightAt(s.pos.x, s.pos.z) + restRadius;
          if (s.pos.y < floor) {
            s.pos.y = floor;
            s.vel.y = Math.max(s.vel.y, 0);
          }
        }
        if (impact > 0) {
          // 부딪힌 반대쪽으로 튕기듯 흔들림
          lean.vx += impactNormal.z * impact * 14;
          lean.vz -= impactNormal.x * impact * 14;
          onImpact?.({ collider: contact.collider.name, speed: impact, point: impactPoint, normal: impactNormal });
        }
        leanTx = THREE.MathUtils.clamp(s.vel.z * FEEL.leanPerSpeed, -FEEL.maxLean, FEEL.maxLean);
        leanTz = THREE.MathUtils.clamp(-s.vel.x * FEEL.leanPerSpeed, -FEEL.maxLean, FEEL.maxLean);
      } else if (s.phase === "falling") {
        s.vel.y -= FEEL.gravity * dt;
        const drag = Math.exp(-FEEL.airDrag * dt);
        s.vel.x *= drag;
        s.vel.z *= drag;
        s.pos.addScaledVector(s.vel, dt);
        if (s.pos.x < bounds.minX || s.pos.x > bounds.maxX) s.vel.x = 0;
        if (s.pos.z < bounds.minZ || s.pos.z > bounds.maxZ) s.vel.z = 0;
        s.pos.x = THREE.MathUtils.clamp(s.pos.x, bounds.minX, bounds.maxX);
        s.pos.z = THREE.MathUtils.clamp(s.pos.z, bounds.minZ, bounds.maxZ);

        const floor = restY(s.pos.x, s.pos.z);
        if (s.pos.y <= floor) {
          s.pos.y = floor;
          // 착지 충격을 흔들림으로: 진행 방향으로 굴러가려는 듯 기울었다가 복원
          lean.vx += s.vel.z * 6;
          lean.vz -= s.vel.x * 6;
          if (s.vel.y < -0.3) {
            s.vel.y = -s.vel.y * FEEL.restitution;
            s.vel.x *= 0.4;
            s.vel.z *= 0.4;
          } else {
            s.vel.set(0, 0, 0);
            setPhase("rest");
          }
        }
      }

      [lean.x, lean.vx] = stepSpring(lean.x, lean.vx, leanTx, FEEL.lean.omega, FEEL.lean.zeta, dt);
      [lean.z, lean.vz] = stepSpring(lean.z, lean.vz, leanTz, FEEL.lean.omega, FEEL.lean.zeta, dt);
      if (s.phase === "rest" && Math.abs(lean.x) + Math.abs(lean.z) + Math.abs(lean.vx) + Math.abs(lean.vz) < 1e-4) {
        lean.x = lean.z = lean.vx = lean.vz = 0;
      }
    }

    root.current?.position.copy(s.pos);
    leanGroup.current?.rotation.set(lean.x, 0, lean.z);

    // 접지 그림자: 높이 들수록 넓고 옅게
    if (shadow.current) shadow.current.visible = !disabled;
    if (shadow.current && !disabled) {
      const ground = restY(s.pos.x, s.pos.z) - restRadius;
      const h = Math.max(0, s.pos.y - restRadius - ground);
      // 높이 들수록 그림자가 광원 반대쪽으로 더 밀려난다
      shadow.current.position.set(
        s.pos.x + shadowOffset[0] * (1 + h * 30),
        ground + 0.0005,
        s.pos.z + shadowOffset[1] * (1 + h * 30),
      );
      shadow.current.scale.setScalar(1 + h * 6);
      (shadow.current.material as THREE.MeshBasicMaterial).opacity =
        shadowOpacity * THREE.MathUtils.clamp(1 - h / 0.12, 0.25, 1);
    }
  });

  return (
    <>
      <group ref={root} name={`grab:${id}`}>
        <group
          ref={leanGroup}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={release}
          onPointerCancel={release}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(id);
            if (m.current.phase !== "held") setCursor("grab");
          }}
          onPointerOut={() => {
            setHovered(null);
            if (m.current.phase !== "held") setCursor("");
          }}
        >
          {children}
        </group>
      </group>
      <DropShadow ref={shadow} size={shadowSize} name={`grab-shadow:${id}`} />
    </>
  );
}
