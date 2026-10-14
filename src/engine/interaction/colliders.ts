import { useEffect } from "react";
import * as THREE from "three";

/**
 * 잡고 있는 물체가 부딪힐 수 있는 장애물 (예: 프라이팬 테두리).
 * 물리 엔진 대신 형상에서 직접 "가장 가까운 점"을 계산한다 → 구(sphere) 근사 물체와의 충돌·충격 속도를 얻는다.
 */
export type Collider = {
  name: string;
  /** 장애물 단면 반지름 (얇은 테두리 = 두께의 절반) */
  thickness: number;
  /** 월드 좌표 p에서 가장 가까운 장애물 위의 점을 out에 쓴다 */
  closestPoint(p: THREE.Vector3, out: THREE.Vector3): void;
};

export type Contact = {
  collider: Collider;
  /** 장애물 표면의 접점 (월드) */
  point: THREE.Vector3;
  /** 장애물 → 물체 방향 단위 벡터 */
  normal: THREE.Vector3;
  /** 겹친 깊이 (m) */
  depth: number;
};

const colliders = new Set<Collider>();

/** 장애물 등록. 반환된 함수로 해제 (효과 안에서 ref로 장애물을 만들 때) */
export function addCollider(collider: Collider) {
  colliders.add(collider);
  return () => {
    colliders.delete(collider);
  };
}

/** 컴포넌트가 마운트된 동안 장애물을 등록한다 */
export function useCollider(collider: Collider) {
  useEffect(() => addCollider(collider), [collider]);
}

const q = new THREE.Vector3();

/** 중심 center, 반지름 radius인 구와 겹치는 장애물 접촉 (가장 깊은 것 하나) */
export function sphereContact(center: THREE.Vector3, radius: number, out: Contact | null = null) {
  let best: Contact | null = null;
  for (const c of colliders) {
    c.closestPoint(center, q);
    const d = center.distanceTo(q);
    const depth = radius + c.thickness - d;
    if (depth <= 0 || d < 1e-6) continue;
    if (best && depth <= best.depth) continue;
    best = out ?? { collider: c, point: new THREE.Vector3(), normal: new THREE.Vector3(), depth };
    best.collider = c;
    best.depth = depth;
    best.normal.subVectors(center, q).divideScalar(d);
    best.point.copy(q).addScaledVector(best.normal, c.thickness);
  }
  return best;
}

/** 장애물 중 가장 가까운 점 (물체가 다가가며 자세를 맞추는 데 사용) */
export function nearestColliderPoint(p: THREE.Vector3, out: THREE.Vector3) {
  let best = Infinity;
  for (const c of colliders) {
    c.closestPoint(p, q);
    const d = p.distanceTo(q);
    if (d < best) {
      best = d;
      out.copy(q);
    }
  }
  return best;
}

/** 수평 원형 테두리 (팬·냄비·그릇 가장자리) */
export function ringCollider(
  name: string,
  getCenter: (out: THREE.Vector3) => void,
  radius: number,
  thickness: number,
): Collider {
  const center = new THREE.Vector3();
  return {
    name,
    thickness,
    closestPoint(p, out) {
      getCenter(center);
      const dx = p.x - center.x;
      const dz = p.z - center.z;
      const len = Math.hypot(dx, dz) || 1;
      out.set(center.x + (dx / len) * radius, center.y, center.z + (dz / len) * radius);
    },
  };
}
