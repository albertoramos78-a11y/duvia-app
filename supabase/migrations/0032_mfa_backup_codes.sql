-- 0032_mfa_backup_codes.sql
--
-- Backup codes for optional TOTP-based 2FA (Supabase Auth's native
-- auth.mfa.* handles enrollment/challenge/verify/unenroll itself — this
-- table only covers what Supabase does NOT provide natively: recovery
-- when the user's authenticator device is lost. A valid unused code
-- disables ALL of the user's MFA factors (simpler and safer than trying
-- to elevate the session to aal2 via a non-Supabase-native path — see
-- docs/superpowers/specs/2026-07-11-optional-2fa-design.md).
--
-- Depends on: pgcrypto extension (for crypt()/gen_salt(), same hashing
-- primitive used for password hashing) — enable if not already present.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.mfa_backup_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mfa_backup_codes_user_id_idx ON public.mfa_backup_codes(user_id);

ALTER TABLE public.mfa_backup_codes ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all to anon/authenticated by default. Only reachable
-- via the SECURITY DEFINER RPCs below (same pattern as
-- parent_email_verifications, migration 0029).

CREATE OR REPLACE FUNCTION public.generate_mfa_backup_codes()
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_codes TEXT[] := ARRAY[]::TEXT[];
  v_code TEXT;
  i INT;
BEGIN
  -- On repart de zéro : les anciens codes non utilisés deviennent invalides.
  DELETE FROM public.mfa_backup_codes WHERE user_id = auth.uid() AND used_at IS NULL;

  FOR i IN 1..10 LOOP
    v_code := encode(gen_random_bytes(5), 'hex');
    v_codes := array_append(v_codes, v_code);
    INSERT INTO public.mfa_backup_codes (user_id, code_hash)
    VALUES (auth.uid(), crypt(v_code, gen_salt('bf')));
  END LOOP;

  RETURN v_codes;
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_mfa_backup_code(p_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT id, code_hash FROM public.mfa_backup_codes
    WHERE user_id = auth.uid() AND used_at IS NULL
  LOOP
    IF crypt(p_code, v_row.code_hash) = v_row.code_hash THEN
      UPDATE public.mfa_backup_codes SET used_at = NOW() WHERE id = v_row.id;
      DELETE FROM auth.mfa_factors WHERE user_id = auth.uid();
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_mfa_backup_codes()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  DELETE FROM public.mfa_backup_codes WHERE user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.generate_mfa_backup_codes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_mfa_backup_code(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_mfa_backup_codes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_mfa_backup_codes() TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_mfa_backup_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_mfa_backup_codes() TO authenticated;
