import { expect, test, type Page } from "@playwright/test";

type Shell = {
  state: "INTACT" | "CRACKED" | "OPENED";
  crack: number;
  open: number;
  impacts: number;
  discarded: boolean;
  history: Array<{ from: string; to: string; cause: string }>;
};

/** 장면 상수 (StoveSetup / COOKTOP / PAN / CrackableEgg) */
const PAN = { x: 0, z: -0.025, rim: 0.14, topY: 0.057 };
/** 바닥에서 집은 계란의 운반 평면 높이: 반지름 0.022 + liftHeight 0.045 */
const CARRY_PLANE_Y = 0.067;

async function waitForScene(page: Page) {
  await page.waitForFunction(
    () => (window.__cook?.sceneReadyFrames ?? 0) > 20 && !!window.__cookProject?.("grab:egg") && !!window.__cookEggShell,
    null,
    { timeout: 60_000 },
  );
}

const shell = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__cookEggShell as { getState: () => Shell }).getState();
    return { state: s.state, crack: s.crack, open: s.open, impacts: s.impacts, discarded: s.discarded, history: s.history };
  });

const eggPos = (page: Page) =>
  page.evaluate(() =>
    (window.__cookScene as { getObjectByName: (n: string) => { position: { toArray: () => number[] } } })
      .getObjectByName("grab:egg")
      .position.toArray(),
  );

/** 운반 평면 위 월드 점 (x, z)의 화면 좌표 */
const screenAt = (page: Page, x: number, z: number) =>
  page.evaluate(
    (o) => window.__cookProject!("frying-pan", o)!,
    [x - PAN.x, CARRY_PLANE_Y - PAN.topY, z - PAN.z] as [number, number, number],
  );

async function grabEgg(page: Page) {
  const [ex, ey] = await page.evaluate(() => window.__cookProject!("grab:egg")!);
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  await page.waitForTimeout(150);
}

/** 계란을 (x, z)로 천천히 옮긴다 (잡은 지점 오프셋을 보정) */
async function carryTo(page: Page, x: number, z: number, steps = 25) {
  let want = [x, z];
  for (let i = 0; i < 3; i++) {
    const [sx, sy] = await screenAt(page, want[0], want[1]);
    await page.mouse.move(sx, sy, { steps: i === 0 ? steps : 4 });
    await page.waitForTimeout(350);
    const p = await eggPos(page);
    want = [want[0] + (x - p[0]), want[1] + (z - p[2])];
  }
  return want;
}

/** 팬 앞쪽 유리 위에서 팬 안쪽으로 빠르게 휘둘러 테두리에 부딪힌다 */
async function smashOnRim(page: Page) {
  const aim = await carryTo(page, -0.03, 0.2);
  const dz = aim[1] - 0.2;
  const [tx, ty] = await screenAt(page, aim[0] + 0.01, 0.0 + dz);
  await page.mouse.move(tx, ty, { steps: 3 });
  await page.waitForTimeout(500);
}

test.describe("계란 깨기 (STEP 4)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
  });

  test("조작 없이는 상태가 바뀌지 않는다 (INTACT 유지)", async ({ page }) => {
    await page.waitForTimeout(1500);
    const s = await shell(page);
    expect(s.state).toBe("INTACT");
    expect(s.history).toHaveLength(0);
    // 잡고 바닥 위를 옮기기만 해도 깨지지 않는다
    await grabEgg(page);
    await carryTo(page, -0.2, 0.0);
    await page.mouse.up();
    await page.waitForTimeout(800);
    expect((await shell(page)).state).toBe("INTACT");
  });

  test("천천히 테두리를 넘기면 금이 가지 않는다", async ({ page }) => {
    await grabEgg(page);
    await carryTo(page, -0.03, 0.2);
    await carryTo(page, -0.03, -0.02, 60);
    const s = await shell(page);
    expect(s.state).toBe("INTACT");
    const [x, , z] = await eggPos(page);
    expect(Math.hypot(x - PAN.x, z - PAN.z)).toBeLessThan(PAN.rim - 0.03);
    await page.mouse.up();
  });

  test("테두리에 부딪히면 금이 가고, 더 드래그하면 벌어지고, 놓으면 껍데기가 떨어진다", async ({ page }) => {
    await grabEgg(page);
    await smashOnRim(page);

    // CRACKED: 충격으로만 전이
    let s = await shell(page);
    expect(s.state).toBe("CRACKED");
    expect(s.crack).toBeGreaterThan(0.99);
    expect(s.history[0]).toMatchObject({ from: "INTACT", to: "CRACKED" });
    expect(s.history[0].cause).toMatch(/^impact/);
    // 화면: 아직 통째 껍데기 (반쪽은 벌어지기 시작해야 보인다)
    expect(await page.evaluate(() => (window.__cookScene as { getObjectByName: (n: string) => { visible: boolean } }).getObjectByName("egg").visible)).toBe(true);

    // 덜 벌린 채 놓으면 다시 맞물린다 (CRACKED 유지)
    const p = await eggPos(page);
    const [sx, sy] = await screenAt(page, p[0] + 0.02, p[2]);
    await page.mouse.move(sx, sy, { steps: 6 });
    await page.waitForTimeout(200);
    s = await shell(page);
    expect(s.open).toBeGreaterThan(0);
    expect(s.open).toBeLessThan(1);
    await page.mouse.up();
    s = await shell(page);
    expect(s.state).toBe("CRACKED");
    expect(s.open).toBe(0);
    await expect.poll(async () => (await page.evaluate(() => (window.__cookGrab as { getState: () => { objects: Record<string, { phase: string }> } }).getState().objects.egg.phase)), { timeout: 5000 }).toBe("rest");

    // 다시 집어 드래그 → OPENED
    await grabEgg(page);
    const q = await eggPos(page);
    for (let i = 1; i <= 12; i++) {
      const [a, b] = await screenAt(page, q[0] + (i % 2 ? 0.012 : -0.012) * Math.min(i, 6) * 0.3, q[2] - 0.006 * i);
      await page.mouse.move(a, b, { steps: 3 });
      await page.waitForTimeout(30);
    }
    s = await shell(page);
    expect(s.state).toBe("OPENED");
    expect(s.history.map((h) => h.to)).toEqual(["CRACKED", "OPENED"]);
    await page.waitForTimeout(400);
    const halvesVisible = await page.evaluate(() => {
      const scene = window.__cookScene as { getObjectByName: (n: string) => { visible: boolean; parent: { visible: boolean } } };
      return [scene.getObjectByName("egg").visible, scene.getObjectByName("egg-shell-blunt").parent.visible];
    });
    expect(halvesVisible).toEqual([false, true]);

    // 놓기 → 빈 반쪽 두 개가 표면에 내려앉는다
    await page.mouse.up();
    await page.waitForTimeout(1500);
    s = await shell(page);
    expect(s.discarded).toBe(true);
    const pieces = await page.evaluate(() =>
      ["blunt", "pointy"].map((n) =>
        (window.__cookScene as { getObjectByName: (n: string) => { position: { toArray: () => number[] } } | undefined })
          .getObjectByName(`egg-shell-piece:${n}`)
          ?.position.toArray(),
      ),
    );
    for (const piece of pieces) {
      expect(piece).toBeDefined();
      // 팬 바닥(0.063) 또는 유리(0.057) 근처에 놓임 — 공중에 떠 있지 않음
      expect(piece![1]).toBeLessThan(0.1);
      expect(piece![1]).toBeGreaterThan(0.05);
    }
    // 빈 손(사라진 계란): 더 이상 잡을 수 없다 (그 자리에 떨어진 껍데기는 잡힐 수 있다)
    const grabbedId = () => page.evaluate(() => (window.__cookGrab as { getState: () => { grabbedId: string | null } }).getState().grabbedId);
    const [ex, ey] = await page.evaluate(() => window.__cookProject!("grab:egg")!);
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    await page.waitForTimeout(100);
    expect(await grabbedId()).not.toBe("egg");
    await page.mouse.up();
    await page.waitForTimeout(800);

    // 떨어진 껍데기 반쪽을 다시 집어 팬 밖(유리 위)으로 옮겨 놓는다
    const piecePos = (n: string) =>
      page.evaluate(
        (name) =>
          (window.__cookScene as { getObjectByName: (n: string) => { position: { toArray: () => number[] } } })
            .getObjectByName(name)
            .position.toArray(),
        `egg-shell-piece:${n}`,
      );
    const before = await piecePos("blunt");
    const [px, py] = await page.evaluate((p) => window.__cookProject!("frying-pan", [p[0], p[1] - 0.057, p[2] + 0.025])!, before);
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.waitForTimeout(100);
    expect(await grabbedId()).toBe("egg-shell:blunt");
    // 들려 올라간다
    await page.waitForTimeout(300);
    expect((await piecePos("blunt"))[1]).toBeGreaterThan(before[1] + 0.02);
    const [tx, ty] = await page.evaluate(() => window.__cookProject!("frying-pan", [-0.12, 0.0, 0.12])!);
    await page.mouse.move(tx, ty, { steps: 25 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    expect(await grabbedId()).toBeNull();
    const after = await piecePos("blunt");
    // 팬 밖으로 옮겨져 유리 위에 내려앉았다 (팬 중심에서 14cm 넘게, 유리 높이 근처)
    expect(Math.hypot(after[0] - PAN.x, after[2] - PAN.z)).toBeGreaterThan(0.14);
    expect(after[1]).toBeGreaterThan(0.057);
    expect(after[1]).toBeLessThan(0.085);

    // 다른 반쪽 바로 위에 놓는다 → 서로 관통하지 않고 옆으로 비켜 내려앉는다
    const pointy = await piecePos("pointy");
    const [qx, qy] = await page.evaluate((p) => window.__cookProject!("frying-pan", [p[0], p[1] - 0.057, p[2] + 0.025])!, pointy);
    const [bx, by] = await page.evaluate((p) => window.__cookProject!("frying-pan", [p[0], p[1] - 0.057, p[2] + 0.025])!, after);
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.waitForTimeout(100);
    expect(await grabbedId()).toBe("egg-shell:blunt");
    await page.mouse.move(qx, qy, { steps: 25 });
    await page.waitForTimeout(500);
    // 들고 지나가는 동안에도 다른 반쪽보다 높이 떠 있다
    const carried = await piecePos("blunt");
    expect(carried[1]).toBeGreaterThan(pointy[1] + 0.02);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const scene = window.__cookScene as { getObjectByName: (n: string) => { position: { x: number; y: number; z: number }; userData: { radius: number } } };
      const [a, b] = ["blunt", "pointy"].map((n) => scene.getObjectByName(`egg-shell-piece:${n}`));
      return { d: Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z), min: a.userData.radius + b.userData.radius };
    });
    expect(r.d).toBeGreaterThanOrEqual(r.min);
  });
});

type Contents = { state: "IN_SHELL" | "POURING" | "IN_PAN"; white: number; yolk: string; area: number };
const contents = (page: Page) =>
  page.evaluate(() => {
    const c = (window.__cookEggContents as { getState: () => Contents }).getState();
    return { state: c.state, white: c.white, yolk: c.yolk, area: c.area };
  });

test.describe("흰자·노른자 (STEP 5)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
  });

  test("껍데기가 다 벌어지면 흰자가 먼저, 노른자가 뒤따라 떨어져 팬에 퍼진다", async ({ page }) => {
    await grabEgg(page);
    await smashOnRim(page);
    // 금만 간 상태에서는 쏟아지지 않는다
    expect((await contents(page)).state).toBe("IN_SHELL");

    // 팬 중앙 위에서 벌리기
    const q = await eggPos(page);
    const [qx, qy] = await screenAt(page, q[0], q[2]);
    // 페이지 안에서 진행 상황을 프레임마다 기록 (흰자/노른자 순서 확인)
    await page.evaluate(() => {
      const w = window as unknown as { __pourLog: Array<[number, string, string]> };
      w.__pourLog = [];
      const tick = () => {
        const c = (window.__cookEggContents as { getState: () => Contents }).getState();
        const shellState = (window.__cookEggShell as { getState: () => { state: string } }).getState().state;
        if (c.state !== "IN_SHELL") w.__pourLog.push([c.white, c.yolk, shellState]);
        if (c.state !== "IN_PAN") requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 1; i <= 14 && (await shell(page)).state !== "OPENED"; i++) {
      await page.mouse.move(qx + i * 7, qy, { steps: 2 });
      await page.waitForTimeout(35);
    }
    expect((await shell(page)).state).toBe("OPENED");
    await expect.poll(async () => (await contents(page)).state).not.toBe("IN_SHELL");

    // 흰자 다 퍼지고 노른자 자리 잡을 때까지 (잡은 채로)
    await expect.poll(async () => (await contents(page)).state, { timeout: 10_000 }).toBe("IN_PAN");
    const log = await page.evaluate(() => (window as unknown as { __pourLog: Array<[number, string, string]> }).__pourLog);
    // 다 벌어지기 전, 틈이 생기자마자 흰자가 흘러나오기 시작한다 (노른자는 아직 껍데기 속)
    expect(log.some(([, y, sh]) => sh !== "OPENED" && y === "inShell")).toBe(true);
    // 노른자가 껍데기를 떠나기 전에 흰자가 이미 상당히 흘러나왔다
    const whileYolkInShell = log.filter(([, y]) => y === "inShell").map(([w]) => w);
    expect(Math.max(...whileYolkInShell)).toBeGreaterThan(0.25);
    expect(log.some(([, y]) => y === "falling")).toBe(true);

    const c = await contents(page);
    expect(c.white).toBeCloseTo(1, 2);
    // 퍼진 흰자 면적: 지름 약 10 ~ 15cm
    expect(c.area * 1e4).toBeGreaterThan(70);
    expect(c.area * 1e4).toBeLessThan(200);

    // 노른자: 흰자 위, 팬 바닥보다 높고 볼록하게(납작한 원판 아님)
    const yolk = await page.evaluate(() => {
      const o = (window.__cookScene as { getObjectByName: (n: string) => { position: { toArray: () => number[] }; scale: { toArray: () => number[] } } }).getObjectByName("egg-yolk");
      return { pos: o.position.toArray(), scale: o.scale.toArray() };
    });
    expect(Math.hypot(yolk.pos[0] - PAN.x, yolk.pos[2] - PAN.z)).toBeLessThan(0.085);
    expect(yolk.pos[1]).toBeGreaterThan(0.063 + 0.008);
    expect(yolk.scale[1]).toBeGreaterThan(0.55);
    expect(yolk.scale[1]).toBeLessThan(0.8);

    // 손을 놓으면 빈 껍데기가 떨어지고 내용물은 그대로
    await page.mouse.up();
    await page.waitForTimeout(1500);
    expect((await contents(page)).state).toBe("IN_PAN");

    // 화면: 노른자는 주황빛 노랑, 흰자는 바닥이 비치는 반투명 (불투명한 흰 원판이 아님)
    const [yx, , yz] = yolk.pos;
    const points = await page.evaluate(
      ([x, z]) => {
        const at = (dx: number, y: number, dz: number) => window.__cookProject!("frying-pan", [x + dx, y, z + 0.025 + dz])!;
        return {
          yolk: window.__cookProject!("egg-yolk")!,
          // 노른자에서 3.5cm 떨어진 흰자 위 (팬 바닥 높이)
          white: at(-0.035, 0.009, 0),
          // 흰자가 닿지 않은 팬 바닥 (팬 중심에서 왼쪽 뒤)
          bare: at(-0.1 - x, 0.006, -0.04 - z),
        };
      },
      [yx, yz] as const,
    );
    const png = await page.screenshot();
    const rgb = await page.evaluate(
      async ({ b64, pts }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const sx = img.width / window.innerWidth;
        // 한 점이 우연히 반사광에 걸리지 않게 주변 9×9 픽셀 중 밝기 중앙값인 픽셀을 쓴다
        return pts.map(([x, y]) => {
          const d = ctx.getImageData(Math.round(x * sx) - 4, Math.round(y * sx) - 4, 9, 9).data;
          const px: number[][] = [];
          for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2], d[i + 3]]);
          px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
          return px[px.length >> 1];
        });
      },
      { b64: png.toString("base64"), pts: [points.yolk, points.white, points.bare] },
    );
    const [r, g, b] = rgb[0];
    expect(r).toBeGreaterThan(170);
    expect(g).toBeGreaterThan(70);
    expect(b).toBeLessThan(90);
    expect(r).toBeGreaterThan(g);
    const luma = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    const white = luma(rgb[1]);
    const bare = luma(rgb[2]);
    await test.info().attach("pour", { body: png, contentType: "image/png" });
    expect(white).toBeGreaterThan(bare + 4);
    expect(white).toBeLessThan(170);
  });
});

test.describe("팬 가장자리에서 벌리려 할 때", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
  });

  test("테두리 밖에서는 벌어지지 않고, 팬 위로 옮겨 벌리면 흰자·노른자가 모두 팬 바닥에 떨어진다", async ({ page }) => {
    await grabEgg(page);
    // 팬 앞 유리 위에서 앞쪽 테두리를 바깥에서 친다 (테두리를 넘지 않고 그 자리에 머문다)
    const aim = await carryTo(page, -0.03, 0.2);
    const [fx, fy] = await screenAt(page, aim[0], aim[1] - 0.2 + 0.11);
    await page.mouse.move(fx, fy, { steps: 1 });
    await page.waitForTimeout(500);
    // 한 바퀴 다 금이 가야 벌릴 수 있다
    expect((await shell(page)).crack).toBeGreaterThan(0.99);
    // 테두리에 걸친 채 벌리려 한다 → 금만 간 채 맞물려 있고, 아무것도 쏟아지지 않는다
    let q = await eggPos(page);
    expect(Math.hypot(q[0] - PAN.x, q[2] - PAN.z)).toBeGreaterThan(0.11);
    let [qx, qy] = await screenAt(page, q[0], q[2]);
    for (let i = 1; i <= 14; i++) {
      await page.mouse.move(qx + (i % 2 ? 1 : -1) * 6, qy + (i % 3) * 2 + 8, { steps: 2 });
      await page.waitForTimeout(35);
    }
    let s = await shell(page);
    expect(s.state).toBe("CRACKED");
    expect(s.open).toBe(0);
    expect((await contents(page)).state).toBe("IN_SHELL");

    // 팬 가운데 위로 옮겨 벌린다
    await carryTo(page, 0.0, 0.0, 20);
    q = await eggPos(page);
    [qx, qy] = await screenAt(page, q[0], q[2]);
    for (let i = 1; i <= 16 && (await shell(page)).state !== "OPENED"; i++) {
      await page.mouse.move(qx + i * 7, qy, { steps: 2 });
      await page.waitForTimeout(35);
    }
    s = await shell(page);
    expect(s.state).toBe("OPENED");
    await expect.poll(async () => (await contents(page)).state, { timeout: 12_000 }).toBe("IN_PAN");
    await page.mouse.up();

    // 흰자가 팬 테두리를 넘지 않았다 (흘러내린 막 없음), 노른자는 팬 바닥 위
    const r = await page.evaluate(() => {
      type Geo = { drawRange: { count: number } };
      const scene = window.__cookScene as { getObjectByName: (n: string) => { geometry: Geo; position: { x: number; y: number; z: number } } };
      const yolk = scene.getObjectByName("egg-yolk").position;
      return { drape: scene.getObjectByName("egg-white-drape").geometry.drawRange.count, yolk: [yolk.x, yolk.y, yolk.z] };
    });
    expect(r.drape).toBe(0);
    expect(Math.hypot(r.yolk[0] - PAN.x, r.yolk[2] - PAN.z)).toBeLessThan(0.085);
    expect(r.yolk[1]).toBeGreaterThan(0.063);
  });
});

test.describe("팬 밖으로 흘렸을 때", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
  });

  test("테두리를 넘은 흰자는 공중에 커튼처럼 걸리지 않고 팬 바깥벽에 붙어 흘러내린다", async ({ page }) => {
    await grabEgg(page);
    await smashOnRim(page);
    await carryTo(page, 0.0, 0.0, 20);
    const q = await eggPos(page);
    const [qx, qy] = await screenAt(page, q[0], q[2]);
    for (let i = 1; i <= 16 && (await shell(page)).state !== "OPENED"; i++) {
      await page.mouse.move(qx + i * 7, qy, { steps: 2 });
      await page.waitForTimeout(35);
    }
    // 쏟아지는 흰자 일부가 앞 왼쪽 테두리 위로 넘쳐 흐른다 (테두리에 걸쳐 1초 동안 흰자를 붓는다)
    await page.evaluate(
      (pan) =>
        new Promise<void>((done) => {
          type Field = { deposit: (x: number, z: number, v: number, r: number) => void };
          const stream = (window.__cookScene as { getObjectByName: (n: string) => { userData: { field?: Field } } }).getObjectByName("egg-white-stream");
          const a = Math.atan2(0.6, -0.8);
          let n = 0;
          const id = setInterval(() => {
            stream.userData.field?.deposit(pan.x + Math.cos(a) * pan.rim, pan.z + Math.sin(a) * pan.rim, 1.2e-7, 0.006);
            if (++n >= 60) {
              clearInterval(id);
              done();
            }
          }, 16);
        }),
      PAN,
    );
    await expect.poll(async () => (await contents(page)).state, { timeout: 12_000 }).toBe("IN_PAN");
    await page.mouse.up();
    await page.waitForTimeout(1500);

    const r = await page.evaluate((pan) => {
      type Geo = { drawRange: { count: number }; attributes: { position: { array: Float32Array } } };
      const scene = window.__cookScene as { getObjectByName: (n: string) => { geometry: Geo } };
      const g = scene.getObjectByName("egg-white-drape").geometry;
      const a = g.attributes.position.array;
      let low = 0;
      let air = 0;
      for (let v = 0; v < g.drawRange.count; v++) {
        const h = a[v * 3 + 1] - pan.topY;
        const rr = Math.hypot(a[v * 3] - pan.x, a[v * 3 + 2] - pan.z);
        // 팬 바닥에서 3.5cm 아래 (바깥벽 반지름 13.4cm 이하) 테두리 근처의 막 정점
        if (h > 0.004 && h < 0.035 && rr > 0.1 && rr < 0.16) {
          low++;
          if (rr > 0.138) air++;
        }
      }
      return { count: g.drawRange.count, low, air };
    }, PAN);
    // 흘러내린 막이 있고, 그 아랫부분은 오므라드는 바깥벽에 붙어 있다 (테두리 바깥 허공에 걸리지 않음)
    expect(r.count).toBeGreaterThan(0);
    expect(r.low).toBeGreaterThan(0);
    expect(r.air).toBe(0);
    // 김은 뜨거운 팬 안의 흰자에서 피어오른다 (넘친 흰자 쪽으로 끌려가지 않는다)
    const heat = await page.evaluate(() => (window.__cookEggContents as { getState: () => { heatCenter: [number, number] | null } }).getState().heatCenter);
    expect(heat).not.toBeNull();
    expect(Math.hypot(heat![0] - PAN.x, heat![1] - PAN.z)).toBeLessThan(0.1);
  });
});

type CookStats = { progress: number; inner: number; outer: number; innerBrown: number; outerBrown: number; std: number; mean: number; yolkCook: number };

/** 흰자 위치별 익힘: 노른자 주변(2.5cm 안) vs 바깥 가장자리(가장 먼 15%) */
const cookStats = (page: Page) =>
  page.evaluate((): CookStats => {
    type Attr = { array: Float32Array; count: number };
    type Obj = { geometry: { attributes: Record<string, Attr> }; position: { x: number; z: number }; material: { userData: Record<string, Record<string, { value: number }>> } };
    const scene = window.__cookScene as { getObjectByName: (n: string) => Obj };
    const { position, thick, cook } = scene.getObjectByName("egg-white").geometry.attributes;
    const yolk = scene.getObjectByName("egg-yolk");
    const cells: Array<[number, number, number]> = [];
    for (let k = 0; k < thick.count; k++) {
      if (thick.array[k] < 0.0004) continue;
      const d = Math.hypot(position.array[k * 3] - yolk.position.x, position.array[k * 3 + 2] - yolk.position.z);
      cells.push([d, cook.array[k * 2], cook.array[k * 2 + 1]]);
    }
    const far = Math.max(...cells.map((c) => c[0]));
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const inner = cells.filter((c) => c[0] < 0.025);
    const outer = cells.filter((c) => c[0] > far * 0.85);
    const mean = avg(cells.map((c) => c[1]));
    return {
      progress: (window.__cookEggCooking as { getState: () => { progress: number } }).getState().progress,
      inner: avg(inner.map((c) => c[1])),
      outer: avg(outer.map((c) => c[1])),
      innerBrown: avg(inner.map((c) => c[2])),
      outerBrown: avg(outer.map((c) => c[2])),
      mean,
      std: Math.sqrt(avg(cells.map((c) => (c[1] - mean) ** 2))),
      yolkCook: yolk.material.userData.cookUniforms.uYolkCook.value,
    };
  });

/** 화면 점들의 밝기 (devicePixelRatio 보정) */
async function lumaAt(page: Page, pts: number[][]) {
  const png = await page.screenshot();
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
      const sx = img.width / window.innerWidth;
      return pts.map(([x, y]) => {
        const p = ctx.getImageData(Math.round(x * sx), Math.round(y * sx), 1, 1).data;
        return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      });
    },
    { b64: png.toString("base64"), pts },
  );
}

test.describe("익히기 (STEP 6)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
  });

  test("진행도가 시간에 따라 오르고, 가장자리부터 익어 노릇해지며, 노른자도 서서히 변한다", async ({ page }) => {
    const cooking = () =>
      page.evaluate(() => (window.__cookEggCooking as { getState: () => { progress: number; heating: boolean } }).getState());
    // 깨기 전에는 가열하지 않는다
    expect(await cooking()).toMatchObject({ progress: 0, heating: false });

    await grabEgg(page);
    await smashOnRim(page);
    const q = await eggPos(page);
    const [qx, qy] = await screenAt(page, q[0], q[2]);
    for (let i = 1; i <= 14 && (await shell(page)).state !== "OPENED"; i++) {
      await page.mouse.move(qx + i * 7, qy, { steps: 2 });
      await page.waitForTimeout(35);
    }
    await expect.poll(async () => (await contents(page)).state, { timeout: 10_000 }).toBe("IN_PAN");
    // 껍데기는 팬 밖에 버린다
    await carryTo(page, -0.215, 0.12, 15);
    await page.mouse.up();

    // 흰자가 팬에 닿은 순간부터 가열, 시간에 따라 증가
    const c0 = await cooking();
    expect(c0.heating).toBe(true);
    expect(c0.progress).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    expect((await cooking()).progress).toBeGreaterThan(c0.progress);

    // 흰자 위 화면 점: 노른자에서 4cm 떨어진 곳
    const yolkPos = await page.evaluate(() =>
      (window.__cookScene as { getObjectByName: (n: string) => { position: { toArray: () => number[] } } }).getObjectByName("egg-yolk").position.toArray(),
    );
    const whitePt = await page.evaluate(
      ([x, z]) => window.__cookProject!("frying-pan", [x - 0.04, 0.009, z + 0.025])!,
      [yolkPos[0], yolkPos[2]] as const,
    );

    // 불을 세게 해서 빨리 진행
    await page.evaluate(() => (window.__cookEggCooking as { getState: () => { setHeat: (h: number) => void } }).getState().setHeat(8));
    await expect.poll(async () => (await cooking()).progress, { timeout: 20_000 }).toBeGreaterThan(0.25);
    await page.evaluate(() => (window.__cookEggCooking as { getState: () => { setHeat: (h: number) => void } }).getState().setHeat(0));
    await page.waitForTimeout(300);
    const mid = await cookStats(page);
    const [midLuma] = await lumaAt(page, [whitePt]);
    await test.info().attach("cook-mid", { body: await page.screenshot(), contentType: "image/png" });
    // 위치마다 익힘이 다르다: 가장자리가 먼저, 노른자 주변 두꺼운 흰자는 아직
    expect(mid.outer).toBeGreaterThan(0.8);
    expect(mid.inner).toBeLessThan(0.45);
    expect(mid.std).toBeGreaterThan(0.15);
    expect(mid.yolkCook).toBeGreaterThan(0);

    await page.evaluate(() => (window.__cookEggCooking as { getState: () => { setHeat: (h: number) => void } }).getState().setHeat(8));
    await expect.poll(async () => (await cooking()).progress, { timeout: 30_000 }).toBe(1);
    await page.waitForTimeout(300);
    const end = await cookStats(page);
    const [endLuma] = await lumaAt(page, [whitePt]);
    await test.info().attach("cook-end", { body: await page.screenshot(), contentType: "image/png" });
    // 다 익음: 흰자 전체가 굳고, 얇은 가장자리만 노릇하게
    expect(end.mean).toBeGreaterThan(0.95);
    expect(end.outerBrown).toBeGreaterThan(0.18);
    expect(end.outerBrown).toBeGreaterThan(end.innerBrown + 0.15);
    expect(end.innerBrown).toBeLessThan(0.05);
    // 노른자는 끝나도 반숙 (겉만 변함)
    expect(end.yolkCook).toBeGreaterThan(mid.yolkCook);
    expect(end.yolkCook).toBeLessThan(1);
    // 화면: 반투명하던 흰자가 불투명한 흰색으로
    expect(endLuma).toBeGreaterThan(midLuma + 30);
    expect(endLuma).toBeGreaterThan(150);
  });
});

type SoundLog = Array<{ name: string; at: number; params?: Record<string, number> }>;

test.describe("소리·시각 효과 (STEP 7)", () => {
  test("조작과 소리가 같은 순간에 나고, 지글거림이 조리 상태를 따르며, 김·기름·거품이 오류 없이 그려진다", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 200));
    });
    await page.goto("/");
    await waitForScene(page);
    // 조작 전에는 소리가 나지 않는다 (자동재생 금지)
    expect(await page.evaluate(() => (window as { __cookAudio?: { log: SoundLog } }).__cookAudio?.log.length ?? 0)).toBe(0);

    // 상태 변화 시각을 페이지 안에서 기록
    await page.evaluate(() => {
      const w = window as unknown as { __marks: Array<{ name: string; at: number }> };
      w.__marks = [];
      type S = { getState: () => unknown; subscribe: (f: (s: Record<string, unknown>, p: Record<string, unknown>) => void) => void };
      (window.__cookEggShell as S).subscribe((s, p) => {
        if ((s.impacts as number) > (p.impacts as number)) w.__marks.push({ name: "impact", at: performance.now() });
        if (s.state !== p.state) w.__marks.push({ name: s.state as string, at: performance.now() });
      });
      (window.__cookEggContents as S).subscribe((s, p) => {
        if (s.yolk !== p.yolk) w.__marks.push({ name: `yolk-${s.yolk}`, at: performance.now() });
      });
    });

    await grabEgg(page);
    await smashOnRim(page);
    const q = await eggPos(page);
    const [qx, qy] = await screenAt(page, q[0], q[2]);
    for (let i = 1; i <= 14 && (await shell(page)).state !== "OPENED"; i++) {
      await page.mouse.move(qx + i * 7, qy, { steps: 2 });
      await page.waitForTimeout(35);
    }
    await expect.poll(async () => (await contents(page)).state, { timeout: 10_000 }).toBe("IN_PAN");

    const { marks, sounds, running } = await page.evaluate(() => {
      const a = (window as unknown as { __cookAudio: { log: SoundLog; engine: { ctx: AudioContext } } }).__cookAudio;
      return {
        marks: (window as unknown as { __marks: Array<{ name: string; at: number }> }).__marks,
        sounds: a.log.filter((s) => s.name !== "pop"),
        running: a.engine.ctx.state,
      };
    });
    expect(running).toBe("running");
    const near = (mark: string, sound: string, within = 20) => {
      const m = marks.find((x) => x.name === mark);
      expect(m, mark).toBeTruthy();
      const s = sounds.filter((x) => x.name === sound).map((x) => Math.abs(x.at - m!.at));
      expect(Math.min(...s), `${sound} ↔ ${mark}`).toBeLessThan(within);
    };
    // 부딪힌 순간 "톡" + "바삭", 다 벌어지는 순간 막이 찢어지는 소리, 노른자가 닿는 순간 옅은 젖은 소리
    near("impact", "knock");
    near("impact", "crack");
    near("OPENED", "tear");
    near("yolk-landed", "plop");
    // 흰자 덩어리가 팬에 닿는 소리는 노른자보다 먼저
    const firstWhite = sounds.find((s) => s.name === "splat" && (s.params?.hot ?? 0) > 0)!;
    expect(firstWhite.at).toBeLessThan(marks.find((m) => m.name === "yolk-landed")!.at);
    // 흰자가 줄기로 이어져 떨어지는 동안 착지 소리가 연달아("퉁퉁") 나지 않는다
    expect(sounds.filter((s) => s.name === "splat").length).toBe(1);
    // 미끄러지며 닿아 있는 동안 "톡"이 연달아 나지 않는다
    expect(sounds.filter((s) => s.name === "knock").length).toBeLessThan(4);

    // 지글거림: 날흰자가 닿은 직후가 가장 크고, 익어 가며 잦아든다. 실제 출력에 소리가 있다
    const sizzle = () => page.evaluate(() => (window as unknown as { __cookSizzle: { value: number } }).__cookSizzle.value);
    const rms = () =>
      page.evaluate(() => {
        const an = (window as unknown as { __cookAudio: { engine: { analyser: AnalyserNode } } }).__cookAudio.engine.analyser;
        const d = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(d);
        return Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length);
      });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const early = await sizzle();
    expect(early).toBeGreaterThan(0.3);
    expect(await rms()).toBeGreaterThan(0.003);
    // 김이 피어오르고, 기름막이 깔려 있다
    expect(await page.evaluate(() => (window.__cookScene as { getObjectByName: (n: string) => { scale: { x: number } } }).getObjectByName("steam").scale.x)).toBe(1);
    expect(await page.evaluate(() => !!(window.__cookScene as { getObjectByName: (n: string) => unknown }).getObjectByName("oil-film"))).toBe(true);

    await page.evaluate(() => (window.__cookEggCooking as { getState: () => { setHeat: (h: number) => void } }).getState().setHeat(10));
    await expect.poll(() => page.evaluate(() => (window.__cookEggCooking as { getState: () => { progress: number } }).getState().progress), { timeout: 30_000 }).toBe(1);
    await page.waitForTimeout(500);
    const late = await sizzle();
    // 지글거림 세기는 불 세기에도 비례하므로, 불을 원래대로 돌린 뒤 처음과 비교한다
    await page.evaluate(() => (window.__cookEggCooking as { getState: () => { setHeat: (h: number) => void } }).getState().setHeat(1));
    await page.waitForTimeout(800);
    const settled = await sizzle();
    expect(late).toBeGreaterThan(0);
    expect(settled).toBeLessThan(early * 0.75);
    expect(settled).toBeGreaterThan(0.05);

    await test.info().attach("step7", { body: await page.screenshot(), contentType: "image/png" });
    expect(errors.filter((e) => !e.includes("THREE.Clock"))).toEqual([]);
  });
});

test.describe("병아리 계란 (깜짝 연출)", () => {
  test("자동화 브라우저에서는 늘 보통 계란이다 (다른 테스트가 흔들리지 않게)", async ({ page }) => {
    await page.goto("/");
    await waitForScene(page);
    const phase = await page.evaluate(() => (window.__cookChick as { getState: () => { phase: string } }).getState().phase);
    expect(phase).toBe("none");
  });

  test("병아리가 든 계란을 벌리면 흰자·노른자 대신 병아리가 튀어나와 화면 밖으로 달아난다", async ({ page }) => {
    await page.goto("/?chick=1");
    await waitForScene(page);
    const chick = () =>
      page.evaluate(() => {
        const phase = (window.__cookChick as { getState: () => { phase: string } }).getState().phase;
        const o = (window.__cookScene as { getObjectByName: (n: string) => { visible: boolean; position: { toArray: () => number[] } } }).getObjectByName("chick");
        return { phase, visible: o.visible, pos: o.position.toArray() };
      });
    expect((await chick()).phase).toBe("inEgg");

    await grabEgg(page);
    await smashOnRim(page);
    const q = await eggPos(page);
    const [qx, qy] = await screenAt(page, q[0], q[2]);
    for (let i = 1; i <= 14 && (await shell(page)).state !== "OPENED"; i++) {
      await page.mouse.move(qx + i * 7, qy, { steps: 2 });
      await page.waitForTimeout(35);
    }
    expect((await shell(page)).state).toBe("OPENED");

    // 튀어나와 보인다
    await expect.poll(async () => (await chick()).phase).toBe("out");
    await expect.poll(async () => (await chick()).visible).toBe(true);
    // 화면 밖으로 사라진다: 마지막 위치는 화면 가장자리 너머
    await expect.poll(async () => (await chick()).phase, { timeout: 5_000 }).toBe("gone");
    const last = await chick();
    expect(last.visible).toBe(false);
    const ndc = await page.evaluate(() => {
      const [sx, sy] = window.__cookProject!("chick", [0, 0.03, 0])!;
      return [sx / window.innerWidth, sy / window.innerHeight];
    });
    expect(ndc[0] < 0 || ndc[0] > 1 || ndc[1] < 0 || ndc[1] > 1).toBe(true);

    // 흰자·노른자는 쏟아지지 않았고 조리도 시작되지 않는다
    expect((await contents(page)).state).toBe("IN_SHELL");
    const heating = await page.evaluate(() => (window.__cookEggCooking as { getState: () => { heating: boolean } }).getState().heating);
    expect(heating).toBe(false);
  });
  test("팬 벽 어디에서 달아나든 멈칫하지 않고 한 번에 팬을 뛰어넘는다", async ({ page }) => {
    // 벽 위쪽(테두리 바로 아래)에서 출발하는 경우가 가장 까다롭다: 테두리 너머는 낮아서 바로 앞만 보면 막힌다
    for (const [start, dir] of [
      [0, 0],
      [0.1, Math.PI / 2],
      [0.12, 0],
      [0.13, Math.PI],
      [0.13, -Math.PI / 4],
    ]) {
      await page.goto("/?chick=1");
      await waitForScene(page);
      const outAt = await page.evaluate(async ([start, dir]) => {
        const w = window as unknown as {
          __cookScene: { getObjectByName: (n: string) => { position: { x: number; z: number; set: (x: number, y: number, z: number) => void } } };
          __cookChick: { getState: () => { hatch: () => void; phase: string } };
          __cookChickDir?: number;
        };
        w.__cookScene.getObjectByName("grab:egg").position.set(Math.cos(dir) * start, 0.035, -0.025 + Math.sin(dir) * start);
        w.__cookChickDir = dir;
        w.__cookChick.getState().hatch();
        const chick = w.__cookScene.getObjectByName("chick");
        const t0 = performance.now();
        while (performance.now() - t0 < 3000) {
          await new Promise((r) => requestAnimationFrame(r));
          if (Math.hypot(chick.position.x, chick.position.z + 0.025) > 0.15) return performance.now() - t0;
        }
        return null;
      }, [start, dir]);
      // 내려앉아 두리번(0.35s) + 달려서 뛰어넘기. 벽에 막혀 멈칫하면 1초를 넘는다
      expect(outAt, `start ${start}, dir ${dir}`).not.toBeNull();
      expect(outAt!, `start ${start}, dir ${dir}`).toBeLessThan(1000);
    }
  });
});
