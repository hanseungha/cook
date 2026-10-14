import * as THREE from "three";

/**
 * 렌더링 품질 기본값. 실사 룩을 위한 색공간/톤매핑/그림자 설정을 한 곳에서 관리한다.
 * 음식/장면과 무관한 순수 렌더러 설정만 둔다.
 */
export const renderConfig = {
  /** 디바이스 픽셀 비율 상한과, 캔버스 전체 픽셀 수 예산(약 4K) */
  maxDpr: 2,
  pixelBudget: 3840 * 2160,
  // Khronos PBR Neutral: 베이스 컬러와 흰 배경을 왜곡 없이 유지 (제품/음식 촬영 룩)
  toneMapping: THREE.NeutralToneMapping,
  toneMappingExposure: 1.0,
  outputColorSpace: THREE.SRGBColorSpace,
  // VSM: shadow.radius로 블러 가능 → 스튜디오 소프트박스 같은 부드러운 그림자
  shadowMapType: THREE.VSMShadowMap,
  background: "#ffffff",
  environment: {
    // Poly Haven "Studio Small 09" (CC0) — 소프트박스 + 흰 사이클로라마
    file: "/assets/hdri/studio_small_09_1k.hdr",
    intensity: 1.0,
    rotationY: 0,
  },
} as const;

/**
 * 렌더 레이어. 메인 카메라는 모두 보지만, 반사판(인덕션 유리)의 반사 카메라는 기본 레이어(0)만 본다.
 * 팬 속 음식·기름처럼 유리에 비칠 수 없는 물체를 noReflection에 두면 반사 패스에서 다시 그리지 않는다.
 */
export const LAYERS = { noReflection: 1 } as const;

/** 물체(와 그 자식)를 반사 패스에서 뺀다. 메인 카메라에는 그대로 보인다 */
export function excludeFromReflections(root: THREE.Object3D) {
  root.traverse((o) => o.layers.set(LAYERS.noReflection));
}

/**
 * 고정 카메라 구도. 위치 대신 "무엇을 화면에 담을지"로 정의해
 * 화면 비율이 바뀌어도 같은 구도를 유지한다 (FixedCamera가 거리를 계산).
 */
/**
 * 화면 크기에 맞춘 DPR: 기기 DPR과 maxDpr 이하이면서 캔버스 픽셀 수가 예산을 넘지 않게.
 * 예) 1920×1080@2x → 2.0 유지, 2560×1440@2x → 1.5
 */
export function budgetedDpr(width: number, height: number, deviceDpr: number) {
  const byBudget = Math.sqrt(renderConfig.pixelBudget / Math.max(1, width * height));
  return Math.max(1, Math.min(deviceDpr, renderConfig.maxDpr, byBudget));
}

export type CameraRig = {
  /** 화면 중심에 올 주시점 */
  target: [number, number, number];
  /** 수평면 기준 내려다보는 각도 */
  elevationDeg: number;
  /** 정면(+Z) 기준 좌우 회전 각도 */
  azimuthDeg: number;
  /** 세로 화각 */
  fov: number;
  /** 주시점 평면에서 반드시 화면 안에 들어와야 하는 영역 (m) */
  frame: { width: number; height: number };
};

/** 주어진 화면 비율에서 frame 영역이 모두 보이는 카메라 거리 */
export function fitDistance(rig: CameraRig, aspect: number) {
  const halfV = THREE.MathUtils.degToRad(rig.fov) / 2;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  return Math.max(
    rig.frame.height / 2 / Math.tan(halfV),
    rig.frame.width / 2 / Math.tan(halfH),
  );
}

export function cameraPosition(rig: CameraRig, distance: number): [number, number, number] {
  const el = THREE.MathUtils.degToRad(rig.elevationDeg);
  const az = THREE.MathUtils.degToRad(rig.azimuthDeg);
  const [x, y, z] = rig.target;
  return [
    x + distance * Math.cos(el) * Math.sin(az),
    y + distance * Math.sin(el),
    z + distance * Math.cos(el) * Math.cos(az),
  ];
}
