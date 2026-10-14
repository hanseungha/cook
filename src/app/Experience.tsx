"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { LookDevCalibration, lookDevCamera } from "@/engine/debug/LookDevCalibration";
import { INGREDIENT_SPOT, StoveSetup, WORK_AREA, stoveCamera } from "@/kitchen/StoveSetup";
import { FriedEgg } from "@/recipes/fried-egg/FriedEgg";
import { loadPanTextures } from "@/kitchen/textures/proceduralTextures";
import { loadEggTextures } from "@/ingredients/egg/eggTextures";

// HDRI 다운로드·WebGL 초기화와 병렬로 텍스처 생성을 바로 시작한다
if (typeof window !== "undefined") {
  void loadPanTextures();
  void loadEggTextures();
}

// WebGL은 브라우저에서만 초기화한다
const Stage = dynamic(
  () => import("@/engine/rendering/Stage").then((m) => m.Stage),
  { ssr: false },
);

export function Experience() {
  const params = useSearchParams();
  const lookdev = params.has("lookdev");

  return (
    <Stage camera={lookdev ? lookDevCamera : stoveCamera} showPerf={params.has("perf")}>
      {lookdev ? (
        <LookDevCalibration />
      ) : (
        <StoveSetup>
          <FriedEgg initial={INGREDIENT_SPOT} bounds={WORK_AREA} />
        </StoveSetup>
      )}
    </Stage>
  );
}
