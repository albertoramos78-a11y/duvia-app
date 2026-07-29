-- supabase/migrations/0058_ai_faq_cache.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Cache de réponses FAQ pour ai-chatbot (voir docs/superpowers/specs/
-- 2026-07-29-ai-faq-cache-design.md) : évite de rappeler l'API Anthropic pour
-- une question dont le texte est très proche d'une question FAQ déjà répondue
-- (ex. "comment inviter l'autre parent ?" vs "comment j'invite l'autre
-- parent"). Correspondance textuelle (pg_trgm, natif Postgres, gratuit) plutôt
-- que sémantique (embeddings) — décision explicite pour ne pas ajouter de
-- nouvelle dépendance externe facturée ; rate donc les vraies paraphrases sans
-- vocabulaire commun (repli normal sur un appel Claude classique dans ce cas).
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_trgm;

create table public.ai_faq_cache (
  id uuid primary key default gen_random_uuid(),
  question_text text not null,
  answer_text text not null,
  faq_fingerprint text not null,
  lang text,
  hit_count int not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index ai_faq_cache_trgm_idx on public.ai_faq_cache using gin (question_text gin_trgm_ops);

-- 🔒 Pas de policy RLS client : seule l'Edge Function ai-chatbot (client
-- service_role) lit/écrit cette table, même modèle que ai_usage_log (voir
-- 0044_ai_features_foundation.sql).
alter table public.ai_faq_cache enable row level security;

-- Lit une réponse en cache dont question_text est très proche de p_question
-- (similarité de trigrammes > p_threshold) ET dont faq_fingerprint correspond
-- au fingerprint actuel de FAQ_KNOWLEDGE (p_fingerprint) — une entrée écrite
-- sous un ancien contenu de FAQ_KNOWLEDGE a un fingerprint différent et n'est
-- donc jamais retournée ici, sans purge explicite nécessaire. Incrémente
-- hit_count/last_used_at sur un hit avant de renvoyer la ligne.
create or replace function public.match_and_touch_faq_cache(
  p_question text,
  p_fingerprint text,
  p_threshold float default 0.7
)
returns table (id uuid, answer_text text)
language plpgsql
as $$
declare
  v_id uuid;
  v_answer text;
begin
  select c.id, c.answer_text into v_id, v_answer
    from public.ai_faq_cache c
   where c.faq_fingerprint = p_fingerprint
     and similarity(c.question_text, p_question) > p_threshold
   order by similarity(c.question_text, p_question) desc
   limit 1;

  if v_id is not null then
    update public.ai_faq_cache set hit_count = hit_count + 1, last_used_at = now()
     where public.ai_faq_cache.id = v_id;
    return query select v_id, v_answer;
  end if;

  return;
end;
$$;

revoke all     on function public.match_and_touch_faq_cache(text, text, float) from public;
grant  execute on function public.match_and_touch_faq_cache(text, text, float) to service_role;
