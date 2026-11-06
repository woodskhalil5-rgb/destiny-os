-- AI phone assistant: when nobody picks up a business's line, an assistant answers (if the owner turned it on),
-- takes down who's calling and what they need, and hands it to the owner as an inquiry. It never quotes prices or
-- books times. Each call keeps its transcript so the owner can read exactly what was said.
alter table os.calls add column if not exists ai_answered boolean not null default false;
alter table os.calls add column if not exists ai_done boolean not null default false;
alter table os.calls add column if not exists ai_transcript jsonb;
alter table os.calls add column if not exists ai_lead jsonb;
