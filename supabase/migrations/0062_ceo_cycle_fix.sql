-- 0062: os.ceo_cycle failed at its first real run (Nov 11, 8am) with "column reference body is ambiguous": the
-- PL/pgSQL variable had the same name as os.messages.body. Variable renamed to txt and the table aliased. The morning
-- CEO check-in was missed that day; evening and later runs are fine.
CREATE OR REPLACE FUNCTION os.ceo_cycle(force text DEFAULT NULL::text)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'os'
AS $function$
declare c record; lt timestamp; kind text; txt text; n int := 0;
begin
  for c in select o.business_id, o.name, b.timezone from os.ceos o join os.businesses b on b.id = o.business_id where b.status <> 'archived' loop
    lt := now() at time zone c.timezone;
    kind := coalesce(force,
      case when extract(day from lt) = 1 and extract(hour from lt) = 9 then 'monthly'
           when extract(isodow from lt) <= 5 and extract(hour from lt) = 8 then 'morning'
           when extract(isodow from lt) <= 5 and extract(hour from lt) = 17 then 'evening' end);
    continue when kind is null;
    continue when force is null and exists (select 1 from os.messages m where m.business_id = c.business_id and m.sender_name = 'HQ schedule'
      and m.body like '@ceo ' || initcap(kind) || '%' and m.created_at > now() - interval '20 hours');
    txt := '@ceo ' || initcap(kind) || ' check-in. ' || os.ceo_numbers(c.business_id) || ' '
      || case kind
        when 'morning' then 'Decide today''s 1 to 3 priorities, give @demarcus his instructions, and tell Khalil in 5 lines or fewer: what''s working, what''s not, what you decided, and anything only he can decide.'
        when 'evening' then 'Check what got done today against this morning''s priorities and tell Khalil in 5 lines or fewer: done, not done and why, money today, and tomorrow''s plan.'
        else 'Close last month: income, costs, profit and the tax set-aside (30% of profit as an estimate). Save it to the tax log with save_note (subject "Tax log ' || to_char(lt - interval '1 month', 'YYYY-MM') || '") and give Khalil the summary plus your top 3 moves for this month.'
      end;
    insert into os.messages (business_id, sender, sender_name, body, status) values (c.business_id, 'owner', 'HQ schedule', txt, 'queued');
    n := n + 1;
  end loop;
  return n;
end $function$;
