/**
 * 성능 프로파일링용 기능 끄기 플래그. 예: /?off=reflector,shadows
 * 벤치마크 스크립트(scripts/bench.mjs)가 기능별 비용을 분리 측정할 때 사용한다.
 */
export type ProfileFeature = "reflector" | "shadows" | "msaa" | "env";

let cached: Set<string> | null = null;

export function isOff(feature: ProfileFeature) {
  if (typeof window === "undefined") return false;
  cached ??= new Set(new URLSearchParams(window.location.search).get("off")?.split(",") ?? []);
  return cached.has(feature);
}
