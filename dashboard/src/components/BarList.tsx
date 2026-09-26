export type BarItem = { key: string; label: string; value: number; detail: string; onClick?: () => void };

// Ranked horizontal bars (magnitude by one hue). Value sits at the tip; the detail and the hover title
// carry the rest. The top N are shown and the remainder folds into one "others" row.
export function BarList({ items, format, top = 8, othersLabel = "אחרים" }: {
  items: BarItem[]; format: (n: number) => string; top?: number; othersLabel?: string;
}) {
  const head = items.slice(0, top);
  const rest = items.slice(top);
  const rows: BarItem[] = rest.length
    ? [...head, { key: "__others", label: `${othersLabel} (${rest.length})`, value: rest.reduce((s, i) => s + i.value, 0), detail: "" }]
    : head;
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  if (!rows.length) return <p className="muted empty">אין נתונים בטווח הזה.</p>;
  return (
    <ul className="barlist">
      {rows.map((r) => (
        <li key={r.key} className={r.onClick ? "clickable" : undefined} onClick={r.onClick}
          title={`${r.label}: ${format(r.value)}${r.detail ? " · " + r.detail : ""}`}>
          {/* bdi: a label with no letters ("$100–$500") must not be reordered by the RTL page */}
          <span className="bl-label"><bdi>{r.label}</bdi></span>
          <span className="bl-track">
            <span className={r.key === "__others" ? "bl-fill bl-others" : "bl-fill"} style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100)}%` }} />
          </span>
          <span className="bl-value num">{format(r.value)}</span>
          <span className="bl-detail muted"><bdi>{r.detail}</bdi></span>
        </li>
      ))}
    </ul>
  );
}
