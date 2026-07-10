-- 0029_parent_email_verification.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Vérification email obligatoire pour les parents (créateur de famille ou 2e
-- parent rejoignant) — voir
-- docs/superpowers/specs/2026-07-10-parent-email-verification-design.md.
--
-- Ne s'appuie PAS sur le champ natif Supabase auth.users.email_confirmed_at :
-- avec le réglage global "Confirm email" désactivé (nécessaire pour ne pas
-- casser les comptes enfants/observateurs par téléphone, adresse synthétique
-- @phone.duvia.app sans vraie boîte mail derrière), ce champ est rempli
-- automatiquement dès l'inscription, avant tout envoi de lien — confirmé par
-- un test réel en production le 2026-07-10. D'où ce mécanisme maison,
-- indépendant : une table de jetons + une RPC de validation, sur le modèle de
-- family_invitations/peek_invitation (0015/0016).
--
-- La table n'est JAMAIS lue/écrite directement par le client (RLS activé,
-- aucune policy) — uniquement via la clé de service (Edge Function
-- send-parent-verification-email, qui génère le jeton et l'insère) et via la
-- RPC ci-dessous (SECURITY DEFINER, qui le valide).
--
-- À exécuter APRÈS 0028. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.parent_email_verifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  token       TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS parent_email_verifications_token_idx ON public.parent_email_verifications(token);
CREATE INDEX IF NOT EXISTS parent_email_verifications_user_id_idx ON public.parent_email_verifications(user_id);

ALTER TABLE public.parent_email_verifications ENABLE ROW LEVEL SECURITY;
-- Aucune policy : ni SELECT ni INSERT ni UPDATE côté client (anon/authenticated).
-- Tout accès passe par la clé de service (Edge Function) ou une fonction
-- SECURITY DEFINER (la RPC ci-dessous) — jamais de lecture/écriture directe.

-- ── Validation du jeton reçu par email ────────────────────────────────────────
-- Ne vérifie PAS que auth.uid() correspond au user_id de la ligne : le jeton
-- lui-même est la preuve de possession de la boîte mail (reçu uniquement par
-- email), pas la session du navigateur qui clique — le lien doit fonctionner
-- même cliqué depuis un autre appareil/navigateur que celui où le compte a
-- été créé (cas explicitement prévu par le design : bouton "J'ai vérifié,
-- actualiser" sur l'appareil d'origine si le clic a eu lieu ailleurs).
CREATE OR REPLACE FUNCTION public.verify_parent_email(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT pev.user_id
    INTO v_user_id
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

  UPDATE auth.users
    SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('email_verified', true)
    WHERE id = v_user_id;

  RETURN TRUE;
END;
$$;

-- Accessible sans authentification (le lien peut être cliqué sur un appareil
-- où l'utilisateur n'a pas de session active) — la sécurité repose sur le
-- secret du jeton, pas sur l'identité de l'appelant. Même pattern que
-- peek_invitation (0016).
REVOKE ALL     ON FUNCTION public.verify_parent_email(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.verify_parent_email(TEXT) TO anon, authenticated;
