-- 0031_known_devices.sql
--
-- Tracks which devices (browsers) have logged into each account, so a
-- "new device" security email can be sent the first time a genuinely new
-- device_id shows up for a given user. device_id is a client-generated
-- UUID persisted in localStorage (src/App.jsx, key duvia_device_id) — this
-- table is the server-side record of which ones have been seen before.
--
-- Depends on: none (standalone new table).

CREATE TABLE IF NOT EXISTS public.known_devices (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id   TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS known_devices_user_id_idx ON public.known_devices(user_id);

ALTER TABLE public.known_devices ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all to anon/authenticated by default. Only reachable
-- via the SECURITY DEFINER RPC below (same pattern as
-- parent_email_verifications, migration 0029).

CREATE OR REPLACE FUNCTION public.record_device_login(p_device_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_existing UUID;
BEGIN
  SELECT id INTO v_existing FROM public.known_devices
  WHERE user_id = auth.uid() AND device_id = p_device_id;

  IF v_existing IS NOT NULL THEN
    UPDATE public.known_devices SET last_seen = NOW() WHERE id = v_existing;
    RETURN FALSE;
  END IF;

  INSERT INTO public.known_devices (user_id, device_id) VALUES (auth.uid(), p_device_id);
  RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_device_login(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_device_login(TEXT) TO authenticated;
