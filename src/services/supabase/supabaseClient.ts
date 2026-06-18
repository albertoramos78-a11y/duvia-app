import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Mêmes valeurs que src/supabaseClient.js actuel — clé "anon", publique par
// conception. La vraie sécurité vient des policies RLS (voir 0001_phase1_*.sql).
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "https://ifhriyvvqkwqgzmrjjxp.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmaHJpeXZ2cWt3cWd6bXJqanhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDg0NjEsImV4cCI6MjA5NzAyNDQ2MX0.7OoRpsQccKcM6OdNU6gD-sQEqZpV8HnXSDIA5HJSZ4Q";

// TODO : remplacer `any` par les types générés (`supabase gen types typescript`)
// une fois le schéma stabilisé. Pas bloquant pour le Phase 1.
export const supabase: SupabaseClient<any> = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

/**
 * Note de migration : src/App.jsx contient encore en haut du fichier (lignes
 * ~14-60) un client Supabase fait main via fetch (`_supaFetch`). Vérifié :
 * il n'est appelé nulle part (`grep -c "_supaFetch(" App.jsx` → 1, soit
 * uniquement sa propre définition). C'est du code mort, sûr à supprimer dès
 * que tu valides — je n'y ai pas touché ici pour rester dans ce dossier
 * autonome, mais c'est un patch d'une minute si tu veux que je le fasse.
 */
