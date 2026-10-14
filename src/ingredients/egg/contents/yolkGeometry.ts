import * as THREE from "three";

/**
 * 노른자 모양: 완벽한 구는 플라스틱 공처럼 보인다.
 * - 막 속 액체가 고르지 않게 처져 표면이 아주 살짝 울퉁불퉁 (몇 % 크기의 완만한 굴곡 → 반사광이 일그러진다)
 * - 아래쪽은 흰자 속으로 넓게 퍼져 위는 둥근 돔, 아래는 퍼진 치마 모양
 */
export function createYolkGeometry(radius: number) {
  const g = new THREE.SphereGeometry(radius, 64, 40);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  // 고정된 완만한 굴곡들 (방향 k, 세기 a, 위상 p) — 매번 같은 모양
  const waves = [
    { k: new THREE.Vector3(1.3, 0.4, -0.7), a: 0.018, p: 0.3 },
    { k: new THREE.Vector3(-0.6, 1.1, 1.2), a: 0.014, p: 1.9 },
    { k: new THREE.Vector3(2.1, -0.8, 1.6), a: 0.009, p: 4.1 },
    { k: new THREE.Vector3(-1.7, 0.3, -2.4), a: 0.007, p: 2.6 },
    { k: new THREE.Vector3(3.4, 1.9, -1.1), a: 0.004, p: 5.2 },
  ];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).divideScalar(radius);
    let r = 1;
    for (const w of waves) r += w.a * Math.sin(v.dot(w.k) * 2 + w.p);
    // 아래쪽(흰자에 잠기는 곳)은 옆으로 퍼진다
    const low = THREE.MathUtils.smoothstep(-v.y, 0.1, 0.9);
    v.multiplyScalar(r);
    v.x *= 1 + 0.1 * low;
    v.z *= 1 + 0.1 * low;
    pos.setXYZ(i, v.x * radius, v.y * radius, v.z * radius);
  }
  g.computeVertexNormals();
  // 구의 이음매·극점은 같은 자리에 정점이 여러 개 → 법선을 합쳐 이음선이 보이지 않게
  const nrm = g.attributes.normal;
  const sum = new Map<string, THREE.Vector3>();
  const key = (i: number) => `${pos.getX(i).toFixed(7)},${pos.getY(i).toFixed(7)},${pos.getZ(i).toFixed(7)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const n = sum.get(k) ?? sum.set(k, new THREE.Vector3()).get(k)!;
    n.x += nrm.getX(i);
    n.y += nrm.getY(i);
    n.z += nrm.getZ(i);
  }
  for (let i = 0; i < pos.count; i++) {
    const n = sum.get(key(i))!.clone().normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}
