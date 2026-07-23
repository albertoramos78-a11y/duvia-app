-- 0052_id_links_update_policy.sql
--
-- id_links (table itself predates committed migrations — created directly
-- in the dashboard, same drift pattern as noted in CLAUDE.md for some other
-- early tables/Edge Functions) only ever got INSERT + SELECT policies.
--
-- The client upserts into it on every connection (App.jsx, "carte
-- d'identité cloud" effect) with onConflict: "family_id,local_id", which
-- matches this table's actual PRIMARY KEY (family_id, local_id). The first
-- upsert per family/local_id pair is a real INSERT (allowed), but every
-- later page load for that same pair hits the ON CONFLICT DO UPDATE branch
-- — which had no RLS policy at all, so Postgres silently refused it as a
-- 403. Root-caused 2026-07-23: reproduced via pg_policies showing zero
-- UPDATE policy on id_links, confirmed against push_subscriptions' working
-- INSERT/UPDATE/DELETE-all-"own"-row pattern (0027).
--
-- Idempotent guard (CREATE POLICY has no IF NOT EXISTS).

DROP POLICY IF EXISTS "id_links_update_self" ON public.id_links;
CREATE POLICY "id_links_update_self" ON public.id_links FOR UPDATE
  USING (supabase_uid = auth.uid()) WITH CHECK (supabase_uid = auth.uid());
