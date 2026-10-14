// 계란프라이 전체 시나리오를 실제 GPU로 돌리며 단계별 성능·자원을 측정하고 스크린샷을 남긴다 (STEP 8 점검).
// 사용: node scripts/audit.mjs [outDir]
//   UNCAPPED=1  vsync를 풀어 실제 처리량(프레임당 ms)을 잰다 (기본: 60Hz 제한 아래 프레임 간격)
//   W, H, DPR   화면 크기 (기본 1280×800@2)
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] ?? "audit";
mkdirSync(out, { recursive: true });
const base = process.env.BASE_URL ?? "http://localhost:3000";
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 800);
const DPR = Number(process.env.DPR ?? 2);
const CARRY_PLANE_Y = 0.067;

const browser = await chromium.launch({
  channel: "chromium",
  args: [
    "--use-angle=metal",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-precise-memory-info",
    ...(process.env.UNCAPPED ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : []),
  ],
});
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
// THROTTLE=4: 메인 스레드를 n배 느리게 (중급 노트북·모바일 CPU 근사)
if (process.env.THROTTLE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.THROTTLE) });

const t0 = Date.now();
await page.goto(base);
await page.waitForFunction(
  () => (window.__cook?.sceneReadyFrames ?? 0) > 30 && !!window.__cookProject?.("grab:egg") && !!window.__cookEggShell,
  null,
  { timeout: 60_000 },
);
const loadMs = Date.now() - t0;

// 프레임 기록: 단계 이름별로 프레임 간격을 모은다
await page.evaluate(() => {
  window.__audit = { phase: "load", frames: {} };
  let last = performance.now();
  const f = (t) => {
    const a = window.__audit;
    (a.frames[a.phase] ??= []).push(t - last);
    if (t - last > 25) {
      const c = window.__cookEggContents?.getState();
      (a.long ??= []).push({ t: Math.round(t), ms: Math.round(t - last), phase: a.phase, shell: window.__cookEggShell?.getState().state, contents: c?.state, white: c && +c.white.toFixed(2), dpr: window.__cook?.info?.dpr });
    }
    last = t;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});
const phase = (name) => page.evaluate((n) => { window.__audit.phase = n; }, name);

const heap = async () => {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners };
};

// 렌더러 상태 + 텍스처·렌더 타깃 목록 (GPU 메모리 추정)
const renderer = () =>
  page.evaluate(() => {
    const info = window.__cook.info;
    const scene = window.__cookScene;
    const seen = new Map();
    const add = (tex, owner) => {
      if (!tex || seen.has(tex.uuid)) return;
      const img = tex.image;
      const w = img?.width ?? img?.data?.width ?? 0;
      const h = img?.height ?? img?.data?.height ?? 0;
      const bpp = tex.type === 1016 /* HalfFloat */ ? 8 : tex.type === 1015 /* Float */ ? 16 : 4;
      const mip = tex.generateMipmaps && tex.minFilter !== 1006 && tex.minFilter !== 1003 ? 4 / 3 : 1;
      seen.set(tex.uuid, { owner, name: tex.name, w, h, bytes: Math.round(w * h * bpp * mip), type: tex.type, aniso: tex.anisotropy });
    };
    scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) for (const k of Object.keys(m)) if (m[k]?.isTexture) add(m[k], `${o.name || o.type}.${k}`);
      if (o.shadow?.map?.texture) add(o.shadow.map.texture, `${o.name || o.type}.shadow`);
    });
    if (scene.environment) add(scene.environment, "scene.environment");
    if (scene.background?.isTexture) add(scene.background, "scene.background");
    const list = [...seen.values()].sort((a, b) => b.bytes - a.bytes);
    let meshes = 0, visible = 0;
    scene.traverseVisible((o) => { if (o.isMesh) visible++; });
    scene.traverse((o) => { if (o.isMesh) meshes++; });
    return {
      calls: info?.calls, triangles: info?.triangles, textures: info?.textures, programs: info?.programs, dpr: info?.dpr,
      meshes, visibleMeshes: visible,
      textureMB: +(list.reduce((s, t) => s + t.bytes, 0) / 1048576).toFixed(1),
      topTextures: list.slice(0, 12).map((t) => `${t.owner} ${t.w}x${t.h} ${(t.bytes / 1048576).toFixed(2)}MB aniso${t.aniso}`),
    };
  });

const report = { viewport: `${W}x${H}@${DPR}`, uncapped: !!process.env.UNCAPPED, loadMs, phases: {}, snapshots: {} };
const snap = async (name) => {
  // 측정(강제 GC 포함)으로 생긴 끊김은 단계 통계에서 뺀다
  const prev = await page.evaluate(() => window.__audit.phase);
  await phase("measure");
  await page.waitForTimeout(700); // 렌더 통계는 30프레임마다 갱신
  report.snapshots[name] = { ...(await renderer()), ...(await heap()), meshesByCost: await meshCost() };
  await phase(prev);
};
// 보이는 메시별 삼각형 수 (큰 순)
const meshCost = () =>
  page.evaluate(() => {
    const rows = [];
    window.__cookScene.traverseVisible((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      const idx = g.index ? g.index.count : g.attributes.position.count;
      const range = Math.min(idx, g.drawRange.count);
      const mats = Array.isArray(o.material) ? o.material.length : 1;
      rows.push([`${o.name || o.parent?.name || o.type}`, Math.round(range / 3), mats, o.castShadow ? "cast" : "", o.material.transparent ? "transp" : ""]);
    });
    return rows.sort((a, b) => b[1] - a[1]).slice(0, 14).map((r) => r.join(" "));
  });
// 스크린샷은 합성기를 잠깐 멈추게 해 긴 프레임을 만든다 → 그동안은 별도 단계로 기록 (NOSHOT=1: 촬영 생략)
const shot = async (name, clip) => {
  if (process.env.NOSHOT) return;
  const prev = await page.evaluate(() => window.__audit.phase);
  await phase("screenshot");
  await page.screenshot({ path: `${out}/${name}.png`, clip });
  await page.waitForTimeout(100);
  await phase(prev);
};
const panClip = async () => {
  const c = await page.evaluate(() => window.__cookProject("frying-pan", [0, 0.03, 0]));
  return { x: c[0] - 300, y: c[1] - 220, width: 600, height: 400 };
};

const at = (x, z) => page.evaluate((o) => window.__cookProject("frying-pan", o), [x, CARRY_PLANE_Y - 0.057, z + 0.025]);
const eggPos = () => page.evaluate(() => window.__cookScene.getObjectByName("grab:egg").position.toArray());
const shellState = () => page.evaluate(() => window.__cookEggShell.getState().state);
async function carryTo(x, z, steps = 25) {
  let want = [x, z];
  for (let i = 0; i < 3; i++) {
    const [sx, sy] = await at(want[0], want[1]);
    await page.mouse.move(sx, sy, { steps: i === 0 ? steps : 4 });
    await page.waitForTimeout(300);
    const p = await eggPos();
    want = [want[0] + (x - p[0]), want[1] + (z - p[2])];
  }
  return want;
}

// 1~2. 접속 → 장면
await phase("idle");
await page.waitForTimeout(2500);
await shot("01-scene");
await snap("idle");

// 3~4. 계란 선택 → 이동
await phase("carry");
const [ex, ey] = await page.evaluate(() => window.__cookProject("grab:egg"));
await page.mouse.move(ex, ey);
await page.mouse.down();
await page.waitForTimeout(200);
await shot("02-grabbed");
const aim = await carryTo(-0.03, 0.2);
await snap("carry");

// 5~6. 테두리에 부딪혀 깨기
await phase("crack");
const dz = aim[1] - 0.2;
const [tx, ty] = await at(aim[0] + 0.01, dz);
await page.mouse.move(tx, ty, { steps: 3 });
await page.waitForTimeout(500);
await shot("03-cracked", await panClip());

// 7. 벌려서 흰자·노른자 떨어뜨리기
await phase("pour");
const q = await eggPos();
const [qx, qy] = await at(q[0], q[2]);
for (let i = 1; i <= 14 && (await shellState()) !== "OPENED"; i++) {
  await page.mouse.move(qx + i * 7, qy + Math.sin(i) * 4, { steps: 2 });
  await page.waitForTimeout(90);
  if (i === 4) await shot("04-opening", await panClip());
}
await page.waitForTimeout(250);
await shot("05-pouring", await panClip());
await page.waitForFunction(() => window.__cookEggContents.getState().state === "IN_PAN", null, { timeout: 15_000 });
await snap("pour");
// 껍데기는 팬 밖에 버린다
await carryTo(-0.215, 0.12, 20);
await page.mouse.up();
await page.waitForTimeout(1200);
await shot("06-in-pan", await panClip());

// 8. 익는 과정 (실시간 몇 초 → 이후 빠르게)
await phase("cook");
await page.waitForTimeout(3000);
await snap("cook-early");
await page.evaluate(() => window.__cookEggCooking.getState().setHeat(4));
const yolkClip = async () => {
  const y = await page.evaluate(() => window.__cookProject("egg-yolk"));
  return { x: y[0] - 200, y: y[1] - 130, width: 400, height: 260 };
};
for (const target of [0.25, 0.5, 0.75, 1]) {
  await page.waitForFunction((t) => window.__cookEggCooking.getState().progress >= t, target, { timeout: 120_000 });
  const tag = String(Math.round(target * 100)).padStart(3, "0");
  await shot(`07-cook-${tag}`, await panClip());
  await shot(`07-cook-${tag}-closeup`, await yolkClip());
}
await snap("cook-done");

// 다 익은 뒤 가만히 두기 (자원이 계속 늘지 않는지)
await phase("done");
await page.waitForTimeout(6000);
await snap("done+6s");
await shot("08-done-full");

// OBJCOST=1: 다 익은 장면에서 물체를 하나씩 빼 보며 프레임 시간 차이 (UNCAPPED=1과 함께)
if (process.env.OBJCOST) {
  const p50 = () =>
    page.evaluate(
      () =>
        new Promise((r) => {
          const t = [];
          let l = performance.now();
          const f = (n) => {
            t.push(n - l);
            l = n;
            if (t.length < 400) requestAnimationFrame(f);
            else r(t.sort((a, b) => a - b)[200]);
          };
          requestAnimationFrame(f);
        }),
    );
  const setVis = (name, v) =>
    page.evaluate(([n, v]) => {
      window.__cookScene.traverse((o) => {
        if ((o.name === n || o.parent?.name === n) && o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.visible = v));
      });
    }, [name, v]);
  await phase("objcost");
  const base = await p50();
  report.objectCost = { base: +base.toFixed(2) };
  for (const name of ["egg-white", "egg-white-collar", "egg-yolk", "egg-white-drape", "steam", "oil-film", "egg-shell-piece:blunt", "egg-shell-piece:pointy", "frying-pan", "induction-cooktop"]) {
    await setVis(name, false);
    const t = await p50();
    await setVis(name, true);
    report.objectCost[name] = +(base - t).toFixed(2);
  }
}
report.phases = await page.evaluate(() => {
  const r = {};
  for (const [name, ft] of Object.entries(window.__audit.frames)) {
    const s = [...ft].sort((a, b) => a - b);
    const q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
    r[name] = { frames: s.length, p50: q(0.5), p95: q(0.95), max: q(1), fps: +(1000 / q(0.5)).toFixed(1), over20ms: s.filter((x) => x > 20).length };
  }
  return r;
});
report.long = await page.evaluate(() => window.__audit.long ?? []);
report.errors = errors;
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
