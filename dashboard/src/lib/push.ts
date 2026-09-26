import { supabase } from "./supabase";

// Public half of the VAPID key pair (the private half lives only in Supabase secrets). Public by
// design: push services use it to check that notifications really come from our push-send function.
export const VAPID_PUBLIC_KEY = "BHGvCIkwyS_vfeCOQFIXQuEz9CaXXLzRulBiqdyBY8ar30WcYe83l05vzZ2okRCxoHu-s7ZGeFcVtEih9xPHAJA";

export type PushState = "unsupported" | "denied" | "off" | "on";

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(b64url: string) {
  const b = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? "on" : "off";
}

async function save(sub: PushSubscription) {
  const j = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert({
    endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, user_agent: navigator.userAgent.slice(0, 200),
  }, { onConflict: "endpoint" });
  if (error) throw new Error(error.message);
}

// Ask permission, subscribe this browser, and register it for lead notifications.
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
  await save(sub);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
  return "off";
}

// Re-save an existing subscription (e.g. after signing in on a device that was subscribed before),
// so the server always knows about this device while it is subscribed.
export async function refreshPush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) await save(sub).catch(() => { /* not fatal */ });
}

export async function sendTestPush(): Promise<{ sent: number; total: number }> {
  const { data, error } = await supabase.functions.invoke("push-send", { body: { test: true } });
  if (error) throw new Error(error.message);
  return { sent: Number(data?.sent) || 0, total: Number(data?.total) || 0 };
}
