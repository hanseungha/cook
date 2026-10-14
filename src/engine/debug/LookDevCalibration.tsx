"use client";

import type { CameraRig } from "../rendering/renderConfig";

export const lookDevCamera: CameraRig = {
  target: [0, 0.05, 0],
  elevationDeg: 30,
  azimuthDeg: 0,
  fov: 30,
  frame: { width: 0.45, height: 0.3 },
};

/**
 * 룩뎁 캘리브레이션 장면 (최종 에셋 아님).
 * 18% 그레이 볼 / 크롬 볼로 조명·톤매핑·그림자가 의도대로 나오는지 확인하는 용도.
 * 개발 확인용으로 ?lookdev 에서만 표시된다.
 */
export function LookDevCalibration() {
  return (
    <group>
      <mesh castShadow position={[-0.09, 0.06, 0]}>
        <sphereGeometry args={[0.06, 64, 64]} />
        <meshStandardMaterial color="#777777" roughness={0.9} metalness={0} />
      </mesh>
      <mesh castShadow position={[0.09, 0.06, 0]}>
        <sphereGeometry args={[0.06, 64, 64]} />
        <meshStandardMaterial color="#ffffff" roughness={0.05} metalness={1} />
      </mesh>
      <mesh receiveShadow rotation-x={-Math.PI / 2}>
        <planeGeometry args={[20, 20]} />
        <shadowMaterial opacity={0.25} />
      </mesh>
    </group>
  );
}
