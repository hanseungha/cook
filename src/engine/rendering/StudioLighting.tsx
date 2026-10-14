"use client";

import { Environment } from "@react-three/drei";
import { renderConfig } from "./renderConfig";
import { isOff } from "../debug/profileFlags";

/**
 * HDRI 기반 IBL + 그림자용 키 라이트.
 * HDRI는 반사/확산광에만 쓰고 배경으로는 보이지 않는다 (배경은 흰색 단색).
 */
export function StudioLighting() {
  const env = renderConfig.environment;
  return (
    <>
      {!isOff("env") && (
        <Environment
          files={env.file}
          environmentIntensity={env.intensity}
          environmentRotation={[0, env.rotationY, 0]}
        />
      )}
      {/* 거의 수직 위의 키 라이트: 그림자가 물체 바로 아래에 부드럽게 모인다 (머리 위 소프트박스 촬영 룩) */}
      <directionalLight
        castShadow
        position={[-0.12, 1.8, -0.08]}
        intensity={1.2}
        color="#fff6ea"
        shadow-mapSize={[2048, 2048]}
        shadow-radius={40}
        shadow-blurSamples={24}
        shadow-bias={-0.0004}
        shadow-normalBias={0.001}
        shadow-camera-left={-0.4}
        shadow-camera-right={0.4}
        shadow-camera-top={0.4}
        shadow-camera-bottom={-0.4}
        shadow-camera-near={0.5}
        shadow-camera-far={3}
      />
    </>
  );
}
