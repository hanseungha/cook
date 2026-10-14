import { create } from "zustand";

/** 계란 껍데기 상태. 전이는 사용자 조작(부딪힘·드래그·놓기)으로만 일어난다 */
export type EggShellState = "INTACT" | "CRACKED" | "OPENED";

/** 조작 규칙 */
export const SHELL_RULES = {
  /** 이보다 약한 충격은 금이 가지 않는다 (m/s, 테두리 쪽으로 다가가던 속도) */
  minImpactSpeed: 0.15,
  /** 이 속도 이상이면 한 번에 둘레 한 바퀴 금이 간다 */
  fullCrackSpeed: 0.55,
  /** 한 번 부딪힌 뒤 같은 충돌의 떨림을 다시 세지 않는 시간 (ms) */
  impactCooldown: 120,
  /** 부딪힌 직후의 움직임은 "벌리기" 드래그로 치지 않는다 (ms) */
  openDelay: 150,
  /** 벌리기 시작 전 무시하는 드래그 거리 (m) */
  openDeadZone: 0.01,
  /** 이만큼 더 드래그하면 완전히 벌어진다 (m) */
  openDistance: 0.06,
} as const;

type ShellData = {
  state: EggShellState;
  /** 누적 균열 0 ~ 1 (1 = 둘레 한 바퀴, 벌릴 수 있음) */
  crack: number;
  /** 첫 충격 지점의 둘레 좌표 (φ / 2π) */
  impactU: number | null;
  impacts: number;
  lastImpactAt: number;
  /** 금이 다 간 뒤 누적한 드래그 거리 (m) */
  openDrag: number;
  /** 벌어진 정도 0 ~ 1 */
  open: number;
  /** 다 벌어진 껍데기를 놓음 (빈 껍데기 반쪽이 떨어짐) */
  discarded: boolean;
  /** 상태 전이 기록 (검증·디버그용) */
  history: Array<{ from: EggShellState; to: EggShellState; cause: string; at: number }>;
};

type ShellActions = {
  /** 테두리 등에 부딪힘 */
  impact: (speed: number, impactU: number, now?: number) => void;
  /** 잡은 채 드래그 */
  drag: (distance: number, touching: boolean, now?: number) => void;
  /** 손에서 놓음 */
  release: () => void;
  reset: () => void;
};

const initial: ShellData = {
  state: "INTACT",
  crack: 0,
  impactU: null,
  impacts: 0,
  lastImpactAt: -Infinity,
  openDrag: 0,
  open: 0,
  discarded: false,
  history: [],
};

/** 충격 속도 → 이번 충격으로 더해지는 균열 (0 ~ 1) */
export function crackFromImpact(speed: number) {
  const { minImpactSpeed: lo, fullCrackSpeed: hi } = SHELL_RULES;
  return Math.min(1, Math.max(0, (speed - lo) / (hi - lo)));
}

export const useEggShellStore = create<ShellData & ShellActions>()((set, get) => {
  const transition = (to: EggShellState, cause: string, at: number) => {
    const { state, history } = get();
    return { state: to, history: [...history, { from: state, to, cause, at }] };
  };

  return {
    ...initial,

    impact(speed, impactU, now = performance.now()) {
      const s = get();
      if (s.state === "OPENED" || now - s.lastImpactAt < SHELL_RULES.impactCooldown) return;
      const added = crackFromImpact(speed);
      if (added <= 0) return;
      set({
        crack: Math.min(1, s.crack + added),
        impactU: s.impactU ?? impactU,
        impacts: s.impacts + 1,
        lastImpactAt: now,
        ...(s.state === "INTACT" ? transition("CRACKED", `impact ${speed.toFixed(2)} m/s`, now) : {}),
      });
    },

    drag(distance, touching, now = performance.now()) {
      const s = get();
      if (s.state !== "CRACKED" || s.crack < 1 || touching) return;
      if (now - s.lastImpactAt < SHELL_RULES.openDelay) return;
      const openDrag = s.openDrag + distance;
      const open = Math.min(1, Math.max(0, (openDrag - SHELL_RULES.openDeadZone) / SHELL_RULES.openDistance));
      set({ openDrag, open, ...(open >= 1 ? transition("OPENED", "drag apart", now) : {}) });
    },

    release() {
      const s = get();
      // 덜 벌린 채 놓으면 다시 맞물린다 (금은 남음)
      if (s.state === "CRACKED") set({ openDrag: 0, open: 0 });
      else if (s.state === "OPENED") set({ discarded: true });
    },

    reset: () => set(initial),
  };
});
