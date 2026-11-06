// os-voice: Twilio's webhooks for the dialer. Every request is checked against Twilio's signature.
//   ?ev=out       a person clicks Call in the dashboard (TwiML App voice URL)
//   ?ev=whisper   played to the person being called when recording is on
//   ?ev=status    the called leg finished: price it
//   ?ev=in        someone calls a business's number: ring its people (and the forward number), then voicemail
//   ?ev=indone    the ring attempt ended: voicemail if nobody answered
//   ?ev=instatus  the incoming call finished: price it
//   ?ev=vm / rec  a voicemail or call recording is ready
//   ?ev=ai        the virtual assistant heard the caller (when nobody answered and the owner turned it on)
//   ?ev=ainone / aiend  the caller went quiet: voicemail at the start, otherwise wrap up with what we have
import { business, post, secret, sql } from "../_core/core.ts";
import { canCall, e164, parseIdentity, priceCall, recordForPhone, twilioCreds, twilioSigOk } from "../_core/twilio.ts";
import { assistantOk, assistantTurn, finishAssistantCall, greeting, MAX_TURNS } from "../_core/receptionist.ts";

const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "content-type": "text/xml" } });
const x = (s: unknown) => String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
const say = (t: string) => `<Say voice="Polly.Joanna">${x(t)}</Say>`;
// Listen for the caller's answer; if they say nothing, Twilio moves on to the Redirect after it.
const listen = (prompt: string, action: string, quiet: string) =>
  `<Gather input="speech" speechTimeout="auto" speechModel="phone_call" language="en-US" timeout="6" action="${action}" method="POST">${say(prompt)}</Gather><Redirect method="POST">${quiet}</Redirect>`;

function localHour(tz: string) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

Deno.serve(async (req) => {
  const c = await twilioCreds();
  if (!c) return new Response("calling isn't set up", { status: 503 });
  const base = (await secret("OS_FUNCTIONS_URL"))!;
  const u = new URL(req.url);
  const publicUrl = `${base}/os-voice${u.search}`;
  const params: Record<string, string> = {};
  if (req.method === "POST") for (const [k, v] of new URLSearchParams(await req.text())) params[k] = v;
  if (!(await twilioSigOk(c.AUTH_TOKEN, publicUrl, params, req.headers.get("x-twilio-signature")))) return new Response("forbidden", { status: 403 });
  const ev = u.searchParams.get("ev");
  const cid = Number(u.searchParams.get("cid") ?? 0);
  const hook = (q: string) => x(`${base}/os-voice?${q}`);
  const voicemail = (name: string, callId: number, lead: string) => say(`Thanks for calling ${name}. ${lead} Please leave a message after the tone.`)
    + `<Record maxLength="120" playBeep="true" recordingStatusCallback="${hook(`ev=vm&cid=${callId}`)}" action="${hook("ev=vmdone")}"/>`;

  try {
    if (ev === "out") {
      const who = parseIdentity(params.From ?? params.Caller ?? "");
      const bid = params.bid;
      if (!who || who.bid !== bid || !(await canCall(who.uid, bid))) return xml(say("You don't have permission to call for this business.") + "<Hangup/>");
      const [b] = await sql`select b.*, i.settings as phone from os.businesses b left join os.integrations i on i.business_id = b.id and i.provider = 'phone' and i.status = 'connected' where b.id = ${bid}`;
      if (!b?.phone?.number) return xml(say("This business doesn't have a phone number yet.") + "<Hangup/>");
      if (b.status === "archived" || b.billing_status === "past_due") return xml(say("Calling is on hold for this business.") + "<Hangup/>");
      const to = e164(params.To);
      if (!to) return xml(say("That phone number doesn't look right.") + "<Hangup/>");
      const [blocked] = await sql`select 1 from os.never_call where business_id = ${bid} and phone = ${to}`;
      if (blocked) return xml(say("That number is on the do not call list.") + "<Hangup/>");
      const h = localHour(b.timezone);
      if (h < 8 || h >= 21) return xml(say("It's outside calling hours, eight A M to nine P M.") + "<Hangup/>");
      const record = b.phone.record === "true";
      const rid = Number(params.rid) || (await recordForPhone(bid, to))?.id || null;
      const [call] = await sql`insert into os.calls (business_id, direction, to_number, from_number, record_id, queue_id, user_id, twilio_sid, recorded)
        values (${bid}, 'outbound', ${to}, ${b.phone.number}, ${rid}, ${Number(params.qid) || null}, ${who.uid}, ${params.CallSid}, ${record}) returning id`;
      return xml(`<Dial callerId="${x(b.phone.number)}" answerOnBridge="true" timeLimit="7200" action="${hook(`ev=dialdone&cid=${call.id}`)}"${record ? ` record="record-from-answer" recordingStatusCallback="${hook(`ev=rec&cid=${call.id}`)}"` : ""}>`
        + `<Number statusCallback="${hook(`ev=status&cid=${call.id}`)}" statusCallbackEvent="completed"${record ? ` url="${hook("ev=whisper")}"` : ""}>${x(to)}</Number></Dial>`);
    }
    if (ev === "whisper") return xml(say("This call may be recorded."));
    if (ev === "status" && cid) {
      await sql`update os.calls set status = ${params.CallStatus ?? "completed"}, ended_at = now() where id = ${cid}`;
      await priceCall(cid, Number(params.CallDuration ?? 0));
      return xml("");
    }
    if (ev === "dialdone") return xml("<Hangup/>");

    if (ev === "in") {
      const bid = u.searchParams.get("bid")!;
      const [b] = await sql`select b.id, b.name, b.status, i.settings as phone from os.businesses b join os.integrations i on i.business_id = b.id and i.provider = 'phone' and i.status = 'connected' where b.id = ${bid}`;
      if (!b) return xml(say("This number is not in service.") + "<Hangup/>");
      const from = e164(params.From) ?? params.From ?? "unknown";
      const rec = await recordForPhone(bid, from);
      const [call] = await sql`insert into os.calls (business_id, direction, to_number, from_number, record_id, twilio_sid)
        values (${bid}, 'inbound', ${b.phone.number}, ${from}, ${rec?.id ?? null}, ${params.CallSid}) on conflict (twilio_sid) do update set status = 'ringing' returning id`;
      const people = await sql`select m.user_id from os.business_members m where m.business_id = ${bid} and m.role in ('owner','admin','operator','caller')
        union select a.user_id from os.platform_admins a limit 9`;
      const fwd = e164(b.phone.forward_to);
      const targets = people.map((p: any) => `<Client>u${String(p.user_id).replace(/-/g, "")}b${bid.replace(/-/g, "")}</Client>`).join("") + (fwd ? `<Number>${x(fwd)}</Number>` : "");
      return xml(`<Dial timeout="20" answerOnBridge="true" action="${hook(`ev=indone&cid=${call.id}`)}">${targets}</Dial>`);
    }
    if (ev === "indone" && cid) {
      if (params.DialCallStatus === "completed") return xml("<Hangup/>");
      const [b] = await sql`select b.*, i.settings as phone from os.calls c join os.businesses b on b.id = c.business_id
        left join os.integrations i on i.business_id = b.id and i.provider = 'phone' and i.status = 'connected' where c.id = ${cid}`;
      // Nobody picked up: the virtual assistant answers if the owner turned it on; otherwise voicemail.
      if (b && await assistantOk(b).catch(() => false)) {
        const hello = greeting(b.name);
        await sql`update os.calls set ai_answered = true, ai_transcript = ${sql.json([{ role: "assistant", content: hello }])} where id = ${cid}`;
        return xml(listen(hello, hook(`ev=ai&cid=${cid}`), hook(`ev=ainone&cid=${cid}`)));
      }
      return xml(voicemail(b?.name ?? "us", cid, "Sorry we missed you."));
    }
    if (ev === "ainone" && cid) {
      await sql`update os.calls set ai_done = true where id = ${cid}`; // nothing said yet: the voicemail handles it
      const [b] = await sql`select b.name from os.calls c join os.businesses b on b.id = c.business_id where c.id = ${cid}`;
      return xml(voicemail(b?.name ?? "us", cid, "Sorry, I didn't catch that."));
    }
    if (ev === "aiend" && cid) {
      await finishAssistantCall(cid);
      return xml(say("I'll pass along what you told me, and someone will call you back as soon as they can. Goodbye.") + "<Hangup/>");
    }
    if (ev === "ai" && cid) {
      const [c] = await sql`select * from os.calls where id = ${cid} and ai_answered and not ai_done`;
      if (!c) return xml("<Hangup/>");
      const heard = String(params.SpeechResult ?? "").trim().slice(0, 1000);
      const t = [...(c.ai_transcript ?? [])];
      if (!heard) return xml(listen("Sorry, I didn't catch that. Could you say that again?", hook(`ev=ai&cid=${cid}`), hook(`ev=aiend&cid=${cid}`)));
      t.push({ role: "user", content: heard });
      const turns = t.filter((m: any) => m.role === "user").length;
      const b = await business(c.business_id);
      let reply;
      try { reply = await assistantTurn(b!, c.from_number, t, turns >= MAX_TURNS); }
      catch (e) {
        console.error("assistant", (e as Error).message);
        await sql`update os.calls set ai_transcript = ${sql.json(t)} where id = ${cid}`;
        await finishAssistantCall(cid);
        return xml(say("Sorry, I'm having trouble right now. I've passed along your message, and someone will call you back. Goodbye.") + "<Hangup/>");
      }
      t.push({ role: "assistant", content: reply.say });
      await sql`update os.calls set ai_transcript = ${sql.json(t)}, ai_lead = ${sql.json({ ...(c.ai_lead ?? {}), ...Object.fromEntries(Object.entries(reply.lead).filter(([, v]) => v)) })} where id = ${cid}`;
      if (reply.done) { await finishAssistantCall(cid); return xml(say(reply.say) + "<Hangup/>"); }
      return xml(listen(reply.say, hook(`ev=ai&cid=${cid}`), hook(`ev=aiend&cid=${cid}`)));
    }
    if (ev === "vmdone") return xml(say("Thank you. Goodbye.") + "<Hangup/>");
    if (ev === "instatus") {
      const [call] = await sql`update os.calls set status = ${params.CallStatus ?? "completed"}, ended_at = now() where twilio_sid = ${params.CallSid} returning id, ai_answered, ai_done`;
      if (call) await priceCall(call.id, Number(params.CallDuration ?? 0));
      // The caller hung up while talking to the assistant: still hand over what they said.
      if (call?.ai_answered && !call.ai_done) await finishAssistantCall(call.id);
      return xml("");
    }
    if (ev === "vm" && cid) {
      const [call] = await sql`update os.calls set voicemail = true, recording_sid = ${params.RecordingSid ?? null} where id = ${cid}
        returning business_id, from_number, record_id`;
      if (call && Number(params.RecordingDuration ?? 0) > 1) {
        const [r] = call.record_id ? await sql`select title from os.records where id = ${call.record_id}` : [];
        const who = r ? `#${call.record_id} ${r.title} (${call.from_number})` : call.from_number;
        await post(call.business_id, "system", `New voicemail from ${who}. Listen to it under Calls. @demarcus make sure someone calls them back.`);
        await sql`select os.alert(${call.business_id}, 'business', 'voicemail', ${"New voicemail from " + (r?.title ?? call.from_number)}, ${`Someone left a voicemail on your business line from ${who}. Open Calls in your dashboard to listen.`}, ${"vm:" + cid})`;
      }
      return xml("");
    }
    if (ev === "rec" && cid) {
      await sql`update os.calls set recording_sid = ${params.RecordingSid ?? null} where id = ${cid}`;
      return xml("");
    }
  } catch (e) {
    console.error("os-voice", ev, (e as Error).message);
    return xml(say("Sorry, something went wrong. Please try again.") + "<Hangup/>");
  }
  return xml("");
});
