/**
 * 위치별 익힘 상태 (three.js 비의존, 음식 종류와 무관).
 *
 * 셀(격자 칸·정점·텍스셀 등 음식이 정하는 단위)마다 받은 열량을 누적한다:
 *   dose += 진행도 증가분 × 열 세기 / 익는 데 필요한 열량
 * - doneness: dose 0 → 1에 걸쳐 단백질이 굳는 정도 (0 = 날것, 1 = 다 익음)
 * - browning: 다 익은 뒤에도 계속 받는 열로 진행되는 갈변 (마이야르)
 * 필요한 열량·갈변 속도는 음식이 셀마다 정한다 (예: 얇은 흰자는 빨리 익고 빨리 노릇해짐).
 * 진행도 증가분을 적분하므로 나중에 흘러 들어온 부분은 그때부터 익기 시작한다.
 */
export class ThermalField {
  readonly dose: Float32Array;
  readonly doneness: Float32Array;
  readonly browning: Float32Array;

  constructor(readonly count: number) {
    this.dose = new Float32Array(count);
    this.doneness = new Float32Array(count);
    this.browning = new Float32Array(count);
  }

  /**
   * 셀 하나에 열을 가한다.
   * @param dp 진행도 증가분
   * @param heat 이 셀의 열 세기 0 ~ 1
   * @param setDose 열 세기 1에서 다 익는 데 필요한 진행도
   * @param brownRate 다 익은 뒤 진행도 1당 갈변량
   */
  heat(k: number, dp: number, heat: number, setDose: number, brownRate: number) {
    if (heat <= 0 || dp === 0) return;
    const before = this.dose[k];
    const dose = Math.max(0, before + (dp * heat) / setDose);
    this.dose[k] = dose;
    this.doneness[k] = cureCurve(dose);
    // 갈변은 거의 다 익은 뒤(dose > 1)의 열량만 받는다
    const over = Math.max(0, dose - 1) - Math.max(0, before - 1);
    if (over !== 0) this.browning[k] = Math.min(1, Math.max(0, this.browning[k] + over * setDose * brownRate));
  }

  /**
   * 날것이 새로 섞여 든 셀 (위에 덮이거나 흘러 들어옴): 지금 상태가 keep 비율만큼만 남는다.
   * 칸마다 익힘이 고정되면 먼저 부은 자리가 새 날것에 덮여도 익은 채 남아, 그 자리의 윤곽이 얼룩으로 드러난다
   */
  dilute(k: number, keep: number) {
    if (keep >= 1 || this.dose[k] === 0) return;
    this.dose[k] *= keep;
    this.browning[k] *= keep;
    this.doneness[k] = cureCurve(this.dose[k]);
  }

  /** 음식이 사라진 셀 (흘러간 자리 등) */
  clear(k: number) {
    this.dose[k] = this.doneness[k] = this.browning[k] = 0;
  }
}

/** 받은 열량 → 굳은 정도: 처음엔 거의 그대로였다가 빠르게 불투명해지고 끝에서 천천히 마무리 */
export function cureCurve(dose: number) {
  const x = Math.min(1, Math.max(0, (dose - 0.08) / 0.92));
  return x * x * (3 - 2 * x);
}
