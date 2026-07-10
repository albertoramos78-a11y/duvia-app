# Validation email à l'import de backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block a `.duvia` backup import when it clearly doesn't belong to the current family, and never let an import silently overwrite an email/phone the user already entered.

**Architecture:** Two new pure functions in `src/utils/core.js` (`hasMatchingParentEmail`, `mergeBackupArrayPreservingContact`), each with unit tests, then wired into the two existing App.jsx functions that already handle backup import (`applyDuviaBackupToCfg`, `handleImportBackupFile`) — no new files, no backend/RLS changes.

**Tech Stack:** React (single-file `src/App.jsx`), `src/utils/core.js` pure helpers + `node --test` (`src/utils/core.test.js`), i18n via `src/i18n/{fr,en,de,es,pt}.js`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-backup-import-email-validation-design.md` — every requirement in it must map to a task below.
- The block applies ONLY inside the existing `backupFid && currentFid && backupFid !== currentFid` branch (`App.jsx:6599`) — same-family imports get no new check, unchanged behavior.
- The block is a hard stop (no "continue anyway" dialog) — reuses the existing thrown-`Error`-with-a-code-string pattern already in `handleImportBackupFile`'s `catch` block (`App.jsx:6610-6619`), not a new UI mechanism.
- Email/phone preservation applies to `parents`, `children`, `observers` only — NOT `contacts` (per spec, that's a personal address book, not family-member accounts).
- French (`fr.js`) is the reference language; the new `backupErrEmailMismatch` key must be genuinely translated (not copy-pasted) in `en.js`, `de.js`, `es.js`, `pt.js`.
- Tests: `TZ=Europe/Paris npm test` must show all tests passing (111 existing + new tests from Task 1).
- Build: `npm run build` must succeed with no new errors/warnings beyond the pre-existing chunk-size warning.
- **Build+tests passing is NOT sufficient to call the App.jsx integration task (Task 2) done.** This repo has no component/rendering test framework — a runtime-only error (wrong variable, bad destructure) passes both cleanly and only shows up live in a browser. A recent change in this exact session shipped this way and crashed the live production app. Task 2 requires an explicit manual verification pass (see Task 2 Step 8) using `npm run dev` before the task is reported DONE — reporting DONE on build+tests alone is treated as incomplete.
- Per `CLAUDE.md`: bump `APP_VERSION` in `src/config.js` and `SW_VERSION` in `public/sw.js` together (current value `1.33` → `1.34`) as the final step of Task 2, since it's the task that ships user-visible app code.

---

### Task 1: `hasMatchingParentEmail` and `mergeBackupArrayPreservingContact` pure helpers

**Files:**
- Modify: `src/utils/core.js` (append at end of file, after `formatChildBirthdate`, currently ending at line 586)
- Modify: `src/utils/core.test.js` (append at end of file, currently ending at line 671)

**Interfaces:**
- Produces: `hasMatchingParentEmail(currentParents, backupParents)` → `boolean`. Both args are arrays of objects that may have an `email` string field (or be `undefined`/empty).
- Produces: `mergeBackupArrayPreservingContact(currentArr, backupArr)` → array. `currentArr` is the family's current array (parents/children/observers, may be `undefined`/empty); `backupArr` is the corresponding array parsed from the backup file (may not even be an array — malformed/legacy files).
- Both exported from `src/utils/core.js`. Task 2 imports and calls both.

- [ ] **Step 1: Write the failing tests**

Append to `src/utils/core.test.js`:

```js
import { hasMatchingParentEmail, mergeBackupArrayPreservingContact } from "./core.js";

test("hasMatchingParentEmail : au moins un email correspond → true", () => {
  const current = [{ email: "alice@example.com" }, { email: "bob@example.com" }];
  const backup  = [{ email: "someone-else@example.com" }, { email: "bob@example.com" }];
  assert.strictEqual(hasMatchingParentEmail(current, backup), true);
});

test("hasMatchingParentEmail : correspondance insensible à la casse et aux espaces", () => {
  const current = [{ email: "Alice@Example.com" }];
  const backup  = [{ email: "  alice@example.com  " }];
  assert.strictEqual(hasMatchingParentEmail(current, backup), true);
});

test("hasMatchingParentEmail : aucun email ne correspond → false", () => {
  const current = [{ email: "alice@example.com" }];
  const backup  = [{ email: "mallory@example.com" }];
  assert.strictEqual(hasMatchingParentEmail(current, backup), false);
});

test("hasMatchingParentEmail : famille actuelle sans aucun email → true (rien à comparer)", () => {
  const current = [{ email: "" }, {}];
  const backup  = [{ email: "mallory@example.com" }];
  assert.strictEqual(hasMatchingParentEmail(current, backup), true);
});

test("hasMatchingParentEmail : fichier sans aucun email de parent → true (rien à comparer)", () => {
  const current = [{ email: "alice@example.com" }];
  const backup  = [{ email: "" }, {}];
  assert.strictEqual(hasMatchingParentEmail(current, backup), true);
});

test("hasMatchingParentEmail : tableaux vides ou absents des deux côtés → true", () => {
  assert.strictEqual(hasMatchingParentEmail([], []), true);
  assert.strictEqual(hasMatchingParentEmail(undefined, undefined), true);
});

test("mergeBackupArrayPreservingContact : email+téléphone actuels conservés, reste du backup", () => {
  const current = [{ name: "Ancien nom", email: "actuel@example.com", phone: "0600000000", color: "#111" }];
  const backup  = [{ name: "Nouveau nom", email: "fichier@example.com", phone: "0699999999", color: "#fff" }];
  const result = mergeBackupArrayPreservingContact(current, backup);
  assert.deepStrictEqual(result, [{ name: "Nouveau nom", email: "actuel@example.com", phone: "0600000000", color: "#fff" }]);
});

test("mergeBackupArrayPreservingContact : champ actuel vide → valeur du backup utilisée", () => {
  const current = [{ name: "X", email: "", phone: "" }];
  const backup  = [{ name: "X", email: "fichier@example.com", phone: "0699999999" }];
  const result = mergeBackupArrayPreservingContact(current, backup);
  assert.deepStrictEqual(result, [{ name: "X", email: "fichier@example.com", phone: "0699999999" }]);
});

test("mergeBackupArrayPreservingContact : élément du backup sans correspondant actuel → inchangé", () => {
  const current = [{ name: "Parent 1", email: "actuel@example.com" }];
  const backup  = [
    { name: "Parent 1", email: "fichier@example.com" },
    { name: "Parent 2 (nouveau)", email: "nouveau@example.com" },
  ];
  const result = mergeBackupArrayPreservingContact(current, backup);
  assert.deepStrictEqual(result, [
    { name: "Parent 1", email: "actuel@example.com" },
    { name: "Parent 2 (nouveau)", email: "nouveau@example.com" },
  ]);
});

test("mergeBackupArrayPreservingContact : backupArr pas un tableau → renvoie currentArr tel quel", () => {
  const current = [{ name: "Parent 1", email: "actuel@example.com" }];
  assert.deepStrictEqual(mergeBackupArrayPreservingContact(current, undefined), current);
  assert.deepStrictEqual(mergeBackupArrayPreservingContact(current, null), current);
});

test("mergeBackupArrayPreservingContact : currentArr absent, backupArr avec des éléments → tous passent tels quels", () => {
  const backup = [{ name: "Parent 1", email: "fichier@example.com" }];
  assert.deepStrictEqual(mergeBackupArrayPreservingContact(undefined, backup), backup);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `hasMatchingParentEmail is not a function` / `mergeBackupArrayPreservingContact is not a function` (or similar `TypeError`), 11 new failing tests.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/utils/core.js`:

```js
// ── Import de backup : validation email + protection contact ────────────────
// Compare les emails de parents du fichier importé à ceux de la famille
// actuelle. Retourne true (laisse passer) dès qu'une correspondance existe
// OU que la comparaison est impossible (aucun email exploitable d'un côté ou
// de l'autre) — ne bloque que quand on peut prouver qu'aucun email ne
// correspond, jamais sur une absence de preuve.
export function hasMatchingParentEmail(currentParents, backupParents) {
  const norm = (list) => (list || [])
    .map(p => String(p?.email || "").trim().toLowerCase())
    .filter(Boolean);
  const currentEmails = norm(currentParents);
  const backupEmails = norm(backupParents);
  if (currentEmails.length === 0 || backupEmails.length === 0) return true;
  return backupEmails.some(e => currentEmails.includes(e));
}

// Fusionne un tableau importé (parents/children/observers) avec le tableau
// actuel, position par position : l'email et le téléphone déjà renseignés
// dans l'app ne sont jamais écrasés par le fichier — tout le reste (nom,
// avatar, couleur, etc.) vient du fichier. Un élément du backup sans
// correspondant actuel à la même position n'a rien à protéger.
export function mergeBackupArrayPreservingContact(currentArr, backupArr) {
  if (!Array.isArray(backupArr)) return currentArr || [];
  return backupArr.map((backupItem, i) => {
    const cur = (currentArr || [])[i];
    if (!cur) return backupItem;
    const merged = { ...backupItem };
    if (cur.email && String(cur.email).trim()) merged.email = cur.email;
    if (cur.phone && String(cur.phone).trim()) merged.phone = cur.phone;
    return merged;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: PASS — all tests in the file pass, including the 11 new ones (122 total tests in the full suite after this task: 111 existing + 11 new).

- [ ] **Step 5: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add hasMatchingParentEmail and mergeBackupArrayPreservingContact helpers

Pure logic for the backup-import email validation feature: detect when a
.duvia file's parent emails don't match the current family (permissive by
default — only blocks on a provable mismatch, never on missing data), and
merge an imported array while keeping already-entered email/phone values
instead of letting the file overwrite them."
```

---

### Task 2: Wire validation into the import flow

**Files:**
- Modify: `src/App.jsx` (import line, `applyDuviaBackupToCfg`, `handleImportBackupFile`)
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js` (1 new key each)
- Modify: `src/config.js`, `public/sw.js` (version bump)

**Interfaces:**
- Consumes: `hasMatchingParentEmail`, `mergeBackupArrayPreservingContact` from Task 1 (`src/utils/core.js`).
- Produces: nothing consumed by later tasks — this is the final task in the plan.

- [ ] **Step 1: Extend the core.js import line in App.jsx**

`src/App.jsx:23` currently reads (exact current content, verify before editing — this line changes often in this file's history):

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction, isMemberIdentityLocked, toggleGuardId, resolveCustomDateGuardians, guardianStripeBackground, guardianNamesLabel, makeSchoolHolIdentity, isConversationHidden, isConsentCharterValid, formatChildBirthdate } from './utils/core.js';
```

Add `hasMatchingParentEmail, mergeBackupArrayPreservingContact` to the end of the import list:

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction, isMemberIdentityLocked, toggleGuardId, resolveCustomDateGuardians, guardianStripeBackground, guardianNamesLabel, makeSchoolHolIdentity, isConversationHidden, isConsentCharterValid, formatChildBirthdate, hasMatchingParentEmail, mergeBackupArrayPreservingContact } from './utils/core.js';
```

If the line's exact current content differs from what's shown above (this file changes often), keep every existing imported name and only append the 2 new ones at the end — don't remove or reorder anything already there.

- [ ] **Step 2: Apply the merge helper in `applyDuviaBackupToCfg`**

`src/App.jsx:14454-14471` currently reads:

```js
function applyDuviaBackupToCfg(currentCfg, backup) {
  const b = backup || {};
  const fam = b.family || {};
  const cust = b.custody || {};
  const cal = b.calendar || {};
  return {
    ...currentCfg,
    parents: Array.isArray(fam.parents) ? fam.parents : (currentCfg?.parents || []),
    children: Array.isArray(fam.children) ? fam.children : (currentCfg?.children || []),
    observers: Array.isArray(fam.observers) ? fam.observers : (currentCfg?.observers || []),
    contacts: Array.isArray(fam.contacts) ? fam.contacts : (currentCfg?.contacts || []),
    custody: cust.main || currentCfg?.custody || {},
    custodyPerChild: cust.perChild || currentCfg?.custodyPerChild || {},
    sameGuardAll: typeof cust.sameGuardAll === "boolean" ? cust.sameGuardAll : (currentCfg?.sameGuardAll ?? true),
    overrides: cal.overrides || currentCfg?.overrides || {},
    specialDates: cal.specialDates || currentCfg?.specialDates || {},
  };
}
```

Replace the `parents`/`children`/`observers` lines (leave `contacts` and everything else untouched — per spec, `contacts` is out of scope):

```js
function applyDuviaBackupToCfg(currentCfg, backup) {
  const b = backup || {};
  const fam = b.family || {};
  const cust = b.custody || {};
  const cal = b.calendar || {};
  return {
    ...currentCfg,
    parents: mergeBackupArrayPreservingContact(currentCfg?.parents, fam.parents),
    children: mergeBackupArrayPreservingContact(currentCfg?.children, fam.children),
    observers: mergeBackupArrayPreservingContact(currentCfg?.observers, fam.observers),
    contacts: Array.isArray(fam.contacts) ? fam.contacts : (currentCfg?.contacts || []),
    custody: cust.main || currentCfg?.custody || {},
    custodyPerChild: cust.perChild || currentCfg?.custodyPerChild || {},
    sameGuardAll: typeof cust.sameGuardAll === "boolean" ? cust.sameGuardAll : (currentCfg?.sameGuardAll ?? true),
    overrides: cal.overrides || currentCfg?.overrides || {},
    specialDates: cal.specialDates || currentCfg?.specialDates || {},
  };
}
```

- [ ] **Step 3: Add the hard-block check in `handleImportBackupFile`**

`src/App.jsx:6591-6624` currently reads:

```js
  async function handleImportBackupFile(file) {
    setBackupImportErr(""); setBackupImportOk("");
    if (!file) return;
    setBackupImporting(true);
    try {
      const parsed = await readDuviaBackupFile(file);
      const currentFid = familySync?.familyId || null;
      const backupFid  = parsed._familyId || null;
      if (backupFid && currentFid && backupFid !== currentFid) {
        const okOther = window.confirm(t.backupOtherFamilyConfirm || "⚠️ Ce fichier provient d'une AUTRE famille.\n\nContinuer ? Vos données actuelles seront écrasées.");
        if (!okOther) { setBackupImporting(false); return; }
      }
      const okReplace = window.confirm(t.backupReplaceConfirm || "Cette opération va REMPLACER votre configuration famille, calendrier de garde et calendrier scolaire.\n\nUne sauvegarde automatique de vos données actuelles sera téléchargée avant.\n\nContinuer ?");
      if (!okReplace) { setBackupImporting(false); return; }
      const safety = buildDuviaBackup({ cfg, history, familyId: familySync?.familyId, lang, userEmail: user?.email, userId: user?.id });
      downloadDuviaBackup(safety, makeBackupFilename("duvia-backup-auto-avant-import"));
      setCfg(prev => applyDuviaBackupToCfg(prev, parsed));
      try { addHist?.({action:t.backupImported||"Sauvegarde importée", detail: parsed._exportedAt || "", type:"backup"}); } catch {}
      setBackupImportOk(t.backupImportOk || "Sauvegarde importée avec succès.");
    } catch (e) {
      const codes = {
        no_file: t.backupErrNoFile || "Aucun fichier.",
        file_too_large: t.backupErrTooLarge || "Fichier trop volumineux (>25 Mo).",
        invalid_json: t.backupErrInvalidJson || "Fichier illisible (JSON invalide).",
        not_duvia_file: t.backupErrNotDuvia || "Ce fichier n'est pas une sauvegarde Duvia.",
        invalid_version: t.backupErrInvalidVer || "Version de sauvegarde inconnue.",
        version_too_new: t.backupErrVerTooNew || "Cette sauvegarde a été créée avec une version plus récente de Duvia. Mettez à jour l'application.",
      };
      setBackupImportErr(codes[e?.message] || (t.backupImportFailed || "Impossible d'importer le fichier."));
    } finally {
      setBackupImporting(false);
      if (backupFileInputRef.current) backupFileInputRef.current.value = "";
    }
  }
```

Replace the `if (backupFid && currentFid && backupFid !== currentFid)` block and add the new error code to `codes`:

```js
  async function handleImportBackupFile(file) {
    setBackupImportErr(""); setBackupImportOk("");
    if (!file) return;
    setBackupImporting(true);
    try {
      const parsed = await readDuviaBackupFile(file);
      const currentFid = familySync?.familyId || null;
      const backupFid  = parsed._familyId || null;
      if (backupFid && currentFid && backupFid !== currentFid) {
        if (!hasMatchingParentEmail(cfg?.parents, parsed?.family?.parents)) {
          throw new Error("parent_email_mismatch");
        }
        const okOther = window.confirm(t.backupOtherFamilyConfirm || "⚠️ Ce fichier provient d'une AUTRE famille.\n\nContinuer ? Vos données actuelles seront écrasées.");
        if (!okOther) { setBackupImporting(false); return; }
      }
      const okReplace = window.confirm(t.backupReplaceConfirm || "Cette opération va REMPLACER votre configuration famille, calendrier de garde et calendrier scolaire.\n\nUne sauvegarde automatique de vos données actuelles sera téléchargée avant.\n\nContinuer ?");
      if (!okReplace) { setBackupImporting(false); return; }
      const safety = buildDuviaBackup({ cfg, history, familyId: familySync?.familyId, lang, userEmail: user?.email, userId: user?.id });
      downloadDuviaBackup(safety, makeBackupFilename("duvia-backup-auto-avant-import"));
      setCfg(prev => applyDuviaBackupToCfg(prev, parsed));
      try { addHist?.({action:t.backupImported||"Sauvegarde importée", detail: parsed._exportedAt || "", type:"backup"}); } catch {}
      setBackupImportOk(t.backupImportOk || "Sauvegarde importée avec succès.");
    } catch (e) {
      const codes = {
        no_file: t.backupErrNoFile || "Aucun fichier.",
        file_too_large: t.backupErrTooLarge || "Fichier trop volumineux (>25 Mo).",
        invalid_json: t.backupErrInvalidJson || "Fichier illisible (JSON invalide).",
        not_duvia_file: t.backupErrNotDuvia || "Ce fichier n'est pas une sauvegarde Duvia.",
        invalid_version: t.backupErrInvalidVer || "Version de sauvegarde inconnue.",
        version_too_new: t.backupErrVerTooNew || "Cette sauvegarde a été créée avec une version plus récente de Duvia. Mettez à jour l'application.",
        parent_email_mismatch: t.backupErrEmailMismatch || "Ce fichier ne correspond à aucun parent de cette famille. Import bloqué pour votre sécurité.",
      };
      setBackupImportErr(codes[e?.message] || (t.backupImportFailed || "Impossible d'importer le fichier."));
    } finally {
      setBackupImporting(false);
      if (backupFileInputRef.current) backupFileInputRef.current.value = "";
    }
  }
```

- [ ] **Step 4: Add the `backupErrEmailMismatch` i18n key to all 5 languages**

In `src/i18n/fr.js`, after line 575 (`backupErrVerTooNew:"Cette sauvegarde a été créée avec une version plus récente de Duvia. Mettez à jour l'application.",`), insert:

```js
    backupErrEmailMismatch:"Ce fichier ne correspond à aucun parent de cette famille. Import bloqué pour votre sécurité.",
```

In `src/i18n/en.js`, after line 524 (`backupErrVerTooNew:"This backup was created with a newer version of Duvia. Please update the app.",`), insert:

```js
    backupErrEmailMismatch:"This file doesn't match any parent in this family. Import blocked for your safety.",
```

In `src/i18n/de.js`, after line 522 (`backupErrVerTooNew:"Diese Sicherung wurde mit einer neueren Version von Duvia erstellt. Bitte aktualisieren Sie die App.",`), insert:

```js
    backupErrEmailMismatch:"Diese Datei entspricht keinem Elternteil dieser Familie. Import zu Ihrer Sicherheit blockiert.",
```

In `src/i18n/es.js`, after line 522 (`backupErrVerTooNew:"Esta copia se creó con una versión más reciente de Duvia. Actualiza la aplicación.",`), insert:

```js
    backupErrEmailMismatch:"Este archivo no corresponde a ningún progenitor de esta familia. Importación bloqueada por tu seguridad.",
```

In `src/i18n/pt.js`, after line 522 (`backupErrVerTooNew:"Esta cópia foi criada com uma versão mais recente do Duvia. Atualize a aplicação.",`), insert:

```js
    backupErrEmailMismatch:"Este ficheiro não corresponde a nenhum progenitor desta família. Importação bloqueada por segurança.",
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: succeeds, no new errors (the pre-existing "chunk larger than 500 kB" warning is expected and unrelated).

- [ ] **Step 6: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `122 passing` (111 existing + 11 from Task 1), 0 failing — this task adds no new test files, it only wires already-tested pure functions into JSX.

- [ ] **Step 7: Static check — confirm the wiring compiles and references resolve**

Run: `grep -n "hasMatchingParentEmail\|mergeBackupArrayPreservingContact" src/App.jsx`
Expected: 3 matches — the import line, the `applyDuviaBackupToCfg` usage (3 call sites: parents/children/observers), and the `handleImportBackupFile` usage. If any name doesn't appear exactly where expected, the import or a call site was mistyped — fix before proceeding to Step 8.

- [ ] **Step 8: Manual live verification (REQUIRED — build+tests passing is not sufficient for this task, see Global Constraints)**

Run: `npm run dev` and open the app in a browser. This step exists because this exact repo already shipped a JSX change this session that passed build+tests cleanly and then crashed the live app — a runtime-only error that neither `npm run build` nor `node --test` can catch, since there's no component-rendering test framework here.

Concretely verify, logged in as a parent with an existing family (Préférences tab → export/import backup section):

1. Export a backup (`.duvia` file) from the current family — confirms the export path still works (untouched by this task, but confirms your test family has data to work with).
2. Open that same exported `.duvia` file in a text editor, change its `_familyId` field to some other random string (e.g. `"totally-different-family-id"`), and change every `family.parents[].email` to something that isn't any current parent's email (e.g. `"nobody@example.com"`). Save it as a second file.
3. In the app, try importing this modified file. Expected: the import is blocked immediately with the new error message (`t.backupErrEmailMismatch`) shown in the UI where `backupImportErr` normally renders — no "continue anyway?" dialog appears at all for this case.
4. Edit the modified file again, this time changing one `family.parents[].email` back to an email that matches a real current parent (keep the different `_familyId`). Re-import. Expected: the block does NOT trigger — the existing "⚠️ fichier d'une autre famille, continuer ?" dialog appears as before (pre-existing, unchanged behavior).
5. Confirm that dialog, and check that a parent's email/phone (that had a value before the import) still shows their OLD value after the import completes, not the modified file's `nobody@example.com` — confirming the preservation merge worked, not just the block check.
6. Confirm the app is otherwise usable after each of the above (no white screen, no console errors) before considering this task done.

Report the actual outcome of steps 3-6 in the task report — don't just report "build and tests pass."

- [ ] **Step 9: Bump the app version**

Per `CLAUDE.md`, increment together in `src/config.js` (`APP_VERSION`) and `public/sw.js` (`SW_VERSION`) — check the current value in `src/config.js` first (it changes with every push) and increment by `0.01` (expected `1.33` → `1.34`, verify against the live file rather than assuming).

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js src/config.js public/sw.js
git commit -m "Block backup import on parent-email mismatch, protect saved contact info

When a .duvia file's _familyId differs from the current family AND none of
its parent emails match a current parent, the import is now blocked with a
clear error instead of only offering a skippable 'continue anyway?'
warning. Separately, importing (in any case) no longer lets the file
overwrite an already-entered parent/child/observer email or phone — only
empty fields get filled from the file, everything else in that record
still comes from the backup. See
docs/superpowers/specs/2026-07-10-backup-import-email-validation-design.md."
```
