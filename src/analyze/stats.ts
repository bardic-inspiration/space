// The statistics behind Analyze's views (spec 10.3). Comparison is between
// distributions: the same seed under two variants is not a matched pair (S16).

export interface Share {
  value: string;
  count: number;
  share: number;
  /** A 95% Wilson interval for the share. */
  low: number;
  high: number;
}

/** A 95% Wilson score interval for `count` of `total`. */
export function wilson(count: number, total: number, z = 1.96): [number, number] {
  if (total === 0) return [0, 0];
  const p = count / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/** The share of each value, largest first, each with its interval. */
export function shares(values: string[]): Share[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => {
    const [low, high] = wilson(count, values.length);
    return { value, count, share: count / values.length, low, high };
  });
}

/** A quantile by linear interpolation between the nearest ranks. `sorted` is ascending. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export interface Summary {
  count: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
  return { count: sorted.length, mean, median: quantile(sorted, 0.5), p10: quantile(sorted, 0.1), p90: quantile(sorted, 0.9), min: sorted[0] ?? NaN, max: sorted.at(-1) ?? NaN };
}

export interface Histogram {
  low: number;
  high: number;
  bins: number[];
}

/** A histogram of `count` equal bins over `[low, high]`; the range of the values when not given, so several can share axes. */
export function histogram(values: number[], count = 20, range?: [number, number]): Histogram {
  const low = range?.[0] ?? Math.min(...values);
  const high = range?.[1] ?? Math.max(...values);
  const bins = new Array<number>(count).fill(0);
  if (values.length === 0 || !Number.isFinite(low)) return { low: 0, high: 1, bins };
  const width = (high - low) / count || 1;
  for (const value of values) bins[Math.min(count - 1, Math.max(0, Math.floor((value - low) / width)))] += 1;
  return { low, high, bins };
}

/** The indices of the values beyond 1.5 times the interquartile range. */
export function outliers(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const [q1, q3] = [quantile(sorted, 0.25), quantile(sorted, 0.75)];
  const reach = (q3 - q1) * 1.5;
  return values.flatMap((value, index) => (value < q1 - reach || value > q3 + reach ? [index] : []));
}

/** Cell counts summed over many matches. */
export function sumCells(all: (Record<string, number> | undefined)[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const cells of all) for (const [key, count] of Object.entries(cells ?? {})) total[key] = (total[key] ?? 0) + count;
  return total;
}
