import { useMemo, useState } from "react";
import { ColumnChart } from "../components/ColumnChart";
import { BarList } from "../components/BarList";
import { ChartCard, Heatmap, LineChart, Segmented, Sparkline, TileMap, type Series } from "../components/charts";
import {
  aggregate, byLoan, byPage, concentration, heatmap, METRICS, metricValue, monthly, payoutHistogram, total,
  weekStart, weeklyBy, weeks, type Metric, type Tz,
} from "../lib/analytics";
import { shortSite, type Day, type Lead } from "../lib/data";
import { int, money, moneyShort, pct } from "../lib/format";
import { longDay, monthLabel, shortDay, type Range } from "../lib/time";

// Categorical slots (validated light + dark, adjacent pairs). A site keeps its slot while selected,
// so colour follows the site, never its rank.
const SLOTS = ["--c1", "--c2", "--c3", "--c4", "--c5"];
const MAX_SERIES = SLOTS.length;

const fmtMetric = (m: Metric) => (m === "earnings" || m === "epl" ? money : m === "leads" ? int : pct);
const axisMetric = (m: Metric) => (m === "earnings" || m === "epl" ? moneyShort : m === "leads" ? int : (n: number) => pct(n));
const HOURS = (h: number) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;

export function Analytics({ leads, days, cover, range }: { leads: Lead[]; days: Day[]; cover: string; range: Range }) {
  const [site, setSite] = useState("");
  const [state, setState] = useState("");
  const [trendMetric, setTrendMetric] = useState<Metric>("earnings");
  const [mapMetric, setMapMetric] = useState<Metric>("earnings");
  const [heatMetric, setHeatMetric] = useState<"leads" | "earnings">("leads");
  const [tz, setTz] = useState<Tz>("il");
  const [picked, setPicked] = useState<string[] | null>(null); // null = default (top sites)
  const [slotOf, setSlotOf] = useState<Record<string, number>>({});

  const from = range.from < cover ? cover : range.from;
  const inRange = useMemo(() => leads.filter((l) => l.day >= from && l.day <= range.to), [leads, from, range.to]);
  // Cross-filtering: each view applies every filter except its own dimension.
  const bySiteF = useMemo(() => (site ? inRange.filter((l) => l.host === site) : inRange), [inRange, site]);
  const byStateF = useMemo(() => (state ? inRange.filter((l) => l.state === state) : inRange), [inRange, state]);
  const both = useMemo(() => (state ? bySiteF.filter((l) => l.state === state) : bySiteF), [bySiteF, state]);

  const t = total(both);
  const hosts = useMemo(() => [...new Set(inRange.map((l) => l.host))].sort(), [inRange]);
  const states = useMemo(() => [...new Set(inRange.map((l) => l.state).filter(Boolean))].sort(), [inRange]);

  // ---------- insights ----------
  const stateAgg = aggregate(bySiteF, (l) => l.state || "?");
  const bestEplState = stateAgg.filter((a) => a.leads >= 10 && a.key !== "?").sort((a, b) => b.epl - a.epl)[0];
  const heat = heatmap(both, tz);
  const perHour = Array.from({ length: 24 }, (_, h) => heat.reduce((s, row) => s + row[h].earnings, 0));
  const bestHour = perHour.indexOf(Math.max(...perHour));
  const top10 = concentration(both, 0.1);

  // ---------- trend ----------
  const siteAgg = aggregate(byStateF, (l) => l.host).sort((a, b) => b.earnings - a.earnings);
  const defaultPick = siteAgg.slice(0, 3).map((a) => a.key);
  const chosen = (picked ?? defaultPick).filter((h) => hosts.includes(h)).slice(0, MAX_SERIES);
  const slotFor = (h: string, i: number) => slotOf[h] ?? i;   // defaults take slots in order
  function toggleSite(h: string) {
    const cur = picked ?? defaultPick;
    const slots = { ...slotOf };
    cur.forEach((x, i) => { if (slots[x] === undefined) slots[x] = i; });  // freeze today's colours first
    if (cur.includes(h)) { setSlotOf(slots); setPicked(cur.filter((x) => x !== h)); return; }
    if (cur.length >= MAX_SERIES) return;
    const used = new Set(cur.map((x) => slots[x]));
    slots[h] = SLOTS.findIndex((_, i) => !used.has(i));
    setSlotOf(slots);
    setPicked([...cur, h]);
  }
  const weekList = weeks(from, range.to);
  const trendKeys = chosen.length ? chosen : ["__all"];
  const trendRows = weeklyBy(byStateF, trendKeys, (l) => (chosen.length ? l.host : "__all"), weekList, trendMetric);
  const series: Series[] = trendKeys.map((k, i) => ({
    key: k, label: k === "__all" ? "כל הרשת" : shortSite(k), color: `var(${SLOTS[k === "__all" ? 0 : slotFor(k, i)]})`, values: trendRows[i],
  }));
  const partialWeek = weekStart(range.to) === weekList[weekList.length - 1];

  // ---------- states ----------
  const mapValues = new Map(stateAgg.filter((a) => a.key !== "?").map((a) => [a.key, metricValue(a, mapMetric)]));
  const stateDetail = (st: string) => {
    const a = stateAgg.find((x) => x.key === st);
    return a ? `${int(a.leads)} לידים · ${money(a.earnings)} · לליד ${money(a.epl)} · אישור ${pct(a.accept)}` : "אין לידים";
  };

  // ---------- sites table (weekly sparkline of earnings) ----------
  const sparks = weeklyBy(byStateF, siteAgg.map((a) => a.key), (l) => l.host, weekList, "earnings");
  const netEarn = siteAgg.reduce((s, a) => s + a.earnings, 0) || 1;

  // ---------- distribution, loan size, pages, history ----------
  const hist = payoutHistogram(both);
  const loans = byLoan(both).map((a) => ({ key: a.key, label: a.key, value: a.epl, detail: `${int(a.leads)} לידים · ${money(a.earnings)}` }));
  const pages = byPage(both).sort((a, b) => b.earnings - a.earnings).slice(0, 15);
  const noPage = both.filter((l) => !l.page).length;
  const hist12 = monthly(days);

  const filtered = site || state;

  return (
    <div className="stack">
      <div className="filters">
        <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="אתר">
          <option value="">כל האתרים</option>
          {hosts.map((h) => <option key={h} value={h}>{shortSite(h)}</option>)}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="מדינה">
          <option value="">כל המדינות</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {filtered && <button className="link" onClick={() => { setSite(""); setState(""); }}>ניקוי סינון</button>}
        <span className="spacer" />
        <span className="muted small">{int(t.leads)} לידים · {money(t.earnings)}{range.from < cover ? ` · פירוט מ-${longDay(cover)}` : ""}</span>
      </div>

      <section className="tiles">
        <div className="tile tile-hero">
          <div className="tile-label">הכנסה ממוצעת לליד</div>
          <div className="tile-value num">{money(t.epl)}</div>
          <div className="delta muted">אחוז אישור {pct(t.accept)} · {int(t.rejected)} נדחו</div>
        </div>
        <div className="tile">
          <div className="tile-label">המדינה הרווחית ביותר לליד</div>
          <div className="tile-value">{bestEplState ? bestEplState.key : "—"}</div>
          <div className="delta muted">{bestEplState ? `${money(bestEplState.epl)} לליד · ${bestEplState.leads} לידים` : "צריך 10+ לידים במדינה"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">השעה הרווחית ביותר</div>
          <div className="tile-value num">{perHour[bestHour] > 0 ? HOURS(bestHour) : "—"}</div>
          <div className="delta muted">{tz === "il" ? "שעון ישראל" : "שעון קליפורניה"} · {money(perHour[bestHour] || 0)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">ריכוזיות ההכנסה</div>
          <div className="tile-value num">{pct(top10)}</div>
          <div className="delta muted">מההכנסה הגיעו מ-10% הלידים הכי משתלמים</div>
        </div>
      </section>

      <ChartCard title="מגמה שבועית" sub={`לפי שבוע (ראשון עד שבת)${partialWeek ? ", השבוע האחרון עדיין חלקי" : ""}. בחר עד ${MAX_SERIES} אתרים להשוואה.`}
        controls={<Segmented label="מדד" options={METRICS} value={trendMetric} onChange={setTrendMetric} />}>
        <div className="chips">
          {siteAgg.slice(0, 16).map((a) => {
            const on = chosen.includes(a.key);
            const slot = on ? slotFor(a.key, chosen.indexOf(a.key)) : -1;
            return (
              <button key={a.key} className={on ? "chip on" : "chip"} aria-pressed={on} onClick={() => toggleSite(a.key)}
                disabled={!on && chosen.length >= MAX_SERIES} title={`${money(a.earnings)} · ${a.leads} לידים`}>
                {on && <span className="key-line" style={{ background: `var(${SLOTS[slot]})` }} />}{shortSite(a.key)}
              </button>
            );
          })}
          {chosen.length > 0 && <button className="link small" onClick={() => setPicked([])}>הצג את כל הרשת</button>}
        </div>
        <LineChart series={series} xLabels={weekList.map(shortDay)} xTitle={(i) => `שבוע של ${longDay(weekList[i])}`}
          format={fmtMetric(trendMetric)} formatAxis={axisMetric(trendMetric)} />
      </ChartCard>

      <section className="two-col wide-first">
        <ChartCard title="מפת מדינות" sub={site ? `רק ${shortSite(site)}` : "כל האתרים"}
          controls={<Segmented label="מדד" options={METRICS} value={mapMetric} onChange={setMapMetric} />}>
          <TileMap values={mapValues} format={mapMetric === "leads" ? int : mapMetric === "accept" ? (n) => pct(n) : moneyShort}
            detail={stateDetail} selected={state} onSelect={setState} />
        </ChartCard>
        <ChartCard title="מדינות מובילות" sub={`לפי ${METRICS.find((m) => m.key === mapMetric)!.label}`}>
          <BarList format={fmtMetric(mapMetric)} top={12}
            items={stateAgg.filter((a) => a.key !== "?" && (mapMetric === "earnings" || mapMetric === "leads" || a.leads >= 5))
              .sort((a, b) => metricValue(b, mapMetric) - metricValue(a, mapMetric))
              .map((a) => ({ key: a.key, label: a.key, value: metricValue(a, mapMetric), detail: `${a.leads} לידים`, onClick: () => setState(state === a.key ? "" : a.key) }))} />
          {(mapMetric === "epl" || mapMetric === "accept") && <p className="note small">רק מדינות עם 5 לידים ומעלה, כדי שמדינה עם ליד בודד לא תעוות את הדירוג.</p>}
        </ChartCard>
      </section>

      <ChartCard title="מתי מגיעים הלידים" sub="יום בשבוע × שעה ביום"
        controls={<div className="control-row">
          <Segmented label="מדד" options={[{ key: "leads", label: "לידים" }, { key: "earnings", label: "הכנסה" }]} value={heatMetric} onChange={setHeatMetric} />
          <Segmented label="אזור זמן" options={[{ key: "il", label: "ישראל" }, { key: "pt", label: "קליפורניה" }]} value={tz} onChange={setTz} />
        </div>}>
        <Heatmap values={heat.map((row) => row.map((c) => (heatMetric === "leads" ? c.leads : Math.round(c.earnings * 100) / 100)))}
          format={heatMetric === "leads" ? int : money}
          detail={(d, h) => { const c = heat[d][h]; return `${int(c.leads)} לידים · ${money(c.earnings)}${c.leads ? ` · לליד ${money(c.earnings / c.leads)}` : ""}`; }} />
      </ChartCard>

      <ChartCard title="ביצועי אתרים" sub={state ? `רק לידים מ-${state}` : "כל המדינות"}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>אתר</th><th>לידים</th><th>אישור</th><th>נדחו</th><th>הכנסה</th><th>לליד</th><th>נתח</th><th>מגמה שבועית</th></tr></thead>
            <tbody>
              {siteAgg.map((a, i) => (
                <tr key={a.key} className="clickable" onClick={() => setSite(site === a.key ? "" : a.key)}>
                  <td className="site-cell">{shortSite(a.key)}</td>
                  <td className="num">{int(a.leads)}</td>
                  <td className="num">{pct(a.accept)}</td>
                  <td className="num">{int(a.rejected)}</td>
                  <td className="num strong">{money(a.earnings)}</td>
                  <td className="num">{money(a.epl)}</td>
                  <td className="num">{pct(a.earnings / netEarn)}</td>
                  <td><Sparkline values={sparks[i]} /></td>
                </tr>
              ))}
              {!siteAgg.length && <tr><td colSpan={8} className="muted empty">אין לידים בטווח הזה.</td></tr>}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <section className="two-col">
        <ChartCard title="התפלגות התשלום לליד" sub="כמה לידים בכל טווח תשלום">
          <ColumnChart data={hist.map((b) => ({ key: b.label, label: b.label, value: b.leads, detail: `${money(b.earnings)} · ${pct(t.earnings ? b.earnings / t.earnings : 0)} מההכנסה` }))}
            format={int} formatAxis={int} tickLabel={(c) => c.label} caption="מספר לידים" height={220} />
        </ChartCard>
        <ChartCard title="הכנסה לליד לפי הסכום שביקשו" sub="לידים שהגיעו דרך הדפדפן (שם נקלט הסכום)">
          <BarList items={loans} format={money} top={10} />
        </ChartCard>
      </section>

      <ChartCard title="עמודי נחיתה" sub={`אותו סוג עמוד בכל אתרי הערים יחד${noPage ? ` · ל-${int(noPage)} לידים אין עמוד (נקלטו רק מהדוח של Leap)` : ""}`}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>עמוד</th><th>לידים</th><th>אישור</th><th>הכנסה</th><th>לליד</th></tr></thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.key}><td className="page-cell" dir="ltr">{p.key}</td><td className="num">{int(p.leads)}</td><td className="num">{pct(p.accept)}</td><td className="num strong">{money(p.earnings)}</td><td className="num">{money(p.epl)}</td></tr>
              ))}
              {!pages.length && <tr><td colSpan={5} className="muted empty">אין נתוני עמודים בטווח הזה.</td></tr>}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <section className="two-col">
        <ChartCard title="לידים לפי חודש" sub="כל ההיסטוריה, כל הרשת (לא מושפע מהסינון)">
          <ColumnChart data={hist12.map((m) => ({ key: m.key, label: m.key, value: m.leads, detail: money(m.earnings) }))}
            format={int} formatAxis={int} tickLabel={(c) => monthLabel(c.label)} caption="לידים" height={220} />
        </ChartCard>
        <ChartCard title="הכנסה לליד לפי חודש" sub="האם כל ליד שווה יותר או פחות עם הזמן">
          <ColumnChart data={hist12.map((m) => ({ key: m.key, label: m.key, value: Math.round(m.epl * 100) / 100, detail: `${int(m.leads)} לידים` }))}
            format={money} formatAxis={moneyShort} tickLabel={(c) => monthLabel(c.label)} caption="הכנסה לליד" height={220} />
        </ChartCard>
      </section>
    </div>
  );
}
