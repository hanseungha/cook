// 계란을 팬 테두리에 부딪혀 깨고 벌린 뒤 껍데기를 놓는 과정을 실제 GPU로 촬영한다.
// 사용: node scripts/crack-demo.mjs [outDir]   (VIDEO=1 이면 webm 녹화, NOSHOT=1 이면 프레임 시간만 측정)
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "crack-demo";
mkdirSync(out, { recursive: true });
const base = process.env.BASE_URL ?? "http://localhost:3000";
const CARRY_PLANE_Y = 0.067; // 바닥에서 집은 계란의 운반 평면 높이

const browser = await chromium.launch({
  channel: "chromium",
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({
  viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) },
  deviceScaleFactor: process.env.VIDEO ? 1 : 2,
  recordVideo: process.env.VIDEO ? { dir: out, size: { width: 1280, height: 800 } } : undefined,
});
const page = await context.newPage();
await page.goto(base);
await page.waitForFunction(
  () => (window.__cook?.sceneReadyFrames ?? 0) > 30 && !!window.__cookProject?.("grab:egg") && !!window.__cookEggShell,
  null,
  { timeout: 60_000 },
);

const at = (x, z) => page.evaluate((o) => window.__cookProject("frying-pan", o), [x, CARRY_PLANE_Y - 0.057, z + 0.025]);
const eggPos = () => page.evaluate(() => window.__cookScene.getObjectByName("grab:egg").position.toArray());
const state = () => page.evaluate(() => window.__cookEggShell.getState().state);
const shot = async (name, target = "grab:egg") => {
  if (process.env.NOSHOT) return;
  await page.screenshot({ path: `${out}/${name}.png` });
  const c = await page.evaluate((t) => window.__cookProject(t), target);
  await page.screenshot({ path: `${out}/${name}-zoom.png`, clip: { x: c[0] - 120, y: c[1] - 90, width: 240, height: 180 } });
};
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

// 프레임 시간 기록 (vsync 기준)
await page.evaluate(() => {
  window.__ft = [];
  let last = performance.now();
  window.__slow = [];
  const f = (t) => {
    window.__ft.push(t - last);
    if (t - last > 20 && window.__cookEggContents) {
      const c = window.__cookEggContents.getState();
      window.__slow.push({ ms: +(t - last).toFixed(1), shell: window.__cookEggShell.getState().state, contents: c.state, yolk: c.yolk, white: +c.white.toFixed(2) });
    }
    last = t;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});

// PROGRAMS=1: 조작 도중 새로 컴파일된 셰이더 프로그램 (끊김 원인)
const programsBefore = await page.evaluate(() => window.__cook.programNames());
const [ex, ey] = await page.evaluate(() => window.__cookProject("grab:egg"));
await page.mouse.move(ex, ey);
await page.mouse.down();
// AUDIO=1: 실제로 나는 소리를 녹음 (사용자 조작으로 오디오가 켜진 직후부터) + 조작 시각 기록
if (process.env.AUDIO) {
  await page.waitForFunction(() => !!window.__cookAudio);
  await page.evaluate(() => {
    const { engine } = window.__cookAudio;
    const dest = engine.ctx.createMediaStreamDestination();
    engine.analyser.connect(dest);
    const rec = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 256000 });
    window.__rec = { rec, chunks: [], start: performance.now(), marks: [] };
    rec.ondataavailable = (e) => window.__rec.chunks.push(e.data);
    rec.start();
    // 조작·상태 변화 시각 (녹음 기준 ms)
    const mark = (name) => window.__rec.marks.push({ name, t: performance.now() - window.__rec.start });
    window.__cookEggShell.subscribe((s, p) => {
      if (s.impacts > p.impacts) mark("impact");
      if (s.state !== p.state) mark(s.state);
    });
    window.__cookEggContents.subscribe((s, p) => {
      if (s.yolk !== p.yolk) mark("yolk-" + s.yolk);
    });
  });
}
const aim = await carryTo(-0.03, 0.2, 30);
await shot("1-ready");
// 팬 안쪽으로 휘둘러 앞쪽 테두리에 부딪힘
const [tx, ty] = await at(aim[0] + 0.01, aim[1] - 0.2);
await page.mouse.move(tx, ty, { steps: 3 });
await page.waitForTimeout(450);
await shot("2-cracked");
console.log("after impact:", await state());
// EDGE=1: 팬 가장자리(앞 왼쪽 테두리 바로 바깥) 위에서 벌리려 한다 — 팬 바닥 위가 아니므로 벌어지지 않아야 한다
if (process.env.EDGE) await carryTo(-0.115, 0.085, 20);
// NOSTREAM=1: 흘러내리는 줄기 메시를 그리지 않음 (성능 원인 분리용)
if (process.env.NOSTREAM) await page.evaluate(() => { window.__cookScene.getObjectByName("egg-white-stream").material.visible = false; });
// SLOWMO=0.1: 내용물만 느리게 (흘러내리는 모양을 스크린샷으로 확인)
if (process.env.SLOWMO) await page.evaluate((v) => { window.__cookSlowMo = v; }, Number(process.env.SLOWMO));
// TRACE=1: 벌리는 동안 성능 기록 (trace.json, 긴 작업 원인 찾기)
if (process.env.TRACE) await browser.startTracing(page, { path: `${out}/trace.json`, screenshots: false, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8.execute", "disabled-by-default-v8.cpu_profiler"] });
// 더 드래그 → 벌어짐
const q = await eggPos();
const [qx, qy] = await at(q[0], q[2]);
for (let i = 1; i <= Number(process.env.OPENSTEPS ?? 14); i++) {
  await page.mouse.move(qx + i * 7, qy + Math.sin(i) * 4, { steps: 2 });
  // OPENWAIT=ms: 천천히 벌린다 (틈이 벌어지는 동안 흘러나오는 모습 확인)
  await page.waitForTimeout(Number(process.env.OPENWAIT ?? 35));
  if (i === 5) await shot("3-opening");
  // PROBE=1: 벌어지는 동안 껍데기 속 노른자·쏟아지는 노른자 위치
  if (process.env.PROBE) console.log("probe", i, JSON.stringify(await page.evaluate(() => {
    const sc = window.__cookScene;
    const w = (n) => { const o = sc.getObjectByName(n); if (!o) return null; const v = o.getWorldPosition(o.position.clone()); return [v.x, v.y, v.z].map((x) => Math.round(x * 1000)).concat([o.visible ? 1 : 0, +o.scale.x.toFixed(2)]); };
    const sh = window.__cookEggShell.getState();
    return { open: +sh.open.toFixed(2), contents: window.__cookEggContents.getState().state, egg: w("grab:egg"), fillYolk: w("egg-fill-yolk"), yolk: w("egg-yolk") };
  })));
  // 다 벌어지면(OPENED) 내용물이 쏟아지기 시작 → 그 자리에서 멈춘다
  if ((await state()) === "OPENED") break;
}
console.log("after drag:", await state());
// EARLYDROP=ms: 다 벌어진 뒤 ms 만에 놓는다 (흰자가 다 퍼지기 전에 껍데기가 팬에 떨어짐)
if (process.env.EARLYDROP) {
  await page.waitForTimeout(Number(process.env.EARLYDROP));
  await page.mouse.up();
}
// OVERFLOW=1: 쏟아지는 흰자 일부가 앞 왼쪽 테두리 위로 넘쳐 흐른다 (테두리에 걸쳐 1초 동안 흰자를 붓는다)
// OVERFLOW=x,z: 팬 중심 기준 (x, z)에 붓는다 (예: 0,0.17 → 팬 앞 조리대 위)
if (process.env.OVERFLOW) {
  const a = Math.atan2(0.6, -0.8);
  const [ox, oz] = process.env.OVERFLOW === "1" ? [Math.cos(a) * 0.14, Math.sin(a) * 0.14] : process.env.OVERFLOW.split(",").map(Number);
  await page.evaluate(([ox, oz]) => new Promise((done) => {
    const stream = window.__cookScene.getObjectByName("egg-white-stream");
    let n = 0;
    const id = setInterval(() => {
      stream.userData.field?.deposit(ox, -0.025 + oz, 1.2e-7, 0.006);
      if (++n >= 60) { clearInterval(id); done(); }
    }, 16);
  }), [ox, oz]);
}
// SPILL=x,z: 다 벌어진 껍데기를 든 채 팬 테두리 밖으로 옮겨 흘린다 (넘친 흰자 모양 확인)
if (process.env.SPILL) {
  const [sx, sz] = process.env.SPILL.split(",").map(Number);
  // SPILLWAIT=ms: 그 자리에서 ms 동안 부은 뒤 옮긴다 (두 지점에 나눠 붓기)
  if (process.env.SPILLWAIT) await page.waitForTimeout(Number(process.env.SPILLWAIT));
  await carryTo(sx, sz, 12);
}
if (process.env.TRACE) {
  await page.waitForTimeout(Number(process.env.TRACE_MS ?? 600));
  await browser.stopTracing();
}
// HIDESHELL=1 + VIDEO=1: 녹화 내내 껍데기를 숨겨 흘러내리는 줄기를 본다
if (process.env.HIDESHELL && process.env.VIDEO) {
  await page.evaluate(() => { window.__cookScene.getObjectByName("grab:egg").traverse((o) => { if (o.material) o.material.visible = false; }); });
}
// 벌어진 껍데기를 든 채로: 흰자가 먼저 흘러내리고 노른자가 뒤따른다
const contents = () => page.evaluate(() => {
  const c = window.__cookEggContents.getState();
  return { state: c.state, white: +c.white.toFixed(2), yolk: c.yolk, areaCm2: +(c.area * 1e4).toFixed(1) };
});
const panShot = async (name) => {
  if (process.env.NOSHOT) return;
  // HIDESHELL=1: 껍데기에 가려진 흘러내리는 줄기를 보기 위해 촬영하는 순간만 계란을 숨긴다
  if (process.env.HIDESHELL) {
    await page.evaluate(() => { window.__cookScene.getObjectByName("grab:egg").traverse((o) => { if (o.material) o.material.visible = false; }); });
    await page.waitForTimeout(20);
  }
  const c = await page.evaluate(() => window.__cookProject("frying-pan", [0, 0.03, 0]));
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: c[0] - 260, y: c[1] - 210, width: 520, height: 360 } });
  // DUMP=1: 흰자 줄기 알갱이 (x, y, z mm, 반지름 mm, 위와 이어짐)
  if (process.env.DUMP) {
    console.log(name, JSON.stringify(await page.evaluate(() => {
      const st = window.__cookScene.getObjectByName("egg-white-stream").userData.strand;
      return st && { anchor: st.anchorLinked, ps: st.particles.map((p) => [Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round(p.z * 1000), +(Math.cbrt((3 * p.v) / 4 / Math.PI) * 1000).toFixed(1), p.linkNext ? 1 : 0]) };
    })));
  }
  if (process.env.HIDESHELL) {
    await page.evaluate(() => { window.__cookScene.getObjectByName("grab:egg").traverse((o) => { if (o.material) o.material.visible = true; }); });
  }
};
let t = 0;
for (const [at, name] of [[90, "4-white-flowing"], [180, "4b-white-flowing"], [250, "5-white-landing"], [330, "5b-white-landing"], [420, "6-yolk-falling"], [550, "6b"], [700, "7-spreading"], [900, "7b"], [1150, "7c"], [2800, "8-settled"]]) {
  await page.waitForTimeout(at - t);
  t = at;
  await panShot(name);
  console.log(name, await contents());
}
// COOK: 조리 과정을 가리지 않도록 껍데기는 팬 밖으로 옮겨서 놓는다
if (process.env.COOK) await carryTo(-0.215, 0.12, 20);
await page.mouse.up();
await page.waitForTimeout(1500);
await panShot("9-shells-dropped");
if (!process.env.NOSHOT) await page.screenshot({ path: `${out}/9-full.png` });
if (!process.env.NOSHOT) {
  const y = await page.evaluate(() => window.__cookProject("egg-yolk"));
  await page.screenshot({ path: `${out}/10-white-closeup.png`, clip: { x: y[0] - 170, y: y[1] - 110, width: 340, height: 220 } });
}
console.log("end", await contents());
// YOLKDBG=1: 노른자 위치(팬 중심 기준 반지름 mm, 높이 mm)
if (process.env.YOLKDBG) console.log("yolk", await page.evaluate(() => {
  const y = window.__cookScene.getObjectByName("egg-yolk").position;
  const pan = window.__cookScene.getObjectByName("frying-pan")?.getWorldPosition(y.clone());
  return { r: pan && +(Math.hypot(y.x - pan.x, y.z - pan.z) * 1000).toFixed(1), y: +(y.y * 1000).toFixed(1), panY: pan && +(pan.y * 1000).toFixed(1) };
}));

// COOK=배율: 불 세기를 높여 조리 과정을 빠르게 진행하며 단계별로 촬영 (위치별 익힘 확인)
if (process.env.COOK) {
  const cook = () => page.evaluate(() => {
    const c = window.__cookEggCooking.getState();
    const white = window.__cookScene.getObjectByName("egg-white").geometry.attributes;
    let n = 0, sum = 0, min = 1, max = 0, brown = 0;
    for (let k = 0; k < white.thick.count; k++) {
      if (white.thick.array[k] < 0.0004) continue;
      const d = white.cook.array[k * 2];
      n++; sum += d; min = Math.min(min, d); max = Math.max(max, d); brown = Math.max(brown, white.cook.array[k * 2 + 1]);
    }
    return { progress: +c.progress.toFixed(2), doneness: { mean: +(sum / n).toFixed(2), min: +min.toFixed(2), max: +max.toFixed(2) }, brownMax: +brown.toFixed(2) };
  });
  console.log("cook start", await cook());
  await page.evaluate((h) => window.__cookEggCooking.getState().setHeat(h), Number(process.env.COOK));
  for (const target of [0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1]) {
    await page.waitForFunction((t) => window.__cookEggCooking.getState().progress >= t, target, { timeout: 120_000 });
    await page.waitForTimeout(150);
    const tag = String(Math.round(target * 100)).padStart(3, "0");
    await panShot(`cook-${tag}`);
    if (!process.env.NOSHOT) {
      const y = await page.evaluate(() => window.__cookProject("egg-yolk"));
      await page.screenshot({ path: `${out}/cook-${tag}-closeup.png`, clip: { x: y[0] - 170, y: y[1] - 110, width: 340, height: 220 } });
      await page.screenshot({ path: `${out}/cook-${tag}-yolk.png`, clip: { x: y[0] - 70, y: y[1] - 45, width: 140, height: 90 } });
    }
    console.log("cook", await cook());
  }
}

// 디버그: HIDE=이름,이름 → 해당 물체를 숨긴 화면도 저장
if (process.env.HIDE && !process.env.NOSHOT) {
  await panShot("hide-none");
  // 이름+이름: 함께 숨긴다
  for (const name of process.env.HIDE.split(",")) {
    const set = (v) => page.evaluate(([ns, v]) => { for (const n of ns) window.__cookScene.getObjectByName(n).traverse((o) => { if (o.material) o.material.visible = v; }); }, [name.split("+"), v]);
    await set(false);
    await page.waitForTimeout(100);
    await panShot(`hide-${name}`);
    await set(true);
  }
}
// EVAL=코드: 마지막에 페이지에서 실행한 뒤 eval.png 촬영 (렌더링 실험용)
if (process.env.EVAL && !process.env.NOSHOT) {
  const ret = await page.evaluate((code) => new Function(code)(), process.env.EVAL);
  if (ret !== undefined) console.log("eval", JSON.stringify(ret));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/eval.png` });
}
// TINT=이름:색,이름:색 → 해당 메시를 단색으로 칠한 화면 (어느 메시가 어디를 그리는지 확인)
if (process.env.TINT && !process.env.NOSHOT) {
  await page.evaluate((spec) => {
    for (const pair of spec.split(",")) {
      const [n, c] = pair.split(":");
      const o = window.__cookScene.getObjectByName(n);
      const m = o.material.clone();
      m.onBeforeCompile = () => {};
      m.customProgramCacheKey = () => "tint-" + n;
      m.color?.set(c);
      m.emissive?.set(c);
      m.transparent = false;
      m.opacity = 1;
      o.material = m;
    }
  }, process.env.TINT);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/tint.png` });
}
// PROBE=1: 노른자 주변 밝은 고리 원인 실험 (흰자 법선 평평 / 노른자 uniform 끔)
if (process.env.PROBE && !process.env.NOSHOT) {
  const clipShot = async (name) => {
    await page.waitForTimeout(200);
    const y = await page.evaluate(() => window.__cookProject("egg-yolk"));
    await page.screenshot({ path: `${out}/probe-${name}.png`, clip: { x: y[0] - 70, y: y[1] - 45, width: 140, height: 90 } });
  };
  await page.evaluate(() => { window.__cookScene.getObjectByName("egg-white-collar").material.visible = false; });
  await clipShot("a-nocollar");
  for (const [name, code] of [
    ["a2-fade1", "f.setX(i, 1)"],
    ["a3-fade05", "f.setX(i, 0.5)"],
  ]) {
    await page.evaluate((code) => {
      const o = window.__cookScene.getObjectByName("egg-white-collar");
      o.material.visible = true;
      const f = o.geometry.attributes.fade;
      for (let i = 0; i < f.count; i++) eval(code);
      f.needsUpdate = true;
    }, code);
    await clipShot(name);
  }
  await page.evaluate(() => { const m = window.__cookScene.getObjectByName("egg-white-collar").material; m.visible = false; });
  await page.evaluate(() => {
    const u = window.__cookScene.getObjectByName("egg-yolk").material.userData.cookUniforms;
    window.__yw = u.uYolk.value.w; u.uYolk.value.w = 0;
    // useFrame이 매 프레임 다시 설정하므로 set을 막는다
    u.uYolk.value.set = function () { return this; };
  });
  await clipShot("b-noyolkuniform");
  await page.evaluate(() => {
    const nor = window.__cookScene.getObjectByName("egg-white").geometry.attributes.normal;
    for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0);
    nor.needsUpdate = true;
  });
  await clipShot("c-flatnormals");
  await page.evaluate(() => {
    const m = window.__cookScene.getObjectByName("egg-white").material;
    window.__spec = m.specularIntensity; m.specularIntensity = 0;
  });
  await clipShot("d-nospec");
  await page.evaluate(() => {
    const m = window.__cookScene.getObjectByName("egg-white").material;
    m.specularIntensity = window.__spec;
    const c = window.__cookScene.getObjectByName("egg-white").geometry.attributes.cook;
    for (let i = 0; i < c.count; i++) c.setX(i, 1);
    c.needsUpdate = true;
  });
  await clipShot("e-alldone");
  await page.evaluate(() => { window.__cookScene.getObjectByName("egg-white").visible = false; });
  await clipShot("f-nowhite");
  console.log("near yolk:", await page.evaluate(() => {
    const out = [];
    const y = window.__cookScene.getObjectByName("egg-yolk");
    window.__cookScene.traverse((o) => {
      if (!o.isMesh || !o.visible || o.name.startsWith("grab")) return;
      o.geometry.computeBoundingSphere?.();
      const c = o.geometry.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
      if (c.distanceTo(y.position) < 0.06) out.push(o.name || o.type);
    });
    return out;
  }));

}
if (process.env.AUDIO) {
  const { b64, marks, sounds } = await page.evaluate(async () => {
    const r = window.__rec;
    await new Promise((res) => { r.rec.onstop = res; r.rec.stop(); });
    const blob = new Blob(r.chunks, { type: "audio/webm" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const sounds = window.__cookAudio.log.filter((e) => e.name !== "pop").map((e) => ({ name: e.name, t: Math.round(e.at - r.start), ...e.params }));
    return { b64: btoa(bin), marks: r.marks.map((m) => ({ ...m, t: Math.round(m.t) })), sounds };
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${out}/audio.webm`, Buffer.from(b64, "base64"));
  writeFileSync(`${out}/audio-events.json`, JSON.stringify({ marks, sounds }, null, 1));
  console.log("audio marks:", JSON.stringify(marks));
  console.log("sounds:", JSON.stringify(sounds.slice(0, 40)));
}
const frames = await page.evaluate(() => {
  const a = window.__ft.slice(2).sort((x, y) => x - y);
  const q = (p) => +a[Math.floor(a.length * p)].toFixed(1);
  return { frames: a.length, p50: q(0.5), p95: q(0.95), max: +a[a.length - 1].toFixed(1), over20ms: a.filter((v) => v > 20).length };
});
if (process.env.PROGRAMS) {
  const after = await page.evaluate(() => window.__cook.programNames());
  console.log("new programs:", after.filter((n) => !programsBefore.includes(n)));
}
console.log("frame times (ms):", frames);
console.log("slow frames:", await page.evaluate(() => window.__slow));
await context.close();
await browser.close();
console.log("saved to", out);
