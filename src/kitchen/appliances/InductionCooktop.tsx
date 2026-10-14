"use client";

import { MeshReflectorMaterial, RoundedBox } from "@react-three/drei";
import type { ThreeElements } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { isOff } from "@/engine/debug/profileFlags";
import { useSupportSurface } from "@/engine/interaction/supportSurfaces";

/** 1구 휴대용 인덕션 치수 (m). 원점은 바닥 중심. */
export const COOKTOP = {
  width: 0.3,
  depth: 0.37,
  bodyHeight: 0.052,
  glass: 0.005,
  /** 화구 중심의 Z 오프셋 (앞쪽은 조작부) */
  burnerZ: -0.025,
  get topY() {
    return this.bodyHeight + this.glass;
  },
};

/**
 * 상판 인쇄(화구 링, 터치 조작부)를 캔버스로 그린 컬러맵.
 * 실제 세라믹 글라스처럼 회색 인쇄가 은은하게 보이도록 대비를 낮게 둔다.
 */
function createGlassPrintTexture() {
  // 화면에서 유리판은 최대 약 1200px(2배 화면) → 1536이면 충분히 선명하고 메모리는 절반 이하
  const px = 1536;
  const aspect = COOKTOP.depth / COOKTOP.width;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = Math.round(px * aspect);
  const ctx = canvas.getContext("2d")!;
  const sx = px / COOKTOP.width;

  ctx.fillStyle = "#0b0b0c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2 + COOKTOP.burnerZ * sx;
  ctx.strokeStyle = "#5a5a5c";
  ctx.lineWidth = 0.0018 * sx;
  for (const r of [0.105, 0.1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * sx, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 화구 중심 표시 (작은 십자 눈금)
  ctx.lineWidth = 0.0012 * sx;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 0.088 * sx, cy + Math.sin(a) * 0.088 * sx);
    ctx.lineTo(cx + Math.cos(a) * 0.094 * sx, cy + Math.sin(a) * 0.094 * sx);
    ctx.stroke();
  }

  // 앞쪽 조작부: 터치 버튼 원 + 슬라이더 눈금
  const panelY = canvas.height - 0.032 * sx;
  ctx.fillStyle = "#6a6a6c";
  ctx.strokeStyle = "#6a6a6c";
  ctx.lineWidth = 0.001 * sx;
  const buttons = [-0.1, -0.07];
  for (const bx of buttons) {
    ctx.beginPath();
    ctx.arc(cx + bx * sx, panelY, 0.007 * sx, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 9; i++) {
    const x = cx + (-0.035 + i * 0.012) * sx;
    const h = (0.003 + i * 0.0007) * sx;
    ctx.fillRect(x, panelY - h / 2, 0.004 * sx, h);
  }
  ctx.beginPath();
  ctx.arc(cx + 0.1 * sx, panelY, 0.007 * sx, 0, Math.PI * 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 유리 상판 (인덕션이 원점에 놓인 장면 기준) */
const glassSurface = {
  name: "induction-glass",
  heightAt: (x: number, z: number) =>
    Math.abs(x) <= COOKTOP.width / 2 && Math.abs(z) <= COOKTOP.depth / 2 ? COOKTOP.topY : null,
};

export function InductionCooktop(props: ThreeElements["group"]) {
  const print = useMemo(() => createGlassPrintTexture(), []);
  useSupportSurface(glassSurface);
  useEffect(() => () => print.dispose(), [print]);

  // 상판은 위쪽 면에만 인쇄가 보이도록 평면을 따로 둔다
  return (
    <group name="induction-cooktop" {...props}>
      <RoundedBox
        args={[COOKTOP.width, COOKTOP.bodyHeight, COOKTOP.depth]}
        radius={0.01}
        smoothness={6}
        position-y={COOKTOP.bodyHeight / 2}
        castShadow
        receiveShadow
      >
        {/* 측면 본체: 클리어코트 대신 약간 낮은 거칠기로 같은 광택 (Standard 셰이더가 더 가볍다) */}
        <meshStandardMaterial color="#1c1c1e" roughness={0.3} metalness={0.2} />
      </RoundedBox>
      <RoundedBox
        args={[COOKTOP.width - 0.004, COOKTOP.glass, COOKTOP.depth - 0.004]}
        radius={0.002}
        smoothness={4}
        position-y={COOKTOP.bodyHeight + COOKTOP.glass / 2}
        receiveShadow
      >
        {/* 유리 두께면: 윗면은 인쇄 평면이 덮으므로 테두리만 보인다 */}
        <meshStandardMaterial color="#060607" roughness={0.06} metalness={0} />
      </RoundedBox>
      <mesh
        rotation-x={-Math.PI / 2}
        position-y={COOKTOP.topY + 0.00005}
        receiveShadow
      >
        <planeGeometry args={[COOKTOP.width - 0.01, COOKTOP.depth - 0.01]} />
        {isOff("reflector") ? (
          <meshPhysicalMaterial map={print} roughness={0.05} clearcoat={1} clearcoatRoughness={0.03} />
        ) : (
          // 세라믹 글라스: 위에 놓인 팬이 은은하게 비친다
            <MeshReflectorMaterial
              map={print}
              roughness={0.08}
              metalness={0}
              resolution={512}
              mirror={0.75}
              mixStrength={1.5}
              mixBlur={0.15}
              blur={[16, 8]}
              depthScale={0}
            />
        )}
      </mesh>
    </group>
  );
}
