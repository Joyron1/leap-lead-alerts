import { useEffect, useMemo, useState } from "react";
import { leadsCsv, shortSite, type Lead } from "../lib/data";
import { int, money } from "../lib/format";
import { israelDateTime, longDay, shortDay, type Range } from "../lib/time";

const PAGE = 50;
const STATUS_HE: Record<string, string> = { accepted: "אושר", rejected: "נדחה", pending: "ממתין" };

export function Leads({ leads, cover, range, site, setSite }: {
  leads: Lead[]; cover: string; range: Range; site: string; setSite: (h: string) => void;
}) {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(0);

  const inRange = useMemo(() => leads.filter((l) => l.day >= range.from && l.day <= range.to), [leads, range.from, range.to]);
  const hosts = useMemo(() => [...new Set(inRange.map((l) => l.host))].sort(), [inRange]);
  const states = useMemo(() => [...new Set(inRange.map((l) => l.state).filter(Boolean))].sort(), [inRange]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return inRange.filter((l) =>
      (!site || l.host === site) && (!state || l.state === state) && (!status || l.status === status) &&
      (!source || l.source === source) &&
      (!needle || l.id.includes(needle) || l.host.includes(needle) || l.page.toLowerCase().includes(needle)));
  }, [inRange, q, site, state, status, source]);

  useEffect(() => setPage(0), [q, site, state, status, source, range.from, range.to]);

  const total = rows.reduce((s, l) => s + l.payout, 0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const view = rows.slice(page * PAGE, page * PAGE + PAGE);

  function exportCsv() {
    const blob = new Blob([leadsCsv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `snaploans-leads-${range.from}_${range.to}${site ? "-" + shortSite(site) : ""}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const clear = () => { setQ(""); setSite(""); setState(""); setStatus(""); setSource(""); };
  const filtered = q || site || state || status || source;

  return (
    <div className="stack">
      <div className="filters">
        <input className="search" placeholder="חיפוש: מזהה ליד, אתר או עמוד" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="אתר">
          <option value="">כל האתרים</option>
          {hosts.map((h) => <option key={h} value={h}>{shortSite(h)}</option>)}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="מדינה">
          <option value="">כל המדינות</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="סטטוס">
          <option value="">כל הסטטוסים</option>
          <option value="accepted">אושר</option><option value="rejected">נדחה</option><option value="pending">ממתין</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="מקור">
          <option value="">כל המקורות</option>
          <option value="browser">דפדפן (בזמן אמת)</option><option value="sync">דוח Leap (השלמה)</option>
        </select>
        {filtered && <button className="link" onClick={clear}>ניקוי סינון</button>}
        <span className="spacer" />
        <button onClick={exportCsv} disabled={!rows.length}>ייצוא CSV</button>
      </div>

      <p className="note">
        <span className="num">{int(rows.length)}</span> לידים · <span className="num">{money(total)}</span>
        {range.from < cover && <> · לידים פרטניים קיימים רק מ-{longDay(cover)}</>}
      </p>

      <div className="card table-wrap">
        <table className="leads">
          <thead>
            <tr><th>זמן (ישראל)</th><th>יום Leap</th><th>אתר</th><th>מדינה</th><th>סטטוס</th><th>תשלום</th><th>מקור</th><th>עמוד</th><th>סכום מבוקש</th><th>מזהה</th></tr>
          </thead>
          <tbody>
            {view.map((l) => (
              <tr key={l.id}>
                <td className="num">{israelDateTime(l.ts)}</td>
                <td className="num muted">{shortDay(l.day)}</td>
                <td><button className="link" onClick={() => setSite(l.host)}>{l.site}</button></td>
                <td>{l.state}</td>
                <td><span className={`pill pill-${l.status || "unknown"}`}>{STATUS_HE[l.status] ?? l.status}</span></td>
                <td className="num strong">{money(l.payout)}</td>
                <td className="muted">{l.source === "sync" ? "Leap" : "דפדפן"}</td>
                <td className="page-cell" dir="ltr" title={l.page}>{l.page}</td>
                <td className="num">{l.loan}</td>
                <td className="num muted">{l.id}</td>
              </tr>
            ))}
            {!view.length && <tr><td colSpan={10} className="muted empty">אין לידים שמתאימים לסינון.</td></tr>}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>→ הקודם</button>
          <span className="num">{page + 1} / {pages}</span>
          <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>הבא ←</button>
        </div>
      )}
    </div>
  );
}
