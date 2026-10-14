import { createTextureSetLoader } from "@/engine/textures/textureSet";
import { generatePanTextureData } from "./textureData";

/**
 * 프라이팬 텍스처 (coating: 논스틱 조리면, enamel: 외부 법랑, steel: 헤어라인 손잡이).
 * Web Worker에서 생성한다.
 */
export const loadPanTextures = createTextureSetLoader(
  () => new Worker(new URL("./panTextures.worker.ts", import.meta.url), { type: "module" }),
  generatePanTextureData,
);
