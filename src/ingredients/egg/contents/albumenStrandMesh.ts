import * as THREE from "three";
import { blobRadius, type AlbumenStrand, type StrandAnchor } from "./albumenStrand";

/**
 * 흰자 줄기 → 하나로 이어진 매끈한 튜브 메시.
 * 알갱이마다 구(부피만큼), 이웃 사이는 실 굵기의 원기둥으로 보고 그 합집합의 단면 반지름을
 * 곡선(캣멀롬)을 따라 잰다 → 덩어리는 둥글게 부풀고, 실은 가늘게 이어지는 콧물 같은 모양.
 * 방울을 따로 그리면 반투명한 구가 겹쳐 얼룩지므로 한 겹의 표면으로 만든다.
 */
const SIDES = 16;
const SAMPLES = 5;
const CAP = 6;
const MAX_RINGS = 1200;

export function createStrandGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_RINGS * SIDES * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(MAX_RINGS * SIDES * 3), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(MAX_RINGS * SIDES * 6), 1));
  g.setDrawRange(0, 0);
  return g;
}

type Ring = { c: THREE.Vector3; t: THREE.Vector3; r: number };

const pts: THREE.Vector3[] = [];
const radii: number[] = [];
const links: number[] = [];
const pool: Ring[] = [];
const ring = (i: number) => (pool[i] ??= { c: new THREE.Vector3(), t: new THREE.Vector3(), r: 0 });
const tmp = new THREE.Vector3();
const nrm = new THREE.Vector3();
const bin = new THREE.Vector3();
const rad = new THREE.Vector3();

function catmull(out: THREE.Vector3, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  for (const k of ["x", "y", "z"] as const) {
    out[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  }
  return out;
}

/** 위치 x의 단면 반지름: 이웃 알갱이 구들과 이 구간 실의 합집합 */
function radiusAt(x: THREE.Vector3, segment: number) {
  let r = segment >= 0 ? links[segment] : 0;
  for (let j = 0; j < pts.length; j++) {
    const rb = radii[j];
    if (rb <= 0) continue;
    const d = x.distanceTo(pts[j]);
    if (d < rb) r = Math.max(r, Math.sqrt(rb * rb - d * d));
  }
  return r;
}

export function updateStrandMesh(mesh: THREE.Mesh, strand: AlbumenStrand, anchor: StrandAnchor) {
  const g = mesh.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const index = g.index!;
  const idx = index.array as Uint32Array;
  let ringCount = 0;
  let indexCount = 0;
  const ps = strand.particles;

  let start = 0;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].linkNext && i < ps.length - 1) continue;
    // 한 줄기: start..i (+ 맨 위가 틈에 매달려 있으면 틈까지)
    const anchored = i === ps.length - 1 && strand.anchorLinked;
    pts.length = radii.length = links.length = 0;
    for (let k = start; k <= i; k++) {
      pts.push(new THREE.Vector3(ps[k].x, ps[k].y, ps[k].z));
      radii.push(blobRadius(ps[k].v) * 0.95);
    }
    if (anchored) {
      pts.push(new THREE.Vector3(anchor.x, anchor.y, anchor.z));
      radii.push(0);
    }
    for (let k = 0; k + 1 < pts.length; k++) {
      const l = Math.max(1e-4, pts[k].distanceTo(pts[k + 1]));
      const a = start + k;
      const isAnchor = anchored && k + 1 === pts.length - 1;
      const v = isAnchor ? ps[a].v : Math.min(ps[a].v, ps[a + 1].v);
      // 알갱이 사이는 잘록하게 (반듯한 관이 아니라 덩어리가 늘어지며 이어진 모양)
      const cap = isAnchor ? Math.min(radii[k] * 0.55, 0.0045) : 0.72 * Math.min(radii[k], radii[k + 1]);
      links.push(Math.min(cap, Math.sqrt(v / (Math.PI * l))));
    }
    start = i + 1;
    const first = ringCount;
    if (ringCount + (pts.length - 1) * SAMPLES + CAP * 2 + 2 > MAX_RINGS) break;

    // 아래 끝 둥근 마개
    const down = pts.length > 1 ? tmp.subVectors(pts[0], pts[1]).normalize() : tmp.set(0, -1, 0);
    const downDir = down.clone();
    for (let c = CAP; c >= 1; c--) {
      const r = ring(ringCount++);
      const f = c / CAP;
      r.c.copy(pts[0]).addScaledVector(downDir, radii[0] * Math.sin((f * Math.PI) / 2));
      r.t.copy(downDir).negate();
      r.r = c === CAP ? 0 : radiusAt(r.c, -1);
    }
    // 몸통
    for (let k = 0; k + 1 < pts.length; k++) {
      const p0 = pts[Math.max(0, k - 1)];
      const p1 = pts[k];
      const p2 = pts[k + 1];
      const p3 = pts[Math.min(pts.length - 1, k + 2)];
      for (let sIdx = 0; sIdx < SAMPLES; sIdx++) {
        const r = ring(ringCount++);
        catmull(r.c, p0, p1, p2, p3, sIdx / SAMPLES);
        catmull(r.t, p0, p1, p2, p3, Math.min(1, sIdx / SAMPLES + 0.01)).sub(r.c);
        if (r.t.lengthSq() < 1e-14) r.t.subVectors(p2, p1);
        r.t.normalize();
        r.r = radiusAt(r.c, k);
      }
    }
    const last = pts[pts.length - 1];
    if (anchored) {
      // 틈 속으로 들어가는 목
      const r = ring(ringCount++);
      r.c.copy(last);
      r.t.copy(ring(ringCount - 2).t);
      r.r = links[links.length - 1];
    } else {
      // 위 끝 둥근 마개
      const up = pts.length > 1 ? new THREE.Vector3().subVectors(last, pts[pts.length - 2]).normalize() : new THREE.Vector3(0, 1, 0);
      for (let c = 0; c <= CAP; c++) {
        const r = ring(ringCount++);
        const f = c / CAP;
        r.c.copy(last).addScaledVector(up, radii[radii.length - 1] * Math.sin((f * Math.PI) / 2));
        r.t.copy(up);
        r.r = c === CAP ? 0 : radiusAt(r.c, -1);
      }
    }
    // 고리 정점: 평행 이동 좌표계로 비틀림 없이
    nrm.set(0, 0, 0);
    for (let q = first; q < ringCount; q++) {
      const r = ring(q);
      if (nrm.lengthSq() < 0.5) {
        nrm.set(1, 0, 0);
        if (Math.abs(r.t.x) > 0.9) nrm.set(0, 0, 1);
      }
      nrm.addScaledVector(r.t, -nrm.dot(r.t)).normalize();
      bin.crossVectors(r.t, nrm);
      // 반지름 변화율 → 법선 기울기 (부푼 곳의 앞뒤가 바르게 음영)
      const prev = ring(Math.max(first, q - 1));
      const next = ring(Math.min(ringCount - 1, q + 1));
      const ds = Math.max(1e-5, prev.c.distanceTo(next.c));
      const drds = (next.r - prev.r) / ds;
      for (let sd = 0; sd < SIDES; sd++) {
        const a = (sd / SIDES) * Math.PI * 2;
        rad.copy(nrm).multiplyScalar(Math.cos(a)).addScaledVector(bin, Math.sin(a));
        const vi = q * SIDES + sd;
        pos.setXYZ(vi, r.c.x + rad.x * r.r, r.c.y + rad.y * r.r, r.c.z + rad.z * r.r);
        rad.addScaledVector(r.t, -drds).normalize();
        nor.setXYZ(vi, rad.x, rad.y, rad.z);
      }
      if (q > first) {
        const a0 = (q - 1) * SIDES;
        const b0 = q * SIDES;
        for (let sd = 0; sd < SIDES; sd++) {
          const s1 = (sd + 1) % SIDES;
          idx[indexCount++] = a0 + sd;
          idx[indexCount++] = a0 + s1;
          idx[indexCount++] = b0 + sd;
          idx[indexCount++] = a0 + s1;
          idx[indexCount++] = b0 + s1;
          idx[indexCount++] = b0 + sd;
        }
      }
    }
  }
  pos.clearUpdateRanges();
  pos.addUpdateRange(0, ringCount * SIDES * 3);
  nor.clearUpdateRanges();
  nor.addUpdateRange(0, ringCount * SIDES * 3);
  index.clearUpdateRanges();
  index.addUpdateRange(0, indexCount);
  pos.needsUpdate = nor.needsUpdate = index.needsUpdate = true;
  // 비어 있어도 메시는 보이게 둔다 (그릴 삼각형 0개) → 셰이더·버퍼가 장면 준비 때 미리 올라가
  // 처음 흘러나오는 순간 프레임이 끊기지 않는다
  g.setDrawRange(0, indexCount);
}
