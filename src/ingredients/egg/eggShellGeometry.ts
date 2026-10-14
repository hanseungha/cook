import * as THREE from "three";
import { crackYAt, type CrackPattern } from "./eggCrack";
import { EGG, eggRadius } from "./eggGeometry";

/** 껍데기 두께 (실제 약 0.3~0.4mm) */
export const SHELL_THICKNESS = 0.00038;

/** 재질 그룹: 바깥 껍데기 / 안쪽 막 / 깨진 단면 */
export const SHELL_GROUPS = { outer: 0, inner: 1, edge: 2 } as const;

const L = EGG.length;
const tOfY = (y: number) => Math.acos(THREE.MathUtils.clamp((-2 * y) / L, -1, 1)) / Math.PI;
const yOfT = (t: number) => -(L / 2) * Math.cos(t * Math.PI);

/** 회전면 위의 점·바깥 법선 (Lathe와 같은 규약: x = r·sinφ, z = r·cosφ) */
function surfacePoint(phi: number, t: number, pos: THREE.Vector3, normal: THREE.Vector3) {
  const y = yOfT(t);
  const r = eggRadius(y);
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  pos.set(r * sin, y, r * cos);
  // 극점 근처는 수치 미분이 불안정 → 장축 방향 법선
  const e = 1e-5;
  if (r < 1e-4) {
    normal.set(0, Math.sign(y), 0);
    return;
  }
  const dr = (eggRadius(Math.min(L / 2, y + e)) - eggRadius(Math.max(-L / 2, y - e))) / (2 * e);
  normal.set(sin, -dr, cos).normalize();
}

/**
 * 균열선을 따라 나뉜 껍데기 반쪽.
 * part "blunt" = 둥근 쪽(−Y ~ 균열), "pointy" = 뾰족한 쪽(균열 ~ +Y).
 * 바깥면·안쪽면(두께만큼 안으로) + 균열선을 따라 두 면을 잇는 단면 띠로 구성된다.
 * 바깥면의 위치·UV는 통째 계란(LatheGeometry)과 같아 맞물린 상태에서는 구분되지 않는다.
 * impactU: 충격 지점의 둘레 좌표(φ / 2π) — 균열 패턴의 w = 0이 이곳에 온다.
 */
export function createShellHalfGeometry(
  part: "blunt" | "pointy",
  pattern: CrackPattern,
  impactU: number,
  // 둘레 138mm / 256 ≈ 0.54mm 간격: 벌린 껍데기를 가까이서 봐도 균열선의 톱니가 살아 있는 최소 밀도
  // (384일 때와 구분되지 않으면서 반쪽당 삼각형 5.6만 → 3.7만)
  columns = 256,
  rows = 36,
) {
  const cols = columns + 1;
  const vertsPerSurface = cols * (rows + 1);
  const total = vertsPerSurface * 2 + cols * 2;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const color = new Float32Array(total * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const n2 = new THREE.Vector3();

  const write = (i: number, pp: THREE.Vector3, nn: THREE.Vector3, u: number, v: number, c: number) => {
    position.set([pp.x, pp.y, pp.z], i * 3);
    normal.set([nn.x, nn.y, nn.z], i * 3);
    uv.set([u, v], i * 2);
    color.set([c, c, c], i * 3);
  };

  // 열마다 균열선의 t
  const crackT = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const u = c / columns;
    crackT[c] = tOfY(crackYAt(pattern.main, u - impactU));
  }

  for (let c = 0; c < cols; c++) {
    const u = c / columns;
    const phi = u * Math.PI * 2;
    const tc = crackT[c];
    for (let r = 0; r <= rows; r++) {
      const k = r / rows;
      // 극점 → 균열선 (blunt: 0 → tc, pointy: tc → 1)
      const t = part === "blunt" ? tc * k : tc + (1 - tc) * k;
      surfacePoint(phi, t, p, n);
      const i = c * (rows + 1) + r;
      write(i, p, n, u, t, 1);
      // 안쪽 막: 두께만큼 안으로, 법선 반대. 오목한 바닥일수록 어둡게(주변광 차폐 근사)
      const rimness = part === "blunt" ? k : 1 - k;
      const ao = 0.45 + 0.55 * Math.pow(rimness, 0.6);
      p.addScaledVector(n, -SHELL_THICKNESS);
      write(vertsPerSurface + i, p, n.negate(), u, t, ao);
    }
    // 단면 띠: 균열선 위의 바깥점 ↔ 안쪽점. 법선은 반쪽 밖(균열 쪽) 장축 방향
    surfacePoint(phi, tc, p, n);
    const dt = part === "blunt" ? 1e-3 : -1e-3;
    surfacePoint(phi, tc + dt, p2, n2);
    tangent.subVectors(p2, p).normalize();
    write(vertsPerSurface * 2 + c * 2, p, tangent, u, tc, 1);
    p.addScaledVector(n, -SHELL_THICKNESS);
    write(vertsPerSurface * 2 + c * 2 + 1, p, tangent, u, tc, 1);
  }

  const index: number[] = [];
  const quads = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) index.push(a, c, b, b, c, d);
    else index.push(a, b, c, b, d, c);
  };
  // 바깥면은 φ·t가 증가하는 방향 기준으로 바깥을 향하게, 안쪽면은 반대로
  const groupStart: number[] = [];
  for (const [surface, flip] of [
    [0, false],
    [1, true],
  ] as const) {
    groupStart.push(index.length);
    const base = surface * vertsPerSurface;
    for (let c = 0; c < columns; c++) {
      for (let r = 0; r < rows; r++) {
        const a = base + c * (rows + 1) + r;
        const b = base + (c + 1) * (rows + 1) + r;
        quads(a, a + 1, b, b + 1, flip);
      }
    }
  }
  groupStart.push(index.length);
  const eBase = vertsPerSurface * 2;
  for (let c = 0; c < columns; c++) {
    const a = eBase + c * 2;
    quads(a, a + 1, a + 2, a + 3, part === "blunt");
  }
  groupStart.push(index.length);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geo.setIndex(index);
  for (let g = 0; g < 3; g++) geo.addGroup(groupStart[g], groupStart[g + 1] - groupStart[g], g);
  fixWinding(geo);
  geo.computeBoundingSphere();
  return geo;
}

/** 그룹별로 기하 법선이 정점 법선과 반대인 삼각형이 많으면 그 그룹의 감김 방향을 뒤집는다 */
function fixWinding(geo: THREE.BufferGeometry) {
  const idx = geo.index!.array as Uint16Array | Uint32Array;
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const vn = new THREE.Vector3();
  for (const g of geo.groups) {
    let vote = 0;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      a.fromBufferAttribute(pos, idx[i]);
      b.fromBufferAttribute(pos, idx[i + 1]).sub(a);
      c.fromBufferAttribute(pos, idx[i + 2]).sub(a);
      b.cross(c);
      // 극점의 퇴화 삼각형은 무시
      if (b.lengthSq() < 1e-18) continue;
      vote += b.dot(vn.fromBufferAttribute(nor, idx[i])) > 0 ? 1 : -1;
    }
    if (vote >= 0) continue;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
  }
}

/** 반쪽의 무게중심 근사 (떨어지는 껍데기의 회전 중심) */
export function shellHalfCentroid(geo: THREE.BufferGeometry, out = new THREE.Vector3()) {
  geo.computeBoundingBox();
  return geo.boundingBox!.getCenter(out);
}

/** 위쪽(로컬 +X) 균열선 위의 점: 반쪽이 벌어질 때의 경첩 */
export function shellHingePoint(pattern: CrackPattern, impactU: number) {
  const u = 0.25; // φ = π/2 → x = r
  const y = crackYAt(pattern.main, u - impactU);
  return new THREE.Vector3(eggRadius(y), y, 0);
}
