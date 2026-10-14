import { expect, test } from "@playwright/test";

test.describe("렌더링 환경", () => {
  test("WebGL 캔버스가 초기화되고 렌더 루프가 돈다", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await page.goto("/");

    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();

    await page.waitForFunction(() => window.__cook?.ready === true);
    const probe = await page.evaluate(() => window.__cook!);
    expect(probe.webglVersion).toBe(2);
    expect(probe.toneMapping).toBe(7); // THREE.NeutralToneMapping

    const start = probe.frames;
    await page.waitForFunction((n) => window.__cook!.frames > n + 10, start);

    const box = await canvas.boundingBox();
    expect(box?.width).toBe(1280);
    expect(box?.height).toBe(800);

    expect(errors).toEqual([]);
  });

  test("캔버스에 실제 픽셀이 그려진다", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => (window.__cook?.sceneReadyFrames ?? 0) > 30, null, { timeout: 60_000 });

    const shot = await page.locator("canvas").screenshot();
    // 단색 화면이면 PNG가 매우 작다. 조명/그림자가 있는 장면은 훨씬 크다.
    expect(shot.byteLength).toBeGreaterThan(20_000);
    await test.info().attach("lookdev", { body: shot, contentType: "image/png" });
  });
});
