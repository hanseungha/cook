/**
 * 효과음 합성 기본 재료 (DOM·Web Audio 비의존 → 메인 스레드와 워커 양쪽에서 쓴다).
 * 샘플 배열에 직접 더해 만든다.
 */
const rand = Math.random;

/** 감쇠하는 사인 (공진) 을 data에 더한다 */
export function addMode(data: Float32Array, sr: number, start: number, freq: number, decay: number, amp: number) {
  const n = Math.min(data.length - start, Math.ceil(decay * 6 * sr));
  const w = (2 * Math.PI * freq) / sr;
  const k = Math.exp(-1 / (decay * sr));
  let env = amp;
  const phase = rand() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    data[start + i] += Math.sin(w * i + phase) * env;
    env *= k;
  }
}

/** 감쇠하는 잡음 펄스. tone > 0 이면 그 주파수로 공진하는 딸깍 소리 */
export function addClick(data: Float32Array, sr: number, start: number, amp: number, decay: number, tone = 0) {
  const n = Math.min(data.length - start, Math.ceil(decay * 6 * sr));
  const k = Math.exp(-1 / (decay * sr));
  let env = amp;
  let prev = 0;
  const w = tone > 0 ? (2 * Math.PI * tone) / sr : 0;
  for (let i = 0; i < n; i++) {
    const noise = rand() * 2 - 1;
    // 고역 강조(1차 차분) → 바삭하고 밝은 소리
    const bright = noise - prev * 0.6;
    prev = noise;
    data[start + i] += (tone > 0 ? Math.sin(w * i) * 0.6 + bright * 0.4 : bright) * env;
    env *= k;
  }
}

/** 1차 저역 통과 (둔탁하게) */
export function lowpass(data: Float32Array, sr: number, cutoff: number) {
  const a = Math.exp((-2 * Math.PI * cutoff) / sr);
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    y = (1 - a) * data[i] + a * y;
    data[i] = y;
  }
}

/** 지글거림 반복 소리의 한 조각 (반복 경계가 들리지 않게 길이를 달리 해 두 개를 겹친다) */
export function sizzleTexture(data: Float32Array, sr: number) {
  const seconds = data.length / sr;
  // 미세한 펄스: 크기가 대부분 작고 가끔 큰(꼬리가 두꺼운) 분포
  for (let t = 0; t < seconds; t += -Math.log(1 - rand()) / 2600) {
    addClick(data, sr, Math.floor(t * sr), Math.pow(rand(), 3.2) * 0.55, 0.0002 + rand() * 0.0004);
  }
  // 바닥에 깔린 잔잔한 쉬익
  let prev = 0;
  for (let i = 0; i < data.length; i++) {
    const n = rand() * 2 - 1;
    data[i] += (n - prev) * 0.035;
    prev = n;
  }
  // 이음매: 끝을 시작과 부드럽게 겹친다
  const fade = Math.floor(0.05 * sr);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    data[i] = data[i] * a + data[data.length - fade + i] * (1 - a);
  }
}


/** 물기가 뜨거운 기름에 닿아 한꺼번에 터지는 "치익" (빠르게 올라와 서서히 잦아듦) */
export function hissBurst(data: Float32Array, sr: number) {
  const rate = 4000;
  for (let t = 0.008; t < data.length / sr - 0.02; t += -Math.log(1 - rand()) / rate) {
    const env = Math.min(1, (t - 0.008) / 0.02) * Math.exp(-(t - 0.03) / 0.28);
    addClick(data, sr, Math.floor(t * sr), Math.pow(rand(), 3) * env * 0.5, 0.00025 + rand() * 0.0003);
  }
}
