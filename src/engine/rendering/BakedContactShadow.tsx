"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

type BakedContactShadowProps = {
  /** 물체 바닥 footprint 크기 (x, z), m */
  size: [number, number];
  /** footprint 모서리 반경, m */
  radius?: number;
  /** 바깥으로 퍼지는 그림자 거리, m */
  spread?: number;
  opacity?: number;
  position?: [number, number, number];
};

/**
 * 정적 물체용 접지 그림자.
 * 바닥 footprint를 블러한 텍스처를 평면에 깔아, 물체가 놓인 접점의 어두운 코어와
 * 넓게 퍼지는 부드러운 감쇠를 함께 표현한다. 런타임 비용은 텍스처 1장.
 */
export function BakedContactShadow({
  size,
  radius = 0.01,
  spread = 0.06,
  opacity = 1,
  position = [0, 0.0004, 0],
}: BakedContactShadowProps) {
  const [w, d] = [size[0] + spread * 2, size[1] + spread * 2];

  const texture = useMemo(() => {
    const ppm = 1600; // pixels per meter
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * ppm);
    canvas.height = Math.round(d * ppm);
    const ctx = canvas.getContext("2d")!;
    const rect = (inset: number) => {
      ctx.beginPath();
      ctx.roundRect(
        (spread + inset) * ppm,
        (spread + inset) * ppm,
        (size[0] - inset * 2) * ppm,
        (size[1] - inset * 2) * ppm,
        Math.max(0, radius - inset) * ppm,
      );
      ctx.fill();
    };
    // 넓은 앰비언트 감쇠 + 중간 + 접점 코어를 겹쳐 실제 AO에 가까운 프로파일을 만든다.
    // 코어는 footprint보다 살짝 바깥(음수 inset)까지 나와야 둥근 하단 모서리 아래 틈이 어둡게 보인다.
    const layers: [blurM: number, alpha: number, inset: number][] = [
      [spread * 0.45, 0.3, 0],
      [spread * 0.15, 0.35, 0],
      [0.0035, 0.55, -0.0015],
      [0.0012, 0.5, -0.0005],
    ];
    // alphaMap은 G 채널을 읽는다: 불투명 검정 바탕 위에 흰색으로 그림자 농도를 누적
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    for (const [blur, alpha, inset] of layers) {
      ctx.filter = `blur(${blur * ppm}px)`;
      ctx.globalAlpha = alpha;
      rect(inset);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  }, [w, d, size, radius, spread]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh position={position} rotation-x={-Math.PI / 2} renderOrder={-1}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial
        color="#000"
        alphaMap={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/** 방향광 그림자만 받는 투명 바닥 (흰 배경 위 그림자 캐처) */
export function ShadowCatcher({ opacity = 0.08 }: { opacity?: number }) {
  return (
    <mesh rotation-x={-Math.PI / 2} receiveShadow>
      <planeGeometry args={[4, 4]} />
      <shadowMaterial opacity={opacity} transparent depthWrite={false} />
    </mesh>
  );
}
