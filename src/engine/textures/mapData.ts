// 워커와 메인 스레드가 공유하는 텍스처 데이터 형식 (three.js 비의존)

/** RGBA8 픽셀 데이터. orm: R=AO(미사용), G=roughness, B=metalness (glTF 규약) */
export type MapData = {
  size: number;
  color?: Uint8Array;
  orm: Uint8Array;
  normal: Uint8Array;
};

/** 워커가 돌려준 MapData 묶음의 버퍼 목록 (복사 없이 전송) */
export function transferables(data: Record<string, MapData>) {
  return Object.values(data).flatMap((m) =>
    [m.color, m.orm, m.normal].filter((b): b is Uint8Array => !!b).map((b) => b.buffer),
  );
}

