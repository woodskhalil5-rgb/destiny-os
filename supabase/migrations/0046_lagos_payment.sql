-- DMG Nigeria: how Lagos roofers pay. The owner decided (Nov 9): local bank transfer in naira to the account the rep
-- (Egbeola) gives them; the rep sends the owner his share. Nora logs every payment so the owner can see what he's owed.
update os.business_config set active = false where business_id = (select id from os.businesses where slug = 'dmg-nigeria');
insert into os.business_config (business_id, version, config, note, created_by, active)
select c.business_id, c.version + 1,
  jsonb_set(c.config, '{facts}', to_jsonb(replace(c.config->>'facts',
    'How DMG Nigeria takes payment (bank transfer or a payment link) is set by the owner; the rep never collects money himself.',
    'How roofers pay: local bank transfer in naira, to the account details the DMG Nigeria rep (Egbeola) gives them on the call or on WhatsApp. Never write bank details into emails or posts yourself. Every payment a roofer makes must be logged (Nora: log it as an invoice marked paid, with the roofer, amount in naira and date), so the owner can see what DMG Nigeria has collected and what share he is owed.'))),
  'Lagos payment: local bank transfer via the rep (migration 0046)', 'migration', true
from os.business_config c join os.businesses b on b.id = c.business_id
where b.slug = 'dmg-nigeria'
  and c.version = (select max(version) from os.business_config x where x.business_id = c.business_id);
