// 계란을 집어 팬에 넣는 과정을 실제 GPU로 촬영한다 (프레임 PNG + 선택적 영상).
// 사용: node scripts/grab-demo.mjs [outDir]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "grab-demo";
mkdirSync(out, { recursive: true });
const base = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  channel: "chromium",
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: process.env.VIDEO ? { dir: out, size: { width: 1280, height: 800 } } : undefined,
});
const page = await context.newPage();
await page.goto(base);
await page.waitForFunction(() => (window.__cook?.sceneReadyFrames ?? 0) > 30 && !!window.__cookProject?.("grab:egg"), null, { timeout: 60_000 });

const proj = (n, o) => page.evaluate(([n, o]) => window.__cookProject(n, o), [n, o]);
const [ex, ey] = await proj("grab:egg");
const [px, py] = await proj("frying-pan", [0.02, 0.006, 0.02]);
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

await shot("1-before");
await page.mouse.move(ex, ey);
await page.mouse.down();
await page.waitForTimeout(250);
await shot("2-picked-up");
// 빠르게 휘두르듯 이동 → 기울어짐 확인
await page.mouse.move(ex + 260, ey - 160, { steps: 6 });
await shot("3-moving-fast");
await page.mouse.move(px, py, { steps: 25 });
await page.waitForTimeout(300);
await shot("4-over-pan");
await page.mouse.up();
await page.waitForTimeout(120);
await shot("5-falling");
await page.waitForTimeout(1200);
await shot("6-landed");
await context.close();
await browser.close();
console.log("saved to", out);
