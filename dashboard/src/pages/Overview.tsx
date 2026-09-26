import { ColumnChart, type Column } from "../components/ColumnChart";
import { BarList } from "../components/BarList";
import { StatTile } from "../components/StatTile";
import { dailyPoints, groupBy, hourlyPoints, monthlyPoints, periodTotals, shortSite, type Day, type Lead } from "../lib/data";
import { int, money, moneyShort, pct } from "../lib/format";
import { daysInclusive, longDay, monthLabel, shortDay, type Range } from "../lib/time";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "D.C.", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export function Overview({ leads, days, cover, range, onSite }: {
  leads: Lead[]; days: Day[]; cover: string; range: Range; onSite: (host: string) => void;
}) {
  const { cur, prev } = periodTotals(range, days, leads);
  const accRate = (t: { leads: number; accepted: number }) => (t.leads ? t.accepted / t.leads : 0);
  const epl = (t: { leads: number; earnings: number }) => (t.leads ? t.earnings / t.leads : 0);

  let cols: Column[];
  let caption: string;
  let tickLabel: (c: Column) => string;
  if (range.key === "today") {
    cols = hourlyPoints(leads, range.from).map((p) => ({ key: p.key, label: p.label, value: p.value, detail: `${p.leads} לידים` }));
    caption = "הכנסה לפי שעה, שעון ישראל (היום של Leap מתחיל בחצות קליפורניה)";
    tickLabel = (c) => c.label;
  } else if (daysInclusive(range.from, range.to) > 92) {
    cols = monthlyPoints(days, range.from, range.to).map((p) => ({ key: p.key, label: p.label, value: p.value, detail: `${int(p.leads)} לידים` }));
    caption = "הכנסה לפי חודש";
    tickLabel = (c) => monthLabel(c.label);
  } else {
    cols = dailyPoints(days, range.from, range.to).map((p) => ({ key: p.key, label: p.label, value: p.value, detail: `${p.leads} לידים` }));
    caption = "הכנסה לפי יום";
    tickLabel = (c) => shortDay(c.label);
  }

  // Per-site / per-state detail only exists from the per-lead coverage start.
  const bFrom = range.from < cover ? cover : range.from;
  const partial = range.from < cover;
  const sites = groupBy(leads, bFrom, range.to, (l) => l.host).map((b) => ({
    key: b.key, label: shortSite(b.key), value: b.earnings, detail: `${b.leads} לידים`, onClick: () => onSite(b.key),
  }));
  const states = groupBy(leads, bFrom, range.to, (l) => l.state).map((b) => ({
    key: b.key, label: `${b.key} · ${STATE_NAMES[b.key] ?? ""}`, value: b.earnings, detail: `${b.leads} לידים`,
  }));

  return (
    <div className="stack">
      <section className="tiles">
        <StatTile hero label="הכנסה" value={money(cur.earnings)} cur={cur.earnings} prev={prev?.earnings ?? null} prevLabel={range.prevLabel} />
        <StatTile label="לידים" value={int(cur.leads)} cur={cur.leads} prev={prev?.leads ?? null} prevLabel={range.prevLabel} />
        <StatTile label="הכנסה לליד (EPL)" value={money(epl(cur))} cur={epl(cur)} prev={prev ? epl(prev) : null} prevLabel={range.prevLabel} />
        <StatTile label="אחוז אישור" value={pct(accRate(cur))} cur={accRate(cur)} prev={prev ? accRate(prev) : null} prevLabel={range.prevLabel} />
      </section>

      <section className="card">
        <ColumnChart data={cols} format={money} formatAxis={moneyShort} tickLabel={tickLabel} caption={caption} />
      </section>

      {partial && (
        <p className="note">פירוט לפי אתר ומדינה קיים רק מ-{longDay(cover)} (Leap מוחק לידים פרטניים אחרי כ-90 יום). הסכומים למעלה מכסים את כל הטווח.</p>
      )}

      <section className="two-col">
        <div className="card">
          <h2>אתרים מובילים</h2>
          <BarList items={sites} format={money} />
        </div>
        <div className="card">
          <h2>מדינות מובילות</h2>
          <BarList items={states} format={money} />
        </div>
      </section>
    </div>
  );
}
