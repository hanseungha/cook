import { expect, test, type Page } from "@playwright/test";

/** 캔버스 스크린샷에서 정규화 좌표(0..1)의 픽셀 밝기(0..255)를 읽는다 */
async function sampleLuma(page: Page, points: [number, number][]) {
  const png = await page.locator("canvas").screenshot();
  return page.evaluate(
    async ({ b64, pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return pts.map(([x, y]) => {
        const d = ctx.getImageData(Math.floor(x * img.width), Math.floor(y * img.height), 1, 1).data;
        return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
      });
    },
    { b64: png.toString("base64"), pts: points },
  );
}

test.describe("주방 장면 (STEP 1)", () => {
  test("팬과 인덕션이 로드되고 흰 배경 위 중앙에 팬이 보인다", async ({ page }) => {
    test.setTimeout(120_000); // 헤드리스 SwiftShader는 HDRI·반사 패스가 느리다
    await page.goto("/");
    // HDRI 로드 후 Suspense가 풀려야 메시가 생긴다
    await page.waitForFunction(() => {
      const scene = window.__cookScene as { getObjectByName?: (n: string) => unknown } | undefined;
      return !!scene?.getObjectByName?.("frying-pan") && (window.__cook?.frames ?? 0) > 30;
    }, null, { timeout: 60_000 });

    const [center, topLeft, topRight] = await sampleLuma(page, [
      [0.5, 0.45], // 팬 조리면
      [0.03, 0.05],
      [0.97, 0.05],
    ]);
    expect(center).toBeLessThan(40); // 검은 코팅
    expect(topLeft).toBeGreaterThan(250); // 흰 배경
    expect(topRight).toBeGreaterThan(250);

    await test.info().attach("kitchen", {
      body: await page.locator("canvas").screenshot(),
      contentType: "image/png",
    });
  });
});
