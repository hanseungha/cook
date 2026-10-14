import { useEffect } from "react";

/**
 * 물체를 내려놓을 수 있는 표면. 월드 좌표 (x, z)의 표면 높이를 돌려주고, 영역 밖이면 null.
 * 물리 엔진 대신 형상에서 직접 계산한 높이를 쓰므로 곡면(팬 안쪽)도 정확하고 비용이 거의 없다.
 */
export type SupportSurface = {
  name: string;
  heightAt(x: number, z: number): number | null;
  /**
   * 표면 가장자리(절벽) 아래 옆면: 가장자리 (x, z) 아래 높이 y에서 옆면의 수평 위치.
   * 넘쳐흐른 액체가 옆면을 따라 달라붙어 흘러내릴 자리. 옆면이 수직이거나 해당 없으면 생략/null
   */
  sideAt?(x: number, z: number, y: number): [number, number] | null;
};

const surfaces = new Set<SupportSurface>();

/** 표면 등록. 반환된 함수로 해제 (효과 안에서 ref로 표면을 만들 때) */
export function addSupportSurface(surface: SupportSurface) {
  surfaces.add(surface);
  return () => {
    surfaces.delete(surface);
  };
}

/** 컴포넌트가 마운트된 동안 표면을 등록한다 */
export function useSupportSurface(surface: SupportSurface) {
  useEffect(() => {
    surfaces.add(surface);
    return () => {
      surfaces.delete(surface);
    };
  }, [surface]);
}

/** (x, z)에서 가장 높은 표면의 높이. 등록된 표면이 없으면 0 */
export function supportHeightAt(x: number, z: number) {
  let best = -Infinity;
  for (const s of surfaces) {
    const h = s.heightAt(x, z);
    if (h !== null && h > best) best = h;
  }
  return best === -Infinity ? 0 : best;
}

/** 가장자리 (x, z) 아래 높이 y의 옆면 위치 (해당하는 표면이 없으면 null → 수직 옆면으로 본다) */
export function supportSideAt(x: number, z: number, y: number): [number, number] | null {
  for (const s of surfaces) {
    const p = s.sideAt?.(x, z, y);
    if (p) return p;
  }
  return null;
}

/**
 * 물체 바닥 footprint(반지름 radius)를 고려한 지지 높이.
 * 중심 + 둘레 8점 중 최댓값 → 벽 근처에서 물체가 벽을 파고들지 않는다.
 */
export function footprintSupportHeight(x: number, z: number, radius: number) {
  let h = supportHeightAt(x, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    h = Math.max(h, supportHeightAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius));
  }
  return h;
}
