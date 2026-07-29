-- 0060_ai_faq_cache_function_grants.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Fix pour match_and_touch_faq_cache (0058/0059) : `revoke all ... from public`
-- ne retire PAS les droits EXECUTE que Supabase accorde par défaut à anon et
-- authenticated (accordés nommément, pas via PUBLIC — ALTER DEFAULT PRIVILEGES
-- au niveau du projet). Sans ce correctif, la fonction reste techniquement
-- appelable via l'API REST (POST /rest/v1/rpc/match_and_touch_faq_cache) par
-- n'importe quel détenteur de la clé anon (publique dans le bundle JS) — sans
-- risque concret aujourd'hui (fonction non security definer + RLS sans policy
-- client sur ai_faq_cache = 0 ligne renvoyée), mais à corriger pour matcher le
-- pattern déjà établi ailleurs dans ce repo (voir 0043_check_and_log_invite_
-- email.sql et 0049_wheel_spins_security.sql, qui font tous deux ce revoke
-- explicite sur anon/authenticated en plus de public).
-- ─────────────────────────────────────────────────────────────────────────────

revoke all     on function public.match_and_touch_faq_cache(text, text, float) from public, anon, authenticated;
grant  execute on function public.match_and_touch_faq_cache(text, text, float) to service_role;
