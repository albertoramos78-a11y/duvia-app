# Rating Response Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rating flow's binary (≥4★/<4★) message split with 5 distinct messages (one per star count), and add a post-submit call-to-action (contact support for 1-2★, share the app for 5★).

**Architecture:** Two pure lookup functions in `src/utils/core.js` map a star count (1-5) to i18n *key names* (never resolved text — core.js has no i18n awareness anywhere in this codebase, and these functions follow that convention so they stay trivially unit-testable). `App.jsx`'s `RatingTab` resolves those keys through the existing `t.key || "fallback"` pattern and renders the CTA button when present. No schema change, no new admin view — `ratings` table and `notify-rating` are untouched.

**Tech Stack:** React (`src/App.jsx`), plain JS pure functions (`src/utils/core.js`), i18n (`src/i18n/*.js`), Node's built-in test runner (`core.test.js`).

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-07-30-rating-response-messages-design.md` — read it if anything below is ambiguous.
- **Version bump on every push that changes app code:** `src/config.js`'s `APP_VERSION` and `public/sw.js`'s `SW_VERSION` must both move together. Current value is `"3.87"`; this plan bumps to `"3.88"`.
- **No schema change.** Do not touch the `ratings` table, `notify-rating`, or add any admin view — out of scope per the design doc.
- **The live preview (under the star selector) stays text-only, no CTA.** Only the post-submit thank-you screen gets a CTA button.
- **`core.js` functions return i18n *keys*, never resolved strings** — matches this file's existing convention (e.g. `matchFaqAnswer`, `resolveGuard`, etc. never reference `t`). Resolution to actual text happens in `App.jsx` via `t.key || "fallback"`.
- Test command: `TZ=Europe/Paris npm test` (the timezone matters — one existing regression test depends on it).
- This project's French is the reference language for i18n; other 4 languages (`en`, `de`, `es`, `pt`) get best-effort translations added in the same task, not skipped (per this project's standing rule to translate proactively).
- JSX changes need live manual verification in the running app — build + tests passing is not sufficient proof by itself for this project (per its standing rule; see Task 3).

---

### Task 1: Pure lookup functions in `core.js` + unit tests

**Files:**
- Modify: `src/utils/core.js` (append after the last export, `matchStatsIntent`, currently ending around line 1145)
- Modify: `src/utils/core.test.js` (append after the last test)

**Interfaces:**
- Produces: `ratingLiveHintFor(stars: number): string` — returns `"ratingHint1"` through `"ratingHint5"` for `stars` 1-5, or `""` for anything else (0, out of range, non-integer). Consumed by Task 3.
- Produces: `ratingThankYouFor(stars: number): { textKey: string, ctaAction: "contact" | "share" | null }` — returns `{ textKey: "ratingThanks1", ctaAction: "contact" }` for 1★, `{ textKey: "ratingThanks2", ctaAction: "contact" }` for 2★, `{ textKey: "ratingThanks3", ctaAction: null }` for 3★, `{ textKey: "ratingThanks4", ctaAction: null }` for 4★, `{ textKey: "ratingThanks5", ctaAction: "share" }` for 5★, and `{ textKey: "ratingThanks", ctaAction: null }` (the pre-existing generic key) for anything else. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Add to the end of `src/utils/core.test.js`:

```js
import { ratingLiveHintFor, ratingThankYouFor } from "./core.js";

test("ratingLiveHintFor : renvoie la bonne clé pour chaque note 1 à 5", () => {
  assert.equal(ratingLiveHintFor(1), "ratingHint1");
  assert.equal(ratingLiveHintFor(2), "ratingHint2");
  assert.equal(ratingLiveHintFor(3), "ratingHint3");
  assert.equal(ratingLiveHintFor(4), "ratingHint4");
  assert.equal(ratingLiveHintFor(5), "ratingHint5");
});

test("ratingLiveHintFor : valeur hors plage ou nulle -> chaîne vide (aucun aperçu avant sélection)", () => {
  assert.equal(ratingLiveHintFor(0), "");
  assert.equal(ratingLiveHintFor(6), "");
  assert.equal(ratingLiveHintFor(undefined), "");
});

test("ratingThankYouFor : notes basses (1-2) -> CTA contact", () => {
  assert.deepEqual(ratingThankYouFor(1), { textKey: "ratingThanks1", ctaAction: "contact" });
  assert.deepEqual(ratingThankYouFor(2), { textKey: "ratingThanks2", ctaAction: "contact" });
});

test("ratingThankYouFor : notes moyennes (3-4) -> pas de CTA", () => {
  assert.deepEqual(ratingThankYouFor(3), { textKey: "ratingThanks3", ctaAction: null });
  assert.deepEqual(ratingThankYouFor(4), { textKey: "ratingThanks4", ctaAction: null });
});

test("ratingThankYouFor : note maximale (5) -> CTA partage", () => {
  assert.deepEqual(ratingThankYouFor(5), { textKey: "ratingThanks5", ctaAction: "share" });
});

test("ratingThankYouFor : valeur hors plage -> repli sur la clé générique existante", () => {
  assert.deepEqual(ratingThankYouFor(0), { textKey: "ratingThanks", ctaAction: null });
  assert.deepEqual(ratingThankYouFor(99), { textKey: "ratingThanks", ctaAction: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `ratingLiveHintFor is not a function` (or similar import error), since neither function exists yet.

- [ ] **Step 3: Implement the functions**

Add to the end of `src/utils/core.js` (after `matchStatsIntent`):

```js
// ── Messages de réponse aux notes (RatingTab) ────────────────────────────────
// Renvoie des CLÉS i18n, jamais du texte résolu — ce fichier n'a aucune
// dépendance à `t` nulle part ailleurs, App.jsx fait la résolution
// `t.clé || "repli"` comme pour tout le reste de l'app.
const RATING_HINT_KEYS = ["ratingHint1", "ratingHint2", "ratingHint3", "ratingHint4", "ratingHint5"];

export function ratingLiveHintFor(stars) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return "";
  return RATING_HINT_KEYS[stars - 1];
}

const RATING_THANKYOU_BY_STARS = {
  1: { textKey: "ratingThanks1", ctaAction: "contact" },
  2: { textKey: "ratingThanks2", ctaAction: "contact" },
  3: { textKey: "ratingThanks3", ctaAction: null },
  4: { textKey: "ratingThanks4", ctaAction: null },
  5: { textKey: "ratingThanks5", ctaAction: "share" },
};

export function ratingThankYouFor(stars) {
  return RATING_THANKYOU_BY_STARS[stars] || { textKey: "ratingThanks", ctaAction: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: all tests pass, including the 6 new ones (no fail count increase from baseline).

- [ ] **Step 5: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add ratingLiveHintFor/ratingThankYouFor pure lookup functions"
```

---

### Task 2: i18n keys (5 languages)

**Files:**
- Modify: `src/i18n/fr.js` (reference language)
- Modify: `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: 12 new translation keys per language (`ratingHint1`-`ratingHint5`, `ratingThanks1`-`ratingThanks5`, `ratingCtaContact`, `ratingCtaShare`), consumed by Task 3.

- [ ] **Step 1: Add the French keys (reference language)**

In `src/i18n/fr.js`, find this existing block (around line 511-516):

```js
    ratingMsgHigh:"Merci beaucoup ! 😍",
    ratingMsgLow:"Merci 🙏 Dites-nous comment améliorer",
    ratingCommentLabel:"Votre commentaire",
    ratingOptional:"(optionnel)",
    ratingSubmit:"Envoyer mon avis",
    ratingThanks:"Merci pour votre retour !",
```

Replace it with (keeping `ratingMsgHigh`/`ratingMsgLow` — they become unused by App.jsx after Task 3 but removing now-orphaned keys is out of scope; leaving them is harmless):

```js
    ratingMsgHigh:"Merci beaucoup ! 😍",
    ratingMsgLow:"Merci 🙏 Dites-nous comment améliorer",
    ratingHint1:"Merci, on est vraiment désolés 😔",
    ratingHint2:"Merci pour votre franchise 😐",
    ratingHint3:"Merci, dites-nous comment on peut mieux faire 🙂",
    ratingHint4:"Merci beaucoup ! 😊",
    ratingHint5:"Merci infiniment ! 😍",
    ratingCommentLabel:"Votre commentaire",
    ratingOptional:"(optionnel)",
    ratingSubmit:"Envoyer mon avis",
    ratingThanks:"Merci pour votre retour !",
    ratingThanks1:"Nous sommes désolés que votre expérience n'ait pas été à la hauteur. Dites-nous ce qui ne va pas, on est là pour arranger ça.",
    ratingThanks2:"Merci pour ce retour honnête. On aimerait comprendre ce qui vous a gêné pour l'améliorer.",
    ratingThanks3:"Merci ! Un petit mot dans le commentaire sur ce qui pourrait être encore mieux nous aiderait beaucoup.",
    ratingThanks4:"Merci beaucoup ! Qu'est-ce qui manquerait pour un 5ème ⭐ ?",
    ratingThanks5:"Merci infiniment, ça nous touche énormément ! Si Duvia vous aide, partagez-le à d'autres parents séparés 💙",
    ratingCtaContact:"📩 Nous contacter",
    ratingCtaShare:"💙 Partager Duvia",
```

- [ ] **Step 2: Add English translations**

In `src/i18n/en.js`, find the equivalent `ratingMsgHigh`/`ratingMsgLow`/`ratingThanks` block (same relative position as fr.js) and add alongside it:

```js
    ratingHint1:"Thank you, we're really sorry 😔",
    ratingHint2:"Thanks for your honesty 😐",
    ratingHint3:"Thanks, tell us how we can do better 🙂",
    ratingHint4:"Thank you so much! 😊",
    ratingHint5:"Thank you so much! 😍",
```
```js
    ratingThanks1:"We're sorry your experience wasn't up to par. Tell us what's wrong, we're here to fix it.",
    ratingThanks2:"Thanks for this honest feedback. We'd like to understand what bothered you so we can improve.",
    ratingThanks3:"Thanks! A quick note in the comment about what could be even better would help a lot.",
    ratingThanks4:"Thank you so much! What would it take to get a 5th ⭐?",
    ratingThanks5:"Thank you so much, this means a lot to us! If Duvia helps you, share it with other separated parents 💙",
    ratingCtaContact:"📩 Contact us",
    ratingCtaShare:"💙 Share Duvia",
```

- [ ] **Step 3: Add German translations**

In `src/i18n/de.js`, same block:

```js
    ratingHint1:"Danke, das tut uns wirklich leid 😔",
    ratingHint2:"Danke für deine Ehrlichkeit 😐",
    ratingHint3:"Danke, sag uns, wie wir es besser machen können 🙂",
    ratingHint4:"Vielen Dank! 😊",
    ratingHint5:"Vielen herzlichen Dank! 😍",
```
```js
    ratingThanks1:"Es tut uns leid, dass deine Erfahrung nicht gut war. Sag uns, was nicht stimmt, wir kümmern uns darum.",
    ratingThanks2:"Danke für dieses ehrliche Feedback. Wir würden gerne verstehen, was dich gestört hat, um uns zu verbessern.",
    ratingThanks3:"Danke! Ein kurzer Kommentar dazu, was noch besser sein könnte, würde sehr helfen.",
    ratingThanks4:"Vielen Dank! Was würde für einen 5. ⭐ noch fehlen?",
    ratingThanks5:"Vielen herzlichen Dank, das bedeutet uns sehr viel! Wenn Duvia dir hilft, teile es mit anderen getrennt lebenden Eltern 💙",
    ratingCtaContact:"📩 Kontaktiere uns",
    ratingCtaShare:"💙 Duvia teilen",
```

- [ ] **Step 4: Add Spanish translations**

In `src/i18n/es.js`, same block:

```js
    ratingHint1:"Gracias, lo sentimos mucho 😔",
    ratingHint2:"Gracias por tu sinceridad 😐",
    ratingHint3:"Gracias, dinos cómo podemos mejorar 🙂",
    ratingHint4:"¡Muchas gracias! 😊",
    ratingHint5:"¡Muchísimas gracias! 😍",
```
```js
    ratingThanks1:"Sentimos que tu experiencia no haya sido buena. Cuéntanos qué falla, estamos aquí para solucionarlo.",
    ratingThanks2:"Gracias por esta opinión sincera. Nos gustaría entender qué te molestó para poder mejorar.",
    ratingThanks3:"¡Gracias! Unas palabras en el comentario sobre qué podría mejorar aún más nos ayudarían mucho.",
    ratingThanks4:"¡Muchas gracias! ¿Qué faltaría para una 5ª ⭐?",
    ratingThanks5:"¡Muchísimas gracias, significa mucho para nosotros! Si Duvia te ayuda, compártelo con otros padres separados 💙",
    ratingCtaContact:"📩 Contáctanos",
    ratingCtaShare:"💙 Compartir Duvia",
```

- [ ] **Step 5: Add Portuguese translations**

In `src/i18n/pt.js`, same block:

```js
    ratingHint1:"Obrigado, lamentamos mesmo 😔",
    ratingHint2:"Obrigado pela tua sinceridade 😐",
    ratingHint3:"Obrigado, diz-nos como podemos melhorar 🙂",
    ratingHint4:"Muito obrigado! 😊",
    ratingHint5:"Muitíssimo obrigado! 😍",
```
```js
    ratingThanks1:"Lamentamos que a tua experiência não tenha sido boa. Diz-nos o que não está bem, estamos aqui para resolver.",
    ratingThanks2:"Obrigado por esta opinião sincera. Gostávamos de perceber o que te incomodou para podermos melhorar.",
    ratingThanks3:"Obrigado! Umas palavras no comentário sobre o que poderia ser ainda melhor ajudavam muito.",
    ratingThanks4:"Muito obrigado! O que faltaria para uma 5ª ⭐?",
    ratingThanks5:"Muitíssimo obrigado, isto significa muito para nós! Se o Duvia te ajuda, partilha com outros pais separados 💙",
    ratingCtaContact:"📩 Contacta-nos",
    ratingCtaShare:"💙 Partilhar o Duvia",
```

- [ ] **Step 6: Verify the build still compiles**

Run: `npm run build`
Expected: `✓ built in` with no errors (catches any stray syntax mistake like a missing comma).

- [ ] **Step 7: Commit**

```bash
git add src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Add i18n keys for rating hints, thank-you messages, and CTAs"
```

---

### Task 3: Wire into `RatingTab` (`App.jsx`)

**Files:**
- Modify: `src/App.jsx:13598` (the `message` ternary)
- Modify: `src/App.jsx:13633-13656` (the `submitted` render block)

**Interfaces:**
- Consumes: `ratingLiveHintFor`, `ratingThankYouFor` from `src/utils/core.js` (Task 1); the 12 i18n keys from Task 2; `APP_URL` (already imported at the top of `App.jsx`, line 27); `sub`, `user` (already destructured in `RatingTab` via `const {C,t,cfg,user,sub,familySync,myUid} = useApp();`).
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Add the import**

Find the existing `core.js` import near the top of `src/App.jsx` (the long destructured import list starting `import { insertValidatedParent, ...`) and add `ratingLiveHintFor, ratingThankYouFor` to that same import list (do not create a second `from "./utils/core.js"` import line — this file has exactly one).

- [ ] **Step 2: Replace the live-preview `message` ternary**

Find (currently at `src/App.jsx:13598`):

```js
  const message = selected >= 4 ? (t.ratingMsgHigh||'Merci beaucoup ! 😍') : (t.ratingMsgLow||'Merci 🙏 Dites-nous comment améliorer');
```

Replace with:

```js
  const ratingHintKey = ratingLiveHintFor(selected);
  const RATING_HINT_FALLBACKS = {
    ratingHint1: "Merci, on est vraiment désolés 😔",
    ratingHint2: "Merci pour votre franchise 😐",
    ratingHint3: "Merci, dites-nous comment on peut mieux faire 🙂",
    ratingHint4: "Merci beaucoup ! 😊",
    ratingHint5: "Merci infiniment ! 😍",
  };
  const message = ratingHintKey ? (t[ratingHintKey] || RATING_HINT_FALLBACKS[ratingHintKey]) : "";
```

(The render site at `src/App.jsx:13700`, `{selected ? message : ""}`, is unchanged — `message` already conditionally renders only when `selected` is truthy, and `ratingLiveHintFor(0)` already returns `""` so this stays consistent.)

- [ ] **Step 3: Enrich the post-submit `submitted` block**

Find (currently at `src/App.jsx:13633-13640`):

```jsx
  if (submitted) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 20px",gap:14,animation:"ratingAppear .45s cubic-bezier(.16,1,.3,1) both"}}>
      <style>{`@keyframes ratingAppear{from{opacity:0;transform:scale(.88) translateY(12px)}to{opacity:1;transform:none}}`}</style>
      <span style={{fontSize:54}}>🎉</span>
      <div style={{fontSize:18,fontWeight:800,color:C.txt}}>{t.ratingThanks||"Merci pour votre retour !"}</div>
      <div style={{fontSize:13,color:C.mut}}>{"★".repeat(selected)}{"☆".repeat(5-selected)} ({selected}/5)</div>
      {comment && <div style={{marginTop:8,fontSize:13,color:C.mut,fontStyle:"italic",textAlign:"center",maxWidth:260,lineHeight:1.5}}>"{comment}"</div>}
      {avgStats?.total_count>0 && <div style={{marginTop:12,fontSize:12,color:C.mut}}>⭐ {avgStats.avg_stars}/5 · {avgStats.total_count} avis au total</div>}
```

Replace with:

```jsx
  if (submitted) {
    const { textKey: ratingThanksKey, ctaAction } = ratingThankYouFor(selected);
    const RATING_THANKYOU_FALLBACKS = {
      ratingThanks: "Merci pour votre retour !",
      ratingThanks1: "Nous sommes désolés que votre expérience n'ait pas été à la hauteur. Dites-nous ce qui ne va pas, on est là pour arranger ça.",
      ratingThanks2: "Merci pour ce retour honnête. On aimerait comprendre ce qui vous a gêné pour l'améliorer.",
      ratingThanks3: "Merci ! Un petit mot dans le commentaire sur ce qui pourrait être encore mieux nous aiderait beaucoup.",
      ratingThanks4: "Merci beaucoup ! Qu'est-ce qui manquerait pour un 5ème ⭐ ?",
      ratingThanks5: "Merci infiniment, ça nous touche énormément ! Si Duvia vous aide, partagez-le à d'autres parents séparés 💙",
    };
    const ratingThanksText = t[ratingThanksKey] || RATING_THANKYOU_FALLBACKS[ratingThanksKey];
    const code = sub?.refCode || user?.refCode || "";
    const inviteLink = `${APP_URL}?ref=${code}`;
    function handleShareClick() {
      const subj = encodeURIComponent(t.refShareEmailSubject || "Rejoins-moi sur Duvia 🏡");
      const body = encodeURIComponent((t.refShareEmailBody || "Salut !\n\nJe t'invite sur Duvia, l'app qui simplifie la coparentalité.\n\nTélécharge l'app et crée ton compte via ce lien : {link}\n\nÀ bientôt sur Duvia !").replace("{link}", inviteLink));
      window.open(`mailto:?subject=${subj}&body=${body}`);
    }
    return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 20px",gap:14,animation:"ratingAppear .45s cubic-bezier(.16,1,.3,1) both"}}>
      <style>{`@keyframes ratingAppear{from{opacity:0;transform:scale(.88) translateY(12px)}to{opacity:1;transform:none}}`}</style>
      <span style={{fontSize:54}}>🎉</span>
      <div style={{fontSize:18,fontWeight:800,color:C.txt,textAlign:"center",maxWidth:320,lineHeight:1.4}}>{ratingThanksText}</div>
      <div style={{fontSize:13,color:C.mut}}>{"★".repeat(selected)}{"☆".repeat(5-selected)} ({selected}/5)</div>
      {comment && <div style={{marginTop:8,fontSize:13,color:C.mut,fontStyle:"italic",textAlign:"center",maxWidth:260,lineHeight:1.5}}>"{comment}"</div>}
      {ctaAction === "contact" && (
        <a href={`mailto:duvia.services@gmail.com?subject=${encodeURIComponent("Retour sur mon expérience Duvia")}`}
           style={{marginTop:6,height:40,padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"center",background:C.vio,color:"#fff",fontSize:13,fontWeight:700,borderRadius:10,textDecoration:"none"}}>
          {t.ratingCtaContact||"📩 Nous contacter"}
        </a>
      )}
      {ctaAction === "share" && (
        <button onClick={handleShareClick}
           style={{marginTop:6,height:40,padding:"0 20px",background:C.vio,color:"#fff",fontSize:13,fontWeight:700,borderRadius:10}}>
          {t.ratingCtaShare||"💙 Partager Duvia"}
        </button>
      )}
      {avgStats?.total_count>0 && <div style={{marginTop:12,fontSize:12,color:C.mut}}>⭐ {avgStats.avg_stars}/5 · {avgStats.total_count} avis au total</div>}
```

Then find the closing of this block (currently):

```jsx
      )}
    </div>
  );

  return (
    <div style={{padding:"8px 0"}}>
```

Replace with (closing the `if (submitted) { ... }` block that was opened above, instead of the old bare `if (submitted) return (`):

```jsx
      )}
    </div>
    );
  }

  return (
    <div style={{padding:"8px 0"}}>
```

- [ ] **Step 4: Verify it builds cleanly**

Run: `npm run build`
Expected: build succeeds, no errors.

- [ ] **Step 5: Run the test suite**

Run: `TZ=Europe/Paris npm test`
Expected: all tests pass (baseline count + the 6 new ones from Task 1), no regressions.

- [ ] **Step 6: Live manual verification**

This is JSX/UI-facing — per this project's standing rule, build + tests passing is not sufficient proof by itself. Run `npm run dev`, open the app, navigate to the rating tab (☰ menu → "Donner mon avis"), and for each star count 1 through 5:
- Click that star count and confirm the live preview text under the stars matches the corresponding `ratingHint` copy (not the old generic 2-message split).
- Submit the rating and confirm the thank-you screen shows the corresponding `ratingThanks` copy.
- For 1★ and 2★: confirm the "📩 Nous contacter" button appears and its `href` is a `mailto:` link to `duvia.services@gmail.com`.
- For 3★ and 4★: confirm no CTA button appears.
- For 5★: confirm the "💙 Partager Duvia" button appears and clicking it opens a mail client draft (or the browser's mailto handler) with the referral link filled in.
- Switch the app to DARK theme and re-check at least one star count for a visual regression (contrast, button colors).

If a live browser check isn't possible in the current execution context, say so explicitly rather than asserting it works.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "Wire 5-message rating hints and post-submit CTA into RatingTab"
```

---

### Task 4: Version bump

**Files:**
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Bump both version constants**

In `src/config.js`, change:
```js
export const APP_VERSION = "3.87";
```
to:
```js
export const APP_VERSION = "3.88";
```

In `public/sw.js`, change:
```js
const SW_VERSION = "3.87";
```
to:
```js
const SW_VERSION = "3.88";
```

- [ ] **Step 2: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: all tests pass, `fail 0`.

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: `✓ built in` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.js public/sw.js
git commit -m "Bump version to 3.88"
```

- [ ] **Step 5: Push**

Once Task 3's live verification has passed:

```bash
git push
```
