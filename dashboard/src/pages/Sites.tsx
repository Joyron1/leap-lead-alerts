import { useState } from "react";
import { siteRows, type Lead, type SiteRow } from "../lib/data";
import { change, int, money, pct } from "../lib/format";
import { longDay, relativeHe, type Range } from "../lib/time";

type SortKey = "key" | "leads" | "accepted" | "earnings" | "epl" | "share" | "lastTs" | "last7";
const QUIET_DAYS = 3;

export function Sites({ leads, cover, range, today, onSite }: {
  leads: Lead[]; cover: string; range: Range; today: string; onSite: (host: string) => void;
}) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "earnings", dir: -1 });
  const from = range.from < cover ? cover : range.from;
  const now = Date.now();
  const rows = siteRows(leads, from, range.to, today).sort((a, b) => {
    const av = a[sort.k], bv = b[sort.k];
    const c = typeof av === "string" ? String(av).localeCompare(String(bv)) : Number(av) - Number(bv);
    return c * sort.dir || b.earnings - a.earnings;
  });
  const quiet = rows.filter((r) => r.lastTs && now - r.lastTs > QUIET_DAYS * 864e5);

  const th = (k: SortKey, label: string) => (
    <th aria-sort={sort.k === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="th-btn" onClick={() => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : k === "key" ? 1 : -1 }))}>
        {label}{sort.k === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  return (
    <div className="stack">
      <p className="note">
        {rows.length} אתרים שהביאו לפחות ליד אחד מאז {longDay(cover)}.
        {quiet.length > 0 && <> <strong>⚠ {quiet.length} מהם בלי ליד {QUIET_DAYS}+ ימים.</strong></>}
        {" "}אתרים שמעולם לא הביאו ליד לא מופיעים כאן. לחיצה על אתר פותחת את הלידים שלו.
      </p>
      <div className="card table-wrap">
        <table className="sites">
          <thead>
            <tr>
              {th("key", "אתר")}{th("leads", "לידים")}{th("accepted", "אושרו")}{th("earnings", "הכנסה")}
              {th("epl", "לליד")}{th("share", "נתח")}{th("last7", "7 ימים אחרונים")}{th("lastTs", "ליד אחרון")}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <Row key={r.host} r={r} now={now} onSite={onSite} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ r, now, onSite }: { r: SiteRow; now: number; onSite: (h: string) => void }) {
  const c = change(r.last7, r.prev7);
  const dir = c === null ? "flat" : c === Infinity || c > 0.0005 ? "up" : c < -0.0005 ? "down" : "flat";
  const silentDays = r.lastTs ? Math.floor((now - r.lastTs) / 864e5) : null;
  return (
    <tr className="clickable" onClick={() => onSite(r.host)}>
      <td className="site-cell">{r.key}</td>
      <td className="num">{int(r.leads)}</td>
      <td className="num">{int(r.accepted)}</td>
      <td className="num strong">{money(r.earnings)}</td>
      <td className="num">{money(r.epl)}</td>
      <td className="num">{pct(r.share)}</td>
      <td>
        <span className="num">{money(r.last7)}</span>{" "}
        {c !== null && (
          <span className={`delta-inline delta-${dir}`}>
            {dir === "up" ? "▲" : dir === "down" ? "▼" : "●"}{" "}
            <span className="num">{c === Infinity ? "חדש" : pct(Math.abs(c))}</span>
          </span>
        )}
      </td>
      <td>
        {silentDays !== null && silentDays >= QUIET_DAYS
          ? <span className="status status-warning"><span aria-hidden>⚠</span> שקט {silentDays} ימים</span>
          : <span className="muted">{r.lastTs ? relativeHe(r.lastTs, now) : "—"}</span>}
      </td>
    </tr>
  );
}
