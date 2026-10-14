"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";

/** 그림자 맵을 다시 그려야 하는 남은 프레임 수 (모듈 단위 공유) */
let pendingFrames = 0;

/**
 * 그림자를 다시 계산하도록 요청한다.
 * 그림자를 드리우는 물체가 움직이거나(팬 들기, 기울이기) 새로 생길 때 호출한다.
 */
export function invalidateShadows(frames = 2) {
  pendingFrames = Math.max(pendingFrames, frames);
}

/**
 * 정적 장면용 그림자: 매 프레임 그림자 맵(VSM 블러 포함)을 다시 그리지 않고
 * 요청이 있을 때만 갱신한다. Suspense 안쪽에 두면 장면 로드 직후 한 번 그려진다.
 */
export function StaticShadows() {
  const get = useThree((s) => s.get);

  useEffect(() => {
    const { gl } = get();
    gl.shadowMap.autoUpdate = false;
    invalidateShadows(3); // 텍스처·환경맵이 반영된 뒤까지 몇 프레임 여유
    return () => {
      gl.shadowMap.autoUpdate = true;
    };
  }, [get]);

  useFrame(({ gl }) => {
    if (pendingFrames > 0) {
      gl.shadowMap.needsUpdate = true;
      pendingFrames--;
    }
  });

  return null;
}
