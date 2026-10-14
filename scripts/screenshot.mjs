// 실제 GPU(Metal)로 렌더링한 장면 스크린샷을 찍는다.
// 사용: [DPR=2] node scripts/screenshot.mjs [url-path] [out.png] [width] [height]
import { chromium } from "@playwright/test";

const [path = "/", out = "screenshot.png", w = "1600", h = "1000"] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  channel: "chromium", // new headless: 하드웨어 GPU 사용 가능
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: +w, height: +h },
  deviceScaleFactor: Number(process.env.DPR ?? 1),
});
const logs = [];
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(m.text()));
page.on("pageerror", (e) => logs.push(e.message));

await page.goto(base + path);
await page.waitForFunction(() => (window.__cook?.frames ?? 0) > 90, null, { timeout: 60_000 });

const info = await page.evaluate(async () => {
  const gl = document.querySelector("canvas").getContext("webgl2");
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  // 2초 동안 프레임 수로 FPS 측정
  const f0 = window.__cook.frames;
  await new Promise((r) => setTimeout(r, 2000));
  return { gpu, fps: (window.__cook.frames - f0) / 2 };
});

await page.screenshot({ path: out });
console.log(JSON.stringify({ out, ...info, logs: [...new Set(logs)] }, null, 2));
await browser.close();
