# Message Emoji Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone long-press a message in the family messaging tab and react to it with one of 6 fixed emoji (👍 ❤️ 😂 😮 😢 🙏), one reaction per person per message, with a badge+count under the message and a tap-to-see-who popover.

**Architecture:** A `reactions` JSONB column (`{emoji: [user_id, ...]}`) added to the existing `messages` table, riding on the realtime `postgres_changes` subscription `useMessages` already has (UPDATE events already replace the whole row — no new channel needed). A pure `toggleMessageReaction` helper in `utils/core.js` computes the next JSONB value (enforces "one reaction per person," toggling off on repeat tap). UI: long-press (timer-based, mouse+touch) opens a floating emoji row above the bubble; badges with counts render under it; tapping a badge shows a small popover of names, resolved via the existing `pMap` lookup already used for sender names/avatars.

**Tech Stack:** React + Vite, Supabase (Postgres + RLS + Realtime), `src/services/supabase/messageService.ts`, `src/hooks/useMessages.ts`, `src/App.jsx` (`MessagingTab`), `node --test` for the pure helper.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-07-07-message-reactions-design.md`.
- Fixed emoji set only: 👍 ❤️ 😂 😂 😮 😢 🙏 (no free-form emoji picker).
- One reaction per person per message. Tapping a new emoji replaces any existing one from that person; tapping the same emoji again removes it.
- No `pushNotif`/`addHist` side effects for reactions — this is a lightweight gesture, not a tracked action.
- No backfill: existing messages start with `reactions: {}` via the column default.
- Tests: `TZ=Europe/Paris npm test` must stay at 100% pass (63/63 as of the last commit on `main`).
- Every task ends with `npm run build` passing. No automated UI test harness exists in this project — verify UI changes with the manual browser check described in each task.
- `node_modules` isn't committed; run `npm install` once if `npm run build`/`npm test` fail with a "command not found" error.
- The SQL migration is run by the user in the Supabase SQL Editor (no DB credentials available in this environment) — the task that adds it ends with "hand the SQL to the user to run," not with running it yourself.

---

### Task 1: Migration — `reactions` column on `messages`

**Files:**
- Create: `supabase/migrations/0025_message_reactions.sql`

**Interfaces:**
- Produces: `messages.reactions JSONB NOT NULL DEFAULT '{}'::jsonb`.

- [ ] **Step 1: Write the migration file**

```sql
-- 0025_message_reactions.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Réactions emoji sur les messages (👍 ❤️ 😂 😮 😢 🙏).
--
-- Stockage : {emoji: [user_id, ...]} — une réaction par personne et par
-- message (appliquée côté client par toggleMessageReaction, pas en base).
-- Aucune nouvelle table ni canal realtime : messages a déjà un abonnement
-- postgres_changes qui traite tout UPDATE en remplaçant la ligne entière.
--
-- À exécuter APRÈS 0024. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 2: Introspection query for the user to confirm no pre-existing conflicting column**

Hand this to the user to run in the Supabase SQL Editor first:

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'messages' and column_name = 'reactions';
```

Expected: 0 rows.

- [ ] **Step 3: Hand the migration SQL to the user to run in the Supabase SQL Editor**

Wait for confirmation before starting Task 2.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0025_message_reactions.sql
git commit -m "Add reactions column to messages"
```

---

### Task 2: Pure helper — `toggleMessageReaction`

**Files:**
- Modify: `src/utils/core.js`
- Test: `src/utils/core.test.js`

**Interfaces:**
- Produces: `toggleMessageReaction(reactions: Record<string,string[]>|null|undefined, userId: string, emoji: string): Record<string,string[]>` — returns a NEW reactions object with `userId` removed from every emoji key, then re-added under `emoji` unless `userId` was already reacting with exactly `emoji` (in which case it stays removed — toggle off). Emoji keys that end up with an empty array are dropped entirely from the result.
- Consumed by: Task 5 (`reactToCloudMessage` in `App.jsx`).

- [ ] **Step 1: Write the failing tests**

Open `src/utils/core.test.js` first to confirm its exact style (each topic section adds its own `import {...} from "./core.js";` right before its tests — see the `formatActorName` section near the end of the file for the most recent example). Add at the end of the file:

```js
import { toggleMessageReaction } from "./core.js";

test("toggleMessageReaction : ajoute une réaction quand il n'y en avait aucune", () => {
  const result = toggleMessageReaction({}, "uid-a", "👍");
  assert.deepEqual(result, { "👍": ["uid-a"] });
});

test("toggleMessageReaction : change de réaction (l'ancienne disparaît)", () => {
  const result = toggleMessageReaction({ "👍": ["uid-a"] }, "uid-a", "❤️");
  assert.deepEqual(result, { "❤️": ["uid-a"] });
});

test("toggleMessageReaction : retaper la même réaction la retire (bascule off)", () => {
  const result = toggleMessageReaction({ "👍": ["uid-a"] }, "uid-a", "👍");
  assert.deepEqual(result, {});
});

test("toggleMessageReaction : ne touche pas aux réactions des autres personnes", () => {
  const result = toggleMessageReaction({ "👍": ["uid-a", "uid-b"] }, "uid-a", "❤️");
  assert.deepEqual(result, { "👍": ["uid-b"], "❤️": ["uid-a"] });
});

test("toggleMessageReaction : reactions null/undefined traité comme vide", () => {
  assert.deepEqual(toggleMessageReaction(null, "uid-a", "😂"), { "😂": ["uid-a"] });
  assert.deepEqual(toggleMessageReaction(undefined, "uid-a", "😂"), { "😂": ["uid-a"] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `toggleMessageReaction is not a function` (or undefined) on all 5 new tests.

- [ ] **Step 3: Implement the function**

Add to the end of `src/utils/core.js`:

```js
// ── Réactions emoji sur les messages ─────────────────────────────────────────
// Une seule réaction par personne et par message : poser un nouveau smiley
// remplace l'ancien ; retaper le smiley déjà posé le retire (bascule on/off).
// Retourne un NOUVEL objet (jamais de mutation) prêt à être envoyé tel quel
// comme valeur de la colonne JSONB `reactions`.
export function toggleMessageReaction(reactions, userId, emoji) {
  const source = reactions || {};
  const hadThisEmoji = (source[emoji] || []).includes(userId);
  const next = {};
  for (const [key, ids] of Object.entries(source)) {
    const filtered = ids.filter(id => id !== userId);
    if (filtered.length) next[key] = filtered;
  }
  if (!hadThisEmoji) next[emoji] = [...(next[emoji] || []), userId];
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: all tests pass, including the 5 new ones.

- [ ] **Step 5: Run the full suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 68`, `pass 68`, `fail 0` (63 pre-existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add toggleMessageReaction helper for message reactions"
```

---

### Task 3: `messageService.ts` — type and DB call

**Files:**
- Modify: `src/services/supabase/messageService.ts`

**Interfaces:**
- Produces: `DuviaMessage.reactions: Record<string, string[]>`, `setMessageReaction(id: string, reactions: Record<string,string[]>): Promise<void>`.
- Consumed by: Task 4 (`useMessages.ts`).

- [ ] **Step 1: Add `reactions` to the `DuviaMessage` interface**

Find:

```ts
export interface DuviaMessage {
  id: string;
  family_id: string;
  sender_id: string;
  sender_name: string | null;
  recipient_ids: string[];
  content: string;
  read_by: string[];
  created_at: string;
}
```

Replace with:

```ts
export interface DuviaMessage {
  id: string;
  family_id: string;
  sender_id: string;
  sender_name: string | null;
  recipient_ids: string[];
  content: string;
  read_by: string[];
  reactions: Record<string, string[]>;
  created_at: string;
}
```

- [ ] **Step 2: Add `setMessageReaction`**

Add to the end of `src/services/supabase/messageService.ts`:

```ts
export async function setMessageReaction(id: string, reactions: Record<string, string[]>): Promise<void> {
  const { error } = await supabase.from("messages").update({ reactions }).eq("id", id);
  if (error) throw error;
}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/services/supabase/messageService.ts
git commit -m "Add reactions field and setMessageReaction to messageService"
```

---

### Task 4: `useMessages.ts` — `react` method

**Files:**
- Modify: `src/hooks/useMessages.ts`

**Interfaces:**
- Consumes: `setMessageReaction` (Task 3).
- Produces: hook return value gains `react(id: string, reactions: Record<string,string[]>): Promise<void>`.
- Consumed by: Task 5 (`App.jsx` root, `reactToCloudMessage`).

- [ ] **Step 1: Import `setMessageReaction`**

Find:

```ts
import { type DuviaMessage, listMessages, sendMessage, markMessageRead } from "../services/supabase/messageService";
```

Replace with:

```ts
import { type DuviaMessage, listMessages, sendMessage, markMessageRead, setMessageReaction } from "../services/supabase/messageService";
```

- [ ] **Step 2: Add the `react` callback**

Find:

```ts
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

  return { msgs, loading, error, send, markRead, refresh };
```

Replace with:

```ts
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

  return { msgs, loading, error, send, markRead, react, refresh };
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useMessages.ts
git commit -m "Add react method to useMessages hook"
```

---

### Task 5: Wire `reactToCloudMessage` in the root `App()` component

**Files:**
- Modify: `src/App.jsx` — the `useMessages` destructuring (~line 2733), the `msgs` mapping (~line 2797), and `ctxValue` (~line 3974).

**Interfaces:**
- Consumes: `react` from `useMessages` (Task 4), `toggleMessageReaction` from `utils/core.js` (Task 2).
- Produces: `reactToCloudMessage(messageId: string, emoji: string): void` in scope for `ctxValue`; `msgs[].reactions` populated on every message object used by the UI.

- [ ] **Step 1: Import `toggleMessageReaction`**

Find (the big import from `./utils/core.js` — already modified several times this project; match whatever the current full list is and just add `toggleMessageReaction` to it):

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName } from './utils/core.js';
```

Replace with:

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction } from './utils/core.js';
```

If the import line has since changed (more names added by other work), keep everything already there and just append `toggleMessageReaction` — do not remove any existing imported name.

- [ ] **Step 2: Capture `react` from the hook**

Find:

```js
  const { msgs: cloudMsgs, send: _sendCloudMsg, markRead: markCloudMessageRead } = useMessages(familySync.familyId);
```

Replace with:

```js
  const { msgs: cloudMsgs, send: _sendCloudMsg, markRead: markCloudMessageRead, react: _reactCloudMsg } = useMessages(familySync.familyId);
```

- [ ] **Step 3: Add `reactions` to the `msgs` mapping**

Find:

```js
  const msgs = (cloudMsgs||[]).map(cm => {
    return {
      id: cm.id, from: cm.sender_id, fromName: cm.sender_name || "?",
      to: cm.recipient_ids || [], content: cm.content, ts: cm.created_at,
      readBy: cm.read_by || [],
      hash: hashMsg(cm.sender_id, cm.recipient_ids||[], cm.content, cm.created_at),
    };
  });
```

Replace with:

```js
  const msgs = (cloudMsgs||[]).map(cm => {
    return {
      id: cm.id, from: cm.sender_id, fromName: cm.sender_name || "?",
      to: cm.recipient_ids || [], content: cm.content, ts: cm.created_at,
      readBy: cm.read_by || [],
      reactions: cm.reactions || {},
      hash: hashMsg(cm.sender_id, cm.recipient_ids||[], cm.content, cm.created_at),
    };
  });

  // Applique toggleMessageReaction (retire/ajoute MA réaction) puis envoie le
  // résultat complet — reactions n'est jamais fusionné côté serveur, la valeur
  // envoyée remplace entièrement la colonne (cf. setMessageReaction).
  function reactToCloudMessage(messageId, emoji){
    if(!myUid) return;
    const cm = (cloudMsgs||[]).find(m=>m.id===messageId);
    if(!cm) return;
    const next = toggleMessageReaction(cm.reactions||{}, myUid, emoji);
    _reactCloudMsg(messageId, next);
  }
```

- [ ] **Step 4: Expose `reactToCloudMessage` via `ctxValue`**

Find:

```js
    msgs, sendCloudMessage, markCloudMessageRead, myUid,
```

Replace with:

```js
    msgs, sendCloudMessage, markCloudMessageRead, reactToCloudMessage, myUid,
```

(Single occurrence in `App.jsx` — confirmed via search before writing this plan.)

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Wire reactToCloudMessage in the root App component"
```

---

### Task 6: `MessagingTab` — long-press emoji picker

**Files:**
- Modify: `src/App.jsx` — add `MSG_REACTION_EMOJIS` constant near `PARENT_AVATARS` (~line 5901), and `MessagingTab`'s state + message bubble (~line 13907 for the destructuring, ~line 14333-14415 for the bubble).

**Interfaces:**
- Consumes: `reactToCloudMessage` (Task 5, via `useApp()`).
- Produces: `longPressMsgId` state and the floating emoji row, consumed visually by Task 7 (badges render as siblings of this same bubble block).

- [ ] **Step 1: Add the fixed emoji set**

Find:

```js
const PARENT_AVATARS = ["👩","👨","👩‍🦱","👨‍🦱","👩‍🦰","👨‍🦰","👩‍🦳","👨‍🦳","👩‍🦲","👨‍🦲","🧔","👱‍♀️","👱","🧑","👮‍♀️","👮","👩‍⚕️","👨‍⚕️","👩‍🏫","👨‍🏫","🧕","🧑‍🦱","🧑‍🦰","🧑‍🦳"];
```

Replace with:

```js
const PARENT_AVATARS = ["👩","👨","👩‍🦱","👨‍🦱","👩‍🦰","👨‍🦰","👩‍🦳","👨‍🦳","👩‍🦲","👨‍🦲","🧔","👱‍♀️","👱","🧑","👮‍♀️","👮","👩‍⚕️","👨‍⚕️","👩‍🏫","👨‍🏫","🧕","🧑‍🦱","🧑‍🦰","🧑‍🦳"];
// Réactions emoji sur les messages — jeu fixe volontairement limité (pas de
// sélecteur libre), voir docs/superpowers/specs/2026-07-07-message-reactions-design.md
const MSG_REACTION_EMOJIS = ["👍","❤️","😂","😮","😢","🙏"];
```

- [ ] **Step 2: Destructure `reactToCloudMessage` in `MessagingTab`**

Find:

```js
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,myUid,uidToLocal,localToUid,emailToUid,familySync}=useApp();
```

Replace with:

```js
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,reactToCloudMessage,myUid,uidToLocal,localToUid,emailToUid,familySync}=useApp();
```

- [ ] **Step 3: Add long-press state near the other message-view state**

Find (line 13912):

```js
  const [showProof,setShowProof]=useState(null);
```

Add right after it:

```js
  const [longPressMsgId,setLongPressMsgId]=useState(null); // id du message dont le picker de réactions est ouvert
  const [reactionPopover,setReactionPopover]=useState(null); // {msgId,emoji} — popover "qui a réagi" ouvert
  const longPressTimer=useRef(null);
  const longPressFired=useRef(false);
```

- [ ] **Step 4: Add long-press handlers and the floating picker to the message bubble**

Find:

```js
                    <div onClick={()=>setShowProof(showProof===m.id?null:m.id)} style={{
                      padding:att&&attIsImg?6:"10px 13px",
                      background:isMe?`linear-gradient(135deg,${col},${col}cc)`:C.sur,
                      color:isMe?"#fff":C.txt,
                      borderRadius:isMe?"18px 4px 18px 18px":"4px 18px 18px 18px",
                      fontSize:14,lineHeight:1.45,cursor:"pointer",
                      border:isMe?"none":`1px solid ${C.bor}`,
                      boxShadow:"0 1px 4px rgba(0,0,0,.08)",wordBreak:"break-word",
                      position:"relative"
                    }}>
```

Replace with:

```js
                    <div
                      onClick={()=>{ if(longPressFired.current){ longPressFired.current=false; return; } setShowProof(showProof===m.id?null:m.id); }}
                      onMouseDown={()=>{ longPressTimer.current=setTimeout(()=>{ longPressFired.current=true; setLongPressMsgId(m.id); },450); }}
                      onMouseUp={()=>clearTimeout(longPressTimer.current)}
                      onMouseLeave={()=>clearTimeout(longPressTimer.current)}
                      onTouchStart={()=>{ longPressTimer.current=setTimeout(()=>{ longPressFired.current=true; setLongPressMsgId(m.id); },450); }}
                      onTouchEnd={()=>clearTimeout(longPressTimer.current)}
                      onTouchCancel={()=>clearTimeout(longPressTimer.current)}
                      style={{
                      padding:att&&attIsImg?6:"10px 13px",
                      background:isMe?`linear-gradient(135deg,${col},${col}cc)`:C.sur,
                      color:isMe?"#fff":C.txt,
                      borderRadius:isMe?"18px 4px 18px 18px":"4px 18px 18px 18px",
                      fontSize:14,lineHeight:1.45,cursor:"pointer",
                      border:isMe?"none":`1px solid ${C.bor}`,
                      boxShadow:"0 1px 4px rgba(0,0,0,.08)",wordBreak:"break-word",
                      position:"relative"
                    }}>
                      {longPressMsgId===m.id&&(
                        <>
                          <div onClick={ev=>{ev.stopPropagation();setLongPressMsgId(null);}} style={{position:"fixed",inset:0,zIndex:398}} />
                          <div onClick={ev=>ev.stopPropagation()} style={{
                            position:"absolute",bottom:"100%",[isMe?"right":"left"]:0,marginBottom:6,
                            display:"flex",gap:2,background:"#fff",border:`1.5px solid ${C.bor}`,borderRadius:20,
                            padding:"4px 6px",boxShadow:"0 8px 24px rgba(0,0,0,.25)",zIndex:399,
                          }}>
                            {MSG_REACTION_EMOJIS.map(em=>(
                              <button key={em} onClick={ev=>{ev.stopPropagation();reactToCloudMessage(m.id,em);setLongPressMsgId(null);}}
                                style={{width:32,height:32,borderRadius:"50%",background:"transparent",border:"none",fontSize:19,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                {em}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 6: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 68`, `pass 68`, `fail 0` (this task touches no pure function in `core.js`, so the count from Task 2 is unchanged).

- [ ] **Step 7: Manual check**

`npm run dev` (or verify directly on `app.duvia.fr` after merging, matching this project's usual verification approach since a local `.env` isn't set up in this environment). Open the messaging tab, press and hold a message bubble for under a second — the row of 6 emoji should appear just above it. Confirm a quick tap still opens/closes the "Intégrité vérifiée" proof block as before (i.e. the long-press guard didn't break the existing tap behavior).

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "Add long-press emoji reaction picker to message bubbles"
```

---

### Task 7: `MessagingTab` — reaction badges and "who reacted" popover

**Files:**
- Modify: `src/App.jsx` — right after the message bubble's closing tag in `MessagingTab` (~line 14415-14426, immediately after Task 6's changes).

**Interfaces:**
- Consumes: `m.reactions` (Task 5), `reactionPopover`/`setReactionPopover` (Task 6), `pMap` (already in scope in `MessagingTab` — same lookup already used for `pMap[String(m.from)]?.color`/`?.avatar`/`?.name`).

- [ ] **Step 1: Add the badges row and popover**

Find (the closing of the bubble div, right before the "Proof hash" block — both already present in the file):

```js
                    </div>

                    {/* Proof hash — compact, discret */}
                    {showProof===m.id&&(
```

Replace with:

```js
                    </div>

                    {/* Réactions — badges par smiley + popover "qui a réagi" */}
                    {m.reactions && Object.entries(m.reactions).some(([,ids])=>ids.length>0) && (
                      <div style={{display:"flex",gap:4,marginTop:4,flexWrap:"wrap",justifyContent:isMe?"flex-end":"flex-start"}}>
                        {Object.entries(m.reactions).filter(([,ids])=>ids.length>0).map(([emoji,ids])=>(
                          <button key={emoji}
                            onClick={()=>setReactionPopover(reactionPopover&&reactionPopover.msgId===m.id&&reactionPopover.emoji===emoji?null:{msgId:m.id,emoji})}
                            style={{display:"flex",alignItems:"center",gap:3,padding:"2px 7px",background:C.sur,border:`1px solid ${C.bor}`,borderRadius:12,fontSize:12,cursor:"pointer"}}>
                            <span>{emoji}</span><span style={{fontSize:10,color:C.mut,fontWeight:700}}>{ids.length}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {reactionPopover&&reactionPopover.msgId===m.id&&(
                      <div style={{marginTop:4,padding:"6px 10px",background:C.card,border:`1px solid ${C.bor}`,borderRadius:10,fontSize:11,color:C.txt,boxShadow:"0 4px 12px rgba(0,0,0,.15)",maxWidth:220}}>
                        {reactionPopover.emoji} {(m.reactions[reactionPopover.emoji]||[]).map(uid=>pMap[String(uid)]?.name||"?").join(", ")}
                      </div>
                    )}

                    {/* Proof hash — compact, discret */}
                    {showProof===m.id&&(
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 68`, `pass 68`, `fail 0`.

- [ ] **Step 4: Manual check**

On `app.duvia.fr` (or local dev), long-press a message and tap 👍 — a badge "👍 1" should appear under the bubble. Tap the badge — a small popover should show your own name. From a second account/window, react to the same message with 👍 too — the badge should update to "👍 2" without a page refresh (realtime UPDATE already wired via `useMessages`'s existing subscription). Then long-press the same message again and tap 👍 a second time (as the same user) — the reaction should disappear (badge removed or count decremented).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Add reaction badges and who-reacted popover to messages"
```
