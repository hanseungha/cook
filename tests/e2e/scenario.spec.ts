import { expect, test, type CDPSession, type Page } from "@playwright/test";

/**
 * STEP 8: 계란프라이 전체 사용자 시나리오 QA
 * 접속 → 장면 → 계란 선택 → 이동 → 테두리에 부딪힘 → 깨짐 → 벌려서 흰자·노른자 떨어뜨림 → 익는 과정
 * 상태 전이·중복 실행·콘솔 오류·메모리·화면 크기·화질 조절을 함께 검사한다.
 */

const PAN = { x: 0, z: -0.025, topY: 0.057 };
const CARRY_PLANE_Y = 0.067;

/** 외부 라이브러리가 내는 알려진 경고 (R3F 9가 내부에서 THREE.Clock을 씀) */
const KNOWN_WARNINGS = [/THREE\.Clock: This module has been deprecated/];

type Scene = { getObjectByName: (n: string) => SceneObject | undefined; traverse: (f: (o: SceneObject) => void) => void };
type SceneObject = { name: string; isMesh?: boolean; visible: boolean; position: { toArray: () => number[] } };
type Store<T> = { getState: () => T };
type ShellState = { state: string; open: number; discarded: boolean; history: Array<{ from: string; to: string; cause: string }> };
type ContentsState = { state: string; white: number; yolk: string; area: number; raw: number; brown: number; history: Array<{ from: string; to: string }> };
type CookingState = { progress: number; heating: boolean; setHeat: (h: number) => void };
type SoundLog = Array<{ name: string; at: number }>;

declare global {
  interface Window {
    __cookEggShell?: unknown;
    __cookEggContents?: unknown;
    __cookEggCooking?: unknown;
    __cookAudio?: unknown;
  }
}

function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    if (KNOWN_WARNINGS.some((r) => r.test(m.text()))) return;
    problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function waitForScene(page: Page) {
  await page.waitForFunction(
    () => (window.__cook?.sceneReadyFrames ?? 0) > 20 && !!window.__cookProject?.("grab:egg") && !!window.__cookEggShell,
    null,
    { timeout: 60_000 },
  );
}

const shell = (page: Page) => page.evaluate(() => (window.__cookEggShell as Store<ShellState>).getState());
const contents = (page: Page) => page.evaluate(() => (window.__cookEggContents as Store<ContentsState>).getState());
const cooking = (page: Page) =>
  page.evaluate(() => {
    const c = (window.__cookEggCooking as Store<CookingState>).getState();
    return { progress: c.progress, heating: c.heating };
  });
const eggPos = (page: Page) =>
  page.evaluate(() => (window.__cookScene as Scene).getObjectByName("grab:egg")!.position.toArray());
const screenAt = (page: Page, x: number, z: number) =>
  page.evaluate((o) => window.__cookProject!("frying-pan", o)!, [x - PAN.x, CARRY_PLANE_Y - PAN.topY, z - PAN.z] as [number, number, number]);

async function carryTo(page: Page, x: number, z: number, steps = 25) {
  let want = [x, z];
  for (let i = 0; i < 3; i++) {
    const [sx, sy] = await screenAt(page, want[0], want[1]);
    await page.mouse.move(sx, sy, { steps: i === 0 ? steps : 4 });
    await page.waitForTimeout(300);
    const p = await eggPos(page);
    want = [want[0] + (x - p[0]), want[1] + (z - p[2])];
  }
  return want;
}

/** 이름별 메시 개수 (같은 물체가 두 번 만들어지지 않았는지) */
const meshCounts = (page: Page) =>
  page.evaluate(() => {
    const counts: Record<string, number> = {};
    (window.__cookScene as Scene).traverse((o) => {
      if (o.isMesh && o.name) counts[o.name] = (counts[o.name] ?? 0) + 1;
    });
    return counts;
  });

async function heapMB(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heap: m.JSHeapUsedSize / 1048576, listeners: m.JSEventListeners };
}

const gpu = (page: Page) =>
  page.evaluate(async () => {
    // 렌더 통계는 30프레임마다 갱신된다
    await new Promise((r) => setTimeout(r, 600));
    return window.__cook!.info!;
  });

/** 화면에서 (cx, cy) 주변이 배경(흰색)이 아닌 무언가로 그려졌는지: 어두운 픽셀 비율 */
const darkFraction = (page: Page, cx: number, cy: number, r: number) =>
  page.evaluate(
    async ([cx, cy, r]) => {
      const canvas = document.querySelector("canvas")!;
      const bmp = await createImageBitmap(canvas);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const s = bmp.width / canvas.clientWidth;
      const d = ctx.getImageData(Math.max(0, (cx - r) * s), Math.max(0, (cy - r) * s), 2 * r * s, 2 * r * s).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) dark++;
      return dark / (d.length / 4);
    },
    [cx, cy, r] as [number, number, number],
  );

test.describe("전체 사용자 시나리오 (STEP 8)", () => {
  test("접속부터 익는 과정까지: 상태 전이·중복 실행·콘솔 오류·메모리", async ({ page, context }) => {
    test.setTimeout(150_000);
    const problems = watchConsole(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");

    // 1~2. 접속 → 프라이팬 장면
    await page.goto("/");
    await waitForScene(page);
    const panAt = (await page.evaluate(() => window.__cookProject!("frying-pan")))!;
    expect(await darkFraction(page, panAt[0], panAt[1], 60)).toBeGreaterThan(0.8);
    const before = await meshCounts(page);
    const gpu0 = await gpu(page);
    const heap0 = await heapMB(cdp);
    expect((await shell(page)).state).toBe("INTACT");
    expect((await contents(page)).state).toBe("IN_SHELL");
    expect((await cooking(page)).heating).toBe(false);

    // 3. 계란 선택
    const [ex, ey] = (await page.evaluate(() => window.__cookProject!("grab:egg")))!;
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window.__cookGrab as Store<{ grabbedId: string | null }>).getState().grabbedId)).toBe("egg");

    // 4. 이동 (조작 없이 깨지지 않는다)
    const aim = await carryTo(page, -0.03, 0.2);
    expect((await shell(page)).state).toBe("INTACT");

    // 5~6. 테두리에 부딪혀 깨뜨림
    const [tx, ty] = await screenAt(page, aim[0] + 0.01, aim[1] - 0.2);
    await page.mouse.move(tx, ty, { steps: 3 });
    await page.waitForTimeout(500);
    expect((await shell(page)).state).toBe("CRACKED");

    // 7. 벌려서 흰자·노른자 떨어뜨림
    const q = await eggPos(page);
    const [qx, qy] = await screenAt(page, q[0], q[2]);
    for (let i = 1; i <= 16 && (await shell(page)).state !== "OPENED"; i++) {
      await page.mouse.move(qx + i * 7, qy, { steps: 2 });
      await page.waitForTimeout(60);
    }
    expect((await shell(page)).state).toBe("OPENED");
    await expect.poll(async () => (await contents(page)).state, { timeout: 15_000 }).toBe("IN_PAN");
    // 껍데기는 팬 밖에 버린다
    await carryTo(page, -0.215, 0.12, 15);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    expect((await shell(page)).discarded).toBe(true);

    // 8. 익는 과정 (빠르게)
    expect((await cooking(page)).heating).toBe(true);
    await page.evaluate(() => (window.__cookEggCooking as Store<CookingState>).getState().setHeat(6));
    const gpuCook = await gpu(page);
    const heapCook = await heapMB(cdp);
    await page.waitForFunction(() => (window.__cookEggCooking as Store<CookingState>).getState().progress >= 1, null, { timeout: 60_000 });
    const done = await contents(page);
    expect(done.raw).toBeLessThan(0.3);
    expect(done.brown).toBeGreaterThan(0.05);

    // 상태 전이: 정해진 순서대로 한 번씩만
    const sh = await shell(page);
    expect(sh.history.map((h) => `${h.from}>${h.to}`)).toEqual(["INTACT>CRACKED", "CRACKED>OPENED"]);
    expect(done.history.map((h) => `${h.from}>${h.to}`)).toEqual(["IN_SHELL>POURING", "POURING>IN_PAN"]);

    // 중복 실행 없음: 물체는 한 벌씩, 착지·찢김 소리는 한 번씩
    const after = await meshCounts(page);
    for (const name of ["egg", "egg-white", "egg-yolk", "egg-white-stream", "egg-white-collar", "oil-film"]) expect(after[name] ?? 0, name).toBe(1);
    expect(after["egg-shell-blunt"]).toBe(1);
    expect(after["egg-shell-pointy"]).toBe(1);
    for (const [name, n] of Object.entries(before)) expect(after[name] ?? 0, name).toBeGreaterThanOrEqual(n);
    const sounds = await page.evaluate(() => (window.__cookAudio as { log: SoundLog }).log.map((s) => s.name));
    const count = (n: string) => sounds.filter((s) => s === n).length;
    expect(count("splat")).toBe(1);
    expect(count("plop")).toBe(1);
    expect(count("knock")).toBeLessThan(4);

    // 메모리: 다 익은 뒤 몇 초 동안 GPU 자원·JS 힙이 계속 늘지 않는다
    const gpuDone = await gpu(page);
    const heapDone = await heapMB(cdp);
    await page.waitForTimeout(5000);
    const gpuLater = await gpu(page);
    const heapLater = await heapMB(cdp);
    expect(gpuLater.geometries).toBe(gpuDone.geometries);
    expect(gpuLater.textures).toBe(gpuDone.textures);
    expect(gpuLater.programs).toBe(gpuDone.programs);
    expect(heapLater.heap - heapDone.heap).toBeLessThan(1.5);
    expect(heapLater.listeners).toBeLessThanOrEqual(heapDone.listeners);
    // 조리하는 동안에도 자원이 프레임마다 쌓이지 않는다 (처음 쏟아질 때 만든 것 외에)
    expect(gpuDone.geometries).toBe(gpuCook.geometries);
    expect(gpuDone.textures).toBe(gpuCook.textures);
    expect(heapDone.heap - heapCook.heap).toBeLessThan(3);
    // 시나리오 전체: 내용물·껍데기 조각 몇 개 분량만 늘었다
    expect(gpuDone.geometries - gpu0.geometries).toBeLessThan(20);
    expect(heapDone.heap - heap0.heap).toBeLessThan(20);

    // 화질 조절: 순조롭게 돌았으면 끝까지 최고 해상도
    expect(gpuLater.dpr).toBe(gpu0.dpr);
    expect(problems).toEqual([]);
  });
});

test.describe("화질 조절 (STEP 8)", () => {
  // 2배 화면: 낮출 여지가 있어야 한다
  test.use({ deviceScaleFactor: 2 });

  test("느린 기기에서는 해상도를 낮추고, 여유가 생기면 되돌린다", async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await waitForScene(page);
    const dpr0 = (await gpu(page)).dpr;
    const cdp = await context.newCDPSession(page);
    // 메인 스레드를 크게 느리게 → 프레임이 계속 길어진다
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 12 });
    await expect.poll(async () => (await gpu(page)).dpr, { timeout: 30_000, intervals: [1000] }).toBeLessThan(dpr0);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await expect.poll(async () => (await gpu(page)).dpr, { timeout: 60_000, intervals: [2000] }).toBe(dpr0);
  });
});

/** 화면 크기별: 캔버스가 화면을 채우고, 팬과 계란이 화면 안에 그려지고, 계란을 집을 수 있다 */
const VIEWPORTS = [
  { label: "휴대폰 세로", width: 390, height: 844, dpr: 3, touch: true },
  { label: "휴대폰 가로", width: 844, height: 390, dpr: 3, touch: true },
  { label: "태블릿", width: 820, height: 1180, dpr: 2, touch: true },
  { label: "노트북", width: 1280, height: 800, dpr: 2, touch: false },
  { label: "와이드 모니터", width: 2560, height: 1080, dpr: 1, touch: false },
];

for (const vp of VIEWPORTS) {
  test.describe(`화면 크기: ${vp.label}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, hasTouch: vp.touch });

    test(`${vp.width}×${vp.height}에서 장면이 온전히 보이고 계란을 집을 수 있다`, async ({ page }) => {
      const problems = watchConsole(page);
      await page.goto("/");
      await waitForScene(page);
      const canvas = await page.evaluate(() => {
        const c = document.querySelector("canvas")!;
        return { cw: c.clientWidth, ch: c.clientHeight, w: c.width, h: c.height, scrollW: document.documentElement.scrollWidth };
      });
      expect(canvas.cw).toBe(vp.width);
      expect(canvas.ch).toBe(vp.height);
      expect(canvas.scrollW).toBeLessThanOrEqual(vp.width);
      // 그리는 픽셀 수는 예산(약 4K) 안
      expect(canvas.w * canvas.h).toBeLessThanOrEqual(3840 * 2160 * 1.01);

      for (const name of ["frying-pan", "grab:egg"]) {
        const p = (await page.evaluate((n) => window.__cookProject!(n), name))!;
        expect(p[0], name).toBeGreaterThan(0);
        expect(p[0], name).toBeLessThan(vp.width);
        expect(p[1], name).toBeGreaterThan(0);
        expect(p[1], name).toBeLessThan(vp.height);
      }
      const pan = (await page.evaluate(() => window.__cookProject!("frying-pan")))!;
      expect(await darkFraction(page, pan[0], pan[1], Math.min(40, vp.width / 12))).toBeGreaterThan(0.8);
      const egg = (await page.evaluate(() => window.__cookProject!("grab:egg")))!;
      expect(await darkFraction(page, egg[0], egg[1], 4)).toBeGreaterThan(0.5);

      // 계란을 집어 옮길 수 있다 (마우스 또는 터치와 같은 포인터 이벤트)
      await page.mouse.move(egg[0], egg[1]);
      await page.mouse.down();
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => (window.__cookGrab as Store<{ grabbedId: string | null }>).getState().grabbedId)).toBe("egg");
      await page.mouse.move(pan[0], pan[1], { steps: 10 });
      await page.mouse.up();
      expect(problems).toEqual([]);
    });
  });
}
