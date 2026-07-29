# Cache FAQ auto-alimenté pour ai-chatbot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Éviter d'appeler l'API Anthropic quand une question posée à `ai-chatbot` est quasi-identique (texte, pas sens) à une question FAQ déjà répondue, pour réduire le coût réel de l'assistant IA.

**Architecture:** Nouvelle table Postgres `ai_faq_cache` + extension `pg_trgm` (correspondance floue de texte, native, gratuite) + une fonction RPC `match_and_touch_faq_cache`. `ai-chatbot/index.ts` consulte le cache avant d'appeler Claude (uniquement sur la 1ère question d'une conversation) ; si aucun outil n'a été utilisé et que la réponse n'est pas `[NO_ANSWER]`, la paire question/réponse est ajoutée au cache après coup, avec un email récapitulatif.

**Tech Stack:** Supabase Postgres (migration SQL, `pg_trgm`), Deno Edge Function (TypeScript), Resend (email déjà utilisé par `notifyNoAnswer`).

## Global Constraints

- Aucune nouvelle dépendance externe (pas d'embeddings/Voyage/OpenAI) — voir `docs/superpowers/specs/2026-07-29-ai-faq-cache-design.md`.
- Seuil de similarité `pg_trgm` : `0.7`.
- Cache limité à la 1ère question d'une conversation (`clientHistory.length === 0`), jamais aux tours de suivi.
- Une paire n'est mise en cache que si zéro outil n'a été appelé sur tout l'échange ET la réponse n'est pas `[NO_ANSWER]`.
- Un hit de cache ne consomme pas le plafond quotidien de tokens (`tokens_this_exchange: 0`, pas d'écriture dans `ai_usage_log`).
- Table `ai_faq_cache` accessible uniquement via `service_role` (RLS activée, aucune policy client), même modèle que `ai_usage_log` (voir `supabase/migrations/0044_ai_features_foundation.sql`).
- Environnement de test pour le code de l'Edge Function : **directement en production**, avec un compte réel (décision explicite 2026-07-29, changement jugé à faible risque — un miss se comporte exactement comme aujourd'hui). La migration SQL, elle, se teste isolément sur staging (`duvia-staging`, ref `xqborcugpzjzungwgepn`) avant application en prod (ref `ifhriyvvqkwqgzmrjjxp`).

---

## Task 1: Table, index et fonction RPC (`ai_faq_cache`)

**Files:**
- Create: `supabase/migrations/0058_ai_faq_cache.sql`

**Interfaces:**
- Produces: table `public.ai_faq_cache(id uuid, question_text text, answer_text text, faq_fingerprint text, lang text, hit_count int, created_at timestamptz, last_used_at timestamptz)`.
- Produces: fonction `public.match_and_touch_faq_cache(p_question text, p_fingerprint text, p_threshold float default 0.7) returns table(id uuid, answer_text text)` — exécutable uniquement par `service_role`. Sur un match, incrémente `hit_count` et met à jour `last_used_at` avant de renvoyer la ligne.

- [ ] **Step 1: Écrire la migration**

```sql
-- supabase/migrations/0058_ai_faq_cache.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Cache de réponses FAQ pour ai-chatbot (voir docs/superpowers/specs/
-- 2026-07-29-ai-faq-cache-design.md) : évite de rappeler l'API Anthropic pour
-- une question dont le texte est très proche d'une question FAQ déjà répondue
-- (ex. "comment inviter l'autre parent ?" vs "comment j'invite l'autre
-- parent"). Correspondance textuelle (pg_trgm, natif Postgres, gratuit) plutôt
-- que sémantique (embeddings) — décision explicite pour ne pas ajouter de
-- nouvelle dépendance externe facturée ; rate donc les vraies paraphrases sans
-- vocabulaire commun (repli normal sur un appel Claude classique dans ce cas).
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_trgm;

create table public.ai_faq_cache (
  id uuid primary key default gen_random_uuid(),
  question_text text not null,
  answer_text text not null,
  faq_fingerprint text not null,
  lang text,
  hit_count int not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index ai_faq_cache_trgm_idx on public.ai_faq_cache using gin (question_text gin_trgm_ops);

-- 🔒 Pas de policy RLS client : seule l'Edge Function ai-chatbot (client
-- service_role) lit/écrit cette table, même modèle que ai_usage_log (voir
-- 0044_ai_features_foundation.sql).
alter table public.ai_faq_cache enable row level security;

-- Lit une réponse en cache dont question_text est très proche de p_question
-- (similarité de trigrammes > p_threshold) ET dont faq_fingerprint correspond
-- au fingerprint actuel de FAQ_KNOWLEDGE (p_fingerprint) — une entrée écrite
-- sous un ancien contenu de FAQ_KNOWLEDGE a un fingerprint différent et n'est
-- donc jamais retournée ici, sans purge explicite nécessaire. Incrémente
-- hit_count/last_used_at sur un hit avant de renvoyer la ligne.
create or replace function public.match_and_touch_faq_cache(
  p_question text,
  p_fingerprint text,
  p_threshold float default 0.7
)
returns table (id uuid, answer_text text)
language plpgsql
as $$
declare
  v_id uuid;
  v_answer text;
begin
  select c.id, c.answer_text into v_id, v_answer
    from public.ai_faq_cache c
   where c.faq_fingerprint = p_fingerprint
     and similarity(c.question_text, p_question) > p_threshold
   order by similarity(c.question_text, p_question) desc
   limit 1;

  if v_id is not null then
    update public.ai_faq_cache set hit_count = hit_count + 1, last_used_at = now()
     where public.ai_faq_cache.id = v_id;
    return query select v_id, v_answer;
  end if;

  return;
end;
$$;

revoke all     on function public.match_and_touch_faq_cache(text, text, float) from public;
grant  execute on function public.match_and_touch_faq_cache(text, text, float) to service_role;
```

- [ ] **Step 2: Appliquer sur staging et vérifier**

```bash
npx supabase link --project-ref xqborcugpzjzungwgepn
npx supabase db push
```

Puis vérifier avec des requêtes ad hoc (`npx supabase db query --linked "<sql>"`) :

1. Insérer une ligne de test :
```sql
insert into public.ai_faq_cache (question_text, answer_text, faq_fingerprint)
values ('comment inviter l''autre parent ?', 'Menu ☰ → Configuration famille → Parents → + Ajouter un parent.', 'fp_test_1');
```
2. Match attendu (texte proche, même fingerprint) :
```sql
select * from public.match_and_touch_faq_cache('comment j''invite l''autre parent', 'fp_test_1', 0.7);
```
Attendu : une ligne renvoyée (l'`answer_text` inséré à l'étape 1).
3. Vérifier l'incrément :
```sql
select hit_count, last_used_at from public.ai_faq_cache where faq_fingerprint = 'fp_test_1';
```
Attendu : `hit_count = 1`, `last_used_at` non nul.
4. Miss attendu (fingerprint différent, texte identique) — vérifie l'invalidation automatique par fingerprint :
```sql
select * from public.match_and_touch_faq_cache('comment j''invite l''autre parent', 'fp_test_2', 0.7);
```
Attendu : aucune ligne renvoyée.
5. Miss attendu (texte trop différent, même fingerprint) :
```sql
select * from public.match_and_touch_faq_cache('comment ajouter une dépense ?', 'fp_test_1', 0.7);
```
Attendu : aucune ligne renvoyée.
6. Nettoyer la ligne de test :
```sql
delete from public.ai_faq_cache where faq_fingerprint = 'fp_test_1';
```

- [ ] **Step 3: Appliquer en production**

```bash
npx supabase link --project-ref ifhriyvvqkwqgzmrjjxp
npx supabase db push
```

Confirmer qu'aucune erreur n'est renvoyée (la migration ne touche que du nouveau — aucune table existante modifiée, risque de régression nul).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0058_ai_faq_cache.sql
git commit -m "Add ai_faq_cache table and match_and_touch_faq_cache RPC"
```

---

## Task 2: Lecture/écriture du cache dans `ai-chatbot`

**Files:**
- Modify: `supabase/functions/ai-chatbot/index.ts`

**Interfaces:**
- Consumes: `public.match_and_touch_faq_cache` (Task 1), `FAQ_KNOWLEDGE` (const existante, ligne 262).
- Produces: `FAQ_FINGERPRINT` (const module-level), `lookupFaqCache(admin, question)`, `notifyNewFaqCacheEntry({ question, answer })`.

- [ ] **Step 1: Ajouter le fingerprint de `FAQ_KNOWLEDGE`**

Juste après la fermeture du template literal `FAQ_KNOWLEDGE` (fin de ligne 461, juste avant `const SYSTEM_PROMPT = ...`), ajouter :

```typescript
// 🔧 Fingerprint de FAQ_KNOWLEDGE (2026-07-29) : simple hash de changement
// (pas cryptographique — pas besoin), utilisé pour invalider automatiquement
// ai_faq_cache quand ce texte est édité à la main. Voir
// docs/superpowers/specs/2026-07-29-ai-faq-cache-design.md.
function faqFingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}
const FAQ_FINGERPRINT = faqFingerprint(FAQ_KNOWLEDGE);
const FAQ_CACHE_SIMILARITY_THRESHOLD = 0.7;
```

- [ ] **Step 2: Ajouter `notifyNewFaqCacheEntry`**

Juste après la fin de `notifyNoAnswer` (après la ligne `console.log("ai-chatbot: notifyNoAnswer Resend response:", ...)`, ligne 859-860), ajouter :

```typescript
// 🔧 (2026-07-29) Notifie l'admin par email à chaque nouvelle entrée ajoutée
// à ai_faq_cache — permet de repérer une réponse à corriger/supprimer sans
// éplucher les logs. Best-effort : les erreurs sont catchées par l'appelant,
// un échec d'envoi ne doit jamais faire échouer la réponse du chatbot.
async function notifyNewFaqCacheEntry(info: { question: string; answer: string }) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🗂️</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouvelle entrée dans le cache FAQ</div>
    </div>
    <div style="padding:28px 24px">
      <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">Question</div>
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap;background:#f7f7fb;border-radius:10px;padding:12px">${escapeHtmlChatbot(info.question)}</p>
      <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">Réponse mise en cache</div>
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap;background:#f7f7fb;border-radius:10px;padding:12px">${escapeHtmlChatbot(info.answer)}</p>
      <p style="color:#999;margin:16px 0 0;font-size:12px">Cette réponse sera désormais réutilisée pour toute question très proche de celle-ci, pour n'importe quelle famille. Si elle est incorrecte ou à retirer : DELETE FROM ai_faq_cache WHERE question_text = '...' (voir ai_faq_cache dans Supabase).</p>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · Assistant IA
    </div>
  </div>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Duvia <${NOTIFY_FROM_EMAIL}>`,
      to: [NOTIFY_ADMIN_EMAIL],
      subject: "🗂️ Nouvelle entrée dans le cache FAQ",
      html,
    }),
  });
  const resBody = await res.json();
  console.log("ai-chatbot: notifyNewFaqCacheEntry Resend response:", JSON.stringify(resBody));
}
```

- [ ] **Step 3: Ajouter `lookupFaqCache`**

Juste après la fin de `executeTool` (ligne 875, juste avant `serve(async (req) => {`), ajouter :

```typescript
// 🔧 (2026-07-29) Consulte ai_faq_cache avant d'appeler Claude — voir Task 2
// du plan d'implémentation. Erreurs non fatales : un souci de lookup ne doit
// jamais bloquer la question de l'utilisateur, juste faire tomber sur le
// chemin normal (appel Claude).
async function lookupFaqCache(admin: ReturnType<typeof createClient>, question: string): Promise<{ answer_text: string } | null> {
  const { data, error } = await admin.rpc("match_and_touch_faq_cache", {
    p_question: question,
    p_fingerprint: FAQ_FINGERPRINT,
    p_threshold: FAQ_CACHE_SIMILARITY_THRESHOLD,
  });
  if (error) {
    console.error("ai-chatbot: lookupFaqCache failed", error);
    return null;
  }
  const row = (data || [])[0];
  return row ? { answer_text: row.answer_text } : null;
}
```

- [ ] **Step 4: Marquer `isFirstQuestion` et brancher la lecture du cache**

Juste après `const clientHistory: Array<{ role: string; content: string }> = Array.isArray(payload?.history) ? payload.history : [];` (ligne 903), ajouter :

```typescript
  const isFirstQuestion = clientHistory.length === 0;
```

Puis, dans le bloc de vérification du plafond quotidien (lignes 941-959), entre le calcul de `tokensUsedSoFar` et le `if (tokensUsedSoFar >= DAILY_TOKEN_LIMIT)`, insérer la consultation du cache :

```typescript
  const tokensUsedSoFar = (usageRows || []).reduce((s, r) => s + weightedTokens(r), 0);

  // 🔧 (2026-07-29) Un hit de cache ne coûte rien : consulté AVANT le plafond
  // pour qu'un utilisateur ayant déjà atteint son quota du jour puisse quand
  // même recevoir une réponse FAQ déjà connue. Voir docs/superpowers/specs/
  // 2026-07-29-ai-faq-cache-design.md.
  if (isFirstQuestion) {
    const cacheHit = await lookupFaqCache(admin, question);
    if (cacheHit) {
      const cleanHistory = [{ role: "user", content: question }, { role: "assistant", content: cacheHit.answer_text }];
      return jsonResponse({
        answer: cacheHit.answer_text, history: cleanHistory,
        tokens_used_today: tokensUsedSoFar, tokens_limit: DAILY_TOKEN_LIMIT, tokens_this_exchange: 0,
      });
    }
  }

  if (tokensUsedSoFar >= DAILY_TOKEN_LIMIT) return jsonResponse({ error: "daily_token_limit_reached" }, 429);
```

- [ ] **Step 5: Suivre l'usage d'outil sur l'échange**

Juste avant la boucle `for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {` (près de `let totalCacheReadTokens = 0;`, ligne 990), ajouter :

```typescript
  let toolWasUsed = false;
```

Dans la branche `if (data?.stop_reason === "tool_use") { ... }` (ligne 1022), juste après `messages.push({ role: "assistant", content });`, ajouter :

```typescript
        toolWasUsed = true;
```

- [ ] **Step 6: Brancher l'écriture du cache**

Juste après le bloc `if (isNoAnswer) { ... }` (après la ligne 1057, avant `await admin.from("ai_usage_log").insert({...})` ligne 1059), ajouter :

```typescript
      // 🔧 (2026-07-29) N'écrit dans ai_faq_cache que si la réponse est
      // générique (aucun outil utilisé, jamais spécifique à une famille) et
      // que Claude n'a pas répondu [NO_ANSWER] — voir docs/superpowers/specs/
      // 2026-07-29-ai-faq-cache-design.md. Best-effort, jamais fatal. `lang`
      // (colonne indicative/analytique, voir migration) reste volontairement
      // non renseignée dans cette itération : le client n'envoie aujourd'hui
      // aucun champ de langue à ai-chatbot (voir App.jsx, supabase.functions.
      // invoke("ai-chatbot", ...)), et l'ajouter n'apporterait qu'une
      // information indicative — pas nécessaire au fonctionnement du cache
      // (la correspondance pg_trgm sépare déjà naturellement les langues,
      // voir le design doc).
      if (isFirstQuestion && !toolWasUsed && !isNoAnswer) {
        try {
          await admin.from("ai_faq_cache").insert({
            question_text: question, answer_text: answer, faq_fingerprint: FAQ_FINGERPRINT,
          });
          await notifyNewFaqCacheEntry({ question, answer });
        } catch (e) {
          console.error("ai-chatbot: ai_faq_cache write failed", e);
        }
      }
```

- [ ] **Step 7: Déployer en production**

```bash
npx supabase link --project-ref ifhriyvvqkwqgzmrjjxp
npx supabase functions deploy ai-chatbot --use-api
```

- [ ] **Step 8: Vérification manuelle en prod (compte réel)**

1. Avec un compte Premium+IA réel, poser une question FAQ **jamais posée avant** (ex. "comment changer mon mot de passe ?"). Vérifier dans la réponse que `tokens_this_exchange > 0` (appel Claude réel). Vérifier via `npx supabase db query --linked "select question_text, answer_text from public.ai_faq_cache order by created_at desc limit 1;"` qu'une nouvelle ligne est apparue, et qu'un email est arrivé sur `duvia.services@gmail.com`.
2. Reposer une reformulation proche de la même question (ex. "comment je change mon mot de passe"). Vérifier que `tokens_this_exchange === 0` dans la réponse (cache hit, pas d'appel Claude) et que `hit_count` est passé à 1 (`select hit_count from public.ai_faq_cache order by created_at desc limit 1;`).
3. Poser une question sur des données réelles de la famille (ex. "combien j'ai dépensé ce mois-ci ?"). Vérifier qu'elle répond normalement (comme avant ce changement) ET qu'AUCUNE nouvelle ligne n'apparaît dans `ai_faq_cache` (un outil a été utilisé).
4. Nettoyer la ligne de test de l'étape 1 :
```bash
npx supabase db query --linked "delete from public.ai_faq_cache where question_text ilike '%comment changer mon mot de passe%';"
```

- [ ] **Step 9: Bump de version et commit**

Suivre la convention du projet (`CLAUDE.md`) : incrémenter `APP_VERSION` dans `src/config.js` et `SW_VERSION` dans `public/sw.js` (même valeur, ex. `"1.00"` → `"1.01"`).

```bash
git add supabase/functions/ai-chatbot/index.ts src/config.js public/sw.js
git commit -m "Add FAQ answer cache to ai-chatbot to reduce Anthropic API calls"
git push
```
