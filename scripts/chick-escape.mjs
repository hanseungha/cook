// 병아리가 팬 가운데에서 여러 방향으로 달아날 때 팬을 빠져나가는 데 걸리는 시간 (막히는 방향 찾기)
// 사용: node scripts/chick-escape.mjs
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const N = Number(process.env.N ?? 12);
// START=0.08: 팬 중심에서 이만큼 떨어진 곳(달아나는 방향 쪽)에서 꺼낸다
const START = Number(process.env.START ?? 0);
const results = [];
for (let i = 0; i < N; i++) {
  const dir = (i / N) * Math.PI * 2;
  await page.goto(`${base}/?chick=1`);
  await page.waitForFunction(() => (window.__cook?.sceneReadyFrames ?? 0) > 20 && !!window.__cookChick, null, { timeout: 60000 });
  const r = await page.evaluate(async ([dir, start]) => {
    // 계란을 팬 가운데 위로 옮겨 놓고 거기서 병아리를 꺼낸다
    const egg = window.__cookScene.getObjectByName("grab:egg");
    egg.position.set(Math.cos(dir) * start, 0.035, -0.025 + Math.sin(dir) * start);
    window.__cookChickDir = dir;
    window.__cookChick.getState().hatch();
    const chick = window.__cookScene.getObjectByName("chick");
    const t0 = performance.now();
    const track = [];
    let outAt = null;
    while (performance.now() - t0 < 4000) {
      await new Promise((res) => requestAnimationFrame(res));
      const p = chick.position;
      const r = Math.hypot(p.x - 0, p.z + 0.025);
      track.push([Math.round(performance.now() - t0), +r.toFixed(3), +p.y.toFixed(3)]);
      if (outAt === null && r > 0.15) outAt = Math.round(performance.now() - t0);
      if (window.__cookChick.getState().phase === "gone") break;
    }
    return { outAt, phase: window.__cookChick.getState().phase, track: track.filter((_, k) => k % 6 === 0) };
  }, [dir, START]);
  results.push({ deg: Math.round((dir * 180) / Math.PI), ...r });
  console.log(Math.round((dir * 180) / Math.PI), "deg: out of pan at", r.outAt, "ms, phase", r.phase, process.env.TRACK ? JSON.stringify(r.track) : "");
}
await browser.close();
