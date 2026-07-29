-- 0059_ai_faq_cache_trgm_index_fix.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Fix pour match_and_touch_faq_cache (0058_ai_faq_cache.sql) : le WHERE clause
-- original filtrait avec `similarity(c.question_text, p_question) > p_threshold`
-- — un appel de fonction, que le GIN trgm (ai_faq_cache_trgm_idx) ne peut PAS
-- accélérer. Seul l'opérateur `%` (et `<->` côté GiST) est indexable par
-- gin_trgm_ops. Résultat : chaque appel faisait un sequential scan complet de
-- la table, l'index restant inutilisé. Sans conséquence tant que la table est
-- petite, mais faux tel qu'écrit.
--
-- Remplace le corps de la fonction pour utiliser `c.question_text % p_question`
-- (indexable), avec le seuil de similarité fixé via `set_config
-- ('pg_trgm.similarity_threshold', p_threshold::text, true)` juste avant la
-- requête — le `true` en 3e argument scope ce réglage à la transaction en
-- cours uniquement, aucun effet de bord global sur d'autres sessions. Le `order
-- by similarity(...) desc limit 1` reste un appel de fonction ordinaire : il
-- n'a pas besoin d'être indexé puisqu'il ne fait que classer les candidats déjà
-- filtrés par `%`.
--
-- Signature et type de retour inchangés → simple CREATE OR REPLACE, pas besoin
-- du DROP+CREATE protégé par transaction utilisé par 0057 (qui, lui, changeait
-- la liste de colonnes d'un `returns table`). Aucun changement de schéma/table.
-- ─────────────────────────────────────────────────────────────────────────────

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
  perform set_config('pg_trgm.similarity_threshold', p_threshold::text, true);

  select c.id, c.answer_text into v_id, v_answer
    from public.ai_faq_cache c
   where c.faq_fingerprint = p_fingerprint
     and c.question_text % p_question
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
