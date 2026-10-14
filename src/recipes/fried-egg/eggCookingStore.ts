import { createCookingProgress } from "@/engine/cooking/cookingProgress";

/**
 * 계란프라이 조리 진행도 (CookingProgress 0 ~ 1).
 * 흰자가 달군 팬에 닿는 순간(쏟아지기 시작) 가열이 시작되고, 센 불 기준 약 45초에 다 익는다.
 * 위치별 익힘(가장자리부터, 얇은 곳부터)은 재료 쪽 ThermalField가 이 값의 증가분으로 계산한다.
 */
export const useEggCookingStore = createCookingProgress({ duration: 45 });
