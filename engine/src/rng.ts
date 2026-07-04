/**
 * M1: シード固定の決定論 RNG（企画書13.4）。
 *
 * mulberry32 — 32bit シードから再現可能な擬似乱数列を生成。
 * 同じシード → 同じ列 → battle() の結果とログが完全再現（検証・再生一致）。
 * ※ Date.now()/Math.random() は一切使わない（決定論を壊すため）。
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 32bit 符号なしに正規化（負値・小数・巨大値でも安定）
    this.state = (seed >>> 0) || 1;
  }

  /** [0, 1) の浮動小数点乱数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 確率 p（0..1）で true */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  /** [1-pct, 1+pct) の乱数倍率（ダメージの小さな揺れ用・企画書4.1.2） */
  variance(pct: number): number {
    return 1 + (this.next() * 2 - 1) * pct;
  }

  /** [minInclusive, maxExclusive) の整数 */
  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }
}
