# engine

음식과 무관한 공통 계층. 레시피 코드는 `src/recipes/<recipe>`에 둔다.

| 디렉터리 | 책임 |
| --- | --- |
| `rendering/` | Canvas, 렌더러 설정(Neutral 톤매핑, sRGB, VSM 그림자), HDRI 조명, 접지 그림자, 고정 카메라(`FixedCamera`), 정적 그림자(`StaticShadows`) |
| `interaction/` | 재료 공통 Grab 인터랙션(`Grabbable`), 지지 표면 레지스트리, 스프링, grab 상태 스토어 |
| `cooking/` | 가열 시스템: 조리 진행도(`createCookingProgress`), 열원 레지스트리(`addHeatSource`/`heatAt`), 위치별 익힘(`ThermalField`), 익힘 표현 GLSL(`COOKING_GLSL`) |
| `audio/` | 오디오 엔진(첫 조작에서 재개, 리미터, 재생 기록), 절차적 효과음(두드림·균열·착지·지글거림), 무거운 합성은 워커(`soundBank.worker.ts`) |
| `effects/` | 절제된 화면 효과 (`Steam`: 반투명 판 몇 장에 위로 흐르는 노이즈) |
| `textures/` | 절차적 텍스처 공통 유틸(노이즈, Web Worker 로더) |
| `debug/` | 테스트용 렌더 프로브, 룩뎁 캘리브레이션 |

- `src/shaders/` — 커스텀 GLSL (흰자 응고, 기름 반사 등)
- `src/kitchen/` — 레시피 간 공유하는 조리도구·가전 (프라이팬, 인덕션, 절차적 텍스처)
- `src/ingredients/` — 재료 모델·텍스처 (예: `egg/`). 인터랙션은 몰라도 된다
  - `egg/contents/` — 흰자(점성 흐름 두께장 `AlbumenField` + 반투명 셰이더), 흘러내리는 덩어리 파티클, 노른자 절차적 애니메이션
- `src/recipes/` — 음식별 구현 (예: `fried-egg/`)
- `public/assets/{models,textures,hdri}` — glTF, PBR 텍스처, HDRI

## 재료를 집을 수 있게 만들기

```tsx
<Grabbable id="tomato" initial={[x, z]} restRadius={0.03} bounds={WORK_AREA} shadowSize={[0.07, 0.07]}>
  <Tomato />   {/* "놓인 자세"로 모델링, 원점 = 중심 */}
</Grabbable>
```

- 내려놓을 수 있는 곳은 `useSupportSurface({ name, heightAt(x, z) })`로 등록 (팬 조리면, 인덕션 유리, 바닥)
- 부딪힐 수 있는 장애물은 `useCollider` / `addCollider`로 등록 (예: `ringCollider` = 팬 테두리).
  잡은 물체는 구로 근사해 충돌하고, 빠르게 움직이면 프레임을 잘게 나눠 검사한다 (터널링 방지)
- 조작 이벤트: `onImpact({ speed, point, normal })`, `onDrag(distance, touching)`, `onRelease()`, `disabled`
  → 재료별 규칙(예: `recipes/fried-egg/eggShellStore` — 충격 속도로 금, 추가 드래그로 벌리기)은 레시피 계층에서
- 잡힌 상태는 `useGrabStore`로 구독 (예: 계란이 팬 위에 놓였는지 → 조리 단계 진행)
- Grabbable 안의 메시는 정적 그림자 맵에서 자동 제외되고, 그림자는 `DropShadow`가 담당

## 음식을 익히기 (가열 시스템)

상태와 표현을 나눈다: **진행도(레시피) → 위치별 익힘(재료) → 셰이더(표현)**

1. 레시피가 진행도 스토어를 만든다: `createCookingProgress({ duration })` + `useCookingClock(store)` — 0 ~ 1, 가열 중 시간·불 세기에 비례해 증가
2. 조리도구가 열원을 등록한다: `addHeatSource({ heatAt(x, y, z) })` (예: 프라이팬 = 코일 고리 모양 열 분포, 조리면에 닿은 것만)
3. 재료는 셀(격자 칸·정점·텍스셀)마다 `ThermalField.heat(k, 진행도 증가분, 열 세기, 익는 데 필요한 열량, 갈변 속도)`로 익힘·갈변을 누적하고 정점 속성/텍스처로 셰이더에 넘긴다
4. 셰이더는 `COOKING_GLSL`의 `cookFront`(얼룩지며 번지는 익는 경계), `cookBrown`(마이야르 갈변), `cookBubble`(생겼다 터지는 기포)로 표현

예: 계란프라이 = 두께·가장자리 거리로 필요한 열량을 정해 가장자리부터 하얘지고 노릇해짐. 스테이크라면 표면 텍스셀마다 열량 → 갈변(시어링), 타코야끼는 구의 아래쪽 정점부터 갈변.

## 소리 붙이기

- `installAudioUnlock()` — 장면 준비 중 AudioContext를 미리 만들고(생성자가 100ms 넘게 막으므로), 첫 사용자 조작에서 재개
- 일회성 소리: `playKnock(세기)`, `playCrackle(세기, 길이, 젖음)`, `playSplat(양, 온도)` — 원인이 일어난 프레임(충돌 콜백·상태 구독·착지 콜백)에서 바로 호출
- 지속음: `new Sizzle().update(level, pops, dt)` — 세기는 레시피가 조리 상태로 계산 (예: `recipes/fried-egg/EggSounds.tsx`)
- 재생 기록 `window.__cookAudio.log` (개발 모드) → 조작 시각과 비교해 동기화 검증

## 성능 규칙

- **DPR**: 기기 DPR(최대 2) 이하이면서 캔버스 픽셀 수가 약 4K(830만)를 넘지 않게 자동 제한 (`budgetedDpr`)
- **그림자**: 매 프레임 갱신하지 않는다. 그림자를 드리우는 물체가 움직이면 `invalidateShadows()` 호출
- **텍스처 생성**: Web Worker에서 실행 (`loadPanTextures`) — 메인 스레드를 막지 않음
- **재질**: 클리어코트·이방성이 필요한 곳만 `MeshPhysicalMaterial`, 나머지는 `MeshStandardMaterial`
- **카메라**: `CameraRig.frame`(반드시 보여야 할 영역)으로 정의 → 화면 비율이 바뀌어도 구도 유지

## 검증 도구

- `node scripts/screenshot.mjs [path] [out.png] [w] [h]` — 실제 GPU(Metal)로 렌더링한 스크린샷 + FPS 측정 (`DPR=2`로 고해상도)
- `node scripts/crack-demo.mjs [outDir]` — 계란 깨기 → 흰자·노른자가 쏟아져 퍼지는 전 과정 촬영 + 프레임 시간 (`VIDEO=1` 녹화, `NOSHOT=1` 측정만, `EDGE=1` 팬 가장자리 위에서 벌리려 함(팬 바닥 위가 아니면 벌어지지 않음), `COOK=배율` 불을 세게 해 익는 과정 단계별 촬영, `AUDIO=1` 실제 출력 소리 녹음 + 조작 시각 기록, `SLOWMO=0.1` 내용물만 느리게, `HIDE=이름,…` 특정 물체를 뺀 비교 사진, `OPENWAIT=ms` 천천히 벌리기, `PROBE=1` 벌리는 동안 노른자 위치, `PROGRAMS=1` 조작 중 새로 컴파일된 셰이더, `TRACE=1` 벌리는 동안 성능 기록 trace.json)
- 셰이더 첫 사용 끊김: 처음 보이는 물체는 `warmUpPrograms`(engine/rendering/warmUp.ts)로 유휴 시간에 화면 1픽셀만 미리 그려 둔다 (`renderer.compile`만으로는 첫 그리기에서 드라이버가 마저 컴파일해 끊길 수 있음)
- `node scripts/bench.mjs [path] [w] [h] [dpr] [초]` — vsync 해제 후 실제 처리량(p50/p95/p99 프레임 시간, 드로우콜, 삼각형) 측정
- `/?off=reflector,shadows,msaa,env` — 기능별 비용 분리 측정용 플래그
- `npm run test:e2e` — macOS에서는 GPU, CI에서는 SwiftShader로 실행 (개발 서버가 이미 떠 있으면 `PORT=3000 npm run test:e2e`)
- `node scripts/audit.mjs [outDir]` — 전체 시나리오(접속 → 집기 → 깨기 → 붓기 → 익히기)를 돌리며 단계별 프레임 시간·드로우콜·삼각형·텍스처 메모리 추정·JS 힙·긴 프레임 기록 + 단계별 스크린샷 (`UNCAPPED=1` vsync 해제 처리량, `NOSHOT=1` 촬영 생략, `OBJCOST=1` 물체별 프레임 비용, `W/H/DPR` 화면 크기). 결과는 report.json
- `CAPPED=1 node scripts/bench.mjs` — 60Hz 제한 아래에서 로드 직후부터 측정
- 화질 조절: `AdaptiveQuality`(engine/rendering)가 1초 구간 프레임 간격 중앙값이 48fps 아래로 3번 이어질 때만 DPR을 낮추고, 10초 여유가 있으면 되돌린다 (drei PerformanceMonitor는 최고 화질에서도 "올림"을 뒤집힘으로 세어 약 10초 뒤 최저 화질로 떨어뜨리는 문제가 있었다)

