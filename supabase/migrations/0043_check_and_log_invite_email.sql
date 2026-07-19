-- 0043_check_and_log_invite_email.sql
--
-- Corrige une faille de course (TOCTOU) trouvée en revue sur send-invite-email
-- (Task 2 de docs/superpowers/plans/2026-07-19-real-invite-email-sending.md) :
-- la Edge Function faisait 2 SELECT count(*) séparés PUIS un INSERT, sans
-- transaction ni verrou — une rafale de requêtes concurrentes du même
-- expéditeur passait toutes le contrôle avant qu'aucun INSERT n'ait eu lieu,
-- dépassant largement les plafonds anti-abus (10/jour, 3/destinataire/semaine).
--
-- Cette RPC SECURITY DEFINER fait le comptage ET l'insertion dans UNE SEULE
-- transaction, sérialisée par un verrou consultatif (pg_advisory_xact_lock)
-- posé sur l'expéditeur — ferme la course pour le scénario réaliste (un seul
-- compte/script en rafale). Le scénario plus marginal de plusieurs comptes
-- DIFFÉRENTS ciblant EXACTEMENT le même destinataire en rafale synchronisée
-- n'est pas verrouillé (nécessiterait un 2e verrou par destinataire, avec un
-- vrai risque de deadlock à gérer) — accepté comme risque résiduel mineur,
-- beaucoup plus dur à exploiter qu'un simple script mono-compte.
--
-- p_sender_user_id est passé explicitement (pas auth.uid()) : cette RPC est
-- appelée par la Edge Function via son client service-role, qui ne porte pas
-- le JWT de l'appelant d'origine — send-invite-email a déjà vérifié ce JWT
-- lui-même avant d'appeler cette fonction.
--
-- Dépend de : 0042_invite_email_log.sql (table + colonnes).

create or replace function public.check_and_log_invite_email(
  p_sender_user_id uuid,
  p_recipient_email text,
  p_invite_type text
) returns table(status text, log_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_daily_count int;
  v_recipient_count int;
  v_new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_sender_user_id::text));

  select count(*) into v_daily_count
  from invite_email_log
  where sender_user_id = p_sender_user_id and sent_at >= now() - interval '24 hours';

  if v_daily_count >= 10 then
    return query select 'daily_limit_reached'::text, null::uuid;
    return;
  end if;

  select count(*) into v_recipient_count
  from invite_email_log
  where recipient_email = p_recipient_email and sent_at >= now() - interval '7 days';

  if v_recipient_count >= 3 then
    return query select 'recipient_limit_reached'::text, null::uuid;
    return;
  end if;

  insert into invite_email_log (sender_user_id, recipient_email, invite_type)
  values (p_sender_user_id, p_recipient_email, p_invite_type)
  returning id into v_new_id;

  return query select 'ok'::text, v_new_id;
end;
$$;

revoke all on function public.check_and_log_invite_email(uuid, text, text) from public, anon, authenticated;
grant execute on function public.check_and_log_invite_email(uuid, text, text) to service_role;
