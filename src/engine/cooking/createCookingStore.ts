import { createStore } from "zustand/vanilla";

/**
 * 조리 단계 상태의 공통 형태.
 * 각 레시피(src/recipes/*)가 자신의 단계(TStep)와 음식 상태(TFood)를 정의해 사용한다.
 * 렌더링/인터랙션 코드는 이 스토어를 구독만 하고 조리 규칙은 알지 못한다.
 */
export type CookingState<TStep extends string, TFood> = {
  step: TStep;
  /** 레시피 시작 후 경과한 조리 시간(초). 프레임 루프에서 누적한다. */
  elapsed: number;
  food: TFood;
  setStep: (step: TStep) => void;
  advance: (dt: number) => void;
  updateFood: (patch: Partial<TFood>) => void;
  reset: () => void;
};

export function createCookingStore<TStep extends string, TFood extends object>(
  initialStep: TStep,
  initialFood: TFood,
) {
  return createStore<CookingState<TStep, TFood>>()((set) => ({
    step: initialStep,
    elapsed: 0,
    food: initialFood,
    setStep: (step) => set({ step }),
    advance: (dt) => set((s) => ({ elapsed: s.elapsed + dt })),
    updateFood: (patch) => set((s) => ({ food: { ...s.food, ...patch } })),
    reset: () => set({ step: initialStep, elapsed: 0, food: initialFood }),
  }));
}
