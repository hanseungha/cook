import { createTextureSetLoader } from "@/engine/textures/textureSet";
import { generateEggTextureData } from "./eggTextureData";

/** 계란 껍데기 텍스처 (Web Worker 생성) */
export const loadEggTextures = createTextureSetLoader(
  () => new Worker(new URL("./eggTextures.worker.ts", import.meta.url), { type: "module" }),
  generateEggTextureData,
);
