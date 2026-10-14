import * as THREE from "three";
import type { MapData } from "./mapData";

export type { MapData };

export type PbrMaps = {
  map?: THREE.Texture;
  roughnessMap: THREE.Texture;
  metalnessMap: THREE.Texture;
  normalMap: THREE.Texture;
};

function toTexture(data: Uint8Array, size: number, colorSpace: THREE.ColorSpace) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export function toMaps(d: MapData): PbrMaps {
  // roughness(G)와 metalness(B)는 한 텍스처를 공유
  const orm = toTexture(d.orm, d.size, THREE.NoColorSpace);
  return {
    map: d.color && toTexture(d.color, d.size, THREE.SRGBColorSpace),
    roughnessMap: orm,
    metalnessMap: orm,
    normalMap: toTexture(d.normal, d.size, THREE.NoColorSpace),
  };
}

/**
 * 텍스처 묶음 로더를 만든다: 워커에서 생성(실패 시 메인 스레드), 결과는 한 번만 만들어 캐시.
 * 페이지 로드 직후 load()를 호출해 두면 HDRI 다운로드 등과 병렬로 진행된다.
 */
export function createTextureSetLoader<K extends string>(
  createWorker: () => Worker,
  generate: () => Record<K, MapData>,
) {
  let pending: Promise<Record<K, PbrMaps>> | null = null;

  const inWorker = () =>
    new Promise<Record<K, MapData>>((resolve, reject) => {
      if (typeof Worker === "undefined") return resolve(generate());
      const worker = createWorker();
      worker.onmessage = (e: MessageEvent<Record<K, MapData>>) => {
        resolve(e.data);
        worker.terminate();
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(e);
      };
      worker.postMessage(null);
    });

  return function load() {
    pending ??= inWorker()
      .catch(() => generate())
      .then(
        (data) =>
          Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, toMaps(v as MapData)]),
          ) as Record<K, PbrMaps>,
      );
    return pending;
  };
}
