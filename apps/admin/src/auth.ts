const enc = new TextEncoder();
const COOKIE = "__Host-localdot_admin";
const HOURS = 8 * 60 * 60;
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
export const configured = (secret: string | undefined): secret is string =>
  !!secret && secret.length >= 32;
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function sign(secret: string, value: string) {
  return hex(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(value)));
}
export async function sameToken(given: string, secret: string) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
export async function authorized(
  request: Request,
  secret?: string,
  now = Date.now(),
): Promise<boolean> {
  if (!configured(secret)) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.{32,256})$/)?.[1];
  if (bearer && (await sameToken(bearer, secret))) return true;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const match = /^(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(cookie ?? "");
  if (!match) return false;
  const expiry = Number(match[1]);
  if (expiry <= now / 1000 || expiry > now / 1000 + HOURS + 60) return false;
  const sig = Uint8Array.from((match[3] ?? "").match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  return crypto.subtle.verify(
    "HMAC",
    await key(secret),
    sig,
    enc.encode(`session:${match[1]}.${match[2]}`),
  );
}
export async function sessionCookie(secret: string, now = Date.now()): Promise<string> {
  const value = `${Math.floor(now / 1000) + HOURS}.${crypto.randomUUID().replaceAll("-", "")}`;
  return `${COOKIE}=${value}.${await sign(secret, `session:${value}`)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${HOURS}`;
}
export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}
export async function readSmall(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
