"use client";

import { Canvas } from "@react-three/fiber";
import { StatsGl } from "@react-three/drei";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { budgetedDpr, renderConfig, type CameraRig } from "./renderConfig";
import { StudioLighting } from "./StudioLighting";
import { FixedCamera } from "./FixedCamera";
import { StaticShadows } from "./StaticShadows";
import { AdaptiveQuality } from "./AdaptiveQuality";
import { RenderProbe, SceneReadyProbe } from "../debug/RenderProbe";
import { isOff } from "../debug/profileFlags";

type StageProps = {
  children?: ReactNode;
  camera: CameraRig;
  /** FPS/GPU 시간 오버레이 표시 (?perf) */
  showPerf?: boolean;
};

/**
 * 모든 요리 콘텐츠가 공유하는 렌더링 루트.
 * 렌더러 설정, 조명, 성능 적응만 담당하고 장면 내용은 children으로 받는다.
 */
export function Stage({ children, camera, showPerf = false }: StageProps) {
  const container = useRef<HTMLDivElement>(null);
  useBlockPageZoom(container);
  const maxDpr = useBudgetedDpr();
  // 프레임 시간이 계속 길면 DPR을 단계적으로 낮춘다 (1.0 ~ 예산 상한 사이), 여유가 생기면 되돌린다
  const [qualityFactor, setQualityFactor] = useState(1);
  const dpr = 1 + (maxDpr - 1) * qualityFactor;

  return (
    <div ref={container} className="h-full w-full">
      <Canvas
        shadows={
          isOff("shadows") ? false : { type: renderConfig.shadowMapType }
        }
        dpr={dpr}
        camera={{ fov: camera.fov, near: 0.05, far: 10 }}
        gl={{
          antialias: !isOff("msaa"),
          powerPreference: "high-performance",
          toneMapping: renderConfig.toneMapping,
          toneMappingExposure: renderConfig.toneMappingExposure,
          outputColorSpace: renderConfig.outputColorSpace,
        }}
      >
        <color attach="background" args={[renderConfig.background]} />
        <AdaptiveQuality onChange={setQualityFactor} />
        <FixedCamera rig={camera} />
        <Suspense fallback={null}>
          <StudioLighting />
          {children}
          <StaticShadows />
          <SceneReadyProbe />
        </Suspense>
        <RenderProbe />
        {showPerf && <StatsGl className="stats-gl" />}
      </Canvas>
    </div>
  );
}

/** 창 크기에 따라 픽셀 예산 안에서 허용되는 최대 DPR */
function useBudgetedDpr() {
  const [value, setValue] = useState<number>(renderConfig.maxDpr);
  useEffect(() => {
    const update = () =>
      setValue(budgetedDpr(window.innerWidth, window.innerHeight, window.devicePixelRatio));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return value;
}

/**
 * 고정 시점 장면 위에서의 휠/핀치가 브라우저 페이지 확대·스크롤로 새지 않도록 막는다.
 * (트랙패드 핀치 = ctrl+wheel, Safari = gesture* 이벤트)
 */
function useBlockPageZoom(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", prevent, { passive: false });
    el.addEventListener("gesturestart", prevent);
    el.addEventListener("gesturechange", prevent);
    return () => {
      el.removeEventListener("wheel", prevent);
      el.removeEventListener("gesturestart", prevent);
      el.removeEventListener("gesturechange", prevent);
    };
  }, [ref]);
}
