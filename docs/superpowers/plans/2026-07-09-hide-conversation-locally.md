# Supprimer une conversation localement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user delete a conversation thread from their own Messages list without affecting the other participant(s)/group, with automatic reappearance the moment new activity arrives.

**Architecture:** A new Supabase table `hidden_conversations` stores one row per (user, conversation) with a server-generated `hidden_at` timestamp. A conversation is hidden for a user if and only if `hidden_at` is at or after the timestamp of its most recent message — no row is ever deleted to "reveal" a conversation again, the comparison is purely client-side against data already loaded. Follows the existing service → hook → component pattern (`messageService.ts` → `useMessages.ts` → `MessagingTab`).

**Tech Stack:** React (Vite), TypeScript for `src/services`/`src/hooks`, Supabase (Postgres + RLS + PostgREST upsert), plain JS for `src/App.jsx` and `src/utils/core.js`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-hide-conversation-locally-design.md` — read it once for full context; this plan implements it in full.
- `conv_key` is the exact same string already computed client-side by `ck(ids)` in `MessagingTab` (`App.jsx`) — sorted, deduped, `|`-joined Supabase UIDs. Never re-derive it differently.
- `hidden_at` must always be server-generated (`NOW()` via a Postgres trigger), never sent by the client — this avoids client clock-skew breaking the reveal-on-new-message comparison against `messages.created_at` (also server-generated).
- No row in `hidden_conversations` is ever deleted by this feature. Re-hiding an already-hidden conversation is an upsert that refreshes `hidden_at`.
- New pure logic goes in `src/utils/core.js` with tests in `src/utils/core.test.js` (project convention, see `CLAUDE.md`).
- Migrations are numbered sequentially and run manually by the user via the Supabase dashboard SQL Editor (no CLI access in this project) — this plan's migration task ends with an explicit hand-off to the user, not an automated DB step.
- Verify every task with `npm run build` (Vite + TS must compile) and, where the task touches `src/utils/core.js`, `TZ=Europe/Paris npm test`.
- i18n: every new user-facing string gets a real translation in all 5 files (`src/i18n/{fr,en,de,es,pt}.js`), not just French — this project's established practice this cycle, not merely `t.key||"fallback"` placeholders.
- UX simplification vs. the spec's wording: the spec describes long-press opening "un petit menu contextuel avec une seule action". Since there is exactly one action, this plan has long-press open the confirmation modal directly (skips a redundant single-item menu) — same gesture, same confirmation copy, one fewer tap. Flagging this here since it's a deliberate small deviation from the spec's literal wording, not an oversight.

---

### Task 1: Pure helper — `isConversationHidden`

**Files:**
- Modify: `src/utils/core.js` (append near the end, after the last exported helper)
- Test: `src/utils/core.test.js` (append near the end, after the last test block)

**Interfaces:**
- Produces: `isConversationHidden(hiddenAt: string|null|undefined, lastMessageTs: string|null|undefined): boolean` — pure function, no dependencies. Used by Task 6 to filter the conversation list.

- [ ] **Step 1: Write the failing tests**

Append to `src/utils/core.test.js`:

```js
import { isConversationHidden } from "./core.js";

test("isConversationHidden : pas de hiddenAt → jamais masquée", () => {
  assert.strictEqual(isConversationHidden(undefined, "2026-07-09T10:00:00Z"), false);
});

test("isConversationHidden : hiddenAt après le dernier message → masquée", () => {
  assert.strictEqual(isConversationHidden("2026-07-09T12:00:00Z", "2026-07-09T10:00:00Z"), true);
});

test("isConversationHidden : nouveau message après hiddenAt → réapparaît", () => {
  assert.strictEqual(isConversationHidden("2026-07-09T10:00:00Z", "2026-07-09T12:00:00Z"), false);
});

test("isConversationHidden : hiddenAt égal au dernier message → reste masquée (cas limite)", () => {
  assert.strictEqual(isConversationHidden("2026-07-09T10:00:00Z", "2026-07-09T10:00:00Z"), true);
});

test("isConversationHidden : hiddenAt présent mais aucun message connu → masquée par défaut", () => {
  assert.strictEqual(isConversationHidden("2026-07-09T10:00:00Z", undefined), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `isConversationHidden is not a function` (or similar import error), the 5 new tests among the failures.

- [ ] **Step 3: Implement the function**

Append to `src/utils/core.js`:

```js
// ── Conversations masquées (côté utilisateur) ────────────────────────────────
// Une conversation est masquée pour un utilisateur si son hidden_at (figé
// côté serveur au moment du clic sur Supprimer, voir hiddenConversationsService.ts)
// est postérieur ou égal à l'horodatage de son dernier message. Dès qu'un
// nouveau message arrive après hidden_at, cette comparaison suffit à faire
// réapparaître le fil — aucune ligne n'est jamais supprimée pour le "révéler".
export function isConversationHidden(hiddenAt, lastMessageTs) {
  if (!hiddenAt) return false;
  if (!lastMessageTs) return true;
  return hiddenAt >= lastMessageTs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: PASS — all tests including the 5 new ones green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add isConversationHidden pure helper for hiding conversations locally"
```

---

### Task 2: Migration — `hidden_conversations` table

**Files:**
- Create: `supabase/migrations/0028_hidden_conversations.sql`

**Interfaces:**
- Produces: table `public.hidden_conversations(id, user_id, family_id, conv_key, hidden_at)`, unique on `(user_id, conv_key)`, RLS restricting all access to `user_id = auth.uid()`, a `BEFORE INSERT OR UPDATE` trigger that always sets `hidden_at = NOW()` regardless of what the client sends. Consumed by Task 3's service functions.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/0028_hidden_conversations.sql`:

```sql
-- 0028_hidden_conversations.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Permet à un utilisateur de retirer une conversation (au sens client-side —
-- voir ck(ids) dans MessagingTab, App.jsx) de sa propre liste de messages,
-- sans rien supprimer pour les autres participants. Une ligne = une
-- conversation masquée par un utilisateur donné ; hidden_at est toujours
-- généré côté serveur (trigger), jamais fourni par le client, pour éviter
-- tout problème de décalage d'horloge lors de la comparaison avec le
-- created_at (serveur, lui aussi) du dernier message de la conversation.
--
-- Ré-masquer une conversation déjà masquée met simplement hidden_at à jour
-- (upsert sur la contrainte unique) — aucune ligne n'est jamais supprimée
-- par cette fonctionnalité ; voir
-- docs/superpowers/specs/2026-07-09-hide-conversation-locally-design.md.
--
-- À exécuter APRÈS 0027. Idempotent (IF NOT EXISTS pour la table/l'index,
-- CREATE OR REPLACE pour la fonction, DROP TRIGGER/POLICY IF EXISTS avant
-- recréation — même convention que 0017/0026/0027).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.hidden_conversations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id   UUID        NOT NULL,
  conv_key    TEXT        NOT NULL,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, conv_key)
);

CREATE INDEX IF NOT EXISTS hidden_conversations_user_id_idx ON public.hidden_conversations(user_id);

-- ── Trigger : hidden_at est toujours l'heure serveur, y compris lors d'un
-- ré-masquage (upsert en conflit = chemin UPDATE, où DEFAULT ne s'applique pas) ──
CREATE OR REPLACE FUNCTION public.handle_hidden_conversations_hidden_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.hidden_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hidden_conversations_set_hidden_at ON public.hidden_conversations;
CREATE TRIGGER hidden_conversations_set_hidden_at
  BEFORE INSERT OR UPDATE ON public.hidden_conversations
  FOR EACH ROW EXECUTE FUNCTION public.handle_hidden_conversations_hidden_at();

ALTER TABLE public.hidden_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hidden_conversations_select_own" ON public.hidden_conversations;
CREATE POLICY "hidden_conversations_select_own" ON public.hidden_conversations FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "hidden_conversations_insert_own" ON public.hidden_conversations;
CREATE POLICY "hidden_conversations_insert_own" ON public.hidden_conversations FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "hidden_conversations_update_own" ON public.hidden_conversations;
CREATE POLICY "hidden_conversations_update_own" ON public.hidden_conversations FOR UPDATE
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
```

- [ ] **Step 2: Commit the migration file**

```bash
git add supabase/migrations/0028_hidden_conversations.sql
git commit -m "Add hidden_conversations migration for local conversation deletion"
```

- [ ] **Step 3: Hand off to the user for manual execution — NOT a subagent step**

This step cannot be delegated to an implementer subagent: the project has no Supabase CLI access (see `reference-supabase-db-access` memory), migrations are run by the user pasting SQL into the Supabase dashboard's SQL Editor. The controlling session must:
1. Paste the full contents of `supabase/migrations/0028_hidden_conversations.sql` and ask the user to run it in the Supabase SQL Editor.
2. Confirm the result is "Success. No rows returned" (or equivalent) before Task 3 is considered unblocked — Task 3's code can be written and build-verified without this, but should not be treated as end-to-end done until the table exists in production.

---

### Task 3: Service layer — `hiddenConversationsService.ts`

**Files:**
- Create: `src/services/supabase/hiddenConversationsService.ts`

**Interfaces:**
- Consumes: `supabase` client from `../../supabaseClient` (same import every other service in this folder uses).
- Produces:
  - `interface HiddenConversation { convKey: string; hiddenAt: string; }`
  - `listHiddenConversations(userId: string): Promise<HiddenConversation[]>`
  - `hideConversation(userId: string, familyId: string, convKey: string): Promise<string>` — returns the server-generated `hidden_at` ISO string.
  Consumed by Task 4's hook.

- [ ] **Step 1: Write the service file**

Create `src/services/supabase/hiddenConversationsService.ts`:

```ts
import { supabase } from "../../supabaseClient";

export interface HiddenConversation {
  convKey: string;
  hiddenAt: string;
}

export async function listHiddenConversations(userId: string): Promise<HiddenConversation[]> {
  const { data, error } = await supabase
    .from("hidden_conversations")
    .select("conv_key, hidden_at")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row) => ({ convKey: row.conv_key, hiddenAt: row.hidden_at }));
}

/** hidden_at n'est jamais envoyé par le client — un trigger côté serveur (voir
 *  migration 0028) le force toujours à NOW(), y compris sur un ré-masquage. */
export async function hideConversation(userId: string, familyId: string, convKey: string): Promise<string> {
  const { data, error } = await supabase
    .from("hidden_conversations")
    .upsert(
      { user_id: userId, family_id: familyId, conv_key: convKey },
      { onConflict: "user_id,conv_key" }
    )
    .select("hidden_at")
    .single();
  if (error) throw error;
  return data.hidden_at;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build succeeds (this file has no runtime callers yet, so a successful build only confirms TypeScript syntax/type correctness — that's sufficient for this step).

- [ ] **Step 3: Commit**

```bash
git add src/services/supabase/hiddenConversationsService.ts
git commit -m "Add hiddenConversationsService for locally hiding conversations"
```

---

### Task 4: Hook — extend `useMessages.ts`

**Files:**
- Modify: `src/hooks/useMessages.ts`

**Interfaces:**
- Consumes: `listHiddenConversations`, `hideConversation` from `../services/supabase/hiddenConversationsService` (Task 3).
- Produces: `useMessages(familyId: string | null, userId: string | null)` (signature change — adds `userId` param) now also returns `hiddenConvs: Record<string, string>` (convKey → hiddenAt ISO) and `hideConversation(convKey: string): Promise<void>`. Consumed by Task 5 (App.jsx call site) and Task 6 (MessagingTab, via context).

- [ ] **Step 1: Update the hook**

Read the current file first — it is reproduced here in full with the required changes so there is no ambiguity about what changes vs. what stays identical:

```ts
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { type DuviaMessage, listMessages, sendMessage, markMessageRead, setMessageReaction, deleteMessage } from "../services/supabase/messageService";
import { listHiddenConversations, hideConversation as hideConversationInDb } from "../services/supabase/hiddenConversationsService";

/**
 * Remplace `const [msgs, setMsgs] = useLocalStorage("duvia_msgs", [])`
 * (App.jsx ligne ~4085). La logique de regroupement par conversation
 * (ck(ids), allConvs, currentMsgs...) peut rester identique côté composant :
 * elle ne fait que dériver `msgs`, qui garde la même forme de tableau.
 */
export function useMessages(familyId: string | null, userId: string | null) {
  const [msgs, setMsgs] = useState<DuviaMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hiddenConvs, setHiddenConvs] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!familyId) return;
    setLoading(true);
    try {
      setMsgs(await listMessages(familyId));
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Erreur de chargement des messages");
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!familyId) return;
    const channel = supabase
      .channel(`messages_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const incoming = payload.new as DuviaMessage;
            setMsgs((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
          } else if (payload.eventType === "UPDATE") {
            setMsgs((prev) => prev.map((m) => (m.id === payload.new.id ? (payload.new as DuviaMessage) : m)));
          } else if (payload.eventType === "DELETE") {
            setMsgs((prev) => prev.filter((m) => m.id !== payload.old.id));
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [familyId]);

  const send = useCallback(
    async (senderId: string, senderName: string, recipientIds: string[], content: string) => {
      if (!familyId) throw new Error("Famille non prête");
      const msg = await sendMessage({ familyId, senderId, senderName, recipientIds, content });
      setMsgs((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      return msg;
    },
    [familyId]
  );

  const markRead = useCallback(
    async (id: string, userId: string) => {
      const target = msgs.find((m) => m.id === id);
      if (!target) return;
      const currentReadBy = target.read_by ?? [];
      if (currentReadBy.includes(userId)) return;
      await markMessageRead(id, userId, currentReadBy);
      setMsgs((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, read_by: [...(m.read_by ?? []), userId] } : m
        )
      );
    },
    [msgs]
  );

  /** Remplace les réactions d'un message (valeur déjà calculée par toggleMessageReaction). */
  const react = useCallback(
    async (id: string, reactions: Record<string, string[]>) => {
      setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, reactions } : m))); // optimiste
      try {
        await setMessageReaction(id, reactions);
      } catch (e) {
        await refresh(); // resynchronise en cas d'échec, comme les autres mutations de ce hook
      }
    },
    [refresh]
  );

  /** Supprime un message (autorisé côté serveur seulement si personne d'autre ne l'a encore lu). */
  const remove = useCallback(
    async (id: string) => {
      const prevMsgs = msgs;
      setMsgs((prev) => prev.filter((m) => m.id !== id)); // optimiste
      try {
        await deleteMessage(id);
      } catch (e) {
        setMsgs(prevMsgs); // annule l'optimisme si le serveur a refusé (ex: lu entre-temps)
        throw e;
      }
    },
    [msgs]
  );

  const refreshHidden = useCallback(async () => {
    if (!userId) return;
    try {
      const rows = await listHiddenConversations(userId);
      setHiddenConvs(Object.fromEntries(rows.map((r) => [r.convKey, r.hiddenAt])));
    } catch (e) {
      // Silencieux : une erreur ici ne doit pas bloquer l'affichage des messages.
      // Au pire une conversation reste visible qui aurait dû être masquée.
    }
  }, [userId]);

  useEffect(() => {
    refreshHidden();
  }, [refreshHidden]);

  /** Masque une conversation pour l'utilisateur courant (optimiste, comme react/remove ci-dessus). */
  const hideConversation = useCallback(
    async (convKey: string) => {
      if (!familyId || !userId) return;
      const prevHiddenConvs = hiddenConvs;
      setHiddenConvs((prev) => ({ ...prev, [convKey]: new Date().toISOString() }));
      try {
        const hiddenAt = await hideConversationInDb(userId, familyId, convKey);
        setHiddenConvs((prev) => ({ ...prev, [convKey]: hiddenAt }));
      } catch (e) {
        setHiddenConvs(prevHiddenConvs);
      }
    },
    [familyId, userId, hiddenConvs]
  );

  return { msgs, loading, error, send, markRead, react, remove, refresh, hiddenConvs, hideConversation };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: PASS. This project's build (`vite build`, see `package.json`) has no separate `tsc` type-check pass and no `typescript` devDependency — `.ts` files are transpiled (types stripped), not type-checked, and `App.jsx`'s existing call site `useMessages(familySync.familyId)` (still one argument at this point) will simply run with `userId` as `undefined` until Task 5 updates the call site. Every new `userId`-dependent code path in this hook is already guarded (`if (!userId) return;`), so this is inert, not broken — `hiddenConvs` just stays `{}` and `hideConversation` becomes a no-op until Task 5.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useMessages.ts
git commit -m "Extend useMessages with hiddenConvs and hideConversation"
```

---

### Task 5: Wire into App.jsx context

**Files:**
- Modify: `src/App.jsx:2825-2826` (useMessages call site + myUid ordering)
- Modify: `src/App.jsx:2878` (remove the now-duplicate myUid declaration)
- Modify: `src/App.jsx:4114` (ctxValue)

**Interfaces:**
- Consumes: `useMessages(familyId, userId)` returning `{..., hiddenConvs, hideConversation}` (Task 4).
- Produces: `hiddenConvs` and `hideConversation` available via `useApp()` context to any component, consumed by Task 6 (`MessagingTab`).

- [ ] **Step 1: Move `myUid` state above the `useMessages` call and pass it in**

`useMessages` needs the current user's Supabase UID to load/write `hidden_conversations` rows, but `myUid` is currently declared *after* the `useMessages` call (`App.jsx:2878`, vs. the call at `App.jsx:2826`). Moving a `useState` declaration earlier in a component is always safe in React (hook call order only needs to be consistent across renders, which an unconditional `useState(null)` trivially satisfies).

Find (around line 2825):
```js
  const [sub,setSub]     = useLocalStorage("duvia_sub", makeSub);
  const { msgs: cloudMsgs, send: _sendCloudMsg, markRead: markCloudMessageRead, react: _reactCloudMsg, remove: _removeCloudMsg } = useMessages(familySync.familyId);
```

Replace with:
```js
  const [sub,setSub]     = useLocalStorage("duvia_sub", makeSub);
  const [myUid, setMyUid] = useState(null);
  const { msgs: cloudMsgs, send: _sendCloudMsg, markRead: markCloudMessageRead, react: _reactCloudMsg, remove: _removeCloudMsg, hiddenConvs, hideConversation } = useMessages(familySync.familyId, myUid);
```

Then find the now-duplicate original declaration (around line 2878, unchanged context lines shown for exact matching):
```js
  const { history: historyData, addHistEntry } = useHistory(familySync.familyId);
  const [myUid, setMyUid] = useState(null);
  // Vérification admin côté serveur — résiste à la manipulation du localStorage
  const [adminVerified, setAdminVerified] = useState(false);
```

Replace with (just removing the now-duplicate line):
```js
  const { history: historyData, addHistEntry } = useHistory(familySync.familyId);
  // Vérification admin côté serveur — résiste à la manipulation du localStorage
  const [adminVerified, setAdminVerified] = useState(false);
```

- [ ] **Step 2: Expose `hiddenConvs`/`hideConversation` via context**

Find (around line 4114):
```js
    msgs, sendCloudMessage, markCloudMessageRead, reactToCloudMessage, deleteCloudMessage, myUid,
```

Replace with:
```js
    msgs, sendCloudMessage, markCloudMessageRead, reactToCloudMessage, deleteCloudMessage, myUid,
    hiddenConvs, hideConversation,
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: PASS. `useMessages` now receives `myUid` as its second argument, so `hiddenConvs`/`hideConversation` become live instead of the inert no-op state described in Task 4.

- [ ] **Step 4: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: PASS — this task touches no `core.js` logic, so this just confirms nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Wire hiddenConvs/hideConversation into app context"
```

---

### Task 6: MessagingTab UI — filter, long-press, confirmation modal

**Files:**
- Modify: `src/App.jsx` (imports, `MessagingTab` destructure, `convList` computation, conversation row, new confirmation modal)
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js`

**Interfaces:**
- Consumes: `isConversationHidden` (Task 1), `hiddenConvs`/`hideConversation` from `useApp()` (Task 5).
- Produces: end-user-visible feature — this is the last task.

- [ ] **Step 1: Import `isConversationHidden`**

`App.jsx` already imports several helpers from `./utils/core.js` in one line near the top of the file. Find:
```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction, isMemberIdentityLocked, toggleGuardId, resolveCustomDateGuardians, guardianStripeBackground, guardianNamesLabel, makeSchoolHolIdentity } from './utils/core.js';
```

Replace with:
```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction, isMemberIdentityLocked, toggleGuardId, resolveCustomDateGuardians, guardianStripeBackground, guardianNamesLabel, makeSchoolHolIdentity, isConversationHidden } from './utils/core.js';
```

- [ ] **Step 2: Add new i18n keys to all 5 languages**

In `src/i18n/fr.js`, find:
```js
    msgRateLimit:"Trop de messages envoyés. Attends une minute avant de réessayer.",
```
Replace with:
```js
    msgRateLimit:"Trop de messages envoyés. Attends une minute avant de réessayer.",
    msgDeleteConvConfirmTitle:"Supprimer cette conversation ?",
    msgDeleteConvConfirmBody:"Cette conversation sera supprimée uniquement de ta liste. Elle restera visible pour les autres participants.",
    msgDeleteConvConfirmBtn:"Supprimer",
```

In `src/i18n/en.js`, find:
```js
    msgRateLimit:"Too many messages sent. Wait a minute before trying again.",
```
Replace with:
```js
    msgRateLimit:"Too many messages sent. Wait a minute before trying again.",
    msgDeleteConvConfirmTitle:"Delete this conversation?",
    msgDeleteConvConfirmBody:"This conversation will only be deleted from your list. It will remain visible to the other participants.",
    msgDeleteConvConfirmBtn:"Delete",
```

In `src/i18n/de.js`, find:
```js
    msgRateLimit:"Zu viele Nachrichten gesendet. Warten Sie eine Minute, bevor Sie es erneut versuchen.",
```
Replace with:
```js
    msgRateLimit:"Zu viele Nachrichten gesendet. Warten Sie eine Minute, bevor Sie es erneut versuchen.",
    msgDeleteConvConfirmTitle:"Diese Unterhaltung löschen?",
    msgDeleteConvConfirmBody:"Diese Unterhaltung wird nur aus deiner Liste gelöscht. Sie bleibt für die anderen Teilnehmer sichtbar.",
    msgDeleteConvConfirmBtn:"Löschen",
```

In `src/i18n/es.js`, find:
```js
    msgRateLimit:"Demasiados mensajes enviados. Espera un minuto antes de volver a intentarlo.",
```
Replace with:
```js
    msgRateLimit:"Demasiados mensajes enviados. Espera un minuto antes de volver a intentarlo.",
    msgDeleteConvConfirmTitle:"¿Eliminar esta conversación?",
    msgDeleteConvConfirmBody:"Esta conversación solo se eliminará de tu lista. Seguirá siendo visible para los demás participantes.",
    msgDeleteConvConfirmBtn:"Eliminar",
```

In `src/i18n/pt.js`, find:
```js
    msgRateLimit:"Demasiadas mensagens enviadas. Espere um minuto antes de tentar novamente.",
```
Replace with:
```js
    msgRateLimit:"Demasiadas mensagens enviadas. Espere um minuto antes de tentar novamente.",
    msgDeleteConvConfirmTitle:"Eliminar esta conversa?",
    msgDeleteConvConfirmBody:"Esta conversa será eliminada apenas da tua lista. Continuará visível para os outros participantes.",
    msgDeleteConvConfirmBtn:"Eliminar",
```

- [ ] **Step 3: Destructure the new context values in `MessagingTab`**

Find:
```js
function MessagingTab(){
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,reactToCloudMessage,deleteCloudMessage,myUid,uidToLocal,localToUid,emailToUid,familySync,isChild,isObs}=useApp();
```

Replace with:
```js
function MessagingTab(){
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,reactToCloudMessage,deleteCloudMessage,myUid,uidToLocal,localToUid,emailToUid,familySync,isChild,isObs,hiddenConvs,hideConversation}=useApp();
```

- [ ] **Step 4: Add long-press state and refs for conversation rows**

Find:
```js
  const [longPressMsgId,setLongPressMsgId]=useState(null); // id du message dont le picker de réactions est ouvert
  const [reactionPopover,setReactionPopover]=useState(null); // {msgId,emoji} — popover "qui a réagi" ouvert
  const longPressTimer=useRef(null);
  const longPressFired=useRef(false);
```

Replace with:
```js
  const [longPressMsgId,setLongPressMsgId]=useState(null); // id du message dont le picker de réactions est ouvert
  const [reactionPopover,setReactionPopover]=useState(null); // {msgId,emoji} — popover "qui a réagi" ouvert
  const longPressTimer=useRef(null);
  const longPressFired=useRef(false);
  const [deleteConvKey,setDeleteConvKey]=useState(null); // clé de la conversation en attente de confirmation de suppression
  const convLongPressTimer=useRef(null);
  const convLongPressFired=useRef(false);
```

- [ ] **Step 5: Filter `convList` to exclude hidden conversations**

Find:
```js
  const convList=Object.values(allConvs).sort((a,b)=>{
    const la=a.msgs.at(-1)?.ts||'',lb=b.msgs.at(-1)?.ts||'';
    return lb.localeCompare(la);
  });
```

Replace with:
```js
  const convList=Object.values(allConvs)
    .filter(conv=>!isConversationHidden(hiddenConvs[conv.key], conv.msgs.at(-1)?.ts))
    .sort((a,b)=>{
      const la=a.msgs.at(-1)?.ts||'',lb=b.msgs.at(-1)?.ts||'';
      return lb.localeCompare(la);
    });
```

- [ ] **Step 6: Add long-press handlers to the conversation row**

Find:
```js
        return(
          <div key={conv.key} onClick={()=>{setConvId(conv.key);setView("chat");}} className="card" style={{
            marginBottom:10,cursor:"pointer",
            borderColor:unread>0?col:isGroup?C.vio+"55":C.bor,
            background:unread>0?`${col}08`:isGroup?`${C.vio}05`:C.card,transition:"all .15s"
          }}>
```

Replace with:
```js
        return(
          <div key={conv.key}
            onClick={()=>{ if(convLongPressFired.current){ convLongPressFired.current=false; return; } setConvId(conv.key);setView("chat"); }}
            onMouseDown={()=>{ convLongPressTimer.current=setTimeout(()=>{ convLongPressFired.current=true; setDeleteConvKey(conv.key); },450); }}
            onMouseUp={()=>clearTimeout(convLongPressTimer.current)}
            onMouseLeave={()=>clearTimeout(convLongPressTimer.current)}
            onTouchStart={()=>{ convLongPressTimer.current=setTimeout(()=>{ convLongPressFired.current=true; setDeleteConvKey(conv.key); },450); }}
            onTouchEnd={()=>clearTimeout(convLongPressTimer.current)}
            onTouchCancel={()=>clearTimeout(convLongPressTimer.current)}
            className="card" style={{
            marginBottom:10,cursor:"pointer",
            borderColor:unread>0?col:isGroup?C.vio+"55":C.bor,
            background:unread>0?`${col}08`:isGroup?`${C.vio}05`:C.card,transition:"all .15s"
          }}>
```

- [ ] **Step 7: Add the confirmation modal**

Find (the end of the list view, right after the "Security info" block):
```js
      {/* Security info */}
      <div style={{marginTop:16,padding:"12px 14px",background:`${C.grn}08`,borderRadius:12,border:`1px solid ${C.grn}22`,display:"flex",gap:10,alignItems:"flex-start"}}>
        <span style={{fontSize:18,flexShrink:0}}>🔒</span>
        <div style={{fontSize:11,color:C.mut,lineHeight:1.5}}>
          {t.msgIntegrityFooter||"Chaque message est signé par un hash cryptographique unique (FNV-1a). Appuyez sur n'importe quel message pour vérifier son intégrité."}
        </div>
      </div>
    </div>
  );
}
```

Replace with:
```js
      {/* Security info */}
      <div style={{marginTop:16,padding:"12px 14px",background:`${C.grn}08`,borderRadius:12,border:`1px solid ${C.grn}22`,display:"flex",gap:10,alignItems:"flex-start"}}>
        <span style={{fontSize:18,flexShrink:0}}>🔒</span>
        <div style={{fontSize:11,color:C.mut,lineHeight:1.5}}>
          {t.msgIntegrityFooter||"Chaque message est signé par un hash cryptographique unique (FNV-1a). Appuyez sur n'importe quel message pour vérifier son intégrité."}
        </div>
      </div>

      {/* Modale confirmation suppression conversation (locale à l'utilisateur) */}
      {deleteConvKey && (
        <div onClick={()=>setDeleteConvKey(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:16,padding:20,maxWidth:340,width:"100%",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
            <div style={{fontSize:15,fontWeight:900,color:C.txt,marginBottom:8}}>{t.msgDeleteConvConfirmTitle||"Supprimer cette conversation ?"}</div>
            <div style={{fontSize:13,color:C.mut,lineHeight:1.5,marginBottom:18}}>{t.msgDeleteConvConfirmBody||"Cette conversation sera supprimée uniquement de ta liste. Elle restera visible pour les autres participants."}</div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setDeleteConvKey(null)} style={{flex:1,height:44,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13,cursor:"pointer"}}>{t.cancel||"Annuler"}</button>
              <button onClick={()=>{hideConversation(deleteConvKey);setDeleteConvKey(null);}} style={{flex:1,height:44,background:C.red,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:13,cursor:"pointer"}}>{t.msgDeleteConvConfirmBtn||"Supprimer"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 9: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: PASS (all tests, including Task 1's new ones).

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Add long-press delete for conversations, filtered from list when hidden"
```

- [ ] **Step 11: Manual smoke test (guided, in the running app)**

Not automatable in this environment (no live Supabase session here) — the controlling session should walk the user through, on `app.duvia.fr` after deploy:
1. Long-press a conversation row → confirmation modal appears with the "only for you" copy.
2. Tap Annuler → modal closes, conversation still in list.
3. Long-press again → tap Supprimer → conversation disappears from the list immediately.
4. Refresh the page → conversation stays gone (confirms the Supabase round-trip persisted, not just local state).
5. Have the other participant send a new message in that conversation → conversation reappears in the list on the next load/Realtime update.
6. Confirm the other participant's own conversation list was never affected by any of the above.
