// os-social: one-tap Facebook, Instagram and YouTube connections for every Destiny OS business, and automatic posting
// of approved content to Instagram and YouTube (Facebook posting stays in os-jobs, which reads the same Page token).
//
// It uses the Facebook and Google apps Destiny Reels already has, so nothing new needs registering with Meta or Google:
// the sign-in goes out with Reels' redirect address, reels-oauth sees our state (it carries os: 1) and forwards the
// code here, and we finish the exchange with that same redirect address.
//
//   POST (x-os-token, owner/admin): status, connect {platform}, choose_page {page_id}, disconnect {platform}
//   GET  ?code&state: the forwarded sign-in (from reels-oauth)
//   POST (Bearer OS_INVOKE_KEY) {action: "publish"}: every minute from cron; posts due content to Instagram/YouTube.
//
// Tokens live in the vault as "<slug>:FACEBOOK_PAGE_TOKEN", "<slug>:FACEBOOK_USER_TOKEN", "<slug>:YOUTUBE_REFRESH_TOKEN"
// and are never sent to the browser. Self-contained on purpose (no shared imports) so it deploys on its own.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20 });
const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const G = "https://graph.facebook.com/v24.0";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-os-token, authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function secret(name: string): Promise<string | null> {
  const [s] = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name}`;
  return (s?.decrypted_secret as string) ?? Deno.env.get(name)?.trim() ?? null;
}
async function putSecret(name: string, value: string, note: string) {
  const [have] = await sql`select id from vault.secrets where name = ${name}`;
  if (have) await sql`select vault.update_secret(${have.id}, ${value})`;
  else await sql`select vault.create_secret(${value}, ${name}, ${note})`;
}
async function dropSecret(name: string) { await sql`delete from vault.secrets where name = ${name}`; }

// Same signed-state format reels-oauth reads (body.mac, mac = sha256(body + REELS_TOKEN_KEY), 15-minute expiry).
async function signState(payload: Record<string, unknown>) {
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 15 * 60_000 })).replace(/=+$/, "");
  return `${body}.${await sha256(body + (await secret("REELS_TOKEN_KEY")))}`;
}
async function readState(state: string): Promise<Record<string, any> | null> {
  const [body, mac] = String(state ?? "").split(".");
  if (!body || !mac || mac !== (await sha256(body + (await secret("REELS_TOKEN_KEY"))))) return null;
  try { const p = JSON.parse(atob(body)); return p.exp > Date.now() ? p : null; } catch { return null; }
}
// OS_OAUTH_REDIRECT (this function's own URL, once it is added to the Meta and Google apps) wins; otherwise Reels' address,
// which reels-oauth forwards here.
const redirectUri = async () => (await secret("OS_OAUTH_REDIRECT")) ?? (await secret("REELS_OAUTH_REDIRECT")) ?? `${BASE}/functions/v1/reels-oauth`;
const appUrl = async () => ((await secret("OS_APP_URL")) ?? "https://app.destinymarketinggroup.com").replace(/\/+$/, "");

async function getJson(url: string, init: RequestInit = {}, timeout = 30_000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message ?? j.error_description ?? (typeof j.error === "string" ? j.error : `HTTP ${r.status}`));
  return j;
}
const fbPost = (path: string, form: Record<string, string>) => getJson(`${G}/${path}`, { method: "POST", body: new URLSearchParams(form) }, 60_000);

async function board(bid: string, body: string, queued = false) {
  await sql`insert into os.messages (business_id, sender, body, status) values (${bid}, 'system', ${body}, ${queued ? "queued" : "handled"})`;
}
async function audit(bid: string, action: string, target: string, details: unknown) {
  await sql`insert into os.activity_log (business_id, actor_type, actor, action, target, details) values (${bid}, 'system', 'social', ${action}, ${target}, ${sql.json(details as any)})`;
}

// ---------------------------------------------------------------- connections
async function setIntegration(bid: string, provider: string, status: string, settings: Record<string, unknown>, secrets: string[]) {
  await sql`insert into os.integrations (business_id, provider, status, secret_names, settings, updated_at)
    values (${bid}, ${provider}, ${status}, ${secrets}, ${sql.json(settings as any)}, now())
    on conflict (business_id, provider) do update set status = excluded.status, secret_names = excluded.secret_names, settings = excluded.settings, updated_at = now()`;
}

async function socialStatus(bid: string) {
  const rows = await sql`select provider, status, settings from os.integrations where business_id = ${bid} and provider in ('facebook', 'instagram', 'youtube')`;
  const by = Object.fromEntries(rows.map((r: any) => [r.provider, r]));
  const fb: any = by.facebook, ig: any = by.instagram, yt: any = by.youtube;
  return {
    ready: { meta: !!(await secret("REELS_META_APP_ID")), google: !!(await secret("REELS_GOOGLE_CLIENT_ID")) },
    facebook: fb ? { status: fb.status, page_name: fb.settings?.page_name ?? null, via: fb.settings?.via ?? "token",
      pages: fb.status === "choose_page" ? (fb.settings?.pages ?? []).map((p: any) => ({ id: p.id, name: p.name, instagram: p.ig_username ?? null })) : undefined } : { status: "not_connected" },
    instagram: ig ? { status: ig.status, username: ig.settings?.username ?? null, reason: ig.settings?.reason ?? null } : { status: "not_connected" },
    youtube: yt ? { status: yt.status, channel: yt.settings?.channel_name ?? null } : { status: "not_connected" },
  };
}

async function connectUrl(bid: string, uid: string, platform: string) {
  const state = await signState({ os: 1, b: bid, u: uid, p: platform });
  const redirect = await redirectUri();
  if (platform === "youtube") {
    const id = await secret("REELS_GOOGLE_CLIENT_ID");
    if (!id) throw new Error("YouTube connections aren't switched on yet.");
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: id, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly", state })}`;
  }
  const app = await secret("REELS_META_APP_ID");
  if (!app) throw new Error("Facebook connections aren't switched on yet.");
  const config = await secret("OS_META_CONFIG_ID") ?? await secret("REELS_META_CONFIG_ID");
  return `https://www.facebook.com/v24.0/dialog/oauth?${new URLSearchParams({
    client_id: app, redirect_uri: redirect, state, response_type: "code",
    ...(config ? { config_id: config } : { scope: "pages_show_list,pages_read_engagement,pages_manage_posts,business_management,instagram_basic,instagram_content_publish" }) })}`;
}

async function facebookCallback(bid: string, code: string) {
  const [b] = await sql`select slug, name from os.businesses where id = ${bid}`;
  const [id, sec] = await Promise.all([secret("REELS_META_APP_ID"), secret("REELS_META_APP_SECRET")]);
  const short = await getJson(`${G}/oauth/access_token?${new URLSearchParams({ client_id: id!, client_secret: sec!, redirect_uri: await redirectUri(), code })}`);
  const long = await getJson(`${G}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: id!, client_secret: sec!, fb_exchange_token: short.access_token })}`).catch(() => ({}));
  const user = long.access_token ?? short.access_token;
  const perms = await getJson(`${G}/me/permissions?access_token=${encodeURIComponent(user)}`).catch(() => ({ data: [] }));
  const granted = new Set((perms.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => p.permission));
  const pages = await getJson(`${G}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(user)}`);
  const list = (pages.data ?? []).map((p: any) => ({ id: p.id, name: p.name, token: p.access_token, ig_id: p.instagram_business_account?.id ?? null, ig_username: p.instagram_business_account?.username ?? null }));
  if (!list.length) throw new Error("No Facebook Pages came through. Connect again and tick the business's Page.");
  await putSecret(`${b.slug}:FACEBOOK_USER_TOKEN`, user, `Destiny OS Facebook sign-in for ${b.name}`);
  const igPerm = granted.has("instagram_content_publish");
  if (list.length === 1) return await choosePage(bid, list[0], igPerm, list);
  await setIntegration(bid, "facebook", "choose_page", { via: "oauth", ig_perm: igPerm, pages: list.map(({ token: _t, ...p }: any) => p) }, ["FACEBOOK_USER_TOKEN"]);
  return `Facebook signed in. Pick which Page to post to (${list.length} found).`;
}

async function choosePage(bid: string, page: any, igPerm: boolean, all: any[] = []) {
  const [b] = await sql`select slug, name from os.businesses where id = ${bid}`;
  await putSecret(`${b.slug}:FACEBOOK_PAGE_TOKEN`, page.token, `Destiny OS Facebook Page for ${b.name}`);
  await setIntegration(bid, "facebook", "connected",
    { via: "oauth", page_id: page.id, page_name: page.name, ig_perm: igPerm, pages: all.map(({ token: _t, ...p }: any) => p) }, ["FACEBOOK_PAGE_TOKEN", "FACEBOOK_USER_TOKEN"]);
  let msg = `Facebook Page "${page.name}" connected.`;
  if (page.ig_id && igPerm) {
    await setIntegration(bid, "instagram", "connected", { ig_user_id: page.ig_id, username: page.ig_username, page_id: page.id }, ["FACEBOOK_PAGE_TOKEN"]);
    msg += ` Instagram @${page.ig_username} connected too.`;
  } else {
    const reason = !page.ig_id ? "No Instagram business account is linked to this Facebook Page. Link it in the Page's settings (Linked accounts), then connect Facebook again."
      : "Instagram posting permission wasn't granted. Connect Facebook again and allow Instagram.";
    await setIntegration(bid, "instagram", "not_connected", { reason }, []);
    msg += page.ig_id ? " Instagram needs permission (connect again and allow Instagram)." : " No Instagram account is linked to that Page.";
  }
  await board(bid, `${msg} Approved posts will now go out on their own at their scheduled time.`);
  await audit(bid, "social_connected", "facebook", { page: page.name, instagram: page.ig_username ?? null });
  return msg;
}

async function youtubeCallback(bid: string, code: string) {
  const [b] = await sql`select slug, name from os.businesses where id = ${bid}`;
  const [id, sec] = await Promise.all([secret("REELS_GOOGLE_CLIENT_ID"), secret("REELS_GOOGLE_CLIENT_SECRET")]);
  const t = await getJson("https://oauth2.googleapis.com/token", { method: "POST",
    body: new URLSearchParams({ code, client_id: id!, client_secret: sec!, redirect_uri: await redirectUri(), grant_type: "authorization_code" }) });
  if (!t.refresh_token) throw new Error("Google didn't give lasting access. Remove the app at myaccount.google.com/permissions and connect again.");
  const ch = await getJson("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${t.access_token}` } });
  const c = (ch.items ?? [])[0];
  if (!c) throw new Error("That Google account has no YouTube channel. Create one on YouTube, then connect again.");
  await putSecret(`${b.slug}:YOUTUBE_REFRESH_TOKEN`, t.refresh_token, `Destiny OS YouTube for ${b.name}`);
  await setIntegration(bid, "youtube", "connected", { channel_id: c.id, channel_name: c.snippet?.title ?? "YouTube" }, ["YOUTUBE_REFRESH_TOKEN"]);
  await board(bid, `YouTube channel "${c.snippet?.title}" connected. Approved videos for YouTube will now go out on their own.`);
  await audit(bid, "social_connected", "youtube", { channel: c.snippet?.title });
  return `YouTube channel "${c.snippet?.title}" connected.`;
}

async function disconnect(bid: string, platform: string) {
  const [b] = await sql`select slug from os.businesses where id = ${bid}`;
  if (platform === "youtube") {
    await dropSecret(`${b.slug}:YOUTUBE_REFRESH_TOKEN`);
    await sql`update os.integrations set status = 'not_connected', settings = '{}'::jsonb, secret_names = '{}' where business_id = ${bid} and provider = 'youtube'`;
  } else if (platform === "instagram") {
    await sql`update os.integrations set status = 'not_connected', settings = '{"reason":"Turned off in Connections."}'::jsonb, secret_names = '{}' where business_id = ${bid} and provider = 'instagram'`;
  } else {
    await dropSecret(`${b.slug}:FACEBOOK_PAGE_TOKEN`); await dropSecret(`${b.slug}:FACEBOOK_USER_TOKEN`);
    await sql`update os.integrations set status = 'not_connected', settings = '{}'::jsonb, secret_names = '{}' where business_id = ${bid} and provider in ('facebook', 'instagram')`;
  }
  await audit(bid, "social_disconnected", platform, {});
}

// ---------------------------------------------------------------- publishing
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
async function mediaFor(bid: string, ids: number[]) {
  if (!ids.length) return [];
  const rows = await sql`select id, kind, path, mime from os.media where business_id = ${bid} and status = 'ready' and id = any(${sql.array(ids)}::bigint[])`;
  const r = await fetch(`${BASE}/storage/v1/object/sign/media`, { method: "POST", headers: { Authorization: `Bearer ${SKEY}`, apikey: SKEY, "content-type": "application/json" },
    body: JSON.stringify({ paths: rows.map((x: any) => x.path), expiresIn: 3 * 3600 }) });
  const signed = await r.json().catch(() => []);
  const urls = Object.fromEntries((Array.isArray(signed) ? signed : []).filter((x: any) => x.signedURL).map((x: any) => [x.path, `${BASE}/storage/v1${x.signedURL}`]));
  const byId = new Map(rows.map((x: any) => [Number(x.id), { ...x, url: urls[x.path] ?? null }]));
  return ids.map((i) => byId.get(i)).filter(Boolean) as any[];
}
async function download(path: string) {
  const r = await fetch(`${BASE}/storage/v1/object/media/${enc(path)}`, { headers: { Authorization: `Bearer ${SKEY}`, apikey: SKEY }, signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`couldn't read the video (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const captionOf = (c: any) => [c.title && !String(c.body ?? "").startsWith(c.title) ? c.title : null, c.body].filter(Boolean).join("\n\n");

async function pageToken(slug: string, pageId: string) {
  const [t] = await sql`select decrypted_secret as v from vault.decrypted_secrets where name = ${slug + ":FACEBOOK_PAGE_TOKEN"}`;
  if (!t) throw new Error("the Facebook connection is missing; connect Facebook again");
  const pg = await getJson(`${G}/${encodeURIComponent(pageId)}?fields=access_token&access_token=${encodeURIComponent(t.v)}`).catch(() => ({}));
  return (pg as any).access_token ?? t.v;
}

async function instagram(c: any, ig: any) {
  const media = await mediaFor(c.business_id, (c.media_ids ?? []).map(Number));
  if (!media.length) throw new Error("Instagram needs a photo or video, and this post has none");
  if (media.some((m) => !m.url)) throw new Error("a photo or video attached to this post couldn't be read");
  const tok = await pageToken(c.slug, ig.page_id);
  const user = encodeURIComponent(ig.ig_user_id), caption = captionOf(c).slice(0, 2200);
  const waitReady = async (id: string) => {
    for (let i = 0; i < 36; i++) {
      const s = await getJson(`${G}/${id}?fields=status_code,status&access_token=${encodeURIComponent(tok)}`).catch(() => ({}));
      if ((s as any).status_code === "FINISHED") return;
      if ((s as any).status_code === "ERROR" || (s as any).status_code === "EXPIRED") throw new Error(`Instagram couldn't process the file (${(s as any).status ?? "error"})`);
      await sleep(5000);
    }
    throw new Error("Instagram took too long to process the video");
  };
  const unsupported = media.find((m) => m.kind === "photo" && !/jpe?g/i.test(m.mime ?? ""));
  if (unsupported) throw new Error("Instagram only takes JPEG photos; this post has a PNG/WebP/HEIC photo");
  let creation: string;
  const video = media.find((m) => m.kind === "video");
  if (video) {
    creation = (await fbPost(`${user}/media`, { media_type: "REELS", video_url: video.url, caption, share_to_feed: "true", access_token: tok })).id;
    await waitReady(creation);
  } else if (media.length === 1) {
    creation = (await fbPost(`${user}/media`, { image_url: media[0].url, caption, access_token: tok })).id;
    await waitReady(creation);
  } else {
    const kids: string[] = [];
    for (const m of media.slice(0, 10)) kids.push((await fbPost(`${user}/media`, { image_url: m.url, is_carousel_item: "true", access_token: tok })).id);
    for (const k of kids) await waitReady(k);
    creation = (await fbPost(`${user}/media`, { media_type: "CAROUSEL", children: kids.join(","), caption, access_token: tok })).id;
    await waitReady(creation);
  }
  return String((await fbPost(`${user}/media_publish`, { creation_id: creation, access_token: tok })).id);
}

async function youtube(c: any) {
  const media = await mediaFor(c.business_id, (c.media_ids ?? []).map(Number));
  const video = media.find((m) => m.kind === "video");
  if (!video) throw new Error("YouTube needs a video, and this post has none");
  const [rt] = await sql`select decrypted_secret as v from vault.decrypted_secrets where name = ${c.slug + ":YOUTUBE_REFRESH_TOKEN"}`;
  if (!rt) throw new Error("the YouTube connection is missing; connect YouTube again");
  const [id, sec] = await Promise.all([secret("REELS_GOOGLE_CLIENT_ID"), secret("REELS_GOOGLE_CLIENT_SECRET")]);
  const t = await getJson("https://oauth2.googleapis.com/token", { method: "POST",
    body: new URLSearchParams({ client_id: id!, client_secret: sec!, refresh_token: rt.v, grant_type: "refresh_token" }) });
  const bytes = await download(video.path);
  const first = String(c.title || c.body || "New video").split("\n")[0].replace(/[<>]/g, "").trim();
  const meta = { snippet: { title: first.slice(0, 100) || "New video", description: captionOf(c).replace(/[<>]/g, "").slice(0, 4900), categoryId: "22" },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false } };
  const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "content-type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": video.mime || "video/mp4", "X-Upload-Content-Length": String(bytes.length) }, body: JSON.stringify(meta), signal: AbortSignal.timeout(30_000) });
  const loc = start.headers.get("location");
  if (!start.ok || !loc) { const j = await start.json().catch(() => ({})); throw new Error(`YouTube: ${j.error?.message ?? start.status}`); }
  const up = await fetch(loc, { method: "PUT", headers: { "content-type": video.mime || "video/mp4" }, body: bytes, signal: AbortSignal.timeout(240_000) });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || !j.id) throw new Error(`YouTube upload failed: ${j.error?.message ?? up.status}`);
  return String(j.id);
}

/** Posts due content to Instagram and YouTube. Facebook is left to os-jobs (same schedule, same Page token). */
async function publishDue() {
  const due = await sql`select c.*, b.slug from os.content c join os.businesses b on b.id = c.business_id
    where b.status <> 'archived' and c.status in ('scheduled', 'publishing', 'published', 'needs_manual', 'failed')
      and c.scheduled_for <= now() + interval '1 minute' and c.scheduled_for > now() - interval '3 days'
      and exists (select 1 from unnest(array[case when c.channel ~* '(instagram|\\mig\\M)' then 'instagram' end,
                                             case when c.channel ~* '(youtube|\\myt\\M)' then 'youtube' end]) w(p)
        join os.integrations i on i.business_id = c.business_id and i.provider = w.p and i.status = 'connected'
        where not exists (select 1 from os.content_posts cp where cp.content_id = c.id and cp.platform = w.p))
    order by c.scheduled_for limit 6`;
  let done = 0;
  for (const c of due) {
    const ch = String(c.channel ?? "");
    const wants = [/(instagram|\big\b)/i.test(ch) ? "instagram" : null, /(youtube|\byt\b)/i.test(ch) ? "youtube" : null].filter(Boolean) as string[];
    const conns = await sql`select provider, settings from os.integrations where business_id = ${c.business_id} and status = 'connected' and provider = any(${wants})`;
    const conn = Object.fromEntries(conns.map((r: any) => [r.provider, r.settings]));
    const onlySocial = !/facebook|\bfb\b/i.test(ch);
    const targets = wants.filter((p) => conn[p]);
    if (!targets.length) continue; // nothing connected: os-jobs hands it to the owner as before
    if (onlySocial && c.status === "scheduled") {
      const [claimed] = await sql`update os.content set status = 'publishing' where id = ${c.id} and status = 'scheduled' returning id`;
      if (!claimed) continue;
    }
    const results: string[] = [], errors: string[] = [];
    for (const p of targets) {
      const [mine] = await sql`insert into os.content_posts (content_id, business_id, platform, status) values (${c.id}, ${c.business_id}, ${p}, 'posting')
        on conflict (content_id, platform) do nothing returning id`;
      if (!mine) continue;
      try {
        const extId = p === "instagram" ? await instagram(c, conn[p]) : await youtube(c);
        await sql`update os.content_posts set status = 'posted', external_id = ${extId}, posted_at = now() where content_id = ${c.id} and platform = ${p}`;
        results.push(p === "instagram" ? "Instagram" : "YouTube");
        await audit(c.business_id, "published", String(c.id), { [p]: extId });
      } catch (e) {
        const err = (e as Error).message.slice(0, 300);
        const skip = /needs a (photo|video)|only takes JPEG/.test(err);
        await sql`update os.content_posts set status = ${skip ? "skipped" : "failed"}, error = ${err} where content_id = ${c.id} and platform = ${p}`;
        errors.push(`${p === "instagram" ? "Instagram" : "YouTube"}: ${err}`);
      }
    }
    if (!results.length && !errors.length) continue;
    const title = `#${c.id}${c.title ? ` "${String(c.title).slice(0, 60)}"` : ""}`;
    if (onlySocial) {
      const missing = wants.filter((p) => !conn[p]);
      if (results.length) {
        await sql`update os.content set status = 'published', published_at = coalesce(published_at, now()),
          note = ${`Posted to ${results.join(" and ")}${errors.length ? `. Not posted: ${errors.join("; ")}` : ""}${missing.length ? `. ${missing.join(", ")} isn't connected` : ""}`} where id = ${c.id}`;
        await sql`delete from os.alerts where dedupe_key = ${"pm:" + c.id} and sent_at is null`;
      } else {
        await sql`update os.content set status = 'failed', note = ${errors.join("; ")} where id = ${c.id}`;
        await sql`select os.alert(${c.business_id}, 'business', 'publish_failed', ${"A scheduled post didn't publish"}, ${`Content ${title} couldn't be posted. ${errors.join(" ")}`}, ${"psf:" + c.id})`;
      }
    }
    if (results.length) await board(c.business_id, `Published content ${title} to ${results.join(" and ")}.${c.status === "needs_manual" ? " (It was marked for posting by hand a moment ago; that's done now, nothing to do.)" : ""}`);
    if (errors.length) await board(c.business_id, `Couldn't post content ${title}: ${errors.join("; ")}. @grayson ${/needs a (photo|video)|JPEG/.test(errors.join(" ")) ? "next time attach the right media for that platform" : "tell the owner; the connection may need redoing under Settings, Connections"}.`, true);
    done += results.length;
  }
  return done;
}

// ---------------------------------------------------------------- server
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);

  if (req.method === "GET") { // forwarded sign-in from reels-oauth
    const state = await readState(url.searchParams.get("state") ?? "");
    const app = await appUrl();
    const back = (msg: string, bid?: string) => Response.redirect(`${app}/app?social=${encodeURIComponent(msg)}${bid ? `&b=${bid}` : ""}`, 302);
    if (!state?.os || !state.b) return back("That link expired. Try connecting again.");
    if (url.searchParams.get("error")) return back(`Not connected: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`, state.b);
    const code = url.searchParams.get("code");
    if (!code) return back("Not connected.", state.b);
    try {
      return back(state.p === "youtube" ? await youtubeCallback(state.b, code) : await facebookCallback(state.b, code), state.b);
    } catch (e) {
      return back(`Not connected: ${(e as Error).message}`, state.b);
    }
  }

  const body = await req.json().catch(() => ({}));
  if (body.action === "publish") {
    const key = await secret("OS_INVOKE_KEY");
    if (!key || req.headers.get("authorization") !== `Bearer ${key}`) return json({ error: "forbidden" }, 403);
    try { return json({ published: await publishDue() }); } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  const t = req.headers.get("x-os-token")?.trim();
  const [user] = t ? await sql`select s.user_id as id from os.sessions s where s.token_hash = ${await sha256(t)} and s.expires_at > now()` : [];
  if (!user) return json({ error: "Please sign in again." }, 401);
  const bid = String(body.business_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(bid)) return json({ error: "Pick a business." }, 400);
  const [isAdmin] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
  const [m] = await sql`select role from os.business_members where user_id = ${user.id} and business_id = ${bid}`;
  const role = isAdmin ? "owner" : m?.role;
  if (!role) return json({ error: "You don't have access to that business." }, 403);
  const canEdit = role === "owner" || role === "admin";

  try {
    if (body.action === "status") return json({ ...(await socialStatus(bid)), can_edit: canEdit });
    if (!canEdit) return json({ error: "Only owners and admins can change connections." }, 403);
    if (body.action === "connect") return json({ url: await connectUrl(bid, user.id, body.platform === "youtube" ? "youtube" : "facebook") });
    if (body.action === "choose_page") {
      const [b] = await sql`select slug from os.businesses where id = ${bid}`;
      const [fb] = await sql`select settings from os.integrations where business_id = ${bid} and provider = 'facebook'`;
      const [ut] = await sql`select decrypted_secret as v from vault.decrypted_secrets where name = ${b.slug + ":FACEBOOK_USER_TOKEN"}`;
      if (!ut) return json({ error: "Sign in with Facebook again first." }, 400);
      const pages = await getJson(`${G}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(ut.v)}`);
      const p = (pages.data ?? []).find((x: any) => x.id === String(body.page_id));
      if (!p) return json({ error: "That Page isn't available any more. Connect Facebook again." }, 400);
      const all = (pages.data ?? []).map((x: any) => ({ id: x.id, name: x.name, ig_id: x.instagram_business_account?.id ?? null, ig_username: x.instagram_business_account?.username ?? null }));
      return json({ ok: true, detail: await choosePage(bid, { id: p.id, name: p.name, token: p.access_token, ig_id: p.instagram_business_account?.id ?? null,
        ig_username: p.instagram_business_account?.username ?? null }, !!fb?.settings?.ig_perm, all) });
    }
    if (body.action === "disconnect") { await disconnect(bid, String(body.platform)); return json({ ok: true }); }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
