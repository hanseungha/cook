"use client";

import { BakedContactShadow, ShadowCatcher } from "@/engine/rendering/BakedContactShadow";
import type { ReactNode } from "react";
import type { GrabBounds } from "@/engine/interaction/Grabbable";
import { useSupportSurface } from "@/engine/interaction/supportSurfaces";
import type { CameraRig } from "@/engine/rendering/renderConfig";
import { COOKTOP, InductionCooktop } from "./appliances/InductionCooktop";
import { FryingPan } from "./cookware/FryingPan";

/** 팬 바닥 중심의 월드 좌표 */
export const PAN_ORIGIN: [number, number, number] = [0, COOKTOP.topY, COOKTOP.burnerZ];

/**
 * 팬을 화면 중앙에 두고 45° 위에서 내려다보는 클로즈업.
 * frame: 가로 화면에서는 높이 0.525m(팬 + 인덕션)가 꽉 차고,
 * 세로 화면에서는 팬 지름 + 여백(0.46m)이 너비에 맞춰진다 (손잡이 끝은 잘릴 수 있음).
 */
export const stoveCamera: CameraRig = {
  target: [PAN_ORIGIN[0] + 0.012, PAN_ORIGIN[1] - 0.005, PAN_ORIGIN[2] + 0.025],
  elevationDeg: 45,
  azimuthDeg: -18,
  fov: 30,
  // 세로 화면에서도 인덕션 옆 계란까지 보이도록 너비 0.52 (가로 화면 구도는 높이 기준이라 그대로)
  frame: { width: 0.52, height: 0.525 },
};

/** 재료를 옮길 수 있는 범위 (화면 안, 인덕션 주변) */
export const WORK_AREA: GrabBounds = { minX: -0.3, maxX: 0.4, minZ: -0.22, maxZ: 0.24 };

/** 흰 바닥: 인덕션 밖 어디든 내려놓을 수 있다 */
const floorSurface = { name: "floor", heightAt: () => 0 };

/** 재료의 처음 위치: 인덕션 왼쪽 앞 바닥 (x, z) */
export const INGREDIENT_SPOT: [number, number] = [-0.215, 0.1];

/** 인덕션 위에 놓인 프라이팬. 흰 배경 위 제품 촬영 구도. 재료는 children으로 받는다. */
export function StoveSetup({ children }: { children?: ReactNode }) {
  useSupportSurface(floorSurface);

  return (
    <group>
      <InductionCooktop />
      <FryingPan position={PAN_ORIGIN} rotation-y={-0.35} />
      <ShadowCatcher />
      <BakedContactShadow size={[COOKTOP.width, COOKTOP.depth]} radius={0.01} spread={0.05} opacity={1} />
      {children}
    </group>
  );
}
