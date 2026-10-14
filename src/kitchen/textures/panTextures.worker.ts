/// <reference lib="webworker" />
import { transferables } from "@/engine/textures/mapData";
import { generatePanTextureData } from "./textureData";

// 메인 스레드를 막지 않도록 팬 텍스처를 워커에서 생성하고, 버퍼를 복사 없이 넘긴다
self.onmessage = () => {
  const data = generatePanTextureData();
  (self as unknown as Worker).postMessage(data, transferables(data));
};
