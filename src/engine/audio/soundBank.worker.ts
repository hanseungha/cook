import { hissBurst, sizzleTexture } from "./synth";

/** 지글거림 반복 소리 2개(길이를 달리 해 겹침) + 치익 4가지를 합성해 돌려준다 */
self.onmessage = (e: MessageEvent<{ sampleRate: number }>) => {
  const sr = e.data.sampleRate;
  const make = (seconds: number, fill: (d: Float32Array, sr: number) => void) => {
    const d = new Float32Array(Math.ceil(seconds * sr));
    fill(d, sr);
    return d;
  };
  const sizzle = [3.7, 5.3].map((s) => make(s, sizzleTexture));
  const hiss = [0, 1, 2, 3].map(() => make(1, hissBurst));
  (self as unknown as Worker).postMessage({ sizzle, hiss }, [...sizzle, ...hiss].map((d) => d.buffer));
};
