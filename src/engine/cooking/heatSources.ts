/**
 * 열원 레지스트리 (지지 표면 레지스트리와 같은 방식).
 * 조리도구가 "어디가 얼마나 뜨거운지"를 등록하면, 음식은 자기 위치의 열 세기만 물어본다
 * → 음식은 팬·그릴·오븐을 모르고, 조리도구는 음식을 모른다.
 */
export type HeatSource = {
  name: string;
  /** 월드 좌표의 상대 열 세기 0 ~ 1 (닿아 있지 않으면 0) */
  heatAt(x: number, y: number, z: number): number;
};

const sources = new Set<HeatSource>();

export function addHeatSource(source: HeatSource) {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** 가장 뜨거운 열원의 세기 */
export function heatAt(x: number, y: number, z: number) {
  let best = 0;
  for (const s of sources) best = Math.max(best, s.heatAt(x, y, z));
  return best;
}
