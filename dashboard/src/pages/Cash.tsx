import { useState, type FormEvent } from "react";
import { addWithdrawal, deleteWithdrawal } from "../lib/api";
import { cashBox, type Day, type Withdrawal } from "../lib/data";
import { money } from "../lib/format";
import { longDay } from "../lib/time";

const israelToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

export function Cash({ days, withdrawals, onChanged }: {
  days: Day[]; withdrawals: Withdrawal[]; onChanged: () => Promise<void>;
}) {
  const box = cashBox(days, withdrawals);
  const [on, setOn] = useState(israelToday);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(value) && value > 0 && /^\d+(\.\d{1,2})?$/.test(amount.trim());
  const overdraw = valid && value > box.balance;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      await addWithdrawal(on, Math.round(value * 100) / 100, note.trim());
      setAmount(""); setNote(""); setOn(israelToday());
      await onChanged();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: Withdrawal) {
    if (!confirm(`למחוק את המשיכה של ${money(w.amount)} מ-${longDay(w.on)}?`)) return;
    setError(null);
    try { await deleteWithdrawal(w.id); await onChanged(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
  }

  return (
    <div className="stack">
      <section className="tiles">
        <div className="tile tile-hero">
          <div className="tile-label">יתרה בקופה (Updated earnings)</div>
          <div className={`tile-value num${box.balance < 0 ? " negative" : ""}`}>{money(box.balance)}</div>
          <div className="delta muted">סך ההכנסות פחות סך המשיכות</div>
        </div>
        <div className="tile">
          <div className="tile-label">סך הכנסות{days[0] ? ` מאז ${longDay(days[0].day)}` : ""}</div>
          <div className="tile-value num">{money(box.earned)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">סך משיכות</div>
          <div className="tile-value num">{money(box.withdrawn)}</div>
          <div className="delta muted">{withdrawals.length === 1 ? "משיכה אחת" : `${withdrawals.length} משיכות`}</div>
        </div>
      </section>

      <section className="card">
        <h2>הוספת משיכה</h2>
        <form className="withdraw-form" onSubmit={submit}>
          <label>תאריך<input type="date" required value={on} max={israelToday()} onChange={(e) => setOn(e.target.value)} /></label>
          <label>סכום ($)<input inputMode="decimal" dir="ltr" required placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} /></label>
          <label className="grow">הערה<input value={note} maxLength={200} placeholder="למשל: העברה לבנק" onChange={(e) => setNote(e.target.value)} /></label>
          <button className="primary" disabled={!valid || busy}>{busy ? "שומר…" : "הוספה"}</button>
        </form>
        {amount && !valid && <div className="alert alert-error">⚠ סכום לא תקין. מספר חיובי עם עד 2 ספרות אחרי הנקודה.</div>}
        {overdraw && <div className="alert alert-error">⚠ הסכום גדול מהיתרה ({money(box.balance)}). אפשר לשמור, והיתרה תהיה שלילית.</div>}
        {error && <div className="alert alert-error" role="alert">⚠ {error}</div>}
      </section>

      <section className="card table-wrap">
        <table>
          <thead><tr><th>תאריך</th><th>סכום</th><th>הערה</th><th>נרשם על ידי</th><th></th></tr></thead>
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w.id}>
                <td className="num">{longDay(w.on)}</td>
                <td className="num strong">{money(w.amount)}</td>
                <td>{w.note}</td>
                <td className="muted small" dir="ltr">{w.createdBy}</td>
                <td><button className="link danger" onClick={() => remove(w)}>מחיקה</button></td>
              </tr>
            ))}
            {!withdrawals.length && <tr><td colSpan={5} className="muted empty">עוד אין משיכות.</td></tr>}
          </tbody>
        </table>
      </section>

      <p className="note">
        ההכנסות מחושבות מאותם נתונים שמוצגים בשאר הדשבורד ומתעדכנות בכל רענון, כך שהיתרה עולה עם כל ליד חדש.
        אם Leap מעדכן תשלום בדיעבד, גם היתרה מתעדכנת.
      </p>
    </div>
  );
}
