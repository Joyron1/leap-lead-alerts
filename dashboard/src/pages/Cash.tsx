import { useState, type FormEvent } from "react";
import { addWithdrawal, deleteWithdrawal } from "../lib/api";
import { cashBox, type Day, type Withdrawal } from "../lib/data";
import { money, pct } from "../lib/format";
import { addDays, longDay, todayPT } from "../lib/time";

const israelToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const cents = (n: number) => Math.round(n * 100);

export function Cash({ days, withdrawals, onChanged, canEdit }: {
  days: Day[]; withdrawals: Withdrawal[]; onChanged: () => Promise<void>; canEdit: boolean;
}) {
  const box = cashBox(days, withdrawals);
  const [on, setOn] = useState(israelToday);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const value = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(value) && value > 0 && /^\d+(\.\d{1,2})?$/.test(amount.trim());
  const after = valid ? (cents(box.balance) - cents(value)) / 100 : box.balance;

  // ---------- figures ----------
  const withdrawnShare = box.earned > 0 ? Math.min(1, Math.max(0, box.withdrawn / box.earned)) : 0;
  const last = withdrawals[0];                                   // list is newest first
  const sinceLast = last ? days.filter((d) => d.day > last.on).reduce((s, d) => s + cents(d.earnings), 0) / 100 : box.earned;
  const today = todayPT();
  const from30 = addDays(today, -30), to30 = addDays(today, -1);  // 30 finished days
  const perDay = days.filter((d) => d.day >= from30 && d.day <= to30).reduce((s, d) => s + d.earnings, 0) / 30;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      await addWithdrawal(on, cents(value) / 100, note.trim());
      setAmount(""); setNote(""); setOn(israelToday());
      await onChanged();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: Withdrawal) {
    setError(null);
    try { await deleteWithdrawal(w.id); setConfirmId(null); await onChanged(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
  }

  return (
    <div className="stack">
      {/* ---------- balance ---------- */}
      <section className="card cash-hero">
        <div className="cash-hero-top">
          <div>
            <div className="tile-label">יתרה בקופה</div>
            <div className={`cash-balance num${box.balance < 0 ? " negative" : ""}`}>{money(box.balance)}</div>
            <div className="muted small">Updated earnings · עולה עם כל ליד חדש</div>
          </div>
          <div className="cash-eq" aria-label="הכנסות פחות משיכות שווה יתרה">
            <div><span className="muted small">הכנסות{days[0] ? ` מאז ${longDay(days[0].day)}` : ""}</span><strong className="num">{money(box.earned)}</strong></div>
            <span className="eq-op" aria-hidden>−</span>
            <div><span className="muted small">משיכות</span><strong className="num">{money(box.withdrawn)}</strong></div>
            <span className="eq-op" aria-hidden>=</span>
            <div><span className="muted small">בקופה</span><strong className="num">{money(box.balance)}</strong></div>
          </div>
        </div>

        <div className="split" role="img" aria-label={`נמשך ${pct(withdrawnShare)}, בקופה ${pct(1 - withdrawnShare)}`}>
          {/* Same order as the legend below: "in the box" first, so it sits on the right in RTL. */}
          <div className="split-bar">
            {withdrawnShare < 1 && <span className="split-in" style={{ flexGrow: 1 - withdrawnShare }} />}
            {withdrawnShare > 0 && <span className="split-out" style={{ flexGrow: withdrawnShare }} />}
          </div>
          <div className="split-legend">
            <span><i className="sw sw-in" />בקופה <strong className="num">{pct(1 - withdrawnShare)}</strong></span>
            <span><i className="sw sw-out" />נמשך <strong className="num">{pct(withdrawnShare)}</strong></span>
          </div>
        </div>
      </section>

      {/* ---------- helpful figures ---------- */}
      <section className="cash-stats">
        <div className="tile">
          <div className="tile-label">הכנסות מאז המשיכה האחרונה</div>
          <div className="tile-value num">{money(sinceLast)}</div>
          <div className="delta muted">{last ? `מאז ${longDay(last.on)}` : "עוד לא נרשמה משיכה"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">המשיכה האחרונה</div>
          <div className="tile-value num">{last ? money(last.amount) : "—"}</div>
          <div className="delta muted">{last ? `${longDay(last.on)}${last.note ? ` · ${last.note}` : ""}` : "—"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">קצב הכנסה</div>
          <div className="tile-value"><span className="num">{money(perDay)}</span> <span className="unit">ליום</span></div>
          <div className="delta muted">ממוצע 30 הימים האחרונים · כ-{money(perDay * 30)} בחודש</div>
        </div>
      </section>

      {/* ---------- history + new withdrawal ---------- */}
      <section className={canEdit ? "cash-grid" : "cash-grid single"}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>היסטוריית משיכות</h2>
              <p className="muted small">{withdrawals.length === 1 ? "משיכה אחת" : `${withdrawals.length} משיכות`}{!canEdit ? " · צפייה בלבד" : ""}</p>
            </div>
          </div>
          {withdrawals.length ? (
            <ul className="wd-list">
              {withdrawals.map((w) => (
                <li key={w.id} className="wd-row">
                  <div className="wd-main">
                    <span className="wd-date">{longDay(w.on)}</span>
                    <span className="wd-note">{w.note || <span className="muted">ללא הערה</span>}</span>
                    <span className="wd-by muted small" dir="ltr">{w.createdBy}</span>
                  </div>
                  <strong className="wd-amount num">{money(w.amount)}</strong>
                  {canEdit && (confirmId === w.id ? (
                    <span className="wd-confirm">
                      <span className="small">למחוק?</span>
                      <button className="small danger-btn" onClick={() => remove(w)}>מחיקה</button>
                      <button className="small" onClick={() => setConfirmId(null)}>ביטול</button>
                    </span>
                  ) : (
                    <button className="wd-del" onClick={() => setConfirmId(w.id)} title="מחיקת המשיכה" aria-label={`מחיקת המשיכה של ${money(w.amount)}`}>✕</button>
                  ))}
                </li>
              ))}
              <li className="wd-row wd-total">
                <div className="wd-main"><span className="wd-date">סה״כ נמשך</span></div>
                <strong className="wd-amount num">{money(box.withdrawn)}</strong>
                {canEdit && <span className="wd-del-spacer" />}
              </li>
            </ul>
          ) : (
            <p className="muted empty">עוד לא נרשמו משיכות.</p>
          )}
        </div>

        {canEdit && (
          <form className="card wd-form" onSubmit={submit}>
            <h2>משיכה חדשה</h2>
            <label className="field">
              <span>סכום</span>
              <span className="money-input">
                <span className="prefix" aria-hidden>$</span>
                <input inputMode="decimal" dir="ltr" required placeholder="0.00" value={amount} aria-invalid={!!amount && !valid}
                  onChange={(e) => setAmount(e.target.value.replace(",", "."))} />
              </span>
            </label>
            <div className="quick">
              <button type="button" className="chip" disabled={box.balance <= 0} onClick={() => setAmount((cents(box.balance) / 100).toFixed(2))}>כל היתרה</button>
              <button type="button" className="chip" disabled={box.balance <= 0} onClick={() => setAmount((Math.floor(cents(box.balance) / 2) / 100).toFixed(2))}>חצי</button>
            </div>
            {amount && !valid && <p className="field-msg bad">מספר חיובי עם עד 2 ספרות אחרי הנקודה.</p>}

            <label className="field">
              <span>תאריך</span>
              <input type="date" required value={on} max={israelToday()} onChange={(e) => setOn(e.target.value)} />
            </label>
            <label className="field">
              <span>הערה <span className="muted">(לא חובה)</span></span>
              <input value={note} maxLength={200} placeholder="למשל: העברה לבנק" onChange={(e) => setNote(e.target.value)} />
            </label>

            <div className={`after${valid && after < 0 ? " negative" : ""}`}>
              <span className="muted small">היתרה אחרי המשיכה</span>
              <strong className="num">{money(after)}</strong>
            </div>
            {valid && after < 0 && <p className="field-msg bad">⚠ הסכום גדול מהיתרה. אפשר לשמור, והיתרה תהיה שלילית.</p>}
            {error && <p className="field-msg bad" role="alert">⚠ {error}</p>}

            <button className="primary wide" disabled={!valid || busy}>{busy ? "שומר…" : "רישום משיכה"}</button>
          </form>
        )}
      </section>

      <p className="note small">
        ההכנסות מחושבות מאותם נתונים שבשאר הדשבורד, ולכן היתרה עולה עם כל ליד חדש, ומתעדכנת גם אם Leap משנה תשלום בדיעבד.
      </p>
    </div>
  );
}
