// Charts, drawn by the studio as SVG (S2): a stacked bar of outcome shares
// and a histogram, small enough that a click on a bar reaches a record.

import { PALETTE } from '../forms/form.ts';
import type { Histogram, Share, Summary } from './stats.ts';

const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
export const fmt = (value: number) => (Number.isFinite(value) ? (Math.abs(value) >= 100 || Number.isInteger(value) ? String(Math.round(value * 10) / 10) : value.toFixed(2)) : '–');

/** The share of each outcome as a stacked bar, each with its 95% Wilson interval. `order` fixes colors across bars. */
export function OutcomeBar({ shares, order, width = 420, onPick }: { shares: Share[]; order: string[]; width?: number; onPick?: (value: string) => void }) {
  let x = 0;
  return (
    <svg className="chart" width={width} height={22 + shares.length * 15} role="img" aria-label="Outcome split">
      {shares.map((share) => {
        const w = share.share * width;
        const bar = (
          <g key={share.value} onClick={() => onPick?.(share.value)} style={{ cursor: onPick ? 'pointer' : undefined }}>
            <rect x={x} y={0} width={w} height={18} fill={PALETTE[Math.max(0, order.indexOf(share.value)) % PALETTE.length]}><title>{share.value}: {share.count}</title></rect>
            {w > 34 && <text x={x + w / 2} y={13} textAnchor="middle" style={{ fill: '#fff' }}>{pct(share.share)}</text>}
          </g>
        );
        x += w;
        return bar;
      })}
      {shares.map((share, index) => (
        <g key={share.value} transform={`translate(0, ${34 + index * 15})`}>
          <rect x={0} y={-9} width={10} height={10} fill={PALETTE[Math.max(0, order.indexOf(share.value)) % PALETTE.length]} />
          <text x={15} y={0}>{share.value} · {share.count} · {pct(share.share)} <tspan className="muted">(95% {pct(share.low)} to {pct(share.high)})</tspan></text>
        </g>
      ))}
    </svg>
  );
}

/** A histogram of 20 bins. Several drawn with the same `top` and range share their axes. */
export function HistogramChart({ histogram, summary, top, color = PALETTE[0], width = 240, height = 70, onPick }: {
  histogram: Histogram; summary: Summary; top?: number; color?: string; width?: number; height?: number;
  /** A click on a bar: the range of values it stands for. */
  onPick?: (low: number, high: number) => void;
}) {
  const most = top ?? Math.max(1, ...histogram.bins);
  const bar = width / histogram.bins.length;
  const step = (histogram.high - histogram.low) / histogram.bins.length;
  const x = (value: number) => (histogram.high === histogram.low ? width / 2 : ((value - histogram.low) / (histogram.high - histogram.low)) * width);
  return (
    <svg className="chart" width={width} height={height + 30} role="img" aria-label="Distribution">
      {histogram.bins.map((count, index) => (
        <rect key={index} x={index * bar + 0.5} y={height - (count / most) * height} width={Math.max(1, bar - 1)} height={(count / most) * height} fill={color}
          onClick={() => onPick?.(histogram.low + index * step, histogram.low + (index + 1) * step)} style={{ cursor: onPick && count ? 'pointer' : undefined }}>
          <title>{fmt(histogram.low + index * step)} to {fmt(histogram.low + (index + 1) * step)}: {count}</title>
        </rect>
      ))}
      <line className="axis" x1={0} x2={width} y1={height + 0.5} y2={height + 0.5} />
      {summary.count > 0 && (
        <>
          <line x1={x(summary.median)} x2={x(summary.median)} y1={0} y2={height} stroke="var(--ink)" strokeDasharray="3 2" />
          <line x1={x(summary.p10)} x2={x(summary.p90)} y1={height + 4} y2={height + 4} stroke="var(--ink)" strokeWidth={2} />
        </>
      )}
      <text x={0} y={height + 16} className="muted">{fmt(histogram.low)}</text>
      <text x={width} y={height + 16} textAnchor="end" className="muted">{fmt(histogram.high)}</text>
      <text x={0} y={height + 28}>mean {fmt(summary.mean)} · median {fmt(summary.median)} · p10 {fmt(summary.p10)} · p90 {fmt(summary.p90)}</text>
    </svg>
  );
}
