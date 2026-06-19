import { createClient } from "@supabase/supabase-js";

// Ces deux valeurs sont publiques par conception (clé "anon").
// La vraie sécurité est gérée par les règles RLS dans Supabase.
const SUPABASE_URL = "https://ifhriyvvqkwqgzmrjjxp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmaHJpeXZ2cWt3cWd6bXJqanhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDg0NjEsImV4cCI6MjA5NzAyNDQ2MX0.7OoRpsQccKcM6OdNU6gD-sQEqZpV8HnXSDIA5HJSZ4Q";

// Stockage de session « intelligent » :
// - « Rester connecté » coché (duvia_remember=1) → token en localStorage
//   (persiste après fermeture de l'onglet).
// - sinon → sessionStorage (effacé à la fermeture de l'onglet) — sûr sur un
//   appareil partagé entre co-parents.
// Survit toujours aux rechargements internes (flux d'éjection).
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
