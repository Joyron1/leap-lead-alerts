import { supabase } from "./supabase";
import { normalizeLead, type Lead, type RawLead, type StatRow, type Withdrawal } from "./data";

// PostgREST caps a response at 1000 rows, so page through. What comes back is decided by the
// RLS policies (signed-in, allow-listed, confirmed user) — nothing here widens access.
async function fetchAll<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from(table).select(cols).order(order, { ascending: true }).range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

export async function fetchLeads(): Promise<Lead[]> {
  const raw = await fetchAll<RawLead>("leap_leads",
    "lead_id,domain,page,state,status,payout,pay_model,source,client_ts,received_at,loan_range,loan_amount", "id");
  return raw.map(normalizeLead).sort((a, b) => b.ts - a.ts);
}

// ---------- withdrawals (the one table the dashboard writes; RLS allows only dashboard users) ----------
type RawWithdrawal = { id: number; withdrawn_on: string; amount: number | string; note: string; created_by: string };
const toWithdrawal = (r: RawWithdrawal): Withdrawal =>
  ({ id: r.id, on: r.withdrawn_on, amount: Number(r.amount) || 0, note: r.note, createdBy: r.created_by });

export async function fetchWithdrawals(): Promise<Withdrawal[]> {
  const raw = await fetchAll<RawWithdrawal>("withdrawals", "id,withdrawn_on,amount,note,created_by", "id");
  return raw.map(toWithdrawal).sort((a, b) => b.on.localeCompare(a.on) || b.id - a.id);
}

export async function addWithdrawal(on: string, amount: number, note: string) {
  const { error } = await supabase.from("withdrawals").insert({ withdrawn_on: on, amount, note });
  if (error) throw new Error(error.message);
}

export async function deleteWithdrawal(id: number) {
  const { error, count } = await supabase.from("withdrawals").delete({ count: "exact" }).eq("id", id);
  if (error) throw new Error(error.message);
  if (!count) throw new Error("המשיכה לא נמחקה (אין הרשאה או שכבר נמחקה).");
}

export async function fetchStats(): Promise<StatRow[]> {
  const raw = await fetchAll<{ day: string; leads: number; accepted: number; earnings: number | string }>(
    "leap_daily_stats", "day,leads,accepted,earnings", "day");
  return raw.map((r) => ({ day: r.day, leads: r.leads, accepted: r.accepted, earnings: Number(r.earnings) || 0 }));
}
