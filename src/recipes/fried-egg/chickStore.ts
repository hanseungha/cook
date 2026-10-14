import { create } from "zustand";

/** 계란을 깼을 때 병아리가 나올 확률 */
export const CHICK_CHANCE = 0.1;

/**
 * 깜짝 연출: 가끔 계란 속에 흰자·노른자 대신 병아리가 들어 있다.
 * 계란마다 처음에 한 번 정한다. 껍데기가 벌어지면 튀어나와 화면 밖으로 달아난다.
 * - none: 보통 계란 / inEgg: 병아리가 든 계란 / out: 나와서 달아나는 중 / gone: 화면 밖으로 사라짐
 */
export type ChickPhase = "none" | "inEgg" | "out" | "gone";

type ChickData = { phase: ChickPhase };
type ChickActions = {
  /** 이 계란에 병아리가 들었는지 정한다. forced가 있으면 확률 대신 그 값 */
  roll: (forced?: boolean) => void;
  hatch: () => void;
  leave: () => void;
};

export const useChickStore = create<ChickData & ChickActions>()((set, get) => ({
  phase: "none",
  roll(forced) {
    const chick = forced ?? Math.random() < CHICK_CHANCE;
    set({ phase: chick ? "inEgg" : "none" });
  },
  hatch() {
    if (get().phase === "inEgg") set({ phase: "out" });
  },
  leave() {
    if (get().phase === "out") set({ phase: "gone" });
  },
}));
