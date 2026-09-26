import { change, pct } from "../lib/format";

// label · value · delta vs a named period. Up is good for every metric on this dashboard.
export function StatTile({ label, value, cur, prev, prevLabel, hero = false }: {
  label: string; value: string; cur: number; prev: number | null; prevLabel: string; hero?: boolean;
}) {
  const c = prev === null ? null : change(cur, prev);
  let delta = null;
  if (c !== null) {
    const dir = c === Infinity || c > 0.0005 ? "up" : c < -0.0005 ? "down" : "flat";
    const text = c === Infinity ? "חדש" : pct(Math.abs(c));
    delta = (
      <div className={`delta delta-${dir}`}>
        <span aria-hidden>{dir === "up" ? "▲" : dir === "down" ? "▼" : "●"}</span>{" "}
        <span className="num">{dir === "down" ? "−" : dir === "up" && c !== Infinity ? "+" : ""}{text}</span>
        <span className="muted"> {prevLabel}</span>
      </div>
    );
  }
  return (
    <div className={hero ? "tile tile-hero" : "tile"}>
      <div className="tile-label">{label}</div>
      <div className="tile-value num">{value}</div>
      {delta}
    </div>
  );
}
