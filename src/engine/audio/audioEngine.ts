/**
 * 공통 오디오 엔진 (Web Audio).
 * - 브라우저 자동재생 정책: 조작 전에 만든 AudioContext는 멈춘(suspended) 상태로 시작하고, 첫 사용자 조작에서 재개한다.
 *   생성자가 오디오 장치를 여느라 메인 스레드를 100ms 넘게 막으므로, 장면을 불러오는 동안 미리 만든다(prepareAudio)
 * - 모든 소리는 master → 리미터(compressor) → 출력. 큰 충격이 겹쳐도 찢어지지 않게
 * - 재생 기록(log): 언제(performance.now / ctx 시각) 어떤 소리를 냈는지 → 조작과 소리의 동기화 검증
 */
export type SoundLogEntry = { name: string; at: number; ctxTime: number; params?: Record<string, number> };

type Engine = {
  ctx: AudioContext;
  /** 소리가 연결될 입력 */
  out: GainNode;
  /** 출력 레벨 측정 (검증·디버그) */
  analyser: AnalyserNode;
};

let engine: Engine | null = null;
const log: SoundLogEntry[] = [];
const listeners = new Set<(e: Engine) => void>();

function create(): Engine | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const out = ctx.createGain();
  // 전체 음량: 배경에 은은하게 깔리는 정도 (예전 0.9 → 약 -7dB)
  out.gain.value = 0.4;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  out.connect(limiter).connect(analyser).connect(ctx.destination);
  return { ctx, out, analyser };
}

/** 재생 가능한 엔진. 아직 사용자 조작 전(멈춤)이면 null → 소리를 내지 않는다 */
export function getAudio() {
  return engine && engine.ctx.state === "running" ? engine : null;
}

/** 엔진을 미리 만든다 (멈춘 상태). 장면 준비 중 유휴 시간에 부르면 첫 조작 때 끊김이 없다 */
export function prepareAudio() {
  if (engine) return engine;
  engine = create();
  if (!engine) return null;
  for (const l of listeners) l(engine);
  if (process.env.NODE_ENV === "development") {
    (window as { __cookAudio?: unknown }).__cookAudio = { engine, log };
  }
  return engine;
}

/** 사용자 조작 시점에 호출: (없으면 만들고) 재개 */
export function unlockAudio() {
  const e = prepareAudio();
  if (e && e.ctx.state === "suspended") void e.ctx.resume();
}

/** 엔진이 준비되면 호출 (이미 준비됐으면 바로) */
export function onAudioReady(fn: (e: Engine) => void) {
  if (engine) fn(engine);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 첫 사용자 조작에서 오디오를 켠다 (한 번만 설치) */
let installed = false;
export function installAudioUnlock() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => prepareAudio(), { timeout: 3000 });
  const unlock = () => unlockAudio();
  for (const type of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(type, unlock, { capture: true });
}

export function logSound(name: string, params?: Record<string, number>) {
  const e = getAudio();
  log.push({ name, at: performance.now(), ctxTime: e ? e.ctx.currentTime : -1, params });
  if (log.length > 500) log.shift();
}
