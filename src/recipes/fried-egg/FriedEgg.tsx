"use client";

import { useCallback } from "react";
import type * as THREE from "three";
import type { GrabBounds } from "@/engine/interaction/Grabbable";
import { supportHeightAt } from "@/engine/interaction/supportSurfaces";
import { Steam } from "@/engine/effects/Steam";
import { OilFilm } from "@/ingredients/oil/OilFilm";
import { PAN } from "@/kitchen/cookware/fryingPanGeometry";
import { PAN_ORIGIN } from "@/kitchen/StoveSetup";
import { CrackableEgg } from "./CrackableEgg";
import { useEggContentsStore } from "./eggContentsStore";
import { useEggCookingStore } from "./eggCookingStore";
import { sizzleLevel } from "./EggSounds";

/** 달군 팬의 기름: 계란을 넣기 전에도 미세하게 일렁이고, 조리 중에는 불 세기만큼 */
const PREHEATED = 0.55;

/**
 * 계란프라이 레시피 장면: 기름 두른 팬 + 깨서 부칠 계란 + 김.
 * 김의 세기는 지글거림 소리와 같은 값에서 나온다 (소리와 화면이 함께 움직이게).
 */
export function FriedEgg({ initial, bounds }: { initial: [number, number]; bounds: GrabBounds }) {
  const oilHeat = useCallback(() => {
    const c = useEggCookingStore.getState();
    return c.heating ? Math.min(1, c.heat) : PREHEATED;
  }, []);
  const steamOrigin = useCallback((out: THREE.Vector3) => {
    // 김은 뜨거운 팬에 닿은 흰자에서만 (팬 밖에 흘린 흰자·노른자 위에서는 피어오르지 않는다)
    const center = useEggContentsStore.getState().heatCenter;
    if (!center) return false;
    out.set(center[0], supportHeightAt(center[0], center[1]) + 0.004, center[1]);
    return true;
  }, []);
  // 김: 물기 많은 날흰자가 뜨거운 팬에 닿아 있을 때 가장 많고, 익어 가며 잦아든다
  const steamIntensity = useCallback(() => sizzleLevel.value * (0.3 + 0.7 * useEggContentsStore.getState().raw), []);

  return (
    <>
      <OilFilm
        position={[PAN_ORIGIN[0], PAN_ORIGIN[1] + PAN.floor + 0.00015, PAN_ORIGIN[2]]}
        radius={PAN.flatRadius * 0.98}
        heat={oilHeat}
      />
      <CrackableEgg initial={initial} bounds={bounds} />
      <Steam origin={steamOrigin} radius={0.045} intensity={steamIntensity} />
    </>
  );
}
