import * as THREE from "three";

/**
 * 28cm 논스틱 프라이팬의 절차적 형상 (단위: m, 팬 바닥 중심이 원점, +X가 손잡이 방향).
 * 실제 제품 치수를 참고한 프로파일을 회전(Lathe)하고, 손잡이는 단면을 경로를 따라 스윕한다.
 */
export const PAN = {
  rimRadius: 0.14,
  height: 0.048,
  wall: 0.003,
  floor: 0.006,
  flatRadius: 0.085,
  handleLength: 0.2,
} as const;

const RADIAL_SEGMENTS = 160;

type Vec2 = [r: number, y: number];

function cubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, steps: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return out;
}

/** 바깥벽: 바닥 평면 → 둥근 모서리 → 바깥으로 벌어지는 벽 */
function outerWallCurve(steps = 48) {
  const { rimRadius: R, height: H, flatRadius: F } = PAN;
  return cubic([F, 0], [F + 0.033, 0], [R - 0.012, H * 0.42], [R, H], steps);
}

/** 안쪽벽: 바깥벽을 두께만큼 안쪽으로 오프셋한 곡선 */
function innerWallCurve(steps = 48) {
  const { rimRadius: R, height: H, flatRadius: F, wall: T, floor: B } = PAN;
  return cubic([F, B], [F + 0.03, B], [R - T - 0.012, H * 0.45], [R - T, H], steps);
}

let outerWallSamples: Vec2[] | null = null;

/** 바깥 곡선에서 높이 y의 반지름 (손잡이 부착 위치, 넘친 흰자가 벽을 따라 흐르는 자리) */
export function outerRadiusAt(y: number) {
  const pts = (outerWallSamples ??= outerWallCurve(400));
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][1] >= y) {
      const [r0, y0] = pts[i - 1];
      const [r1, y1] = pts[i];
      return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
    }
  }
  return PAN.rimRadius;
}

/**
 * 조리면(안쪽) 높이 — 팬 중심으로부터의 수평 거리 r에서의 표면 y (팬 로컬).
 * 팬 바깥이면 null. 물체를 팬 안에 내려놓을 때 지지 높이로 쓴다.
 */
let innerWallSamples: Vec2[] | null = null;

export function cookingSurfaceHeightAt(r: number): number | null {
  const { rimRadius: R, wall: T, floor: B, flatRadius: F, height: H } = PAN;
  if (r > R) return null;
  if (r <= F) return B;
  if (r >= R - T) return H; // 테두리 윗면
  // 매 프레임 여러 번 불리므로 벽 곡선은 한 번만 샘플
  const pts = (innerWallSamples ??= innerWallCurve(200));
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] >= r) {
      const [r0, y0] = pts[i - 1];
      const [r1, y1] = pts[i];
      return y0 + ((r - r0) / (r1 - r0)) * (y1 - y0);
    }
  }
  return H;
}

export function innerRadiusAt(y: number) {
  const pts = innerWallCurve(400);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][1] >= y) {
      const [r0, y0] = pts[i - 1];
      const [r1, y1] = pts[i];
      return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
    }
  }
  return PAN.rimRadius - PAN.wall;
}

function lathe(profile: Vec2[], planarUv: boolean) {
  const geo = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    RADIAL_SEGMENTS,
  );
  if (planarUv) {
    // 위에서 투영한 평면 UV: 바닥의 스페클이 늘어지지 않도록
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const span = PAN.rimRadius * 2;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, pos.getX(i) / span + 0.5, pos.getZ(i) / span + 0.5);
    }
    uv.needsUpdate = true;
  }
  // LatheGeometry가 프로파일 기준으로 계산한 노멀을 그대로 쓴다 (재계산하면 이음새가 보임)
  return geo;
}

/** 조리면: 중심에서 바깥으로, 안쪽 벽을 타고 테두리까지 (위를 향하는 면) */
export function createInteriorGeometry() {
  const floor: Vec2[] = [];
  for (let i = 0; i <= 24; i++) floor.push([(PAN.flatRadius * i) / 24, PAN.floor]);
  const wall = innerWallCurve().slice(1);
  // Lathe 면 방향: 프로파일 진행 방향 기준. 조리면은 위/안쪽을 향하도록 역순.
  return lathe([...floor, ...wall].reverse(), true);
}

function exteriorProfile(): Vec2[] {
  const bottom: Vec2[] = [];
  for (let i = 0; i <= 24; i++) bottom.push([(PAN.flatRadius * i) / 24, 0]);
  return [...bottom, ...outerWallCurve().slice(1)];
}

/** 외부 (바닥 + 바깥벽) */
export function createExteriorGeometry() {
  return lathe(exteriorProfile(), false);
}

/**
 * 외벽의 환경광 차폐(AO) 프로파일 — Lathe UV의 v(프로파일 진행) 방향 1D 값.
 *
 * HDRI는 흰 스튜디오 바닥을 담고 있어, 아래를 향한 외벽이 그대로 쓰면 "흰 바닥"을 반사해
 * 밝게 뜬다. 실제로는 팬 아래에 검은 유리 상판이 있으므로
 * 1) 노멀이 아래를 볼수록 하반구(검은 유리)가 차지하는 비율만큼 어둡게
 * 2) 유리와 맞닿는 접점 근처는 추가로 어둡게 (틈새 차폐)
 */
export function exteriorOcclusionProfile() {
  const pts = exteriorProfile();
  return pts.map(([, y], i) => {
    const [r0, y0] = pts[Math.max(0, i - 1)];
    const [r1, y1] = pts[Math.min(pts.length - 1, i + 1)];
    const dr = r1 - r0;
    const dy = y1 - y0;
    const ny = -dr / Math.hypot(dr, dy); // 바깥 노멀의 y 성분
    // 코사인 가중 반구 중 수평선 아래 비율 = (1 - ny) / 2
    const belowHorizon = (1 - ny) / 2;
    const hemisphere = 1 - 0.7 * belowHorizon;
    const crease = 1 - 0.75 * Math.exp(-y / 0.005);
    return Math.max(0, hemisphere * crease);
  });
}

/**
 * 테두리: 바깥 상단에서 안쪽 상단으로 넘어가는 반원 (살짝 위로 말림).
 * 실제 코팅팬처럼 코팅이 벗겨진 알루미늄 단면이 얇은 은색 선으로 보이도록 별도 메시로 둔다.
 */
export function createRimGeometry() {
  const { rimRadius: R, height: H, wall: T } = PAN;
  const rim: Vec2[] = [];
  const cr = R - T / 2;
  const rr = T / 2;
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI;
    rim.push([cr + Math.cos(a) * rr, H + Math.sin(a) * rr * 1.1]);
  }
  return lathe(rim, false);
}

/** 바닥의 인덕션 스테인리스 디스크 (아래에서 보이는 부분) */
export function createBaseDiscGeometry() {
  const geo = new THREE.CircleGeometry(PAN.flatRadius * 0.92, RADIAL_SEGMENTS);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, -0.0002, 0);
  return geo;
}

/**
 * 손잡이: 단면(둥근 사각형, 초타원)을 곡선 경로를 따라 스윕.
 * 시작부는 벽에 붙는 넓고 납작한 브래킷, 중간은 잡기 좋은 두께, 끝은 넓은 패들 + 둥근 마감.
 */
export function createHandleGeometry() {
  const attachY = 0.033;
  const startR = outerRadiusAt(attachY) - 0.0006;
  const L = PAN.handleLength;
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(startR, attachY, 0),
    new THREE.Vector3(startR + 0.02, attachY + 0.006, 0),
    new THREE.Vector3(startR + L * 0.35, attachY + 0.022, 0),
    new THREE.Vector3(startR + L * 0.7, attachY + 0.036, 0),
    new THREE.Vector3(startR + L, attachY + 0.043, 0),
  ]);

  const lengthSteps = 160;
  const sectionSteps = 48;
  const capSteps = 16;
  const exponent = 3.2; // 초타원 지수: 클수록 각진 단면

  // 길이 방향 폭/두께 프로파일 (t: 0..1)
  const width = (t: number) => {
    const bracket = Math.exp(-Math.pow(t / 0.1, 2)) * 0.016;
    const paddle = THREE.MathUtils.smoothstep(t, 0.55, 0.92) * 0.008;
    return 0.02 + bracket + paddle;
  };
  const thickness = (t: number) => {
    const bracket = Math.exp(-Math.pow(t / 0.08, 2)) * 0.003;
    return 0.0105 - t * 0.003 + bracket;
  };

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const vert = new THREE.Vector3();
  const p = new THREE.Vector3();

  const rows = lengthSteps + capSteps;
  for (let i = 0; i <= rows; i++) {
    let t: number;
    let capScale = 1;
    let capThick = 1;
    if (i <= lengthSteps) {
      t = i / lengthSteps;
    } else {
      // 끝 마감: 단면 전체를 원호(구면) 형태로 줄여 둥근 돔으로 닫는다
      const k = (i - lengthSteps) / capSteps;
      t = 1;
      capScale = Math.sqrt(Math.max(0, 1 - k * k));
      // 두께는 끝에서만 급히 줄여 위에서 보면 반원, 옆에서 보면 둥근 모서리
      capThick = Math.sqrt(Math.max(0, 1 - Math.pow(k, 4)));
    }
    path.getPointAt(Math.min(t, 1), p);
    path.getTangentAt(Math.min(t, 1), tangent);
    if (i > lengthSteps) {
      const k = (i - lengthSteps) / capSteps;
      p.addScaledVector(tangent, k * width(1) * 0.5);
    }
    side.crossVectors(tangent, up).normalize();
    vert.crossVectors(side, tangent).normalize();
    const w = (width(t) / 2) * capScale;
    const h = (thickness(t) / 2) * capThick;

    for (let j = 0; j <= sectionSteps; j++) {
      const a = (j / sectionSteps) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const sx = Math.sign(c) * Math.pow(Math.abs(c), 2 / exponent);
      const sy = Math.sign(s) * Math.pow(Math.abs(s), 2 / exponent);
      positions.push(
        p.x + side.x * sx * w + vert.x * sy * h,
        p.y + side.y * sx * w + vert.y * sy * h,
        p.z + side.z * sx * w + vert.z * sy * h,
      );
      uvs.push(i / rows, j / sectionSteps);
    }
  }

  const stride = sectionSteps + 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < sectionSteps; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 팬 안쪽 벽의 리벳 위치 (손잡이 브래킷 고정용) */
export function rivetTransforms() {
  const y = 0.031;
  const r = innerRadiusAt(y);
  return [-0.008, 0.008].map((z) => ({
    position: new THREE.Vector3(Math.sqrt(r * r - z * z), y, z),
    rotationY: -Math.atan2(z, r),
  }));
}
