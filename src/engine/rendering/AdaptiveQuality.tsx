"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";

/**
 * 프레임 시간이 계속 길 때만 화질(DPR)을 낮추고, 다시 여유가 생기면 천천히 되돌린다.
 *
 * 1초 구간마다 프레임 간격의 중앙값을 본다 (한두 번의 끊김 — GC, 탭 전환, 스크린샷 — 에는 반응하지 않음).
 * - 중앙값이 화면 주사율 간격의 1.25배를 넘고 초당 48프레임에 못 미치는 구간이 3번 이어지면 → 한 단계 낮춤
 * - 주사율을 지키는 구간이 10번 이어지면 → 한 단계 올림
 * (drei PerformanceMonitor는 이미 최고 화질에서 "올림"도 뒤집힘으로 세어 몇 초 뒤 최저 화질로 떨어뜨린다)
 */
export function AdaptiveQuality({
  onChange,
  step = 0.25,
}: {
  /** 화질 0 (최저) ~ 1 (최고) */
  onChange: (quality: number) => void;
  step?: number;
}) {
  const s = useRef({
    quality: 1,
    windowStart: -1,
    last: -1,
    times: [] as number[],
    /** 지금까지 본 가장 짧은 구간 중앙값 = 화면 주사율 간격 */
    refresh: Infinity,
    slow: 0,
    good: 0,
  });

  useFrame(() => {
    const a = s.current;
    const now = performance.now();
    if (a.last < 0 || document.hidden) {
      a.last = now;
      a.windowStart = now;
      a.times.length = 0;
      return;
    }
    const dt = now - a.last;
    a.last = now;
    // 화면이 멈췄다 돌아온 경우(탭 전환 등)는 구간을 버린다
    if (dt > 250) {
      a.windowStart = now;
      a.times.length = 0;
      return;
    }
    a.times.push(dt);
    if (now - a.windowStart < 1000) return;
    const sorted = a.times.sort((x, y) => x - y);
    const median = sorted[sorted.length >> 1];
    a.times.length = 0;
    a.windowStart = now;
    a.refresh = Math.min(a.refresh, median);

    // 느림: 주사율 간격의 1.25배 이상이면서 초당 48프레임 아래 (주사율 제한 없는 환경에서도 과민하지 않게)
    if (median > a.refresh * 1.25 && median > 1000 / 48) {
      a.slow++;
      a.good = 0;
    } else {
      a.good++;
      a.slow = 0;
    }
    let next = a.quality;
    if (a.slow >= 3 && a.quality > 0) {
      next = Math.max(0, a.quality - step);
      a.slow = 0;
    } else if (a.good >= 10 && a.quality < 1) {
      next = Math.min(1, a.quality + step);
      a.good = 0;
    }
    if (next !== a.quality) {
      a.quality = next;
      onChange(next);
    }
  });

  return null;
}
