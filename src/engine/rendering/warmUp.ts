import * as THREE from "three";

/**
 * 아직 보이지 않는 물체의 셰이더를 미리 "처음 사용"까지 끝내 둔다.
 *
 * renderer.compile()은 프로그램을 만들기만 하고, 실제 첫 그리기에서 링크 결과 확인(getProgramInfoLog 등)이
 * 일어나며 드라이버가 그때 컴파일을 마무리해 한 프레임이 끊길 수 있다 (Metal/ANGLE에서 수십 ms).
 * → 숨은 물체를 잠깐 보이게 하고 화면 구석 1픽셀만 그려(scissor) 첫 사용을 미리 치른다.
 * 같은 장면·조명·출력 대상(화면)으로 그려야 실제와 같은 프로그램이 쓰인다. 다음 프레임이 덮어쓴다.
 */
export function warmUpPrograms(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D) {
  const restore: Array<() => void> = [];
  root.traverse((o) => {
    if (!o.visible) {
      o.visible = true;
      restore.push(() => (o.visible = false));
    }
    if (o.frustumCulled) {
      o.frustumCulled = false;
      restore.push(() => (o.frustumCulled = true));
    }
  });
  // 조상이 숨겨져 있으면 그려지지 않는다
  for (let p = root.parent; p; p = p.parent) {
    if (!p.visible) {
      const q = p;
      q.visible = true;
      restore.push(() => (q.visible = false));
    }
  }
  const scissorTest = gl.getScissorTest();
  const scissor = gl.getScissor(new THREE.Vector4());
  gl.setScissorTest(true);
  gl.setScissor(0, 0, 1, 1);
  gl.render(scene, camera);
  gl.setScissor(scissor);
  gl.setScissorTest(scissorTest);
  for (const r of restore) r();
}
