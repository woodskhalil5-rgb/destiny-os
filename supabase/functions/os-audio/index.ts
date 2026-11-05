// os-audio: makes voiceovers and background music with ElevenLabs, for videos and reels.
// The ElevenLabs key stays in the Edge Function secrets (ELEVENLABS_API_KEY); callers never see it.
// Callers prove themselves with a short-lived token whose hash is in os.tool_tokens (purpose 'audio').
import { sql } from "../_core/core.ts";

const XI = "https://api.elevenlabs.io/v1";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!tok) return json({ error: "forbidden" }, 403);
  const [ok] = await sql`select 1 from os.tool_tokens where token_hash = ${await sha256(tok)} and purpose = 'audio' and expires_at > now()`;
  if (!ok) return json({ error: "forbidden" }, 403);

  const key = Deno.env.get("ELEVENLABS_API_KEY")?.trim();
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  if (action === "status") return json({ elevenlabs_key: !!key });
  if (!key) return json({ error: "ELEVENLABS_API_KEY isn't set in the Edge Function secrets." }, 400);
  const H = { "xi-api-key": key, "content-type": "application/json" };

  if (action === "voices") {
    const r = await fetch(`${XI}/voices`, { headers: H });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.detail?.message ?? j.detail ?? r.status }, 502);
    return json({ voices: (j.voices ?? []).map((v: any) => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels, description: v.description })) });
  }

  if (action === "tts" || action === "music") {
    const url = action === "tts"
      ? `${XI}/text-to-speech/${encodeURIComponent(String(body.voice_id))}?output_format=mp3_44100_128`
      : `${XI}/music?output_format=mp3_44100_128`;
    const payload = action === "tts"
      ? { text: String(body.text ?? "").slice(0, 2500), model_id: body.model_id ?? "eleven_multilingual_v2",
          voice_settings: body.voice_settings ?? { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }
      : { prompt: String(body.prompt ?? "").slice(0, 2000), music_length_ms: Math.max(3000, Math.min(180000, Number(body.length_ms) || 60000)),
          force_instrumental: true, model_id: body.model_id ?? "music_v1" };
    const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(payload), signal: AbortSignal.timeout(140_000) });
    if (!r.ok) { const t = await r.text(); return json({ error: `ElevenLabs ${r.status}: ${t.slice(0, 400)}` }, 502); }
    return new Response(await r.arrayBuffer(), { headers: { "content-type": "audio/mpeg" } });
  }

  return json({ error: "Unknown action." }, 400);
});
