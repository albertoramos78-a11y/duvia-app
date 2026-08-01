-- ─────────────────────────────────────────────────────────────────────────────
-- app_config.beta_enabled/beta_end are non-sensitive, global, read-only feature
-- flags (no user data) — but the existing policy only allows `authenticated`
-- reads, so isBeta() silently stays false anywhere it's checked before login
-- (registration screen, RGPD gate). Adds anon SELECT so those pre-auth checks
-- work too. Idempotent (drop+recreate).
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "app_config_select_anon" on public.app_config;
create policy "app_config_select_anon" on public.app_config
  for select to anon using (true);
