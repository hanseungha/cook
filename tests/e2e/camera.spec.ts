import { expect, test, type Page } from "@playwright/test";

async function waitForScene(page: Page) {
  await page.waitForFunction(
    () => (window.__cook?.sceneReadyFrames ?? 0) > 30 && !!window.__cook?.info?.camera,
    null,
    { timeout: 60_000 },
  );
}

const cameraPos = (page: Page) => page.evaluate(() => window.__cook!.info!.camera);

/** 캔버스 중앙 픽셀 밝기 (팬 조리면이면 어둡다) */
async function centerLuma(page: Page) {
  const png = await page.locator("canvas").screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(img.width >> 1, Math.floor(img.height * 0.45), 1, 1).data;
    return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
  }, png.toString("base64"));
}

test.describe("고정 카메라 (STEP 2)", () => {
  test("휠·드래그·핀치로 카메라와 페이지 배율이 바뀌지 않는다", async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
    const before = await cameraPos(page);

    const box = (await page.locator("canvas").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -800); // 확대 시도
    await page.mouse.wheel(0, 800); // 축소 시도
    await page.mouse.down();
    await page.mouse.move(cx + 300, cy + 150, { steps: 10 }); // 회전 시도
    await page.mouse.up();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -500); // 트랙패드 핀치 = ctrl+wheel
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);

    expect(await cameraPos(page)).toEqual(before);
    const scale = await page.evaluate(() => window.visualViewport?.scale ?? 1);
    expect(scale).toBe(1);
  });

  for (const [w, h, label] of [
    [390, 844, "모바일 세로"],
    [1024, 768, "4:3"],
    [2560, 1080, "울트라와이드"],
  ] as const) {
    test(`${label}(${w}×${h})에서도 팬이 화면 중앙에 있다`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      await waitForScene(page);
      expect(await centerLuma(page)).toBeLessThan(40);
    });
  }
});
