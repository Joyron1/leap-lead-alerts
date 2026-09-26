import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from "react";
import { niceTicks } from "../lib/format";

// Width of a container, tracked with ResizeObserver.
function useWidth(min = 280): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(min, e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}

// ---------- segmented control ----------
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { key: T; label: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} role="radio" aria-checked={value === o.key} className={value === o.key ? "seg active" : "seg"} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

export function ChartCard({ title, sub, controls, children }: { title: string; sub?: string; controls?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div><h2>{title}</h2>{sub && <p className="muted small">{sub}</p>}</div>
        {controls}
      </div>
      {children}
    </section>
  );
}

// ---------- multi-series line chart ----------
export type Series = { key: string; label: string; color: string; values: number[] };

export function LineChart({ series, xLabels, xTitle, format, formatAxis, height = 280 }: {
  series: Series[]; xLabels: string[]; xTitle: (i: number) => string;
  format: (n: number) => string; formatAxis: (n: number) => string; height?: number;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const n = xLabels.length;
  const ticks = niceTicks(Math.max(0, ...series.flatMap((s) => s.values)));
  const top = ticks[ticks.length - 1] || 1;

  // Direct end labels only when there is room and they would not collide (never stack them).
  // Vertical placement does not depend on the right margin, so decide on labels first and only
  // reserve room for them when they will actually be drawn.
  const mTop = 14, mBottom = 26;
  const ih = height - mTop - mBottom;
  const y = (v: number) => mTop + ih - (v / top) * ih;
  const ends = series.map((s) => ({ s, y: y(s.values[n - 1] ?? 0) })).sort((a, b) => a.y - b.y);
  const labelsFit = series.length > 0 && series.length <= 4 && ends.every((e, i) => i === 0 || e.y - ends[i - 1].y >= 14);
  const m = { top: mTop, right: labelsFit ? 96 : 14, bottom: mBottom, left: 52 };
  const iw = width - m.left - m.right;
  const x = (i: number) => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));

  function move(e: RPointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  }

  return (
    <div className="chart">
      <div className="chart-bar">
        <ul className="legend">
          {series.map((s) => (<li key={s.key}><span className="key-line" style={{ background: s.color }} />{s.label}</li>))}
        </ul>
        <button className="link" onClick={() => setAsTable((t) => !t)}>{asTable ? "הצג גרף" : "הצג כטבלה"}</button>
      </div>
      {asTable ? (
        <div className="table-wrap chart-table">
          <table>
            <thead><tr><th>תקופה</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
            <tbody>
              {xLabels.map((_, i) => n - 1 - i).map((i) => (
                <tr key={i}><td>{xTitle(i)}</td>{series.map((s) => <td key={s.key} className="num">{format(s.values[i] ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" dir="ltr" ref={ref}>
          <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(", ")}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
                <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">{formatAxis(t)}</text>
              </g>
            ))}
            {xLabels.map((l, i) => i % every === 0 && (
              <text key={i} x={x(i)} y={height - 8} textAnchor="middle" className="tick">{l}</text>
            ))}
            {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + ih} />}
            {series.map((s) => (
              <g key={s.key}>
                <path d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={x(n - 1)} cy={y(s.values[n - 1] ?? 0)} r={4} fill={s.color} className="ring" />
                {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} className="ring" />}
              </g>
            ))}
            {labelsFit && ends.map((e) => (
              <text key={e.s.key} x={x(n - 1) + 10} y={e.y} dy="0.32em" className="end-label">{e.s.label.length > 12 ? e.s.label.slice(0, 11) + "…" : e.s.label}</text>
            ))}
            <rect x={m.left} y={m.top} width={iw} height={ih} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: Math.min(Math.max(x(hover), 110), width - 110), top: 0 }}>
              <div className="tt-title">{xTitle(hover)}</div>
              {[...series].sort((a, b) => (b.values[hover] ?? 0) - (a.values[hover] ?? 0)).map((s) => (
                <div key={s.key} className="tt-row">
                  <span className="key-line" style={{ background: s.color }} />
                  <span className="tt-value">{format(s.values[hover] ?? 0)}</span>
                  <span className="tt-detail">{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- weekday × hour heatmap (one hue; darker = more) ----------
const DAYS_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const DAYS_LONG = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

export function Heatmap({ values, format, detail }: {
  values: number[][]; format: (n: number) => string; detail: (d: number, h: number) => string;
}) {
  const [ref, width] = useWidth(320);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(0, ...values.flat());
  const m = { top: 4, left: 30, bottom: 22 };
  const cw = (width - m.left) / 24, ch = Math.max(18, Math.min(30, cw));
  const height = m.top + ch * 7 + m.bottom;
  const alpha = (v: number) => (v > 0 && max > 0 ? 0.12 + 0.88 * (v / max) : 0);

  return (
    <div className="chart">
      <div className="chart-bar">
        <span className="scale-key muted small">פחות <span className="scale-ramp" /> יותר</span>
        <button className="link" onClick={() => setAsTable((t) => !t)}>{asTable ? "הצג מפה" : "הצג כטבלה"}</button>
      </div>
      {asTable ? (
        <div className="table-wrap chart-table">
          <table className="compact">
            <thead><tr><th>יום</th>{Array.from({ length: 24 }, (_, h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{values.map((row, d) => (
              <tr key={d}><td>{DAYS_LONG[d]}</td>{row.map((v, h) => <td key={h} className="num">{v ? format(v) : ""}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" dir="ltr" ref={ref} onPointerLeave={() => setHover(null)}>
          <svg width={width} height={height} role="img" aria-label="מפת חום לפי יום ושעה">
            {values.map((row, d) => (
              <g key={d}>
                <text x={m.left - 6} y={m.top + d * ch + ch / 2} dy="0.32em" textAnchor="end" className="tick">{DAYS_HE[d]}</text>
                {row.map((v, h) => (
                  <rect key={h} x={m.left + h * cw + 1} y={m.top + d * ch + 1} width={Math.max(1, cw - 2)} height={ch - 2} rx={3}
                    className={v > 0 ? "heat" : "heat-empty"} fillOpacity={v > 0 ? alpha(v) : undefined}
                    stroke={hover && hover[0] === d && hover[1] === h ? "var(--ink)" : undefined} strokeWidth={2}
                    onPointerEnter={() => setHover([d, h])} />
                ))}
              </g>
            ))}
            {Array.from({ length: 8 }, (_, i) => i * 3).map((h) => (
              <text key={h} x={m.left + h * cw + cw / 2} y={height - 6} textAnchor="middle" className="tick">{String(h).padStart(2, "0")}:00</text>
            ))}
          </svg>
          {hover && (
            <div className="tooltip" style={{ left: Math.min(Math.max(m.left + hover[1] * cw + cw / 2, 110), width - 110), top: Math.max(0, m.top + hover[0] * ch - 70) }}>
              <div className="tt-title">יום {DAYS_LONG[hover[0]]}, {String(hover[1]).padStart(2, "0")}:00–{String((hover[1] + 1) % 24).padStart(2, "0")}:00</div>
              <div className="tt-value">{format(values[hover[0]][hover[1]])}</div>
              <div className="tt-detail">{detail(hover[0], hover[1])}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- US tile-grid map (every state the same size, so small states stay readable) ----------
const TILES: Record<string, [number, number]> = {
  AK: [0, 0], ME: [11, 0], VT: [10, 1], NH: [11, 1],
  WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
  OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
  CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
  AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
  OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6],
  HI: [0, 7], TX: [4, 7], FL: [9, 7],
};

export function TileMap({ values, format, detail, selected, onSelect }: {
  values: Map<string, number>; format: (n: number) => string; detail: (st: string) => string;
  selected: string; onSelect: (st: string) => void;
}) {
  const [ref, width] = useWidth(320);
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(0, ...values.values());
  const cell = Math.min(58, (width - 4) / 12);
  const gap = 3;
  const alpha = (v: number) => (v > 0 && max > 0 ? 0.14 + 0.86 * (v / max) : 0);

  return (
    <div className="chart">
      <div className="chart-bar">
        <span className="scale-key muted small">פחות <span className="scale-ramp" /> יותר · לחיצה על מדינה מסננת את כל הדף</span>
      </div>
      <div className="chart-plot" dir="ltr" ref={ref} onPointerLeave={() => setHover(null)}>
        <svg width={cell * 12} height={cell * 8} role="img" aria-label="מפת מדינות ארה״ב">
          {Object.entries(TILES).map(([st, [c, r]]) => {
            const v = values.get(st) ?? 0;
            const a = alpha(v);
            const x = c * cell + gap / 2, yy = r * cell + gap / 2, s = cell - gap;
            return (
              <g key={st} className="tile" onPointerEnter={() => setHover(st)} onClick={() => onSelect(selected === st ? "" : st)}>
                <rect x={x} y={yy} width={s} height={s} rx={4} className={v > 0 ? "heat" : "heat-empty"} fillOpacity={v > 0 ? a : undefined}
                  stroke={selected === st || hover === st ? "var(--ink)" : undefined} strokeWidth={2} />
                <text x={x + s / 2} y={yy + s / 2 - (s > 40 ? 5 : 0)} textAnchor="middle" dy="0.32em"
                  className={a > 0.55 ? "tile-text on-dark" : v > 0 ? "tile-text" : "tile-text muted-text"}>{st}</text>
                {s > 40 && v > 0 && (
                  <text x={x + s / 2} y={yy + s / 2 + 10} textAnchor="middle" dy="0.32em" className={a > 0.55 ? "tile-val on-dark" : "tile-val"}>{format(v)}</text>
                )}
              </g>
            );
          })}
        </svg>
        {hover && (
          <div className="tooltip" style={{ left: Math.min(Math.max((TILES[hover][0] + 0.5) * cell, 110), cell * 12 - 110), top: Math.max(0, TILES[hover][1] * cell - 76) }}>
            <div className="tt-title">{hover}</div>
            <div className="tt-value">{format(values.get(hover) ?? 0)}</div>
            <div className="tt-detail">{detail(hover)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- sparkline (trend at a glance, de-emphasised; last point accented) ----------
export function Sparkline({ values, width = 84, height = 22 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 0) || 1;
  const px = (i: number) => 2 + (i / (values.length - 1)) * (width - 4);
  const py = (v: number) => height - 3 - (v / max) * (height - 6);
  const last = values.length - 1;
  return (
    <svg width={width} height={height} className="sparkline" aria-hidden style={{ direction: "ltr" }}>
      <path d={values.map((v, i) => `${i ? "L" : "M"}${px(i)},${py(v)}`).join("")} fill="none" className="spark-line" strokeWidth={1.5} />
      <circle cx={px(last)} cy={py(values[last])} r={2.5} className="spark-dot" />
    </svg>
  );
}
