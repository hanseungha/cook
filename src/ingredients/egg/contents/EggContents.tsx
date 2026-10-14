"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { DropShadow } from "@/engine/rendering/DropShadow";
import { warmUpPrograms } from "@/engine/rendering/warmUp";
import { excludeFromReflections } from "@/engine/rendering/renderConfig";
import { stepSpring } from "@/engine/interaction/spring";
import { heatAt } from "@/engine/cooking/heatSources";
import { ThermalField } from "@/engine/cooking/thermalField";
import { AlbumenField, CLIFF, FIELD_GRID, albumenNoise } from "./albumenField";
import { AlbumenStrand } from "./albumenStrand";
import { createStrandGeometry, updateStrandMesh } from "./albumenStrandMesh";
import { createAlbumenMaterial, createYolkMaterial } from "./eggContentsMaterials";
import { createYolkGeometry } from "./yolkGeometry";

/** 내용물 치수 (특란 기준) */
export const CONTENTS = {
  /** 흰자 부피 (m³) ≈ 33ml */
  whiteVolume: 3.3e-5,
  /** 노른자 반지름 (m) ≈ 지름 31mm */
  yolkRadius: 0.0155,
  /**
   * 노른자를 감싸고 함께 떨어지는 농후 흰자의 비율. 노른자는 흰자와 따로 떨어지지 않는다:
   * 계란을 옮기며 부어 노른자가 맨 팬에 떨어져도 그 둘레에 흰자가 고인다
   */
  yolkWhite: 0.25,
  /** 노른자에 딸린 흰자가 착지한 뒤 다 퍼져 나오는 시간 (초) */
  yolkWhiteSpread: 0.35,
};
/** 노른자와 따로 흘러내리는 묽은 흰자 부피 */
const FREE_WHITE = CONTENTS.whiteVolume * (1 - CONTENTS.yolkWhite);

/** 쏟아지는 순서와 속도 */
const POUR = {
  /** 흰자가 흘러나오는 시간 (초) */
  whiteDuration: 1.2,
  /** 흘러나온 흰자가 한쪽으로 쏠리는 속도 (m/s) — 웅덩이가 매번 같은 원이 되지 않게 */
  lean: [0.035, 0.014] as const,
  /** 노른자가 껍데기를 떠나는 시각 (흰자가 먼저 흘러내린 뒤) */
  yolkRelease: 0.42,
  /** 노른자가 빠져나올 수 있는 틈 (흘러나오는 정도 기준) */
  yolkGate: 0.75,
  /** 흰자 두께장을 만들기 전에 기다리는 프레임 수 (갈라지는 프레임과 무거운 계산이 겹치지 않게) */
  fieldDelayFrames: 2,
  gravity: 9.8,
};

/** 노른자 착지 후 출렁임 (돔 높이 비율 스프링) */
const YOLK = {
  /** 흰자 위에 놓인 노른자의 높이/반지름 비율 (막이 받쳐 볼록한 돔) */
  restSquash: 0.66,
  wobble: { omega: 24, zeta: 0.32 },
  /** 노른자 바닥 둘레의 높이 차가 이보다 크면 굴러떨어진다 (m) */
  fallDrop: 0.004,
  /** 이보다 크면 낮은 쪽으로 천천히 미끄러진다 (m) */
  slideDrop: 0.0008,
  slideSpeed: 0.05,
  /** 노른자 폭 안에서 이보다 크게 꺼지면 모서리 (붙어 머물다 중심이 넘어가야 떨어진다) */
  edgeDrop: 0.03,
};

/**
 * 익는 속도 (진행도 단위, 열 세기 1 기준).
 * 얇은 가장자리는 금방 익고 노릇해지며, 노른자 주변의 두꺼운 농후 흰자는 거의 끝까지 반투명하다.
 */
const COOK = {
  /** 두께별 다 익는 데 필요한 진행도: 얇은 막 → 두꺼운 층 */
  setDose: { thin: 0.2, thick: 0.86, thickAt: 0.0052 },
  /** 다 익은 뒤 진행도 1당 갈변량 (얇은 곳만) */
  brownRate: 0.9,
  brownBelow: 0.0015,
  /** 노른자가 다 익는 데 필요한 진행도 (반숙 프라이: 끝나도 겉만 살짝) */
  yolkSetDose: 1.15,
  /**
   * 가장자리는 바닥 열 + 옆으로 드러난 얇은 단면 때문에 더 빨리 익는다:
   * 가장자리에서 edgeReach(m) 안쪽까지 필요한 열량이 edgeFactor배로 줄어든다 → 익는 경계가 안쪽으로 번져 들어감
   */
  edgeFactor: 0.4,
  edgeReach: 0.022,
  /** 위치별 익힘을 갱신하는 간격 (초) — 조리는 느리게 진행되므로 매 프레임 할 필요가 없다 */
  interval: 0.1,
};

type Pour = {
  /** 쏟아지기 시작한 뒤 지난 준비 프레임 수 */
  warmup: number;
  t: number;
  field: AlbumenField | null;
  strand: AlbumenStrand;
  lastSource: THREE.Vector3;
  sourceVel: THREE.Vector3;
  yolk: {
    phase: "inShell" | "falling" | "landed";
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    squash: number;
    squashV: number;
    settledFor: number;
  };
  reported: boolean;
  /** 노른자에 딸려 아직 팬에 내려놓지 않은 흰자 부피 (m³) */
  carried: number;
  /** 노른자를 둘러싼 농후 흰자(볼록한 층). 노른자가 떨어진 자리에서 자라난다 */
  mound: Mound;
  /** 흰자 위치별 익힘 + 격자 칸마다 받는 열 세기 */
  thermal: ThermalField | null;
  cellHeat: Float32Array | null;
  /** 지난번 익힐 때의 흐름 두께 (새 흰자가 덮였는지 판단) */
  prevH: Float32Array | null;
  cookedProgress: number;
  cookTimer: number;
  lastProgress: number;
  yolkDose: number;
  cook: CookSummary;
};

/** 익는 상태 요약: 열을 받는 흰자 면적(m²), 그중 아직 날것인 비율, 노릇한 정도 (0 ~ 1) */
/** heatCenter: 열을 받는 흰자의 중심 (김이 피어오르는 곳). 팬 밖에 흘린 흰자·노른자는 열을 받지 않아 제외 */
export type CookSummary = { heatedArea: number; raw: number; brown: number; heatCenter: [number, number] | null };

/** 진행 상황 + 내용물 중심(노른자, 없으면 흰자가 처음 떨어진 곳) */
export type ContentsProgress = { white: number; yolk: "inShell" | "falling" | "landed"; area: number; center: [number, number] } & CookSummary;

export type Mound = { x: number; z: number; amount: number; phase: number };

/** 흰자(+농후 흰자)·노른자 윗면의 월드 높이. 흰자가 없는 곳은 null */
function contentsTop(p: Pour, x: number, z: number) {
  const field = p.field;
  if (!field) return null;
  const h = field.heightAt(x, z);
  const white = h + moundAt(p.mound, x, z) * THREE.MathUtils.smoothstep(h, 0.0003, 0.0015);
  let top = white > 0.0003 ? field.groundAt(x, z) + white : -Infinity;
  const y = p.yolk;
  if (y.phase === "landed") {
    // 납작해진 노른자(가로 a, 세로 b 타원체)의 윗면
    const a = CONTENTS.yolkRadius / Math.sqrt(y.squash);
    const b = CONTENTS.yolkRadius * y.squash;
    const d = Math.hypot(x - y.pos.x, z - y.pos.z) / a;
    if (d < 1) top = Math.max(top, y.pos.y + b * Math.sqrt(1 - d * d));
  }
  return top === -Infinity ? null : top;
}

/** 농후 흰자 층의 최대 두께 (m)와 반경 (m) */
const MOUND = { height: 0.0032, radius: 0.026 };

/** 농후 흰자 층의 두께: 노른자 주변의 낮은 고원, 가장자리는 각도에 따라 들쭉날쭉 */
function moundAt(m: Mound, x: number, z: number) {
  if (m.amount <= 0) return 0;
  const dx = x - m.x;
  const dz = z - m.z;
  const d = Math.hypot(dx, dz);
  const a = Math.atan2(dz, dx);
  const edge = MOUND.radius * (1 + 0.16 * Math.sin(3 * a + m.phase) + 0.08 * Math.sin(5 * a + m.phase * 2.3));
  const t = THREE.MathUtils.clamp(d / edge, 0, 1);
  return MOUND.height * m.amount * (1 - t * t * (3 - 2 * t));
}

const tmp = new THREE.Vector3();
const s = new THREE.Vector3();

type EggContentsProps = {
  /** true가 되는 순간부터 쏟아진다 (한 번만) */
  active: boolean;
  /** 껍데기 틈(쏟아지는 곳)의 월드 좌표 */
  source: (out: THREE.Vector3) => void;
  /** 내용물이 떨어질 표면 높이 */
  groundAt: (x: number, z: number) => number;
  /** 가장자리 (x, z) 아래 높이 y의 옆면 수평 위치 (팬 바깥벽 등). 없으면 수직 옆면으로 본다 */
  sideAt?: (x: number, z: number, y: number) => [number, number] | null;
  /** 흰자가 다 퍼지고 노른자가 자리를 잡았을 때 */
  onSettled?: () => void;
  /** 진행 상황 (검증·디버그) + 익는 상태 요약 (소리 등) */
  onProgress?: (p: ContentsProgress) => void;
  /** 흰자·노른자가 바닥에 닿은 순간 (소리 동기화). volume m³, speed m/s */
  onLand?: (e: { kind: "white" | "yolk"; volume: number; x: number; z: number; speed: number }) => void;
  /** 껍데기 틈이 벌어진 정도 0 ~ 1 (흘러나오는 빠르기). 없으면 1 */
  flow?: () => number;
  /** 조리 진행도 0 ~ 1 (조리 상태는 레시피가 관리하고, 여기서는 위치별 익힘으로 나눠 표현만 한다) */
  cookingProgress?: () => number;
  /**
   * 흰자가 팬에 깔리기 시작할 때 한 번: 내용물 윗면 높이 조회 함수를 넘긴다
   * (다른 물체 — 버린 껍데기 등 — 가 흰자·노른자를 뚫지 않고 그 위에 놓이게). 내용물이 없는 곳은 null
   */
  onSurface?: (topAt: (x: number, z: number) => number | null) => void;
};

/**
 * 껍데기에서 쏟아지는 흰자·노른자.
 * - 흐름: 틈에서 흘러나오는 흰자 덩어리(파티클) — 속도 방향으로 늘어나 끈적한 줄기처럼 보인다
 * - 흰자: 닿은 자리에 부피를 쌓고 점성 흐름으로 퍼지는 두께장 → 두께·반사·불규칙한 가장자리
 * - 노른자: 흰자보다 늦게 떨어져, 착지 순간 눌렸다가 출렁이며 볼록한 돔으로 자리 잡는다
 */
export function EggContents({ active, source, groundAt, sideAt, onSettled, onProgress, onLand, cookingProgress, flow, onSurface }: EggContentsProps) {
  const fieldMesh = useRef<THREE.Mesh>(null);
  const stream = useRef<THREE.Mesh>(null);
  const yolkMesh = useRef<THREE.Mesh>(null);
  const yolkShadow = useRef<THREE.Mesh>(null);
  const drapeMesh = useRef<THREE.Mesh>(null);
  const collarMesh = useRef<THREE.Mesh>(null);
  const pour = useRef<Pour | null>(null);
  const group = useRef<THREE.Group>(null);
  const get = useThree((st) => st.get);

  // 팬 속 흰자·노른자는 팬 몸체에 가려 인덕션 유리에 비치지 않는다 → 반사 패스에서 무거운 흰자 셰이더를 다시 그리지 않게
  useEffect(() => {
    if (group.current) excludeFromReflections(group.current);
  }, []);

  // 쏟아지는 순간 셰이더 첫 사용으로 프레임이 끊기지 않도록, 장면이 준비된 뒤 유휴 시간에 미리 한 번 그려 둔다
  useEffect(() => {
    const warm = () => {
      const root = group.current;
      if (!root) return;
      const { gl, scene, camera } = get();
      warmUpPrograms(gl, scene, camera, root);
      // 흰자 가장자리 노이즈도 미리
      albumenNoise();
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 1500 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 0);
    return () => clearTimeout(id);
  }, [get]);

  const materials = useMemo(
    () => {
      // 절벽을 넘어 흘러내리는 막: 위(테두리 윗면)와 옆(세로 막)을 함께 그리므로 양면
      const uniforms = { uCookTime: { value: 0 }, uYolkCook: { value: 0 }, uYolk: { value: new THREE.Vector4() }, uHeating: { value: 0 } };
      const drape = createAlbumenMaterial("field", uniforms);
      drape.side = THREE.DoubleSide;
      const result = {
        uniforms,
        field: createAlbumenMaterial("field", uniforms),
        collar: createAlbumenMaterial("collar", uniforms),
        drape,
        stream: createAlbumenMaterial("stream"),
        yolk: createYolkMaterial(uniforms),
      };
      result.yolk.userData.cookUniforms = uniforms;
      return result;
    },
    [],
  );
  const strandGeometry = useMemo(() => createStrandGeometry(), []);
  const yolkGeometry = useMemo(() => createYolkGeometry(CONTENTS.yolkRadius), []);
  // 흰자 격자 메시 (위치·법선·cover·milk는 흐름에 맞춰 갱신). 크기는 AlbumenField 기본값과 같다
  const fieldGeometry = useMemo(() => {
    const n = FIELD_GRID.n;
    const g = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
    g.setAttribute("thick", new THREE.BufferAttribute(new Float32Array(n * n), 1));
    g.setAttribute("milk", new THREE.BufferAttribute(new Float32Array(n * n), 1));
    g.setAttribute("cook", new THREE.BufferAttribute(new Float32Array(n * n * 2), 2));
    return g;
  }, []);

  const drapeGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const verts = MAX_CLIFF_VERTS;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    g.setAttribute("thick", new THREE.BufferAttribute(new Float32Array(verts), 1));
    g.setAttribute("milk", new THREE.BufferAttribute(new Float32Array(verts), 1));
    g.setAttribute("cook", new THREE.BufferAttribute(new Float32Array(verts * 2), 2));
    g.setDrawRange(0, 0);
    return g;
  }, []);

  const collarGeometry = useMemo(() => createCollarGeometry(), []);

  useEffect(
    () => () => {
      drapeGeometry.dispose();
      for (const m of [materials.field, materials.drape, materials.collar, materials.stream, materials.yolk]) m.dispose();
      collarGeometry.dispose();
      strandGeometry.dispose();
      yolkGeometry.dispose();
      fieldGeometry.dispose();
    },
    [materials, strandGeometry, yolkGeometry, fieldGeometry, drapeGeometry, collarGeometry],
  );

  useFrame((_, rawDt) => {
    // 개발 모드: window.__cookSlowMo = 0.1 이면 내용물만 10배 느리게 (흘러내리는 모양 확인용)
    const slow = process.env.NODE_ENV === "development" ? ((window as { __cookSlowMo?: number }).__cookSlowMo ?? 1) : 1;
    const dt = Math.min(rawDt, 1 / 20) * slow;
    if (!active) {
      if (yolkShadow.current) yolkShadow.current.visible = false;
      return;
    }
    if (!pour.current) {
      const start = new THREE.Vector3();
      source(start);
      pour.current = {
        warmup: 0,
        t: 0,
        field: null,
        strand: new AlbumenStrand(FREE_WHITE, POUR.whiteDuration),
        carried: CONTENTS.whiteVolume * CONTENTS.yolkWhite,
        lastSource: start.clone(),
        sourceVel: new THREE.Vector3(),
        yolk: { phase: "inShell", pos: start.clone(), vel: new THREE.Vector3(), squash: 1, squashV: 0, settledFor: 0 },
        reported: false,
        mound: { x: 0, z: 0, amount: 0, phase: 1.7 },
        thermal: null,
        cellHeat: null,
        prevH: null,
        cookedProgress: cookingProgress?.() ?? 0,
        cookTimer: 0,
        lastProgress: cookingProgress?.() ?? 0,
        yolkDose: 0,
        cook: { heatedArea: 0, raw: 0, brown: 0, heatCenter: null },
      };
    }
    const p = pour.current;
    // 흰자 두께장(격자·절벽 탐색)은 무거우므로 껍데기가 갈라지기 시작하는 프레임을 피해 몇 프레임 뒤에 만든다.
    // 그동안 흘러나온 흰자는 아직 껍데기 틈에 있다 (떨어져 닿기까지 수십 ms 더 걸린다)
    if (p.warmup < POUR.fieldDelayFrames) {
      p.warmup++;
      source(p.lastSource);
      return;
    }
    // 틈이 좁으면 천천히 흘러나온다 (쏟아지는 순서·시간은 흘러나온 정도 기준)
    const gate = THREE.MathUtils.clamp(flow?.() ?? 1, 0, 1);
    p.t += dt * gate;

    // 쏟아지는 곳 (껍데기와 함께 움직임)
    source(tmp);
    p.sourceVel.subVectors(tmp, p.lastSource).divideScalar(Math.max(dt, 1e-4));
    p.lastSource.copy(tmp);

    // 흰자 두께장: 첫 덩어리가 닿을 곳을 중심으로
    if (!p.field) {
      p.field = new AlbumenField(tmp.x, tmp.z, groundAt);
      const mesh = fieldMesh.current;
      if (mesh) {
        mesh.visible = true;
        // 절벽을 가로지르는 삼각형은 빼고 그린다 (그 자리는 흘러내리는 막이 잇는다)
        mesh.geometry.setIndex(p.field.surfaceIndex());
      }
      // 격자 칸마다 닿아 있는 열원의 세기 (팬은 움직이지 않으므로 칸마다 한 번만, 흰자가 닿을 때 계산 — −1 = 아직)
      const f = p.field;
      onSurface?.((x, z) => contentsTop(p, x, z));
      p.thermal = new ThermalField(f.n * f.n);
      p.cellHeat = new Float32Array(f.n * f.n).fill(-1);
      p.prevH = new Float32Array(f.n * f.n);
    }
    const field = p.field;
    const mound = p.mound;
    // 흰자 위 표면 (농후 흰자는 흰자가 있는 곳에서만 솟는다)
    const whiteAt = (x: number, z: number) => {
      const h = field.heightAt(x, z);
      return h + moundAt(mound, x, z) * THREE.MathUtils.smoothstep(h, 0.0003, 0.0015);
    };
    const surfaceAt = (x: number, z: number) => field.groundAt(x, z) + whiteAt(x, z);

    // --- 흘러나오는 흰자 줄기 (콧물처럼 덩어리째 늘어지다 끊긴다) ---
    // 틈은 껍데기와 함께 움직이고, 흰자는 한쪽으로 살짝 쏠려 흘러내린다
    const anchor = {
      x: tmp.x,
      y: tmp.y,
      z: tmp.z,
      vx: p.sourceVel.x,
      vy: p.sourceVel.y,
      vz: p.sourceVel.z,
      spawn: [POUR.lean[0], -0.04, POUR.lean[1]] as [number, number, number],
    };
    p.strand.step(
      dt,
      anchor,
      surfaceAt,
      (x, z, v, r, speed) => {
        field.deposit(x, z, v, r);
        onLand?.({ kind: "white", volume: v, x, z, speed });
      },
      gate,
    );
    if (stream.current) {
      updateStrandMesh(stream.current, p.strand, anchor);
      // 검증·디버그용
      stream.current.userData.strand = p.strand;
      stream.current.userData.field = field;
    }

    // --- 흰자 퍼짐 ---
    field.step(dt);
    const growing = mound.amount > 0 && mound.amount < 1;
    if (growing) mound.amount = Math.min(1, mound.amount + dt * 1.6);
    // --- 익힘: 진행도 증가분을 위치별 열 세기·두께에 따라 나눠 받는다 ---
    // (uniform 객체는 재질과 함께 만들어 userData에 둔다 — 메시를 통해 갱신)
    const cookU = (yolkMesh.current?.material as THREE.Material | undefined)?.userData.cookUniforms as
      | typeof materials.uniforms
      | undefined;
    if (cookU) cookU.uCookTime.value += dt;
    const progressNow = cookingProgress?.() ?? 0;
    // 진행도가 오르는 동안 = 가열 중 (가장자리 거품이 부드럽게 생기고 사라지게)
    if (cookU) {
      const target = progressNow > p.lastProgress && progressNow < 1 ? 1 : 0;
      cookU.uHeating.value += (target - cookU.uHeating.value) * Math.min(1, dt * 2);
    }
    p.lastProgress = progressNow;
    p.cookTimer += dt;
    const cookDue = p.cookTimer >= COOK.interval && progressNow !== p.cookedProgress;
    if (field.changed || growing || cookDue) {
      if (field.changed || growing) updateFieldMesh(fieldMesh.current, field, mound);
      if (cookDue) {
        const dp = progressNow - p.cookedProgress;
        p.cookedProgress = progressNow;
        p.cookTimer = 0;
        p.cook = cookWhite(fieldMesh.current, field, p.thermal!, p.cellHeat!, p.prevH!, dp);
        if (p.yolk.phase === "landed") {
          const yp = p.yolk.pos;
          p.yolkDose += (dp * heatAt(yp.x, field.groundAt(yp.x, yp.z), yp.z)) / COOK.yolkSetDose;
          if (cookU) cookU.uYolkCook.value = THREE.MathUtils.clamp(p.yolkDose, 0, 1);
        }
      }
      updateCliffs(drapeMesh.current, field, p.thermal!, sideAt);
    }

    // --- 노른자 ---
    const y = p.yolk;
    const R = CONTENTS.yolkRadius;
    if (y.phase === "inShell") {
      // 껍데기 안: 틈 바로 위에 매달려 있다가
      y.pos.copy(tmp).add(s.set(0, R * 0.55, 0));
      // 노른자는 틈이 충분히 벌어져야 빠져나온다
      if (p.t >= POUR.yolkRelease && gate > POUR.yolkGate) {
        y.phase = "falling";
        y.vel.copy(p.sourceVel).multiplyScalar(0.5);
      }
    } else if (y.phase === "falling") {
      y.vel.y -= POUR.gravity * dt;
      y.vel.x *= Math.exp(-2 * dt);
      y.vel.z *= Math.exp(-2 * dt);
      y.pos.addScaledVector(y.vel, dt);
      // 모서리 옆을 지나 떨어질 때 옆면(유리 옆면, 팬 벽)을 파고들지 않게 밀어낸다
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        if (field.groundAt(y.pos.x + cx * R, y.pos.z + cz * R) > y.pos.y - R * 0.5) {
          y.pos.x -= cx * R * 0.25;
          y.pos.z -= cz * R * 0.25;
          const into = y.vel.x * cx + y.vel.z * cz;
          if (into > 0) {
            y.vel.x -= cx * into;
            y.vel.z -= cz * into;
          }
        }
      }
      // 떨어지는 동안 살짝 길쭉하게
      y.squash = 1.06;
      const floor = surfaceAt(y.pos.x, y.pos.z);
      if (y.pos.y - R <= floor) {
        y.phase = "landed";
        onLand?.({ kind: "yolk", volume: (4 / 3) * Math.PI * R ** 3, x: y.pos.x, z: y.pos.z, speed: Math.abs(y.vel.y) });
        // 착지 충격: 납작하게 눌렸다가 출렁이며 돔으로
        y.squash = 0.9;
        y.squashV = -Math.min(9, Math.abs(y.vel.y) * 4.5);
        y.vel.set(0, 0, 0);
        // 노른자를 감싸고 함께 떨어진 농후 흰자가 주변에 볼록하게 고인다
        Object.assign(mound, { x: y.pos.x, z: y.pos.z, amount: 0.001 });
      }
    } else {
      // 노른자를 감싸고 함께 떨어진 농후 흰자가 노른자 밑에서 둘레로 퍼져 나온다
      if (p.carried > 0) {
        const v = Math.min(p.carried, (CONTENTS.whiteVolume * CONTENTS.yolkWhite * dt) / CONTENTS.yolkWhiteSpread);
        field.deposit(y.pos.x, y.pos.z, v, R * 1.1);
        p.carried -= v;
      }
      // 비탈·모서리(팬 테두리, 유리 끝)에 걸치면 낮은 쪽으로 미끄러지거나 굴러떨어진다
      const here = field.groundAt(y.pos.x, y.pos.z);
      // 완만한 비탈(팬 안쪽 벽)에서 가장 낮은 쪽, 그리고 모서리(팬 테두리 바깥, 유리 끝) 방향을 따로 본다
      let low = here;
      let dirX = 0;
      let dirZ = 0;
      let edgeX = 0;
      let edgeZ = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        const g = field.groundAt(y.pos.x + cx * R * 0.8, y.pos.z + cz * R * 0.8);
        // 모서리: 수 cm가 한꺼번에 꺼지는 곳 (팬 안쪽 벽은 가팔라도 이보다 완만)
        if (here - g > YOLK.edgeDrop) {
          edgeX += cx;
          edgeZ += cz;
        } else if (g < low) {
          low = g;
          dirX = cx;
          dirZ = cz;
        }
      }
      const drop = here - low;
      // 모서리에 걸친 노른자는 흰자에 붙어 머문다. 중심이 모서리를 넘어 받칠 곳이 없을 때만 떨어진다
      const el = Math.hypot(edgeX, edgeZ);
      const overEdge = el > 0 && field.groundAt(y.pos.x + (edgeX / el) * R * 0.2, y.pos.z + (edgeZ / el) * R * 0.2) < here - YOLK.edgeDrop;
      if (overEdge) {
        y.phase = "falling";
        y.vel.set((edgeX / el) * 0.12, 0, (edgeZ / el) * 0.12);
        y.settledFor = 0;
      } else if (drop > YOLK.fallDrop) {
        y.phase = "falling";
        y.vel.set(dirX * 0.18, 0, dirZ * 0.18);
        y.settledFor = 0;
      } else if (drop > YOLK.slideDrop) {
        const v = YOLK.slideSpeed * Math.min(1, drop / YOLK.fallDrop) * dt;
        y.pos.x += dirX * v;
        y.pos.z += dirZ * v;
        y.settledFor = 0;
      }
      [y.squash, y.squashV] = stepSpring(y.squash, y.squashV, YOLK.restSquash, YOLK.wobble.omega, YOLK.wobble.zeta, dt);
      y.squash = Math.max(0.45, y.squash);
      // 바닥이 흰자 속에 살짝 잠긴 채 흰자 표면 위에 놓인다
      const white = whiteAt(y.pos.x, y.pos.z);
      y.pos.y = field.groundAt(y.pos.x, y.pos.z) + white * 0.55 + R * y.squash * 0.9;
      y.settledFor = Math.abs(y.squashV) < 0.02 && Math.abs(y.squash - YOLK.restSquash) < 0.003 ? y.settledFor + dt : 0;
    }
    const yolk = yolkMesh.current;
    if (yolk) {
      // 껍데기 속에 있는 동안은 껍데기 쪽(Egg의 속 내용물)이 그린다
      yolk.visible = y.phase !== "inShell";
      yolk.position.copy(y.pos);
      // 부피 보존: 낮아진 만큼 옆으로 퍼짐
      const side = 1 / Math.sqrt(y.squash);
      yolk.scale.set(side, y.squash, side);
    }
    // 노른자를 감싸 올라온 흰자 + 흰자 셰이더에 노른자 위치 전달
    const onWhite = y.phase === "landed" && whiteAt(y.pos.x, y.pos.z) > 0.0008;
    if (cookU) cookU.uYolk.value.set(y.pos.x, y.pos.z, R / Math.sqrt(y.squash), onWhite ? 1 : 0);
    const collar = collarMesh.current;
    if (collar) {
      collar.visible = onWhite;
      if (onWhite) updateCollar(collar, y.pos, R / Math.sqrt(y.squash), R * y.squash, surfaceAt, field, p.thermal!, mound.phase);
    }
    const ys = yolkShadow.current;
    if (ys) {
      const ground = field.groundAt(y.pos.x, y.pos.z);
      const h = Math.max(0, y.pos.y - R * y.squash - ground);
      ys.visible = true;
      ys.position.set(y.pos.x + 0.002, ground + 0.0002, y.pos.z + 0.0015);
      ys.scale.setScalar((1 + h * 6) * (y.phase === "landed" ? 1 / Math.sqrt(y.squash) : 1));
      // 흰자 위에 놓이면 노른자가 흰자에 잠겨 그림자가 거의 생기지 않는다 (진하면 노른자 아래 회색 호가 받침처럼 보인다)
      (ys.material as THREE.MeshBasicMaterial).opacity = 0.55 * THREE.MathUtils.clamp(1 - h / 0.1, 0.15, 1) * (onWhite ? 0.3 : 1);
    }

    onProgress?.({
      white: p.strand.emitted / FREE_WHITE,
      yolk: y.phase,
      area: field.coverage(),
      center: y.phase === "landed" ? [y.pos.x, y.pos.z] : [field.x0 + field.size / 2, field.z0 + field.size / 2],
      ...p.cook,
    });
    if (!p.reported && p.strand.done && p.carried <= 0 && field.settled && y.phase === "landed" && y.settledFor > 0.3) {
      p.reported = true;
      onSettled?.();
    }
  });

  return (
    <group ref={group} name="egg-contents">
      <mesh
        ref={fieldMesh}
        name="egg-white"
        geometry={fieldGeometry}
        material={materials.field}
        visible={false}
        frustumCulled={false}
        renderOrder={2}
      />
      <mesh
        ref={drapeMesh}
        name="egg-white-drape"
        geometry={drapeGeometry}
        material={materials.drape}
        frustumCulled={false}
        renderOrder={2}
      />
      <mesh
        ref={stream}
        name="egg-white-stream"
        geometry={strandGeometry}
        material={materials.stream}
        frustumCulled={false}
        renderOrder={3}
      />
      <mesh
        ref={collarMesh}
        name="egg-white-collar"
        geometry={collarGeometry}
        material={materials.collar}
        visible={false}
        frustumCulled={false}
        renderOrder={2}
      />
      <mesh ref={yolkMesh} name="egg-yolk" geometry={yolkGeometry} material={materials.yolk} visible={false} />
      <DropShadow ref={yolkShadow} size={[0.04, 0.04]} name="egg-yolk-shadow" depthOffset={false} />
    </group>
  );
}

/** 노른자 둘레 흰자 띠의 해상도 (둘레 × 안→밖) */
const COLLAR = { around: 128, rows: 9, climb: 0.001, reach: 0.006 };

function createCollarGeometry() {
  const { around, rows } = COLLAR;
  const count = around * rows;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute("thick", new THREE.BufferAttribute(new Float32Array(count), 1));
  g.setAttribute("milk", new THREE.BufferAttribute(new Float32Array(count), 1));
  g.setAttribute("cook", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  // 안쪽(노른자에 붙은 곳) 1 → 바깥 0: 아래 흰자 위에 겹쳐도 경계가 보이지 않게 서서히 사라진다
  const fade = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s = (i % rows) / (rows - 1);
    fade[i] = Math.pow(1 - s, 1.6) * (1 - s * s * (3 - 2 * s) * 0.3);
  }
  g.setAttribute("fade", new THREE.BufferAttribute(fade, 1));
  const index: number[] = [];
  // (둘레 i → i+1) × (안 → 밖) = 위를 향하는 감김
  for (let i = 0; i < around; i++) {
    const i1 = (i + 1) % around;
    for (let r = 0; r + 1 < rows; r++) {
      const a = i * rows + r;
      const b = i1 * rows + r;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  g.setIndex(index);
  return g;
}

/**
 * 노른자 아래 옆면을 감싸고 올라온 농후 흰자 띠.
 * 안쪽 끝은 노른자 표면에 붙어 흰자 수면보다 조금 높이 올라가 있고(표면장력으로 맺힌 메니스커스),
 * 바깥으로 갈수록 오목하게 내려와 얇아지며 흰자 표면에 녹아든다 → 노른자가 흰자 속에 앉아 있는 모습.
 */
function updateCollar(
  mesh: THREE.Mesh,
  c: THREE.Vector3,
  a: number,
  h: number,
  surfaceAt: (x: number, z: number) => number,
  field: AlbumenField,
  thermal: ThermalField,
  phase: number,
) {
  const g = mesh.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const thick = g.attributes.thick as THREE.BufferAttribute;
  const milk = g.attributes.milk as THREE.BufferAttribute;
  const cook = g.attributes.cook as THREE.BufferAttribute;
  const { around, rows, climb, reach } = COLLAR;
  const { n, cell, x0, z0 } = field;
  /** 높이 y에서 노른자(타원체) 가로 반지름 */
  const radiusAt = (y: number) => a * Math.sqrt(Math.max(0, 1 - ((y - c.y) / h) ** 2));
  for (let i = 0; i < around; i++) {
    const th = (i / around) * Math.PI * 2;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    // 둘레마다 조금씩 다른 높이·폭 (매끈한 고리처럼 보이지 않게)
    const wob = Math.sin(3 * th + phase) * 0.3 + Math.sin(7 * th + phase * 1.7) * 0.15;
    const water = surfaceAt(c.x + cos * a * 1.08, c.z + sin * a * 1.08);
    const yIn = Math.min(c.y - h * 0.2, water + climb * (1 + wob));
    const rIn = radiusAt(yIn) - 0.0002;
    const rOut = a + reach * (1 + wob * 0.3);
    for (let r = 0; r < rows; r++) {
      const s = r / (rows - 1);
      const rad = THREE.MathUtils.lerp(rIn, rOut, Math.pow(s, 0.85));
      const x = c.x + cos * rad;
      const z = c.z + sin * rad;
      const under = surfaceAt(x, z) + 0.0002;
      // 오목한 필렛: 노른자 쪽은 가파르게, 바깥은 완만하게 흰자 수면으로
      const y = Math.max(under, under + (yIn - under) * Math.pow(1 - s, 2.2));
      pos.setXYZ(i * rows + r, x, y, z);
      thick.setX(i * rows + r, 0.0032);
      milk.setX(i * rows + r, 0.06 + 0.1 * (1 - s));
      // 익힘: 아래 흰자와 같은 값, 노른자에 가까울수록 (두꺼워서) 덜 익음
      const gi = THREE.MathUtils.clamp(Math.round((x - x0) / cell), 0, n - 1);
      const gj = THREE.MathUtils.clamp(Math.round((z - z0) / cell), 0, n - 1);
      const k = gj * n + gi;
      cook.setXY(i * rows + r, thermal.doneness[k] * (0.7 + 0.3 * s), 0);
    }
  }
  for (const attr of [pos, thick, milk, cook]) attr.needsUpdate = true;
  g.computeVertexNormals();
  // 실제 경사대로 두면 노른자 쪽으로 선 면이 조명을 정면으로 받아 주변 흰자보다 훨씬 밝은 고리가 된다
  // → 법선을 위쪽(아래 흰자 표면과 같은 방향)으로 많이 눕혀 밝기를 흰자에 맞춘다
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < nor.count; i++) {
    const x = nor.getX(i) * 0.3;
    const z = nor.getZ(i) * 0.3;
    const y = Math.max(0.2, nor.getY(i)) * 0.3 + 0.7;
    const l = Math.hypot(x, y, z);
    nor.setXYZ(i, x / l, y / l, z / l);
  }
}

/** 렌더용 표면 두께 (흐름 두께 + 농후 흰자) */
const surface = new Float32Array(FIELD_GRID.n * FIELD_GRID.n);

/** 3×3 흐림 가중치 (가운데 4는 따로) */
const BLUR: Array<[number, number]> = [
  [1, 2], [-1, 2], [FIELD_GRID.n, 2], [-FIELD_GRID.n, 2],
  [FIELD_GRID.n + 1, 1], [FIELD_GRID.n - 1, 1], [-FIELD_GRID.n + 1, 1], [-FIELD_GRID.n - 1, 1],
];

/**
 * 넓게 흐린 표면 두께 (반경 3칸 ≈ 8mm). 탁한 정도·표면 기울기에 쓴다.
 * 흐름은 격자 방향으로 계산되어, 나눠 부은 흰자가 겹쳐 멈춘 두께 경계가 격자 직선(네모·마름모)이 된다
 * → 두께 그대로 칠하면 네모난 뿌연 조각과 직선 주름 반사가 보인다
 */
const smooth = new Float32Array(FIELD_GRID.n * FIELD_GRID.n);
const smoothTmp = new Float32Array(FIELD_GRID.n * FIELD_GRID.n);
const SMOOTH_W = [1, 3, 6, 7, 6, 3, 1];

/** 표면 두께: 안쪽(두꺼운 곳)은 흐린 두께, 얇은 가장자리는 원래 두께 — 둘 사이를 매끄럽게 섞는다 (고르면 꺾인 주름이 생긴다) */
function smoothSurface(k: number) {
  const inner = THREE.MathUtils.smoothstep(Math.min(surface[k], smooth[k]), 0.0006, 0.0015);
  return surface[k] + (smooth[k] - surface[k]) * inner;
}

/** 렌더 두께 (흐름 두께 + 농후 흰자 + 젖은 막) — 절벽 칸 그리기에서 재사용 */
const renderT = new Float32Array(FIELD_GRID.n * FIELD_GRID.n);
/** 흰자 격자 정점 법선 — 절벽 칸의 바닥 조각도 같은 법선을 써야 이음매(격자 톱니)가 보이지 않는다 */
const surfaceNormal = new Float32Array(FIELD_GRID.n * FIELD_GRID.n * 3).map((_, i) => (i % 3 === 1 ? 1 : 0));

const MAX_CLIFF_VERTS = 100000;

/** 흰자 가장자리까지의 거리 (익힘 계산용) */
const edgeDist = new Float32Array(FIELD_GRID.n * FIELD_GRID.n);

/** 두께 → 탁도 (얇은 흰자는 거의 투명, 두꺼운 농후 흰자는 살짝 탁함) */
const milkOf = (t: number) =>
  0.02 + 0.08 * THREE.MathUtils.smoothstep(t, 0.001, 0.0045) + 0.34 * THREE.MathUtils.smoothstep(t, 0.0045, 0.0078);

/** 흰자가 지나간 자리의 젖은 막 두께 (거의 투명, 반사만 보이는 정도) */
const filmOf = (wet: number) => (wet > 0.0004 ? Math.min(0.0005, 0.0003 + wet * 0.08) : 0);

/**
 * 절벽(팬 테두리, 유리 끝)이 지나가는 칸.
 * - 칸을 정확한 절벽선에서 나눠 높은 쪽·낮은 쪽 다각형을 각각 그 높이에 그린다 → 계단·톱니 없이 절벽선까지 채움
 * - 흰자가 절벽을 넘어간 곳(위·아래가 모두 젖음)은 절벽을 따라 흘러내린 막으로 위아래를 잇는다
 */
function updateCliffs(
  mesh: THREE.Mesh | null,
  field: AlbumenField,
  thermal: ThermalField,
  sideAt?: (x: number, z: number, y: number) => [number, number] | null,
) {
  if (!mesh) return;
  const g = mesh.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const thick = g.attributes.thick as THREE.BufferAttribute;
  const milk = g.attributes.milk as THREE.BufferAttribute;
  const cook = g.attributes.cook as THREE.BufferAttribute;
  const { n, cell, x0, z0, ground, wet } = field;
  const { doneness, browning } = thermal;
  const b = field.bounds;
  let v = 0;
  /** k: 익힘 값을 가져올 격자점 (−1 = 열원에서 떨어져 익지 않는 곳) */
  type P = { x: number; y: number; z: number; t: number; m?: number; k: number };
  const put = (p: P, nx: number, ny: number, nz: number) => {
    pos.setXYZ(v, p.x, p.y, p.z);
    nor.setXYZ(v, nx, ny, nz);
    thick.setX(v, p.t);
    milk.setX(v, p.m ?? milkOf(p.t));
    if (p.k >= 0) cook.setXY(v, doneness[p.k], browning[p.k]);
    else cook.setXY(v, 0, 0);
    v++;
  };
  const corner = (k: number): P => ({
    x: x0 + (k % n) * cell,
    y: ground[k] + Math.max(surface[k], renderT[k] * 0.5) + (renderT[k] > 0 ? 0.0003 : -0.0005),
    z: z0 + Math.floor(k / n) * cell,
    t: renderT[k],
    // 탁한 정도는 흰자 격자와 같은 기준 (흐름 두께) — 다르면 절벽 칸만 뿌옇게 떠 격자 톱니가 보인다
    m: milkOf(surface[k]),
    k,
  });
  // 양면 재질은 뒷면에서 법선을 뒤집는다 → 삼각형이 반드시 법선 쪽을 앞면으로 향하게 감는다
  // (아니면 아래(흰 바닥)를 반사해 밝은 톱니·줄무늬가 생긴다)
  const tri = (p0: P, p1: P, p2: P, nx: number, ny: number, nz: number) => {
    const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
    const bx = p2.x - p0.x, by = p2.y - p0.y, bz = p2.z - p0.z;
    const facing = (ay * bz - az * by) * nx + (az * bx - ax * bz) * ny + (ax * by - ay * bx) * nz;
    put(p0, nx, ny, nz);
    if (facing >= 0) {
      put(p1, nx, ny, nz);
      put(p2, nx, ny, nz);
    } else {
      put(p2, nx, ny, nz);
      put(p1, nx, ny, nz);
    }
  };
  // 바닥에 깔린 조각: 정점마다 흰자 격자와 같은 법선 (평평한 법선을 쓰면 반사가 달라 경계가 계단처럼 드러난다)
  const putN = (p: P) => put(p, surfaceNormal[p.k * 3], surfaceNormal[p.k * 3 + 1], surfaceNormal[p.k * 3 + 2]);
  const fan = (pts: P[]) => {
    for (let i = 1; i + 1 < pts.length; i++) {
      const p0 = pts[0], p1 = pts[i], p2 = pts[i + 1];
      const up = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
      putN(p0);
      if (up >= 0) {
        putN(p1);
        putN(p2);
      } else {
        putN(p2);
        putN(p1);
      }
    }
  };
  // 막 두께가 절벽선을 따라 조금씩 달라 가닥처럼 흘러내리는 느낌
  const strand = (x: number, z: number) => 0.75 + 0.25 * Math.sin(x * 610 + z * 230) * Math.sin(z * 520 - x * 170);

  for (const c of field.cliffs) {
    if (v + 120 > MAX_CLIFF_VERTS) break;
    const ci = c.cell % n;
    const cj = Math.floor(c.cell / n);
    if (ci < b.i0 - 3 || ci > b.i1 + 3 || cj < b.j0 - 3 || cj > b.j1 + 3) continue;
    const gs = c.corners.map((k) => ground[k]);
    const mid = (Math.max(...gs) + Math.min(...gs)) / 2;
    const low: P[] = [];
    const high: P[] = [];
    const crossings: Array<{ top: P; bottom: P; dx: number; dz: number; hi: number; lo: number }> = [];
    for (let e = 0; e < 4; e++) {
      const k = c.corners[e];
      (ground[k] > mid ? high : low).push(corner(k));
      const x = c.edges[e];
      if (!x) continue;
      const top = { x: x.x, y: x.top + Math.max(surface[x.hi], renderT[x.hi] * 0.5) + 0.0003, z: x.z, t: renderT[x.hi], m: milkOf(surface[x.hi]), k: x.hi };
      const bottom = { x: x.x, y: x.bottom + Math.max(surface[x.lo], renderT[x.lo] * 0.5) + 0.0003, z: x.z, t: renderT[x.lo], m: milkOf(surface[x.lo]), k: x.lo };
      // 바깥벽이 아래로 오므라드는 곳(팬)은 고인 흰자가 벽 밑까지 들어가 있다
      // (테두리 바로 아래에서 끊기면 테두리 둘레를 따라 격자 모양 톱니 선이 보인다)
      // 많이 고인 곳일수록 벽 밑 깊이 들어가 끝이 둥글게 이어진다 (모두 같은 깊이면 끝이 직선으로 잘린다)
      const base = sideAt?.(x.x, x.z, x.bottom + 0.001);
      if (base) {
        const f = THREE.MathUtils.smoothstep(field.h[x.lo] + field.wet[x.lo] * 0.5, 0.0004, 0.0025);
        bottom.x += (base[0] - bottom.x) * f;
        bottom.z += (base[1] - bottom.z) * f;
        bottom.t *= 1 - 0.4 * f;
      }
      high.push(top);
      low.push(bottom);
      const hx = x0 + (x.hi % n) * cell;
      const hz = z0 + Math.floor(x.hi / n) * cell;
      const len = Math.hypot(x.x - hx, x.z - hz) || 1;
      crossings.push({ top, bottom, dx: (x.x - hx) / len, dz: (x.z - hz) / len, hi: x.hi, lo: x.lo });
    }
    if (high.some((p) => p.t > 0)) fan(high);
    if (low.some((p) => p.t > 0)) fan(low);
    // 흘러내린 막: 절벽선 조각(교차점 두 개)마다, 위·아래가 모두 젖은 경우만
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const a = crossings[i];
      const d = crossings[i + 1];
      if (Math.max(wet[a.hi], wet[d.hi]) < 0.0003 || Math.max(wet[a.lo], wet[d.lo]) < 0.0003) continue;
      // 법선: 절벽선 조각에 수직인 수평 방향(낮은 쪽) → 이웃 조각과 매끄럽게 이어짐
      let nx = d.top.z - a.top.z;
      let nz = -(d.top.x - a.top.x);
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      if (nx * (a.dx + d.dx) + nz * (a.dz + d.dz) < 0) {
        nx = -nx;
        nz = -nz;
      }
      // 두께: 많이 흘러넘친 곳일수록 두껍고, 흘러넘친 구간의 양 끝은 가늘게 사라진다
      const amount = (x: (typeof crossings)[number]) =>
        THREE.MathUtils.smoothstep(Math.min(wet[x.hi], wet[x.lo]), 0.0001, 0.0007) * strand(x.top.x, x.top.z);
      const ta = Math.max(a.top.t, 0.0016) * amount(a);
      const td = Math.max(d.top.t, 0.0016) * amount(d);
      // 넘친 흰자는 공중에 커튼처럼 걸리지 않고 옆면(팬 바깥벽, 유리 옆면)에 달라붙어 흘러내린다.
      // 가닥마다 흘러내린 길이가 달라(끈적한 흰자가 벽에 붙어 멈춤) 아래 끝이 들쭉날쭉한 혀 모양이 된다
      const ROWS = 7;
      // 아래 끝: 완만하게 출렁이는 선 + 군데군데 길게 늘어진 굵은 방울 (이웃 조각끼리 매끄럽게 이어지는 저주파)
      const reach = (p: P) => {
        const wave = 0.5 + 0.18 * Math.sin(p.x * 180 + p.z * 110) + 0.1 * Math.sin(p.z * 330 - p.x * 140);
        const drip = Math.max(0, Math.sin(p.x * 260 - p.z * 210)) ** 8;
        return THREE.MathUtils.clamp(wave + 0.45 * drip, 0.2, 1);
      };
      const column = (c: (typeof crossings)[number], t: number) => {
        const top = c.top;
        // 넘친 흰자가 아래에 고일수록 막이 벽을 따라 더 길게 내려와 있다 (넘치는 순간 바로 바닥까지 닿지 않음)
        const len = reach(top) * (0.25 + 0.75 * THREE.MathUtils.smoothstep(wet[c.lo], 0.0003, 0.0012));
        const out: Array<P & { wx: number; wz: number }> = [];
        for (let r = 0; r <= ROWS; r++) {
          const f = (r / ROWS) * len;
          const y = top.y + (c.bottom.y - top.y) * f;
          const w = sideAt?.(top.x, top.z, y) ?? [top.x, top.z];
          // 아래로 갈수록 얇아지고 끝은 둥글게 사라진다
          const tt = t * (1 - 0.55 * (r / ROWS)) * (r === ROWS ? 0 : 1);
          const film = 0.0004 + tt * 0.6;
          // 벽에 붙은 날 흰자는 맑은 막 (뿌옇지 않게 — 광택으로만 보인다)
          out.push({ x: w[0] + nx * film, y, z: w[1] + nz * film, t: tt, k: -1, m: milkOf(tt), wx: w[0], wz: w[1] });
        }
        return out;
      };
      const ca = column(a, ta);
      const cd = column(d, td);
      for (let r = 0; r < ROWS; r++) {
        // 벽 곡면의 바깥 법선: 세로 단면에서 접선(수평 변화, 높이 변화)에 수직
        const dr = (ca[r].wx - ca[r + 1].wx) * nx + (ca[r].wz - ca[r + 1].wz) * nz;
        const dy = ca[r].y - ca[r + 1].y || 1e-6;
        const l = Math.hypot(dr, dy);
        const hn = dy / l;
        const vn = -dr / l;
        tri(ca[r], cd[r], cd[r + 1], nx * hn, vn, nz * hn);
        tri(ca[r], cd[r + 1], ca[r + 1], nx * hn, vn, nz * hn);
      }
    }
  }
  for (const attr of [pos, nor, thick, milk, cook]) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, v * attr.itemSize);
    attr.needsUpdate = true;
  }
  g.setDrawRange(0, v);
  fieldBounds(g, field);
}

/**
 * 흰자에 열을 가하고 위치별 (익힘, 갈변)을 정점 속성 cook에 쓴다.
 * 두께가 얇을수록 빨리 익고(가장자리부터 하얘짐), 다 익은 얇은 곳은 계속 열을 받아 노릇해진다.
 */
function cookWhite(
  mesh: THREE.Mesh | null,
  field: AlbumenField,
  thermal: ThermalField,
  cellHeat: Float32Array,
  prevH: Float32Array,
  dp: number,
): CookSummary {
  const summary: CookSummary = { heatedArea: 0, raw: 0, brown: 0, heatCenter: null };
  if (!mesh) return summary;
  let heated = 0;
  let raw = 0;
  let brown = 0;
  let hx = 0;
  let hz = 0;
  const cook = mesh.geometry.attributes.cook as THREE.BufferAttribute;
  const { n } = field;
  const b = field.bounds;
  const i0 = Math.max(1, b.i0 - 2);
  const i1 = Math.min(n - 2, b.i1 + 2);
  const j0 = Math.max(1, b.j0 - 2);
  const j1 = Math.min(n - 2, b.j1 + 2);
  const { thin, thick, thickAt } = COOK.setDose;
  // 가장자리까지의 거리 (2패스 챔퍼 거리 변환, m)
  const reach = COOK.edgeReach;
  const diag = field.cell * Math.SQRT2;
  for (let j = j0 - 1; j <= j1 + 1; j++) {
    for (let i = i0 - 1; i <= i1 + 1; i++) {
      const k = j * n + i;
      edgeDist[k] = renderT[k] > 0.0003 && i >= i0 && i <= i1 && j >= j0 && j <= j1 ? reach : 0;
    }
  }
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * n + i;
      if (edgeDist[k] === 0) continue;
      edgeDist[k] = Math.min(edgeDist[k], edgeDist[k - 1] + field.cell, edgeDist[k - n] + field.cell, edgeDist[k - n - 1] + diag, edgeDist[k - n + 1] + diag);
    }
  }
  for (let j = j1; j >= j0; j--) {
    for (let i = i1; i >= i0; i--) {
      const k = j * n + i;
      if (edgeDist[k] === 0) continue;
      edgeDist[k] = Math.min(edgeDist[k], edgeDist[k + 1] + field.cell, edgeDist[k + n] + field.cell, edgeDist[k + n + 1] + diag, edgeDist[k + n - 1] + diag);
    }
  }
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * n + i;
      // 날 흰자가 새로 덮이면(흐름 두께가 늘면) 그만큼 묽어진다 (층 전체의 평균 익힘)
      const hk = field.h[k];
      if (hk > prevH[k] + 1e-5) thermal.dilute(k, prevH[k] / hk);
      prevH[k] = hk;
      const t = surface[k] > 0 ? Math.max(renderT[k], smoothSurface(k)) : renderT[k];
      if (t <= 0) {
        if (thermal.dose[k] !== 0) thermal.clear(k);
      } else {
        // 열이 두께를 뚫고 올라오는 시간: 얇은 곳은 금방, 두께가 늘수록 완만하게 늘어남
        const x = THREE.MathUtils.clamp((t - 0.0003) / (thickAt - 0.0003), 0, 1);
        const edge = THREE.MathUtils.lerp(COOK.edgeFactor, 1, THREE.MathUtils.smootherstep(edgeDist[k], 0, reach));
        const setDose = (thin + (thick - thin) * Math.pow(x, 0.7)) * edge;
        const brownRate = COOK.brownRate * (1 - THREE.MathUtils.smoothstep(t, 0.0005, COOK.brownBelow));
        if (cellHeat[k] < 0) cellHeat[k] = heatAt(field.x0 + i * field.cell, field.ground[k], field.z0 + j * field.cell);
        thermal.heat(k, dp, cellHeat[k], setDose, brownRate);
        if (cellHeat[k] > 0 && t > 0.0004) {
          heated += cellHeat[k];
          hx += cellHeat[k] * i;
          hz += cellHeat[k] * j;
          raw += cellHeat[k] * (1 - thermal.doneness[k]);
          brown += cellHeat[k] * thermal.browning[k];
        }
      }
      cook.setXY(k, thermal.doneness[k], thermal.browning[k]);
    }
  }
  cook.clearUpdateRanges();
  cook.addUpdateRange(j0 * n * 2, (j1 - j0 + 1) * n * 2);
  cook.needsUpdate = true;
  summary.heatedArea = heated * field.cell * field.cell;
  if (heated > 0) summary.heatCenter = [field.x0 + (hx / heated) * field.cell, field.z0 + (hz / heated) * field.cell];
  summary.raw = heated > 0 ? raw / heated : 0;
  // 노릇함은 가장자리에만 생기므로 "가장 노릇한 띠"가 얼마나 진행됐는지로: 면적 비율을 키워서
  summary.brown = heated > 0 ? Math.min(1, (brown / heated) * 6) : 0;
  return summary;
}

/** 두께장 → 격자 메시 (흰자가 있는 영역만 갱신) */
function updateFieldMesh(mesh: THREE.Mesh | null, field: AlbumenField, mound: Mound) {
  if (!mesh) return;
  const g = mesh.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const thick = g.attributes.thick as THREE.BufferAttribute;
  const milk = g.attributes.milk as THREE.BufferAttribute;
  const { n, h, ground, cell, x0, z0 } = field;
  const b = field.bounds;
  const i0 = Math.max(1, b.i0 - 2);
  const i1 = Math.min(n - 2, b.i1 + 2);
  const j0 = Math.max(1, b.j0 - 2);
  const j1 = Math.min(n - 2, b.j1 + 2);
  const firstTime = !mesh.userData.initialized;
  if (firstTime) {
    // 격자 전체를 바닥에 깔아 둔다 (흰자가 없는 곳은 cover = 0)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        pos.setXYZ(k, x0 + i * cell, ground[k], z0 + j * cell);
        nor.setXYZ(k, 0, 1, 0);
        surfaceNormal.set([0, 1, 0], k * 3);
      }
    }
    mesh.userData.initialized = true;
  }
  // 렌더 두께 = 흐름 두께 + 농후 흰자 층
  for (let j = j0 - 1; j <= j1 + 1; j++) {
    for (let i = i0 - 1; i <= i1 + 1; i++) {
      const k = j * n + i;
      const hk = h[k];
      const m = moundAt(mound, x0 + i * cell, z0 + j * cell) * THREE.MathUtils.smoothstep(hk, 0.0003, 0.0015);
      surface[k] = hk + m;
    }
  }
  // 두께를 가로·세로로 흐린다 (절벽 건너편은 다른 면이라 섞지 않는다)
  const R = SMOOTH_W.length >> 1;
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? surface : smoothTmp;
    const dst = pass === 0 ? smoothTmp : smooth;
    const step = pass === 0 ? 1 : n;
    for (let j = j0 - 1; j <= j1 + 1; j++) {
      for (let i = i0 - 1; i <= i1 + 1; i++) {
        const k = j * n + i;
        let sum = 0;
        let wsum = 0;
        for (let o = -R; o <= R; o++) {
          const ii = pass === 0 ? i + o : i;
          const jj = pass === 0 ? j : j + o;
          if (ii < i0 - 1 || ii > i1 + 1 || jj < j0 - 1 || jj > j1 + 1) continue;
          const q = k + o * step;
          if (Math.abs(ground[q] - ground[k]) > CLIFF) continue;
          const w = SMOOTH_W[o + R];
          sum += src[q] * w;
          wsum += w;
        }
        dst[k] = sum / wsum;
      }
    }
  }
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * n + i;
      const t = surface[k];
      // 절벽 건너편 이웃은 같은 면이 아니다: 기울기·흐림 계산에서 빼야
      // 절벽 옆 정점의 법선이 눕지 않는다 (누우면 흰 배경을 강하게 반사해 밝은 톱니가 생긴다)
      // 기울기는 흐린 두께로 (두께 경계가 격자 직선 주름으로 빛나지 않게). 얇은 가장자리는 원래 두께로 (윤곽이 무르지 않게)
      const sm = smoothSurface;
      const eta = ground[k] + sm(k);
      const same = (o: number) => Math.abs(ground[k + o] - ground[k]) <= CLIFF;
      const slope = (o: number) => {
        const f = same(o);
        const b = same(-o);
        if (f && b) return (ground[k + o] + sm(k + o) - (ground[k - o] + sm(k - o))) / 2;
        if (f) return ground[k + o] + sm(k + o) - eta;
        if (b) return eta - (ground[k - o] + sm(k - o));
        return 0;
      };
      const nx = -slope(1) / cell;
      const nz = -slope(n) / cell;
      const len = Math.hypot(nx, 1, nz);
      nor.setXYZ(k, nx / len, 1 / len, nz / len);
      surfaceNormal[k * 3] = nx / len;
      surfaceNormal[k * 3 + 1] = 1 / len;
      surfaceNormal[k * 3 + 2] = nz / len;
      // 가장자리 판정용 두께는 살짝 흐리게(3×3): 두께가 한 칸 안에서 0으로 떨어지면
      // 경계선이 삼각형 대각선을 따라 톱니처럼 보인다
      let sum = 4 * t;
      let wsum = 4;
      for (const [o, w] of BLUR) {
        if (!same(o)) continue;
        sum += surface[k + o] * w;
        wsum += w;
      }
      const soft = sum / wsum;
      // 흰자가 지나간 자리에는 얇게 젖은 막이 남는다 (흐른 자국이 끊기지 않게)
      // 안쪽(충분히 두꺼운 곳)은 넓게 흐린 두께 → 물결 세기·기포·익는 속도가 두께 경계를 따라 네모나게 갈리지 않게.
      // 얇은 가장자리는 3×3 두께 그대로 (윤곽은 또렷하게)
      const inner = THREE.MathUtils.smoothstep(Math.min(soft, smooth[k]), 0.0006, 0.0015);
      const rt = Math.max(soft + (smooth[k] - soft) * inner, filmOf(field.wet[k]));
      renderT[k] = rt;
      thick.setX(k, rt);
      pos.setY(k, ground[k] + Math.max(sm(k), rt * 0.5) + (rt > 0 ? 0.0003 : -0.0005));
      // 얇은 흰자는 거의 투명, 두꺼운 농후 흰자는 살짝 탁함 (흐린 두께로 → 경계가 둥글게 번진다)
      milk.setX(k, milkOf(sm(k)));
    }
  }
  // 바뀐 줄만 GPU로 올린다 (격자 전체 3.6만 정점을 매 프레임 올리지 않게)
  for (const a of [pos, nor, thick, milk]) {
    a.clearUpdateRanges();
    if (!firstTime) a.addUpdateRange(j0 * n * a.itemSize, (j1 - j0 + 1) * n * a.itemSize);
    a.needsUpdate = true;
  }
  fieldBounds(g, field);
}

/**
 * 흰자 격자 전체를 감싸는 고정 구 (투명 물체 정렬용). 정점이 바뀔 때마다 3.6만 개를 다시 훑지 않게 한 번만 정한다
 * (화면 밖 판정은 쓰지 않는다 — frustumCulled = false)
 */
function fieldBounds(g: THREE.BufferGeometry, field: AlbumenField) {
  if (g.boundingSphere && g.userData.boundsFor === field) return;
  const mid = field.groundAt(field.x0 + field.size / 2, field.z0 + field.size / 2);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(field.x0 + field.size / 2, mid, field.z0 + field.size / 2), field.size * 0.75);
  g.userData.boundsFor = field;
}
