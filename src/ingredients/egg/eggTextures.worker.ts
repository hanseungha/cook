/// <reference lib="webworker" />
import { transferables } from "@/engine/textures/mapData";
import { generateEggTextureData } from "./eggTextureData";

self.onmessage = () => {
  const data = generateEggTextureData();
  (self as unknown as Worker).postMessage(data, transferables(data));
};
