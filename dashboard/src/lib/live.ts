import { supabase } from "./supabase";
import type { RawLead } from "./data";

export type LiveStatus = "connecting" | "live" | "offline";

// Row changes streamed over Supabase Realtime. The server applies the subscriber's RLS, so only
// signed-in dashboard users receive anything. Polling in App stays on as the safety net.
export function subscribeLive(h: {
  onLead: (row: RawLead) => void;
  onWithdrawals: () => void;
  onStatus: (s: LiveStatus) => void;
}): () => void {
  const ch = supabase
    .channel("dashboard-live")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "leap_leads" }, (p) => h.onLead(p.new as RawLead))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "leap_leads" }, (p) => h.onLead(p.new as RawLead))
    .on("postgres_changes", { event: "*", schema: "public", table: "withdrawals" }, () => h.onWithdrawals())
    .subscribe((status) =>
      h.onStatus(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED" ? "offline" : "connecting"));
  return () => { void supabase.removeChannel(ch); };
}

// ---------- sound + system notifications ----------
let audio: AudioContext | null = null;
export function chime(accepted: boolean) {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    // Accepted: two rising notes. Rejected: one low note.
    (accepted ? [660, 990] : [330]).forEach((f, i) => {
      const o = audio!.createOscillator(), g = audio!.createGain();
      o.type = "sine"; o.frequency.value = f;
      const s = t + i * 0.14;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.18, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.32);
      o.connect(g).connect(audio!.destination);
      o.start(s); o.stop(s + 0.35);
    });
  } catch { /* audio blocked until the first click on the page; the toast still shows */ }
}

export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;

export function systemNotify(title: string, body: string, tag: string) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try { new Notification(title, { body, tag, icon: "/icon.svg" }); } catch { /* some browsers only allow this from a service worker */ }
}
