import { createClient } from "@supabase/supabase-js";

// Les clés sont lues depuis les variables d'environnement Vercel (VITE_*)
// Jamais hardcodées dans le code source.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("⚠️ Variables VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquantes.");
}

// Stockage de session « intelligent » :
// - « Rester connecté » coché (duvia_remember=1) → token en localStorage
//   (persiste après fermeture de l'onglet).
// - sinon → sessionStorage (effacé à la fermeture de l'onglet) — sûr sur un
//   appareil partagé entre co-parents.
const REMEMBER_KEY = "duvia_remember";
const smartStorage = (typeof window === "undefined") ? undefined : {
  getItem(k) {
    try { return window.localStorage.getItem(k) ?? window.sessionStorage.getItem(k); } catch { return null; }
  },
  setItem(k, v) {
    try {
      const remember = window.localStorage.getItem(REMEMBER_KEY) === "1";
      if (remember) { window.localStorage.setItem(k, v); window.sessionStorage.removeItem(k); }
      else { window.sessionStorage.setItem(k, v); window.localStorage.removeItem(k); }
    } catch {}
  },
  removeItem(k) {
    try { window.localStorage.removeItem(k); window.sessionStorage.removeItem(k); } catch {}
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: smartStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
