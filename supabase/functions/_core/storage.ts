// Media files in the private "media" bucket. Paths always start with the business id, and only the
// server hands out links (short-lived), so a business can only ever reach its own files.
import { sql } from "./core.ts";

const BASE = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const BUCKET = "media";

export const MIME: Record<string, "photo" | "video" | "audio"> = {
  "image/jpeg": "photo", "image/png": "photo", "image/webp": "photo", "image/heic": "photo", "image/heif": "photo",
  "video/mp4": "video", "video/quicktime": "video",
  "audio/mpeg": "audio", "audio/mp4": "audio", "audio/x-m4a": "audio", "audio/wav": "audio", "audio/x-wav": "audio",
};
export const MAX_BYTES = 50 * 1024 * 1024;

function st(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}/storage/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
}
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** A one-time URL the browser PUTs the file to. */
export async function uploadUrl(path: string) {
  const r = await st(`object/upload/sign/${BUCKET}/${enc(path)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`storage: ${j.message ?? j.error ?? r.status}`);
  return `${BASE}/storage/v1${j.url}`;
}

/** Short-lived download links, keyed by path. */
export async function signedUrls(paths: string[], expiresIn = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const r = await st(`object/sign/${BUCKET}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths, expiresIn }) });
  const j = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(j)) return {};
  return Object.fromEntries(j.filter((x: any) => x.signedURL).map((x: any) => [x.path, `${BASE}/storage/v1${x.signedURL}`]));
}

/** Size and type of an uploaded object, or null if it isn't there. */
export async function objectInfo(path: string) {
  const [o] = await sql`select metadata from storage.objects where bucket_id = ${BUCKET} and name = ${path}`;
  if (!o) return null;
  return { bytes: Number(o.metadata?.size ?? 0), mime: String(o.metadata?.mimetype ?? "") };
}

export async function download(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await st(`object/${BUCKET}/${enc(path)}`, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`couldn't read ${path} (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function removeObjects(paths: string[]) {
  if (!paths.length) return;
  await st(`object/${BUCKET}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefixes: paths }) });
}

export function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The previews (JPEG) of library items as image blocks a model can look at. */
export async function previewBlocks(paths: string[]) {
  return await Promise.all(paths.map(async (p) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(await download(p)) } })));
}

/** Library items attached to a post, in the order given, with links. Only this business's ready files. */
export async function mediaFor(bid: string, ids: number[], expiresIn = 3600) {
  if (!ids?.length) return [];
  const rows = await sql`select id, kind, path, mime, tag, contractor, trade, job, title from os.media
    where business_id = ${bid} and status = 'ready' and id = any(${sql.array(ids.map(Number))}::bigint[])`;
  const urls = await signedUrls(rows.map((r: any) => r.path), expiresIn);
  const byId = new Map(rows.map((r: any) => [Number(r.id), { ...r, url: urls[r.path] ?? null }]));
  return ids.map((i) => byId.get(Number(i))).filter(Boolean) as any[];
}
