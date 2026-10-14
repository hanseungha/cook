import { create } from "zustand";

/** 계란 내용물(흰자·노른자) 상태. 껍데기가 벌어지기 시작하면(틈이 생기면) 쏟아지기 시작한다 */
export type EggContentsState = "IN_SHELL" | "POURING" | "IN_PAN";

type ContentsData = {
  state: EggContentsState;
  /** 흘러나온 흰자 비율 0 ~ 1 */
  white: number;
  yolk: "inShell" | "falling" | "landed";
  /** 흰자가 덮은 면적 (m²) */
  area: number;
  /** 열을 받는 흰자 면적 (m²), 그중 날것 비율, 노릇함 0 ~ 1 */
  heatedArea: number;
  raw: number;
  brown: number;
  /** 내용물 중심 (x, z) */
  center: [number, number] | null;
  /** 열을 받는 흰자의 중심 (김이 피어오르는 곳). 열을 받는 흰자가 없으면 null */
  heatCenter: [number, number] | null;
  history: Array<{ from: EggContentsState; to: EggContentsState; at: number }>;
};

type ContentsActions = {
  pour: () => void;
  settle: () => void;
  progress: (p: Omit<ContentsData, "state" | "history">) => void;
  reset: () => void;
};

const initial: ContentsData = { state: "IN_SHELL", white: 0, yolk: "inShell", area: 0, heatedArea: 0, raw: 0, brown: 0, center: null, heatCenter: null, history: [] };

export const useEggContentsStore = create<ContentsData & ContentsActions>()((set, get) => {
  const to = (state: EggContentsState) => ({
    state,
    history: [...get().history, { from: get().state, to: state, at: performance.now() }],
  });
  return {
    ...initial,
    pour() {
      if (get().state === "IN_SHELL") set(to("POURING"));
    },
    settle() {
      if (get().state === "POURING") set(to("IN_PAN"));
    },
    progress(p) {
      const s = get();
      // 매 프레임 호출되므로 의미 있게 바뀐 경우에만 갱신 (구독자 리렌더 방지)
      if (
        s.yolk !== p.yolk ||
        Math.abs(s.white - p.white) > 0.01 ||
        Math.abs(s.area - p.area) > 2e-5 ||
        Math.abs(s.heatedArea - p.heatedArea) > 2e-5 ||
        Math.abs(s.raw - p.raw) > 0.005 ||
        Math.abs(s.brown - p.brown) > 0.005 ||
        !s.center ||
        Math.hypot(s.center[0] - p.center![0], s.center[1] - p.center![1]) > 0.002 ||
        !s.heatCenter !== !p.heatCenter ||
        (s.heatCenter && p.heatCenter && Math.hypot(s.heatCenter[0] - p.heatCenter[0], s.heatCenter[1] - p.heatCenter[1]) > 0.002)
      )
        set(p);
    },
    reset: () => set(initial),
  };
});
