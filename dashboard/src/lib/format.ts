export const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Axis / compact: $0.6 · $12 · $1.2K
export const moneyShort = (n: number) => {
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "K";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 });
};

export const int = (n: number) => n.toLocaleString("en-US");

// Same scale as the Telegram alerts (fireMarks in lead-alert / leap-sync): one per full $10, max 10.
export const fireMarks = (payout: number) => "🔥".repeat(Math.max(0, Math.min(10, Math.floor(payout / 10))));
export const pct = (n: number) => (n * 100).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "%";

export const change = (cur: number, prev: number): number | null =>
  prev > 0 ? (cur - prev) / prev : cur > 0 ? Infinity : null;

// Clean axis ticks: 0 / 5 / 10 / 15 …, top tick >= max.
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
