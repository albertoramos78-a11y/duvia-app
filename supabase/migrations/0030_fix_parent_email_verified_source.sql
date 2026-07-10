-- 0030_fix_parent_email_verified_source.sql
--
-- Corrige la vérification email parent (migration 0029) : `email_verified`
-- dans user_metadata n'est PAS une clé custom à nous — Supabase la peuple
-- automatiquement à true pour toute inscription auto-confirmée (comme
-- email_confirmed_at, voir le design doc "Révision"). Preuve en prod : un
-- compte tout juste créé avait déjà email_verified=true en métadonnées
-- alors que sa ligne parent_email_verifications avait verified_at NULL
-- (jeton jamais cliqué).
--
-- Nouvelle source de vérité : la table parent_email_verifications
-- elle-même, via auth.uid() (non falsifiable côté client, pas de paramètre
-- à faire confiance).
--
-- Dépend de : 0029_parent_email_verification.sql

-- verify_parent_email : on retire l'UPDATE auth.users qui écrivait dans un
-- champ qu'on ne lit plus (et qui n'a jamais été la vraie preuve de toute
-- façon).
CREATE OR REPLACE FUNCTION public.verify_parent_email(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT pev.user_id INTO v_user_id
  FROM public.parent_email_verifications pev
  WHERE pev.token = p_token
    AND pev.verified_at IS NULL
    AND pev.expires_at > NOW()
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE public.parent_email_verifications
  SET verified_at = NOW()
  WHERE token = p_token;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_parent_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_parent_email(TEXT) TO anon, authenticated;

-- Nouvelle fonction : est-ce que LE compte actuellement connecté (auth.uid())
-- a déjà un jeton vérifié ? Aucun paramètre → aucune valeur à falsifier.
CREATE OR REPLACE FUNCTION public.is_parent_email_verified()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.parent_email_verifications
    WHERE user_id = auth.uid() AND verified_at IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.is_parent_email_verified() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_parent_email_verified() TO authenticated;
