import { getAudio, logSound } from "./audioEngine";
import { addClick, addMode, lowpass } from "./synth";

/**
 * 절차적 효과음 (녹음 파일 없이 샘플을 직접 합성).
 * 충격 세기·조리 상태에 따라 매번 다르게 만들 수 있고, 같은 소리가 반복되는 기계적인 느낌이 없다.
 * 모두 음식과 무관한 재료(두드림, 바삭한 균열, 젖은 착지, 지글거림)로 만들고, 레시피가 조합한다.
 *
 * 합성 원리
 * - 단단한 것끼리 부딪힘: 아주 짧은 잡음 펄스(접촉) + 감쇠하는 공진(물체 고유 진동)
 * - 바삭하게 깨짐: 짧은 딸깍 소리 수십 개가 불규칙한 간격으로 (앞쪽에 몰려) 이어짐
 * - 지글거림: 기름 속 물기가 터지는 미세한 펄스 수천 개/초 + 가끔 크게 튀는 소리
 */

const rand = Math.random;

function play(name: string, seconds: number, fill: (data: Float32Array, sr: number) => void, gain: number, params?: Record<string, number>) {
  const e = getAudio();
  logSound(name, params);
  if (!e) return;
  const sr = e.ctx.sampleRate;
  const buffer = e.ctx.createBuffer(1, Math.ceil(seconds * sr), sr);
  const data = buffer.getChannelData(0);
  fill(data, sr);
  const src = e.ctx.createBufferSource();
  src.buffer = buffer;
  const g = e.ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(e.out);
  src.start();
}

/**
 * 껍데기가 팬 테두리에 부딪히는 "톡" 소리. strength 0 ~ 1.
 * 속이 액체로 찬 계란은 부딪힌 진동을 금세 삼키고, 무른 물체가 친 팬은 거의 울리지 않는다
 * → 맑게 이어지는 음(공진)은 몇 ms 안에 사라지는 둔탁한 접촉음이 대부분이다.
 * 구성: 짧은 잡음 접촉(중역, 고역은 눌러서) + 몇 ms짜리 껍데기 울림 + 낮은 몸통 "툭" + 아주 짧게 막힌 팬 소리
 */
export function playKnock(strength: number, ring: number[] = [880, 2170]) {
  const s = Math.min(1, Math.max(0.05, strength));
  play(
    "knock",
    0.12,
    (d, sr) => {
      // 접촉: 짧은 잡음 펄스 (밝은 딸깍이 아니라 껍데기끼리 맞닿는 탁한 소리)
      addClick(d, sr, 0, 0.9, 0.0012);
      // 껍데기 울림: 액체가 받쳐 곧바로 죽는다 (2~3ms)
      addMode(d, sr, 0, 1250 + rand() * 300, 0.0025, 0.35);
      addMode(d, sr, 0, 2300 + rand() * 400, 0.0015, 0.15);
      // 계란 몸통의 둔탁한 "툭"
      const body = new Float32Array(d.length);
      addClick(body, sr, 0, 1.4, 0.01);
      lowpass(body, sr, 450);
      for (let i = 0; i < d.length; i++) d[i] += body[i];
      // 팬 테두리: 무른 계란이 쳐서 울림이 바로 막힌다 (종소리처럼 남지 않게 수십 ms)
      ring.forEach((f, i) => addMode(d, sr, 0, f * (1 + (rand() - 0.5) * 0.02), 0.02 / (1 + i), 0.025 * s));
      // 쨍한 고역을 눌러 둔탁하게
      lowpass(d, sr, 3200);
    },
    0.85 * Math.pow(s, 0.8),
    { strength: s },
  );
}

/**
 * 바삭하게 금 가는 소리. intensity 0 ~ 1 (클수록 딸깍이 많고 크다), wet 0 ~ 1 (안쪽 막이 찢어지는 젖은 소리)
 */
export function playCrackle(intensity: number, duration = 0.12, wet = 0) {
  const k = Math.min(1, Math.max(0.05, intensity));
  play(
    wet > 0.5 ? "tear" : "crack",
    duration + 0.05,
    (d, sr) => {
      const count = Math.round(4 + 34 * k);
      for (let i = 0; i < count; i++) {
        // 앞쪽에 몰린 불규칙한 시각
        const t = duration * Math.pow(rand(), 1.8);
        const amp = (0.25 + 0.75 * Math.pow(rand(), 2)) * (1 - (0.5 * t) / duration);
        // 마른 껍데기는 음높이 없는 잡음 딸깍 (사인 성분이 있으면 유리처럼 쨍하게 들린다), 젖은 막은 낮고 둔한 소리
        const tone = wet > 0.5 ? 700 + rand() * 1500 : 0;
        addClick(d, sr, Math.floor(t * sr), amp, wet > 0.5 ? 0.0018 : 0.0006 + rand() * 0.0008, tone);
      }
      lowpass(d, sr, wet > 0 ? 2600 : 4500);
    },
    0.5 * Math.pow(k, 0.7) * (wet > 0.5 ? 0.8 : 1),
    { intensity: k },
  );
}

/**
 * 끈적한 액체가 뜨거운 표면에 떨어지는 소리: 아주 짧고 옅은 젖은 "찰싹" + 곧바로 "치익" 하고 올라오는 지글거림.
 * 실제로 날계란이 팬에 떨어질 때 둔탁한 저음("퉁")은 거의 나지 않는다 → 낮은 음 없이 중고역의 젖은 소리만.
 * volume 0 ~ 1 (떨어진 양), hot 0 ~ 1 (표면 온도: 0이면 젖은 소리만)
 */
export function playSplat(volume: number, hot: number, name = "splat") {
  const v = Math.min(1, Math.max(0.03, volume));
  play(
    name,
    0.12,
    (d, sr) => {
      // 젖은 표면끼리 닿는 소리: 부드러운 딸깍 몇 개가 몇 ms 안에 몰려서
      const count = 3 + Math.round(4 * v);
      for (let i = 0; i < count; i++) {
        const t = 0.012 * Math.pow(rand(), 1.5);
        addClick(d, sr, Math.floor(t * sr), 0.4 + 0.6 * rand(), 0.0012 + rand() * 0.0015, 900 + rand() * 1400);
      }
      lowpass(d, sr, 3200);
    },
    0.16 * Math.pow(v, 0.6),
    { volume: v, hot },
  );
  // 치익: 미리 합성해 둔 소리 중 하나를 (조금씩 다른 빠르기로) 재생
  const e = getAudio();
  const bank = e && soundBank(e.ctx);
  if (e && bank && hot > 0) {
    const src = e.ctx.createBufferSource();
    src.buffer = bank.hiss[Math.floor(rand() * bank.hiss.length)];
    src.playbackRate.value = 0.9 + rand() * 0.25;
    const g = e.ctx.createGain();
    g.gain.value = 0.55 * Math.pow(v, 0.6) * hot;
    src.connect(g).connect(e.out);
    src.start();
  }
}

/**
 * 작은 새가 "삐약" 우는 소리: 높은 음(약 4kHz)에서 빠르게 내려오는 짧은 휘파람 + 약한 배음.
 * excited 0 ~ 1: 클수록 높고 짧고 급하게 (달아나며 우는 소리)
 */
export function playPeep(excited = 0.5) {
  const k = Math.min(1, Math.max(0, excited));
  const seconds = 0.09 + 0.07 * (1 - k) + rand() * 0.03;
  const f0 = 4300 + 600 * k + rand() * 400;
  const f1 = f0 * (0.62 + rand() * 0.1);
  play(
    "peep",
    seconds + 0.01,
    (d, sr) => {
      const n = Math.floor(seconds * sr);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // 처음에 살짝 올라갔다가 길게 내려온다 + 떨림
        const f = f0 * (1 + 0.08 * Math.sin(Math.PI * Math.min(1, t * 4))) + (f1 - f0) * t * t + 120 * Math.sin(i * 0.004);
        phase += (2 * Math.PI * f) / sr;
        const env = Math.min(1, t * 14) * Math.pow(1 - t, 1.6);
        d[i] = (Math.sin(phase) + 0.18 * Math.sin(2 * phase + 0.4) + 0.05 * (rand() * 2 - 1)) * env;
      }
      lowpass(d, sr, 7000);
    },
    0.32,
    { excited: k },
  );
}

type Bank = { sizzle: AudioBuffer[]; hiss: AudioBuffer[] };
let bank: Bank | null = null;
let bankLoading = false;

/**
 * 합성 비용이 큰 소리(지글거림 반복, 치익)는 워커에서 미리 만든다 → 메인 스레드가 멈추지 않는다.
 * 준비 전이면 null (그동안은 해당 소리를 생략)
 */
export function soundBank(ctx: BaseAudioContext) {
  if (bank || bankLoading || typeof Worker === "undefined") return bank;
  bankLoading = true;
  const worker = new Worker(new URL("./soundBank.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<{ sizzle: Float32Array[]; hiss: Float32Array[] }>) => {
    const toBuffer = (data: Float32Array) => {
      const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      return b;
    };
    bank = { sizzle: ev.data.sizzle.map(toBuffer), hiss: ev.data.hiss.map(toBuffer) };
    worker.terminate();
  };
  worker.postMessage({ sampleRate: ctx.sampleRate });
  return null;
}

/**
 * 계속 들리는 지글거림. level 0 ~ 1 로 세기를, pops(초당)로 기름이 크게 튀는 소리 빈도를 조절한다.
 * 조리 상태 → level·pops 계산은 레시피가 하고, 여기서는 소리만 만든다.
 */
export class Sizzle {
  private gain: GainNode | null = null;
  private layers: GainNode[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private level = 0;
  private t = 0;

  /** 반복 소리를 합성해 재생 준비 (오디오가 켜진 뒤 유휴 시간에 미리 부르면 첫 지글거림에서 끊기지 않는다) */
  prepare() {
    if (this.gain) return true;
    const e = getAudio();
    const bank = e && soundBank(e.ctx);
    if (!e || !bank) return false;
    const { ctx } = e;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    // 지글거림은 고역에 몰려 있다 (저역은 둔탁하고 부엌 소음처럼 들림)
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 5200;
    presence.Q.value = 0.7;
    presence.gain.value = 3;
    this.gain.connect(hp).connect(presence).connect(e.out);
    for (const buffer of bank.sizzle) {      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      src.connect(g).connect(this.gain);
      src.start();
      this.layers.push(g);
      this.sources.push(src);
    }
    return true;
  }

  /** 매 프레임 호출 */
  update(level: number, pops: number, dt: number) {
    if (!this.gain && (level <= 0 || !this.prepare())) return;
    const e = getAudio()!;
    this.t += dt;
    const now = e.ctx.currentTime;
    // 실제 지글거림은 일정하지 않고 파도처럼 살짝 오르내린다 (두 층이 엇갈리게)
    const swell = (i: number) => 0.5 + 0.2 * Math.sin(this.t * (1.3 + i * 0.7) + i * 2) + 0.1 * Math.sin(this.t * (3.1 + i));
    this.layers.forEach((g, i) => g.gain.setTargetAtTime(swell(i), now, 0.2));
    if (Math.abs(level - this.level) > 0.002 || level === 0) {
      this.gain!.gain.setTargetAtTime(level * 0.5, now, 0.12);
      this.level = level;
    }
    // 기름이 크게 튀는 소리 (포아송)
    if (level > 0.02 && rand() < pops * dt) {
      const k = 0.3 + 0.7 * Math.pow(rand(), 2);
      play(
        "pop",
        0.05,
        (d, sr) => {
          addClick(d, sr, 0, 1, 0.0005 + rand() * 0.0007, 2500 + rand() * 4000);
          if (rand() < 0.4) addClick(d, sr, Math.floor((0.004 + rand() * 0.01) * sr), 0.5, 0.0004);
        },
        0.22 * k * Math.min(1, level * 1.5),
      );
    }
  }

  get current() {
    return this.level;
  }

  dispose() {
    for (const s of this.sources) s.stop();
    this.gain?.disconnect();
    this.gain = null;
    this.layers = [];
    this.sources = [];
  }
}
