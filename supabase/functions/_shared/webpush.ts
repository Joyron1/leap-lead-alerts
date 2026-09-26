// Web Push with WebCrypto only (works in Deno edge functions and in Node >= 20 for tests):
//   - payload encryption: RFC 8291 "aes128gcm" content coding (RFC 8188 framing, one record)
//   - sender auth: RFC 8292 VAPID (ES256 JWT)
// No npm web-push: it leans on Node's https/ECDH internals, which is exactly what an edge runtime
// is worst at. This file is small enough to read against the RFCs.

const te = new TextEncoder();

export const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str: string): Uint8Array {
    const b = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// TS >= 5.7 types Uint8Array as Uint8Array<ArrayBufferLike>, which WebCrypto's BufferSource rejects even
// though every array here is ArrayBuffer-backed. One explicit cast keeps old and new TS both happy.
const bs = (u: Uint8Array) => u as unknown as BufferSource;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", bs(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bs(data)));
}

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };

// RFC 8291 §3.4 + RFC 8188 §2: salt(16) | rs(4) | idlen(1) | keyid(=as_public, 65) | AES-GCM(plaintext || 0x02)
export async function encryptPayload(
  payload: Uint8Array, p256dh: string, auth: string,
  fixed?: { salt: Uint8Array; asKeys: CryptoKeyPair },   // tests only
): Promise<Uint8Array> {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  const as = fixed?.asKeys ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", bs(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0" || ua_public || as_public, L=32)
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = (await hmac(prkKey, concat(keyInfo, new Uint8Array([1])))).slice(0, 32);

  // CEK / NONCE = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0" | "Content-Encoding: nonce\0")
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", bs(cek), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce) }, key, bs(concat(payload, new Uint8Array([2])))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// RFC 8292: Authorization: vapid t=<ES256 JWT for the push service origin>, k=<public key>
export async function vapidHeader(endpoint: string, privateJwk: JsonWebKey, subject: string, now = Date.now()): Promise<string> {
  const header = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const { kty, crv, x, y, d } = privateJwk;
  const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto already returns the raw r||s form JWS wants (not DER).
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${claims}`)));
  const pub = b64u.enc(concat(new Uint8Array([4]), b64u.dec(x!), b64u.dec(y!)));
  return `vapid t=${header}.${claims}.${b64u.enc(sig)}, k=${pub}`;
}

export type PushResult = { endpoint: string; status: number; gone: boolean; error?: string };

export async function sendPush(sub: PushSubscriptionKeys, message: unknown, vapid: { jwk: JsonWebKey; subject: string }, ttlSeconds = 24 * 3600): Promise<PushResult> {
  try {
    const body = await encryptPayload(te.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(sub.endpoint, vapid.jwk, vapid.subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "high",
      },
      body: bs(body),
    });
    const error = res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 200);
    // 404/410: the browser dropped this subscription (uninstalled, cleared data, revoked permission).
    return { endpoint: sub.endpoint, status: res.status, gone: res.status === 404 || res.status === 410, error };
  } catch (e) {
    return { endpoint: sub.endpoint, status: 0, gone: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
