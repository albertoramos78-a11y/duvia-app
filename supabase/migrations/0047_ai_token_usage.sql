-- 0047_ai_token_usage.sql
--
-- Ajoute le suivi du nombre de tokens Anthropic consommés par ai_usage_log,
-- pour un vrai plafond quotidien en tokens (40 000/jour) sur le chatbot IA,
-- affiché comme une barre de progression côté client — voir
-- supabase/functions/ai-chatbot/index.ts.
--
-- Les lignes déjà existantes (posées avant ce suivi) prennent 0 par défaut :
-- sous-estime légèrement l'usage du jour même où cette migration est passée
-- pour les comptes déjà actifs ce jour-là, sans conséquence au-delà (une
-- seule journée de transition).
alter table public.ai_usage_log add column if not exists input_tokens int not null default 0;
alter table public.ai_usage_log add column if not exists output_tokens int not null default 0;

-- Permet au client de lire SA PROPRE consommation de tokens du jour (pour
-- afficher la barre de progression avant même d'avoir posé une question) —
-- seule policy SELECT sur cette table, strictement scopée à auth.uid().
-- Cohérent avec le raisonnement déjà documenté dans 0044 (fonctionnalité
-- réservée aux comptes activés par l'admin, risque d'abus faible) : lire son
-- propre historique d'usage n'expose rien de sensible.
drop policy if exists "ai_usage_log_select_own" on public.ai_usage_log;
create policy "ai_usage_log_select_own" on public.ai_usage_log for select
  using (user_id = auth.uid());
