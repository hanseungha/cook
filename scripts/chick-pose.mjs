// 병아리 모습 확인: 계란을 깨지 않고 병아리를 바로 꺼내 내려앉힌 뒤 멈추고 여러 각도에서 클로즈업
// 사용: node scripts/chick-pose.mjs [outDir]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const out = process.argv[2] ?? "chick-pose";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })).newPage();
await page.goto("http://localhost:3000/?chick=1");
await page.waitForFunction(() => (window.__cook?.sceneReadyFrames ?? 0) > 30 && !!window.__cookChick, null, { timeout: 60000 });
await page.evaluate(() => { window.__cookChickSlow = 0.3; window.__cookChick.getState().hatch(); });
await page.waitForFunction(() => window.__cookScene.getObjectByName("chick").visible);
await page.waitForTimeout(900);
await page.evaluate(() => {
  window.__cookChickSlow = 0;
  // 계란은 숨긴다 (병아리를 가리지 않게)
  window.__cookScene.getObjectByName("grab:egg").visible = false;
  for (const n of ["grab-shadow:egg"]) { const o = window.__cookScene.getObjectByName(n); if (o) o.visible = false; }
});
for (const [name, yaw] of [["front", 0], ["side", Math.PI / 2], ["back", Math.PI], ["three", 0.8]]) {
  await page.evaluate((y) => {
    // 정지 상태에서 카메라를 향한 방향 기준으로 돌린다
    window.__cookChickYaw = y;
  }, yaw);
  await page.waitForTimeout(150);
  const c = await page.evaluate(() => window.__cookProject("chick", [0, 0.03, 0]));
  await page.screenshot({ path: `${out}/pose-${name}.png`, clip: { x: c[0] - 80, y: c[1] - 75, width: 160, height: 130 } });
}
await browser.close();
