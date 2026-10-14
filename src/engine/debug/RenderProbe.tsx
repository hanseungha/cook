"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import * as THREE from "three";
import { useGrabStore } from "../interaction/grabStore";

export type RenderProbeState = {
  ready: boolean;
  frames: number;
  webglVersion: 1 | 2;
  renderer: string;
  toneMapping: number;
  /** 컴파일된 셰이더 프로그램 목록 (이름:캐시키 앞부분) */
  programNames?: () => string[];
  /** Suspense가 풀린 뒤(HDRI·에셋 로드 완료) 렌더된 프레임 수 */
  sceneReadyFrames?: number;
  /** 최근 프레임의 렌더러 통계 (드로우콜, 삼각형, 텍스처/프로그램 수) */
  info?: {
    calls: number;
    triangles: number;
    textures: number;
    geometries: number;
    programs: number;
    dpr: number;
    camera: [number, number, number];
  };
};

declare global {
  interface Window {
    __cook?: RenderProbeState;
    /** 개발 모드 전용: 콘솔/테스트에서 씬 그래프 검사 */
    __cookScene?: unknown;
    /** 개발 모드 전용: 이름으로 찾은 물체의 화면(CSS px) 좌표 */
    __cookProject?: (name: string, offset?: [number, number, number]) => [number, number] | null;
    /** 개발 모드 전용: grab 상태 스토어 */
    __cookGrab?: unknown;
  }
}

/**
 * 렌더 루프 상태를 window.__cook 으로 노출한다.
 * Playwright가 WebGL 초기화와 프레임 진행을 검증하는 데 사용한다.
 */
export function RenderProbe() {
  const get = useThree((s) => s.get);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    window.__cookScene = scene;
    window.__cookGrab = useGrabStore;
    window.__cookProject = (name, offset = [0, 0, 0]) => {
      const { camera, size } = get();
      const obj = scene.getObjectByName(name);
      if (!obj) return null;
      const p = obj.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...offset));
      p.project(camera);
      return [((p.x + 1) / 2) * size.width + size.left, ((1 - p.y) / 2) * size.height + size.top];
    };
    return () => {
      delete window.__cookScene;
      delete window.__cookProject;
      delete window.__cookGrab;
    };
  }, [scene, get]);

  useEffect(() => {
    const { gl } = get();
    // 한 프레임 안의 모든 패스(그림자, 반사, 메인)를 합산하도록 수동 리셋
    gl.info.autoReset = false;
    const ctx = gl.getContext();
    window.__cook = {
      ready: true,
      frames: 0,
      webglVersion: typeof WebGL2RenderingContext !== "undefined" &&
        ctx instanceof WebGL2RenderingContext ? 2 : 1,
      renderer: String(ctx.getParameter(ctx.RENDERER)),
      toneMapping: gl.toneMapping,
      // 컴파일된 셰이더 프로그램 이름 (도중에 새로 컴파일되어 끊기는지 확인)
      programNames: () => (gl.info.programs ?? []).map((p) => `${p.name}:${p.cacheKey.slice(0, 60)}`),
    };
    return () => {
      delete window.__cook;
    };
  }, [get]);

  useFrame(({ gl, camera }) => {
    const probe = window.__cook;
    if (!probe) return;
    probe.frames++;
    if (probe.frames % 30 === 0) {
      probe.info = {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        textures: gl.info.memory.textures,
        geometries: gl.info.memory.geometries,
        programs: gl.info.programs?.length ?? 0,
        dpr: gl.getPixelRatio(),
        camera: camera.position.toArray().map((v) => +v.toFixed(4)) as [number, number, number],
      };
    }
    gl.info.reset();
  });

  return null;
}

/** Suspense 경계 안쪽에 두어 실제 장면이 화면에 나온 뒤의 프레임을 센다 */
export function SceneReadyProbe() {
  useFrame(() => {
    const probe = window.__cook;
    if (probe) probe.sceneReadyFrames = (probe.sceneReadyFrames ?? 0) + 1;
  });
  return null;
}
