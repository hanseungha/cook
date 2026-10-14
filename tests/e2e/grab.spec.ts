import { expect, test, type Page } from "@playwright/test";

type GrabObject = { phase: "rest" | "held" | "falling"; position: [number, number, number] };

async function waitForScene(page: Page) {
  await page.waitForFunction(
    () => (window.__cook?.sceneReadyFrames ?? 0) > 20 && !!window.__cookProject?.("grab:egg"),
    null,
    { timeout: 60_000 },
  );
}

const screenOf = (page: Page, name: string, offset?: [number, number, number]) =>
  page.evaluate(([n, o]) => window.__cookProject!(n, o)!, [name, offset] as const);

const egg = (page: Page) =>
  page.evaluate(() => {
    const store = window.__cookGrab as { getState: () => { objects: Record<string, unknown> } };
    return store.getState().objects.egg as GrabObject;
  });

/** 장면 상수 (StoveSetup / COOKTOP / PAN / EGG) */
const PAN_CENTER = { x: 0, z: -0.025, floorY: 0.057 + 0.006 };
const EGG_REST = 0.022;
const GLASS_Y = 0.057;

test.describe("Grab 인터랙션 (STEP 3)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
  });

  test("계란을 집어 팬 안에 내려놓으면 팬 바닥에 착지한다", async ({ page }) => {
    const start = await egg(page);
    expect(start.phase).toBe("rest");

    // 호버 시 grab 커서
    const [ex, ey] = await screenOf(page, "grab:egg");
    await page.mouse.move(ex, ey);
    await expect.poll(() => page.evaluate(() => document.querySelector("canvas")!.style.cursor)).toBe("grab");

    // 집기
    await page.mouse.down();
    await expect.poll(async () => (await egg(page)).phase).toBe("held");
    await expect.poll(() => page.evaluate(() => document.querySelector("canvas")!.style.cursor)).toBe("grabbing");

    // 팬 중앙으로 이동 (중간에 들어 올려졌는지 확인)
    const [px, py] = await screenOf(page, "frying-pan", [0, 0.006, 0]);
    await page.mouse.move((ex + px) / 2, (ey + py) / 2, { steps: 15 });
    await page.waitForTimeout(150);
    const lifted = await page.evaluate(() =>
      (window.__cookScene as { getObjectByName: (n: string) => { position: { y: number } } })
        .getObjectByName("grab:egg").position.y,
    );
    expect(lifted).toBeGreaterThan(start.position[1] + 0.03);

    await page.mouse.move(px, py, { steps: 15 });
    // 스프링이 따라올 때까지 (테두리에 닿아 잠시 멈칫할 수 있음)
    await expect
      .poll(async () => {
        const p = await page.evaluate(() =>
          (window.__cookScene as { getObjectByName: (n: string) => { position: { x: number; z: number } } })
            .getObjectByName("grab:egg").position,
        );
        return Math.hypot(p.x - PAN_CENTER.x, p.z - PAN_CENTER.z);
      }, { timeout: 5000 })
      .toBeLessThan(0.04);
    await page.mouse.up();

    // 낙하 → 착지
    await expect.poll(async () => (await egg(page)).phase, { timeout: 5000 }).toBe("rest");
    const [x, y, z] = (await egg(page)).position;
    expect(Math.hypot(x - PAN_CENTER.x, z - PAN_CENTER.z)).toBeLessThan(0.06);
    expect(y).toBeCloseTo(PAN_CENTER.floorY + EGG_REST, 3);
  });

  test("인덕션 유리 위에 내려놓으면 유리 높이에 착지한다", async ({ page }) => {
    const [ex, ey] = await screenOf(page, "grab:egg");
    // 유리 앞쪽 조작부 근처 (팬 밖)
    const [gx, gy] = await screenOf(page, "induction-cooktop", [0.09, GLASS_Y, 0.15]);
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    await page.mouse.move(gx, gy, { steps: 20 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await expect.poll(async () => (await egg(page)).phase, { timeout: 5000 }).toBe("rest");
    const [, y] = (await egg(page)).position;
    expect(y).toBeCloseTo(GLASS_Y + EGG_REST, 3);
  });

  test("빈 곳을 드래그하면 아무것도 잡히지 않는다", async ({ page }) => {
    await page.mouse.move(60, 60);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 10 });
    await page.mouse.up();
    expect((await egg(page)).phase).toBe("rest");
    expect(await page.evaluate(() => (window.__cookGrab as { getState: () => { grabbedId: unknown } }).getState().grabbedId)).toBeNull();
  });
});
