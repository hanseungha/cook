import { fbm, heightToNormal, mulberry32 } from "@/engine/textures/noise";
import type { MapData } from "@/engine/textures/mapData";

/** 프라이팬 텍스처 데이터 (Web Worker에서 생성) */

export type PanTextureData = {
  coating: MapData;
  enamel: MapData;
  steel: MapData;
};

/**
 * 논스틱 코팅 (조리면 평면 UV 기준, 중심 = UV 0.5).
 * 플라스틱처럼 보이지 않게 하는 요소:
 * - 코팅 아래 금속 입자(플레이크): 메탈릭 + 낮은 거칠기 → 빛을 받으면 반짝임
 * - 동심원 가공결: 하이라이트가 원형으로 번지는 실제 팬 특유의 반사
 * - 넓은 범위의 거칠기 얼룩: 균일한 하이라이트를 깨뜨림
 * roughness는 G, metalness는 B 채널 (glTF ORM 규약) — 같은 텍스처를 두 맵에 쓴다.
 */
export function generateCoating(size = 2048): MapData {
  const rand = mulberry32(7);
  const n = size * size;
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const grain = fbm(size, [[512, 1], [256, 0.5]], 11);
  const smudge = fbm(size, [[6, 1], [14, 0.6], [40, 0.3]], 19);
  const height = new Float32Array(n);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // 중심에서의 거리(픽셀) → 동심원 가공결 (약 0.5mm 간격, 미세하게 흔들림)
      const r = Math.hypot(x - size / 2, y - size / 2);
      const groove = Math.sin(r * 1.6 + grain[i] * 2.0) * 0.5 + 0.5;
      height[i] = groove * 0.6 + grain[i] * 0.4;

      const flake = rand();
      let c = 16 + (grain[i] - 0.5) * 6;
      let rough = 0.34 + (smudge[i] - 0.5) * 0.16 + (groove - 0.5) * 0.04;
      let metal = 0;
      if (flake > 0.975) {
        // 금속 입자: 밝고 매끈한 메탈릭 점
        const k = rand();
        c = 70 + k * 80;
        rough = 0.18 + k * 0.1;
        metal = 1;
      }
      const j = i * 4;
      color[j] = color[j + 1] = c;
      color[j + 2] = c + 2;
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = Math.max(0, Math.min(255, rough * 255));
      orm[j + 2] = metal * 255;
      orm[j + 3] = 255;
    }
  }

  return { size, color, orm, normal: heightToNormal(height, size, 0.9) };
}

/**
 * 팬 외부 법랑 도장: 짙은 차콜 메탈릭 페인트.
 * 미세 입자 + 넓은 얼룩으로 균일한 플라스틱 광택을 피한다.
 */
export function generateEnamel(size = 1024): MapData {
  const rand = mulberry32(41);
  const n = size * size;
  const orm = new Uint8Array(n * 4);
  const smudge = fbm(size, [[4, 1], [12, 0.5]], 43);
  const grain = fbm(size, [[256, 1]], 47);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const flake = rand() > 0.96;
    orm[j] = 255;
    orm[j + 1] = Math.max(0, Math.min(255, (0.38 + (smudge[i] - 0.5) * 0.14 - (flake ? 0.12 : 0)) * 255));
    orm[j + 2] = flake ? 255 : 90;
    orm[j + 3] = 255;
  }
  return { size, orm, normal: heightToNormal(grain, size, 0.5) };
}

/**
 * 헤어라인 스테인리스: U 방향으로 길게 늘어진 미세한 줄무늬.
 * 셀 수를 축별로 다르게 두어 이방성 결을 만든다.
 */
export function generateBrushedSteel(size = 1024): MapData {
  const rand = mulberry32(23);
  const n = size * size;
  // 행(v)마다 다른 값 → U 방향 줄무늬
  const rowNoise = new Float32Array(size).map(() => rand());
  const fine = fbm(size, [[512, 1], [128, 0.4]], 31);
  const height = new Float32Array(n);
  const rough = new Uint8Array(n * 4);

  for (let y = 0; y < size; y++) {
    const row = (rowNoise[y] + rowNoise[(y + 1) % size] + rowNoise[(y + 2) % size]) / 3;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const h = row * 0.8 + fine[i] * 0.2;
      height[i] = h;
      const j = i * 4;
      rough[j + 1] = Math.max(0, Math.min(255, 70 + (h - 0.5) * 60));
      rough[j + 3] = 255;
    }
  }

  return { size, orm: rough, normal: heightToNormal(height, size, 0.6) };
}

export function generatePanTextureData(): PanTextureData {
  return {
    coating: generateCoating(2048),
    enamel: generateEnamel(1024),
    steel: generateBrushedSteel(1024),
  };
}
