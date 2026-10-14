// 프레임 제한(vsync)을 풀고 실제 렌더링 처리량을 측정한다.
// 사용: node scripts/bench.mjs [url-path] [width] [height] [dpr] [seconds]
import { chromium } from "@playwright/test";

const [path = "/", w = "1920", h = "1080", dpr = "2", secs = "5"] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  channel: "chromium",
  args: [
    "--use-angle=metal",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    // CAPPED=1: 실제 사용자처럼 vsync(60Hz) 아래에서 측정 (끊김·유휴 작업 확인)
    ...(process.env.CAPPED ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"]),
  ],
});
const page = await browser.newPage({
  viewport: { width: +w, height: +h },
  deviceScaleFactor: +dpr,
});
const t0 = Date.now();
await page.goto(base + path);
// 장면(HDRI 포함)이 실제로 화면에 나온 시점
await page.waitForFunction(() => (window.__cook?.sceneReadyFrames ?? 0) > 0, null, { timeout: 60_000 });
const sceneReadyMs = Date.now() - t0;
await page.waitForTimeout(+(process.env.WARMUP ?? 3000));

const result = await page.evaluate(async (seconds) => {
  const times = [];
  const spikes = [];
  const start = performance.now();
  let last = start;
  let running = true;
  const tick = (t) => {
    const dt = t - last;
    times.push(dt);
    if (dt > 33) spikes.push([Math.round(t - start), Math.round(dt)]);
    last = t;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  running = false;
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
  const info = window.__cook?.info ?? null;
  return {
    fps: +(1000 / q(0.5)).toFixed(1),
    frameMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) },
    spikes: spikes.slice(0, 8),
    canvas: [document.querySelector("canvas").width, document.querySelector("canvas").height],
    info,
  };
}, +secs);

console.log(JSON.stringify({ path, viewport: `${w}x${h}@${dpr}x`, sceneReadyMs, ...result }));
await browser.close();
