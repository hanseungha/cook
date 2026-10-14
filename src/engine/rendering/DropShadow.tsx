"use client";

import { forwardRef, useEffect, useMemo } from "react";
import * as THREE from "three";

/**
 * 움직이는 물체 아래의 부드러운 접지 그림자 (원형/타원 블롭).
 * 그림자 맵을 다시 그리지 않고 평면 1장으로 표현 → 드래그 중에도 비용이 거의 없다.
 * 위치·크기·농도는 소유자(예: Grabbable)가 매 프레임 갱신한다.
 */
type DropShadowProps = {
  size: [number, number];
  name?: string;
  /**
   * 깊이 오프셋으로 아래 표면과의 z-fighting을 피한다.
   * 물체가 표면에 거의 닿는 경우(컵 모양 껍데기 안쪽 바닥 등)에는 그림자가 물체 위로 비쳐 보이므로 끈다.
   */
  depthOffset?: boolean;
};

export const DropShadow = forwardRef<THREE.Mesh, DropShadowProps>(
  function DropShadow({ size, name, depthOffset = true }, ref) {
    const texture = useMemo(() => {
      const px = 256;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = px;
      const ctx = canvas.getContext("2d")!;
      // alphaMap은 G 채널을 읽는다: 검정 바탕 + 흰색 그라디언트
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, px, px);
      const g = ctx.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
      // 접점의 진한 코어 + 넓게 번지는 반그림자
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.22, "rgba(255,255,255,0.85)");
      g.addColorStop(0.5, "rgba(255,255,255,0.3)");
      g.addColorStop(0.78, "rgba(255,255,255,0.08)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, px, px);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      return tex;
    }, []);
    useEffect(() => () => texture.dispose(), [texture]);

    return (
      <mesh ref={ref} name={name} rotation-x={-Math.PI / 2} renderOrder={1}>
        <planeGeometry args={size} />
        <meshBasicMaterial
          color="#000"
          alphaMap={texture}
          transparent
          depthWrite={false}
          toneMapped={false}
          polygonOffset={depthOffset}
          polygonOffsetFactor={-2}
        />
      </mesh>
    );
  },
);
