import { createClient } from "@supabase/supabase-js";

// Ces deux valeurs sont publiques par conception (clé "anon").
// La vraie sécurité est gérée par les règles RLS dans Supabase.
const SUPABASE_URL = "https://ifhriyvvqkwqgzmrjjxp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmaHJpeXZ2cWt3cWd6bXJqanhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDg0NjEsImV4cCI6MjA5NzAyNDQ2MX0.7OoRpsQccKcM6OdNU6gD-sQEqZpV8HnXSDIA5HJSZ4Q";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
