import { useEffect, useRef, useState } from "react";
import { niceTicks } from "../lib/format";

export type Column = { key: string; label: string; value: number; detail?: string };

// Single-series column chart in plain SVG. Mark specs: bars <= 24px, 4px rounded data-end and a
// square baseline, 2px surface gap between neighbours, hairline grid, hover crosshair + tooltip,
// and a table view so the numbers never depend on reading the bars.
export function ColumnChart(props: {
  data: Column[];
  format: (n: number) => string;
  formatAxis: (n: number) => string;
  tickLabel: (c: Column) => string;
  caption: string;
  height?: number;
}) {
  const { data, format, formatAxis, tickLabel, caption, height = 240 } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(280, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable]);

  const m = { top: 12, right: 8, bottom: 26, left: 48 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const ticks = niceTicks(Math.max(0, ...data.map((d) => d.value)));
  const top = ticks[ticks.length - 1] || 1;
  const band = data.length ? iw / data.length : iw;
  const bw = Math.max(1, Math.min(24, band - 2));
  const y = (v: number) => m.top + ih - (v / top) * ih;
  const y0 = m.top + ih;
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 64))));
  const cur = active !== null ? data[active] : null;

  return (
    <div className="chart">
      <div className="chart-bar">
        <span className="muted">{caption}</span>
        <button className="link" onClick={() => setAsTable((t) => !t)}>{asTable ? "הצג גרף" : "הצג כטבלה"}</button>
      </div>
      {asTable ? (
        <div className="table-wrap chart-table">
          <table>
            <thead><tr><th>תקופה</th><th>הכנסה</th><th>פירוט</th></tr></thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.key}><td>{tickLabel(d)}</td><td className="num">{format(d.value)}</td><td className="muted">{d.detail}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" dir="ltr" ref={wrap} onMouseLeave={() => setActive(null)}>
          <svg width={width} height={height} role="img" aria-label={caption}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
                <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">{formatAxis(t)}</text>
              </g>
            ))}
            {cur && active !== null && (
              <line className="crosshair" x1={m.left + band * active + band / 2} x2={m.left + band * active + band / 2} y1={m.top} y2={y0} />
            )}
            {data.map((d, i) => {
              const x = m.left + band * i + (band - bw) / 2;
              const path = barPath(x, y(d.value), bw, y0);
              return (
                <g key={d.key}>
                  {path && <path d={path} className={active === i ? "bar bar-active" : "bar"} />}
                  <rect x={m.left + band * i} y={m.top} width={band} height={ih} fill="transparent"
                    onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} tabIndex={-1} />
                  {i % every === 0 && (
                    <text x={m.left + band * i + band / 2} y={height - 8} textAnchor="middle" className="tick">{tickLabel(d)}</text>
                  )}
                </g>
              );
            })}
          </svg>
          {cur && active !== null && (
            <div className="tooltip" style={{
              left: Math.min(Math.max(m.left + band * active + band / 2, 90), width - 90),
              top: Math.max(0, y(cur.value) - 64),
            }}>
              <div className="tt-title">{tickLabel(cur)}</div>
              <div className="tt-value">{format(cur.value)}</div>
              {cur.detail && <div className="tt-detail">{cur.detail}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function barPath(x: number, yTop: number, w: number, yBase: number) {
  const h = yBase - yTop;
  if (h <= 0.5) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
}
