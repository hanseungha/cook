import { create } from "zustand";

export type GrabPhase = "rest" | "held" | "falling";

type GrabState = {
  /** 현재 잡고 있는 물체 id (한 번에 하나) */
  grabbedId: string | null;
  hoveredId: string | null;
  /** 물체별 상태 — 조리 로직(예: 계란이 팬 위에 놓였는지)이 구독한다 */
  objects: Record<string, { phase: GrabPhase; position: [number, number, number] }>;
  setGrabbed: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  report: (id: string, phase: GrabPhase, position: [number, number, number]) => void;
};

export const useGrabStore = create<GrabState>()((set) => ({
  grabbedId: null,
  hoveredId: null,
  objects: {},
  setGrabbed: (grabbedId) => set({ grabbedId }),
  setHovered: (hoveredId) => set({ hoveredId }),
  report: (id, phase, position) =>
    set((s) => ({ objects: { ...s.objects, [id]: { phase, position } } })),
}));
