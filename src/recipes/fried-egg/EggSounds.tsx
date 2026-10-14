"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { installAudioUnlock, onAudioReady } from "@/engine/audio/audioEngine";
import { Sizzle, playCrackle, playKnock, playSplat, soundBank } from "@/engine/audio/proceduralSounds";
import { heatAt } from "@/engine/cooking/heatSources";
import { supportHeightAt } from "@/engine/interaction/supportSurfaces";
import { useEggContentsStore } from "./eggContentsStore";
import { useEggCookingStore } from "./eggCookingStore";
import { useEggShellStore } from "./eggShellStore";

/**
 * 계란프라이의 소리 연출: 조작·조리 상태 → 절차적 효과음.
 * 모든 소리는 원인이 일어난 그 프레임에 바로 낸다 (충돌 콜백, 상태 변화 구독, 착지 콜백).
 *
 * - 테두리에 부딪힘: 세기에 비례한 "톡" (금이 가지 않는 약한 충돌도 소리는 난다)
 * - 금이 감: 이번 충격으로 늘어난 균열만큼 "바삭"
 * - 벌림: 안쪽 막이 찢어지는 젖은 소리가 벌어지는 만큼 조금씩, 다 벌어지는 순간 "뚝"
 * - 흰자 착지: 처음 닿는 덩어리에 옅은 젖은 소리 + "치익" (저음 "퉁" 없음), 이어지는 줄기는 지글거림만 키움
 * - 노른자 착지: 흰자 위에 얹혀 거의 들리지 않게
 * - 지글거림: 열을 받는 흰자 면적 × 아직 날것인 비율(물기) → 세기, 노릇해질수록 기름 튀는 소리가 잦아짐
 */
export const eggSoundCues = {
  /** Grabbable 충돌 콜백에서 호출 */
  impact(speed: number) {
    // 테두리에 닿은 채 미끄러지면 충돌 콜백이 연달아 온다 → 새로 부딪힌 것(잠깐 떨어졌다 다시, 또는 더 세게)만 소리
    const now = performance.now();
    if (now - knock.lastAt < 220 && speed < knock.lastSpeed * 1.6) {
      knock.lastAt = now;
      return;
    }
    knock.lastAt = now;
    knock.lastSpeed = speed;
    if (speed < 0.05) return;
    playKnock(Math.min(1, speed / 0.6));
  },
  /** EggContents 착지 콜백에서 호출 */
  land(e: { kind: "white" | "yolk"; volume: number; x: number; z: number; speed: number }) {
    const hot = heatAt(e.x, supportHeightAt(e.x, e.z), e.z) * useEggCookingStore.getState().heat;
    if (e.kind === "yolk") {
      // 노른자는 먼저 깔린 흰자 위에 얹히듯 떨어진다 → 거의 들리지 않는 젖은 소리
      playSplat(0.08, 0, "plop");
      return;
    }
    landing.volume += e.volume;
    landing.hot = Math.max(landing.hot, hot);
    landing.boost = Math.min(1, landing.boost + (e.volume / 1.2e-5) * Math.min(1, hot * 1.5));
  },
};

const knock = { lastAt: -Infinity, lastSpeed: 0 };

/** 같은 프레임에 여러 알갱이가 닿으면 한 소리로 묶는다 */
const landing = { volume: 0, hot: 0, boost: 0, lastAt: -Infinity, splatAt: -Infinity };

const SIZZLE = {
  /** 이 면적(m²)의 흰자가 뜨거운 팬에 닿아 있으면 최대 세기 */
  fullArea: 0.009,
  /** 다 익은 뒤에도 기름 속에서 계속 나는 지글거림 비율 */
  settled: 0.32,
};

export function EggSounds() {
  const sizzle = useRef<Sizzle | null>(null);

  useEffect(() => {
    installAudioUnlock();
    if (process.env.NODE_ENV === "development") (window as { __cookSizzle?: unknown }).__cookSizzle = sizzleLevel;
    const s = new Sizzle();
    sizzle.current = s;
    // 지글거림·치익 소리는 오디오가 켜지면 바로 워커에서 합성을 시작한다
    const off = onAudioReady((e) => {
      soundBank(e.ctx);
    });
    return () => {
      off();
      s.dispose();
    };
  }, []);

  useEffect(
    () =>
      useEggShellStore.subscribe((s, prev) => {
        if (s.crack > prev.crack) {
          const added = s.crack - prev.crack;
          playCrackle(0.25 + added * 0.75, 0.06 + added * 0.12);
        }
        if (s.state === "OPENED" && prev.state !== "OPENED") {
          playCrackle(0.6, 0.14, 0.7);
          tear.last = 1;
        } else if (s.open > tear.last + 0.14) {
          // 벌어지는 동안 안쪽 막이 조금씩 찢어진다
          playCrackle(0.2 + s.open * 0.3, 0.05, 1);
          tear.last = s.open;
        } else if (s.open < tear.last) {
          tear.last = s.open;
        }
      }),
    [],
  );

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    // 착지 소리: 같은 프레임의 착지를 하나로 묶고, 덩어리째 떨어진 경우만 "철퍽".
    // 줄기가 이어져 조금씩 내려앉는 것은 소리를 따로 내지 않고 지글거림만 키운다 (뚝뚝 떨어지는 소리처럼 들리지 않게)
    const now = performance.now();
    // 흰자는 콧물처럼 한 줄기로 이어져 떨어진다 → "치익"은 처음 덩어리가 닿을 때 한 번, 그 뒤 이어지는 덩어리는 지글거림만 키운다
    if (landing.volume > 0 && (landing.volume > 2.5e-6 || now - landing.lastAt > 90)) {
      if (landing.volume > 2.5e-6 && now - landing.splatAt > 1500) {
        playSplat(Math.min(1, landing.volume / 1.2e-5), landing.hot);
        landing.splatAt = now;
      }
      landing.volume = 0;
      landing.hot = 0;
      landing.lastAt = now;
    }
    landing.boost *= Math.exp(-dt / 0.6);

    const s = sizzle.current;
    if (!s) return;
    const cooking = useEggCookingStore.getState();
    const contents = useEggContentsStore.getState();
    const area = Math.min(1.2, contents.heatedArea / SIZZLE.fullArea);
    // 물기 많은 날흰자가 가장 요란하고, 익어 갈수록 잦아들어 기름 속 잔잔한 지글거림으로
    const moisture = SIZZLE.settled + (1 - SIZZLE.settled) * contents.raw;
    const level = cooking.heating ? Math.min(1, area * moisture * cooking.heat * 0.85 + landing.boost * 0.5) : 0;
    // 노릇해질수록 가장자리에서 기름이 톡톡 튄다
    const pops = 1.5 + 5 * contents.brown + 2 * contents.raw;
    s.update(level, pops, dt);
    sizzleLevel.value = level;
  });

  return null;
}

const tear = { last: 0 };

/** 현재 지글거림 세기 (시각 효과가 같은 값을 쓴다: 소리와 김·기포가 함께 움직이게) */
export const sizzleLevel = { value: 0 };
