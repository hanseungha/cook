/**
 * 껍데기에서 흘러나오는 흰자 줄기 (three.js 비의존).
 *
 * 흰자는 물이 아니라 점탄성 젤이라 방울로 끊겨 떨어지지 않고, 콧물처럼 덩어리째 늘어지다 끊긴다.
 * 줄기를 "알갱이(부피) + 이웃 알갱이를 잇는 실" 사슬로 근사한다:
 * - 실의 늘어남 저항 (트라우턴 신장 점성): 장력 = 3μ·A·(dl/dt)/l, 단면적 A = 실 부피 / l
 *   → 굵은 곳은 천천히 늘어나고, 가늘어진 곳은 점점 빨리 늘어나 목이 생기고 끊어진다 (점성 액체의 처짐)
 * - 표면장력: 실이 이웃을 끌어당겨 가까워진 알갱이는 하나의 덩어리로 합쳐진다
 * - 껍데기 틈(anchor)에 붙은 첫 실이 줄기 전체를 매달고 있다가, 다 흘러나오면 가늘어져 끊긴다
 * - 바닥(팬)에 닿은 알갱이는 그 자리에 부피를 내려놓는다 → 줄기가 이어진 채로 바닥에 쌓인다
 */

export type StrandParticle = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 부피 (m³) */
  v: number;
  /** 다음 알갱이(위쪽, 더 늦게 나온 것)와 실로 이어져 있는지 */
  linkNext: boolean;
};

export type StrandAnchor = {
  x: number;
  y: number;
  z: number;
  /** 틈 자체의 속도 (껍데기와 함께 움직임) */
  vx: number;
  vy: number;
  vz: number;
  /** 새로 흘러나오는 흰자의 처음 속도 (틈 기준, 한쪽으로 쏠려 나온다) */
  spawn?: [number, number, number];
};

export const STRAND = {
  /** 신장 점성 (Pa·s). 흰자는 전단 점성보다 신장 점성이 훨씬 커서 실처럼 늘어난다 */
  viscosity: 6,
  density: 1035,
  /** 표면장력 (N/m) */
  tension: 0.05,
  /** 실 반지름이 이보다 가늘어지면 끊어진다 (m) */
  breakRadius: 0.0006,
  /** 껍데기 틈에서 나오는 목의 반지름 (흘러나오는 양이 줄면 가늘어진다) (m) */
  neckRadius: 0.0045,
  /** 새 알갱이가 생기는 틈에서의 거리 (m) */
  spawnDistance: 0.0028,
  gravity: 9.8,
  maxParticles: 160,
  /** 이보다 적은 양으로는 새 알갱이를 만들지 않는다 (질량이 0에 가까우면 힘 계산이 폭주) (m³) */
  minParticle: 2e-9,
  substep: 1 / 500,
};

const blobRadius = (v: number) => Math.cbrt((3 * v) / (4 * Math.PI));

export class AlbumenStrand {
  /** 아래(먼저 나온 것) → 위(최근에 나온 것) 순서 */
  readonly particles: StrandParticle[] = [];
  /** 가장 위 알갱이가 껍데기 틈에 매달려 있는지 */
  anchorLinked = false;
  /** 흘러나온 부피 / 바닥에 내려놓은 부피 (m³) */
  emitted = 0;
  deposited = 0;
  private t = 0;
  private wobble = 0;

  constructor(
    readonly total: number,
    /** 흘러나오는 시간 (초) — 처음에 많이, 갈수록 가늘게 */
    readonly duration: number,
  ) {}

  /** 지금까지 흘러나왔어야 할 부피: 처음 덩어리가 왈칵 나오고 끝은 가늘게 */
  private emittedBy(t: number) {
    const k = Math.min(1, t / this.duration);
    return this.total * (1 - Math.pow(1 - k, 2.6));
  }

  /**
   * 틈에 매달린 목에 든 흰자 부피: 왈칵 나올 때는 틈만큼 굵고, 다 나오면 가늘어져 결국 끊긴다.
   * (매달린 덩어리 전체가 아니라 이 목이 무게를 버티므로, 덩어리는 처지며 내려간다)
   */
  private neckVolume() {
    const k = Math.min(1, this.t / this.duration);
    const flow = Math.max(0.04, Math.pow(1 - k, 1.6));
    const r = STRAND.neckRadius * Math.sqrt(flow);
    return Math.PI * r * r * STRAND.spawnDistance;
  }

  get done() {
    return this.emitted >= this.total * 0.999 && this.particles.length === 0;
  }

  step(
    dt: number,
    anchor: StrandAnchor,
    surfaceAt: (x: number, z: number) => number,
    deposit: (x: number, z: number, volume: number, radius: number, speed: number) => void,
    /** 틈이 벌어진 정도 0 ~ 1: 좁으면 천천히 흘러나오고, 닫히면 멈춘다 (매달린 줄기는 계속 처진다) */
    flow = 1,
  ) {
    this.t += dt * flow;
    this.emit(anchor);
    const n = Math.max(1, Math.ceil(dt / STRAND.substep));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      this.forces(h, anchor);
      for (const p of this.particles) {
        p.x += p.vx * h;
        p.y += p.vy * h;
        p.z += p.vz * h;
      }
      this.land(surfaceAt, deposit);
      this.breakAndMerge(anchor);
    }
  }

  private emit(a: StrandAnchor) {
    const target = this.emittedBy(this.t);
    let dv = target - this.emitted;
    if (dv <= 0) return;
    const ps = this.particles;
    const top = ps[ps.length - 1];
    // 틈 가까이 있는 맨 위 알갱이는 계속 부풀고, 충분히 멀어지면 새 알갱이가 이어서 나온다
    if (top && this.anchorLinked && Math.hypot(top.x - a.x, top.y - a.y, top.z - a.z) < STRAND.spawnDistance) {
      top.v += dv;
    } else if (dv < STRAND.minParticle && this.emitted + dv < this.total * 0.999) {
      // 아직 모자라면 다음 프레임에 모아서
      return;
    } else if (ps.length < STRAND.maxParticles && dv >= STRAND.minParticle) {
      if (top) top.linkNext = this.anchorLinked;
      const [sx, sy, sz] = a.spawn ?? [0, -0.04, 0];
      // 나올 때마다 방향이 조금씩 달라 줄기가 곧은 막대가 되지 않는다
      const w = this.wobble++ * 2.399;
      const jx = Math.cos(w) * 0.018;
      const jz = Math.sin(w) * 0.018;
      ps.push({ x: a.x, y: a.y - 0.0008, z: a.z, vx: a.vx + sx + jx, vy: a.vy + sy, vz: a.vz + sz + jz, v: dv, linkNext: false });
      this.anchorLinked = true;
    } else if (top) {
      top.v += dv;
    } else if (dv < STRAND.minParticle) {
      // 마지막 남은 극소량은 이미 흘러나간 것으로 (보이지도 들리지도 않는 양)
      this.deposited += dv;
    } else {
      dv = 0;
    }
    this.emitted += dv;
  }

  /** 실 하나 (i ↔ j, j가 없으면 껍데기 틈) 의 점성 감쇠 + 표면장력 */
  private link(pi: StrandParticle, pj: StrandParticle | null, a: StrandAnchor, h: number, neck: number) {
    const jx = pj ? pj.x : a.x;
    const jy = pj ? pj.y : a.y;
    const jz = pj ? pj.z : a.z;
    let dx = jx - pi.x;
    let dy = jy - pi.y;
    let dz = jz - pi.z;
    const l = Math.max(0.0012, Math.hypot(dx, dy, dz));
    dx /= l;
    dy /= l;
    dz /= l;
    const mi = pi.v * STRAND.density;
    const mj = pj ? pj.v * STRAND.density : Infinity;
    const meff = pj ? (mi * mj) / (mi + mj) : mi;
    // 실에 든 흰자: 가는 쪽 알갱이만큼 (큰 덩어리와 작은 알갱이 사이의 실은 가늘다)
    const vl = pj ? Math.min(pi.v, pj.v) : Math.min(pi.v, neck);
    const rel = ((pj ? pj.vx : a.vx) - pi.vx) * dx + ((pj ? pj.vy : a.vy) - pi.vy) * dy + ((pj ? pj.vz : a.vz) - pi.vz) * dz;
    const gamma = (3 * STRAND.viscosity * vl) / (l * l * meff);
    let impulse = (1 - Math.exp(-gamma * h)) * rel * meff;
    // 표면장력: 실 둘레 × σ 로 서로 끌어당긴다
    const r = Math.min(Math.sqrt(vl / (Math.PI * l)), blobRadius(vl));
    impulse += 2 * Math.PI * r * STRAND.tension * h;
    pi.vx += (dx * impulse) / mi;
    pi.vy += (dy * impulse) / mi;
    pi.vz += (dz * impulse) / mi;
    if (pj) {
      pj.vx -= (dx * impulse) / mj;
      pj.vy -= (dy * impulse) / mj;
      pj.vz -= (dz * impulse) / mj;
    }
  }

  private forces(h: number, a: StrandAnchor) {
    const ps = this.particles;
    for (const p of ps) {
      p.vy -= STRAND.gravity * h;
      // 공기 저항 (아주 약하게)
      const drag = Math.exp(-0.6 * h);
      p.vx *= drag;
      p.vz *= drag;
    }
    // 실 장력은 사슬을 따라 전달되므로 몇 번 반복
    const neck = this.neckVolume();
    for (let it = 0; it < 3; it++) {
      if (this.anchorLinked && ps.length) this.link(ps[ps.length - 1], null, a, h, neck);
      for (let i = ps.length - 2; i >= 0; i--) if (ps[i].linkNext) this.link(ps[i], ps[i + 1], a, h, neck);
    }
  }

  private land(surfaceAt: (x: number, z: number) => number, deposit: (x: number, z: number, v: number, r: number, speed: number) => void) {
    const ps = this.particles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const r = blobRadius(p.v);
      if (p.y - r * 0.4 > surfaceAt(p.x, p.z)) continue;
      deposit(p.x, p.z, p.v, 0.0075 + r * 0.5, Math.hypot(p.vx, p.vy, p.vz));
      this.deposited += p.v;
      // 아래 알갱이와의 실도 함께 사라진다 (위쪽 실은 남아 계속 내려와 쌓인다)
      if (i > 0) ps[i - 1].linkNext = false;
      if (i === ps.length - 1) this.anchorLinked = false;
      ps.splice(i, 1);
      i--;
    }
  }

  private breakAndMerge(a: StrandAnchor) {
    const ps = this.particles;
    const linkLen = (p: StrandParticle, x: number, y: number, z: number) => Math.hypot(x - p.x, y - p.y, z - p.z);
    // 다 흘러나온 뒤 틈에 매달린 실이 가늘어지면 끊긴다
    if (this.anchorLinked && ps.length) {
      const top = ps[ps.length - 1];
      const l = linkLen(top, a.x, a.y, a.z);
      const vl = Math.min(top.v, this.neckVolume());
      const finished = this.emitted >= this.total * 0.999;
      // 마지막 남은 방울은 잠깐 대롱대롱 매달렸다가 떨어진다
      if (finished && (Math.sqrt(vl / (Math.PI * Math.max(l, 1e-4))) < STRAND.breakRadius || this.t > this.duration + 0.35)) {
        this.anchorLinked = false;
      }
    }
    for (let i = ps.length - 2; i >= 0; i--) {
      const p = ps[i];
      if (!p.linkNext) continue;
      const q = ps[i + 1];
      const l = linkLen(p, q.x, q.y, q.z);
      const vl = Math.min(p.v, q.v);
      if (Math.sqrt(vl / (Math.PI * Math.max(l, 1e-4))) < STRAND.breakRadius) {
        p.linkNext = false;
        continue;
      }
      // 가까워진 두 알갱이는 한 덩어리로 (운동량 보존)
      if (l < 0.45 * (blobRadius(p.v) + blobRadius(q.v))) {
        const v = p.v + q.v;
        p.x = (p.x * p.v + q.x * q.v) / v;
        p.y = (p.y * p.v + q.y * q.v) / v;
        p.z = (p.z * p.v + q.z * q.v) / v;
        p.vx = (p.vx * p.v + q.vx * q.v) / v;
        p.vy = (p.vy * p.v + q.vy * q.v) / v;
        p.vz = (p.vz * p.v + q.vz * q.v) / v;
        p.v = v;
        p.linkNext = q.linkNext;
        // 맨 위가 합쳐졌으면 합쳐진 알갱이가 그대로 틈에 매달린다 (anchorLinked 유지)
        ps.splice(i + 1, 1);
      }
    }
  }
}

export { blobRadius };
