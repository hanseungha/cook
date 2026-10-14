import { fbm, heightToNormal, mulberry32 } from "@/engine/textures/noise";
import type { MapData } from "@/engine/textures/mapData";

/**
 * 갈색 계란 껍데기 (Lathe UV: u = 둘레, v = 장축).
 * - 넓은 얼룩(색 불균일) + 작은 진한 반점 + 드문 밝은 석회 반점
 * - 기공: 촘촘한 미세 함몰 → 노멀맵, 빛에 따라 오돌토돌한 질감
 * - 거칠기: 대체로 무광(0.5~0.65), 부위별로 미세하게 다름
 * 둘레가 장축보다 약 1.8배 길어 u 방향 텍스처를 2번 반복한다 (EggShell 재질에서 repeat).
 */
export function generateEggShell(size = 1024): MapData {
  const rand = mulberry32(101);
  const n = size * size;
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const mottle = fbm(size, [[6, 1], [14, 0.6], [32, 0.35]], 103);
  const fine = fbm(size, [[128, 1], [256, 0.6]], 107);
  const bumps = fbm(size, [[48, 1], [96, 0.5]], 109);
  const height = new Float32Array(n);

  // 기본 색 (sRGB): 흔한 갈색란의 밝은 황갈색 (진하면 흰 배경에서 초콜릿처럼 어둡게 보인다)
  const base = [224, 182, 146];

  for (let i = 0; i < n; i++) {
    const m = (mottle[i] - 0.5) * 2; // -1..1
    const f = (fine[i] - 0.5) * 2;
    let shade = 1 + m * 0.07 + f * 0.03;
    let rough = 0.58 + m * 0.04 + f * 0.03;
    let h = bumps[i] * 0.5 + fine[i] * 0.2;

    const r = rand();
    if (r < 0.006) {
      shade *= 0.74 + rand() * 0.1; // 진한 반점
    } else if (r > 0.998) {
      shade *= 1.12; // 밝은 석회 반점
      rough += 0.08;
    }
    // 기공: 아주 작은 함몰
    if (rand() < 0.06) {
      h -= 0.35;
      rough += 0.05;
    }
    height[i] = h;

    const j = i * 4;
    color[j] = Math.min(255, base[0] * shade);
    color[j + 1] = Math.min(255, base[1] * shade);
    color[j + 2] = Math.min(255, base[2] * shade);
    color[j + 3] = 255;
    orm[j] = 255;
    orm[j + 1] = Math.max(0, Math.min(255, rough * 255));
    orm[j + 2] = 0;
    orm[j + 3] = 255;
  }

  return { size, color, orm, normal: heightToNormal(height, size, 1.4) };
}

export function generateEggTextureData() {
  return { shell: generateEggShell(1024) };
}
