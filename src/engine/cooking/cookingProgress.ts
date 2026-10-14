import { useFrame } from "@react-three/fiber";
import { create, type StoreApi, type UseBoundStore } from "zustand";

/**
 * 조리 진행도 (CookingProgress) 0 ~ 1.
 * 시간이 흐르며 열 세기(heat)에 비례해 증가한다. 음식의 위치별 익힘 정도는 이 값의 증가분을
 * 열 분포·두께에 따라 나눠 받는 `ThermalField`가 계산하고, 렌더링은 그 결과만 셰이더에 넘긴다.
 *   진행도(상태) → ThermalField(위치별 익힘) → 셰이더(표현)
 */
export type CookingProgressState = {
  progress: number;
  heating: boolean;
  /** 열 세기 1에서 진행도가 0 → 1이 되는 시간 (초) */
  duration: number;
  /** 열 세기 배율 (불 조절) */
  heat: number;
  startHeating: () => void;
  stopHeating: () => void;
  setHeat: (heat: number) => void;
  /** 프레임 루프에서 호출 */
  tick: (dt: number) => void;
  /** 디버그·검증: 진행도를 직접 지정 (위치별 익힘은 증가분만큼 한 번에 적용된다) */
  setProgress: (progress: number) => void;
  reset: () => void;
};

export type CookingProgressStore = UseBoundStore<StoreApi<CookingProgressState>>;

export function createCookingProgress({ duration }: { duration: number }): CookingProgressStore {
  const initial = { progress: 0, heating: false, duration, heat: 1 };
  return create<CookingProgressState>()((set, get) => ({
    ...initial,
    startHeating: () => set({ heating: true }),
    stopHeating: () => set({ heating: false }),
    setHeat: (heat) => set({ heat: Math.max(0, heat) }),
    tick(dt) {
      const s = get();
      if (!s.heating || s.progress >= 1) return;
      set({ progress: Math.min(1, s.progress + (dt * s.heat) / s.duration) });
    },
    setProgress: (progress) => set({ progress: Math.min(1, Math.max(0, progress)) }),
    reset: () => set(initial),
  }));
}

/** 가열 중인 동안 매 프레임 진행도를 증가시킨다 */
export function useCookingClock(store: CookingProgressStore) {
  useFrame((_, dt) => store.getState().tick(Math.min(dt, 1 / 20)));
}
