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

/**
 * M6: 決定論のサブシード導出（FNV-1a 系の文字列ハッシュ混合）。
 *
 * (seasonSeed, roundKey, matchIndex …) から、その試合専用の 32bit シードを独立に作る。
 * dive() のような逐次 rng 列と違い「任意の試合を単独で再計算できる」＝バッチの冪等性に必須
 * （再実行しても同じカードは同じシード → 同じ結果／実装プラン 13.5「冪等」）。
 * Date.now()/Math.random() は不使用（決定論）。
 */
export function deriveSeed(seasonSeed: number, ...parts: (string | number)[]): number {
  let h = (seasonSeed >>> 0) || 1;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    h = (h ^ 0x9e3779b9) >>> 0; // パート境界を混ぜる（"a","bc" と "ab","c" を分ける）
  }
  return (h >>> 0) || 1; // 0 を避ける（Rng は 0 を 1 に正規化するが明示）
}
