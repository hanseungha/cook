"use client";

import { useThree } from "@react-three/fiber";
import { useLayoutEffect } from "react";
import type { PerspectiveCamera } from "three";
import { LAYERS, cameraPosition, fitDistance, type CameraRig } from "./renderConfig";

/**
 * 사용자 조작이 없는 고정 카메라.
 * 캔버스 크기가 바뀔 때마다 rig.frame 영역이 화면에 꼭 맞도록 거리만 다시 계산한다.
 * (가로로 넓은 화면은 높이 기준, 세로 화면은 너비 기준으로 맞춰진다)
 */
export function FixedCamera({ rig }: { rig: CameraRig }) {
  const get = useThree((s) => s.get);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);

  useLayoutEffect(() => {
    const { camera: cam, invalidate } = get();
    const camera = cam as PerspectiveCamera;
    const aspect = width / height;
    camera.layers.enable(LAYERS.noReflection);
    camera.fov = rig.fov;
    camera.aspect = aspect;
    camera.position.set(...cameraPosition(rig, fitDistance(rig, aspect)));
    camera.lookAt(...rig.target);
    camera.updateProjectionMatrix();
    invalidate();
  }, [get, rig, width, height]);

  return null;
}
