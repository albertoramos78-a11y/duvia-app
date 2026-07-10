# Vérification email des parents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a parent (family creator or a second parent joining) to click a real confirmation link sent to the email they typed, before they can use the app — and remove the ways that requirement could currently be bypassed (SMS/WhatsApp invite sharing, a legacy invite path that skips creator approval).

**Architecture:** Three independent pieces, each touching `src/App.jsx` only (plus i18n): (1) trigger Supabase's native confirmation-link email on parent signup and gate app access behind `email_confirmed_at`, (2) restrict the parent-invite share UI to email only, (3) remove a legacy parent-join code path that bypassed the existing creator-approval step. No backend/RLS/migration changes — this reuses Supabase Auth's built-in confirmation mechanism, not a custom token system.

**Tech Stack:** React (single-file `src/App.jsx`), Supabase Auth (`signUp`, `resend`, `getUser`, `onAuthStateChange`), i18n via `src/i18n/{fr,en,de,es,pt}.js`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-parent-email-verification-design.md` — every requirement in it must map to a task below.
- Applies to parents ONLY (`metadata?.role === "parent"` at signup time, `user?.role === "parent"` at gate time). Children and observers are completely unaffected — do not touch their signup, invite-sharing, or approval code paths.
- No new backend table, RPC, or Edge Function — the entire mechanism is Supabase Auth's built-in `email_confirmed_at` field plus its native confirmation-link email, triggered via `supabase.auth.resend({type:"signup", ...})`. The project's global "Confirm email" login-gate setting stays OFF (unchanged) — this feature is an app-level gate on top, not a change to that setting.
- The blocking gate must never flash-render during initial load: the new `emailConfirmedAt` state starts as `undefined` ("not yet known" — never blocks) and only becomes a real value (`null` = unconfirmed, blocks; an ISO date string = confirmed, doesn't block) after `supabase.auth.getUser()` resolves.
- New i18n keys must be genuinely translated (not French copy-pasted) in `en.js`, `de.js`, `es.js`, `pt.js`, matching this repo's `t.key||"French fallback"` convention used everywhere else in the file (the one existing screen that doesn't follow this, the hardcoded `pendingApproval` screen at App.jsx:4198-4207, is a pre-existing inconsistency — do not copy it, use proper i18n for all new UI).
- Tests: `TZ=Europe/Paris npm test` must show all 122 existing tests still passing (this plan adds no new pure-logic functions, so no new test files).
- Build: `npm run build` must succeed with no new errors/warnings beyond the pre-existing chunk-size warning.
- **Build+tests passing is NOT sufficient to call this plan's tasks done** — this repo has no component/rendering test framework, and a runtime-only error (bad scope, undefined variable) passes both cleanly and only shows up live (see `[[feedback-verify-ui-changes-live]]`, a real prod crash happened this exact session from trusting build+tests alone on a JSX change). Each task's manual-verification step must actually be performed with `npm run dev` before reporting DONE, or explicitly disclosed as not performed and why.
- Per `CLAUDE.md`: bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together as the final step of the LAST task only (not every task — this plan ships as one coherent feature).

---

### Task 1: Trigger confirmation email + blocking gate screen

**Files:**
- Modify: `src/App.jsx` (`linkAccount` function ~line 2048-2073, new state + effect near the `user` state declaration ~line 3070, new early-return gate in `App()`'s render chain ~line 4198)
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js` (5 new keys each)

**Interfaces:**
- Produces: `emailConfirmedAt` state (`undefined | null | string`) inside `App()`, readable by later code in the same function. Not exported/shared with other tasks — Tasks 2 and 3 are independent of this one.

- [ ] **Step 1: Add `emailRedirectTo` and the confirmation-email trigger to `linkAccount`**

`src/App.jsx:2048-2073` currently reads:

```js
  // ── Inscription : crée le compte Supabase Auth et ouvre la session ────────
  async function linkAccount(email, password, metadata) {
    try {
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { data: metadata || {} },
      });
      if (error) {
        if (error.message?.includes("already registered"))
          return { ok: false, error: "already_registered" };
        throw error;
      }
      // signUp retourne une session directement si "Confirm email" est OFF
      if (!data?.session) {
        // Pas de session → on force la connexion
        const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
        if (signInErr) throw signInErr;
      }
      const getUserRes = await supabase.auth.getUser();
      const newUserId = getUserRes.data?.user?.id;
      // ── PostHog : tracking inscription ──
      if (newUserId) posthog.capture("signup", { role: metadata?.role || "unknown" });
      return { ok: true, userId: newUserId };
    } catch (e) {
      console.error("[Duvia][sync] linkAccount error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }
```

Replace with (adds `emailRedirectTo` to the signUp options, and — only for the parent role — an explicit `resend()` call right after, mirroring the existing `resetPasswordForEmail` redirect pattern at `App.jsx:5704`, `${APP_URL}/?reset=1`):

```js
  // ── Inscription : crée le compte Supabase Auth et ouvre la session ────────
  async function linkAccount(email, password, metadata) {
    try {
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: metadata || {}, emailRedirectTo: `${APP_URL}/?email_verified=1` },
      });
      if (error) {
        if (error.message?.includes("already registered"))
          return { ok: false, error: "already_registered" };
        throw error;
      }
      // signUp retourne une session directement si "Confirm email" est OFF
      if (!data?.session) {
        // Pas de session → on force la connexion
        const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
        if (signInErr) throw signInErr;
      }
      // 🔧 Vérification email obligatoire pour les parents (créateur ou 2e
      // parent) : on déclenche explicitement l'email de confirmation natif
      // Supabase, indépendamment du réglage global "Confirm email" (laissé
      // désactivé pour ne pas casser les comptes enfants/observateurs par
      // téléphone) — voir le garde-fou plein-écran plus bas dans App().
      if (metadata?.role === "parent") {
        try {
          await supabase.auth.resend({
            type: "signup", email,
            options: { emailRedirectTo: `${APP_URL}/?email_verified=1` },
          });
        } catch (resendErr) {
          console.warn("[Duvia][sync] confirmation email resend failed:", resendErr);
        }
      }
      const getUserRes = await supabase.auth.getUser();
      const newUserId = getUserRes.data?.user?.id;
      // ── PostHog : tracking inscription ──
      if (newUserId) posthog.capture("signup", { role: metadata?.role || "unknown" });
      return { ok: true, userId: newUserId };
    } catch (e) {
      console.error("[Duvia][sync] linkAccount error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }
```

- [ ] **Step 2: Add the `emailConfirmedAt` state and its effect**

`src/App.jsx:3070` currently reads:

```js
  const [user, setUser] = useState(() => {
```

Immediately after the full `user` state declaration (find the matching closing of that `useState(() => { ... });` block — it's a lazy initializer, read the surrounding 10-15 lines to find exactly where the statement ends before inserting), insert:

```js
  // 🔧 Vérification email parent : null = confirmé non fait (bloque), une
  // date = confirmé, undefined = pas encore su (ne bloque jamais, évite un
  // flash de l'écran de blocage pendant le chargement initial).
  const [emailConfirmedAt, setEmailConfirmedAt] = useState(undefined);
  useEffect(() => {
    if (!user || user.role !== "parent") return;
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setEmailConfirmedAt(data?.user?.email_confirmed_at ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "USER_UPDATED" && session?.user) {
        setEmailConfirmedAt(session.user.email_confirmed_at ?? null);
      }
    });
    return () => { cancelled = true; sub?.subscription?.unsubscribe(); };
  }, [user?.id, user?.role]);
```

- [ ] **Step 3: Add the blocking gate screen**

`src/App.jsx:4198` currently reads:

```js
  if(familySync.pendingApproval) return (
```

Insert a new early-return immediately BEFORE this line (so email verification is checked first):

```js
  if(user?.role === "parent" && emailConfirmedAt === null) {
    async function handleResendVerification() {
      try {
        await supabase.auth.resend({
          type: "signup", email: user.email,
          options: { emailRedirectTo: `${APP_URL}/?email_verified=1` },
        });
        setResendMsg(t.parentEmailVerifyResendOk || "Email renvoyé.");
      } catch (e) {
        setResendMsg(e.message || "Erreur.");
      }
    }
    async function handleRefreshVerification() {
      const { data } = await supabase.auth.getUser();
      setEmailConfirmedAt(data?.user?.email_confirmed_at ?? null);
    }
    return (
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C.bg}}>
        <div style={{textAlign:"center",maxWidth:340}}>
          <div style={{fontSize:40,marginBottom:10}}>✉️</div>
          <div style={{fontWeight:900,fontSize:17,marginBottom:8,color:C.txt}}>{t.parentEmailVerifyTitle||"Vérifie ton email"}</div>
          <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:20}}>{(t.parentEmailVerifyBody||"Un email de confirmation a été envoyé à {email}. Clique sur le lien qu'il contient pour accéder à l'application.").replace("{email}", user.email||"")}</div>
          {resendMsg && <div style={{fontSize:12,color:C.grn,marginBottom:14}}>{resendMsg}</div>}
          <button onClick={handleRefreshVerification} style={{height:44,padding:"0 20px",background:C.vio,color:"#fff",border:"none",fontSize:13,fontWeight:700,borderRadius:10,marginRight:10,marginBottom:10}}>{t.parentEmailVerifyRefresh||"J'ai vérifié, actualiser"}</button>
          <button onClick={handleResendVerification} style={{height:44,padding:"0 20px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13,borderRadius:10,marginBottom:10}}>{t.parentEmailVerifyResend||"Renvoyer l'email"}</button>
          <div>
            <button onClick={()=>handleSetUser(null)} style={{height:36,padding:"0 16px",background:"transparent",color:C.mut,border:"none",fontSize:12,textDecoration:"underline"}}>{t.logout||"Se déconnecter"}</button>
          </div>
        </div>
      </div>
    );
  }

```

Add the `resendMsg` state this block references — insert it right next to the `emailConfirmedAt` state added in Step 2:

```js
  const [resendMsg, setResendMsg] = useState("");
```

- [ ] **Step 4: Add the 5 new i18n keys to all 5 languages**

In `src/i18n/fr.js`, after line 512 (`invErrInvalid:"⚠️ Lien d'invitation invalide ou erreur. Réessaie.",`), insert:

```js
    parentEmailVerifyTitle:"Vérifie ton email",
    parentEmailVerifyBody:"Un email de confirmation a été envoyé à {email}. Clique sur le lien qu'il contient pour accéder à l'application.",
    parentEmailVerifyRefresh:"J'ai vérifié, actualiser",
    parentEmailVerifyResend:"Renvoyer l'email",
    parentEmailVerifyResendOk:"Email renvoyé.",
```

In `src/i18n/en.js`, find the equivalent `invErrInvalid:` line and insert immediately after:

```js
    parentEmailVerifyTitle:"Verify your email",
    parentEmailVerifyBody:"A confirmation email was sent to {email}. Click the link inside it to access the app.",
    parentEmailVerifyRefresh:"I've verified, refresh",
    parentEmailVerifyResend:"Resend email",
    parentEmailVerifyResendOk:"Email resent.",
```

In `src/i18n/de.js`, find the equivalent `invErrInvalid:` line and insert immediately after:

```js
    parentEmailVerifyTitle:"Bestätige deine E-Mail",
    parentEmailVerifyBody:"Eine Bestätigungs-E-Mail wurde an {email} gesendet. Klicke auf den Link darin, um auf die App zuzugreifen.",
    parentEmailVerifyRefresh:"Ich habe bestätigt, aktualisieren",
    parentEmailVerifyResend:"E-Mail erneut senden",
    parentEmailVerifyResendOk:"E-Mail erneut gesendet.",
```

In `src/i18n/es.js`, find the equivalent `invErrInvalid:` line and insert immediately after:

```js
    parentEmailVerifyTitle:"Verifica tu email",
    parentEmailVerifyBody:"Se envió un email de confirmación a {email}. Haz clic en el enlace para acceder a la aplicación.",
    parentEmailVerifyRefresh:"Ya verifiqué, actualizar",
    parentEmailVerifyResend:"Reenviar email",
    parentEmailVerifyResendOk:"Email reenviado.",
```

In `src/i18n/pt.js`, find the equivalent `invErrInvalid:` line and insert immediately after:

```js
    parentEmailVerifyTitle:"Verifica o teu email",
    parentEmailVerifyBody:"Um email de confirmação foi enviado para {email}. Clica no link para aceder à aplicação.",
    parentEmailVerifyRefresh:"Já verifiquei, atualizar",
    parentEmailVerifyResend:"Reenviar email",
    parentEmailVerifyResendOk:"Email reenviado.",
```

(The exact surrounding line numbers in en/de/es/pt weren't captured verbatim in the plan — find `invErrInvalid:` in each file via search, since the key exists in all 5 per the shared invite-error pattern, and insert right after it in each.)

- [ ] **Step 5: Build and test**

Run: `npm run build`
Expected: succeeds, no new errors.

Run: `TZ=Europe/Paris npm test`
Expected: `122 passing`, unchanged.

- [ ] **Step 6: Manual verification with `npm run dev` (required, see Global Constraints)**

Register a brand-new parent account (family creator) with a real, checkable email address. Verify:
1. After registration, instead of the normal app, the "Vérifie ton email" screen appears.
2. A confirmation email actually arrives at that address (check the inbox).
3. Clicking "Renvoyer l'email" doesn't error (Supabase's own rate-limit may reject a second click within ~60s — that's expected, not a bug).
4. Clicking the link in the email redirects back to the app; either the screen auto-clears (same-tab `USER_UPDATED` detection) or clicking "J'ai vérifié, actualiser" clears it.
5. Confirm a CHILD or OBSERVER account (real email or phone) is completely unaffected — no verification screen ever appears for them.
6. Confirm an EXISTING already-verified parent logging in normally never sees this screen.

Report the actual outcome of each numbered check in the task report.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Require parent email confirmation before app access

New parents (creator or a second parent joining) must click a Supabase
confirmation-link email before the app unblocks — the account is created
immediately (global 'Confirm email' setting stays off, so nothing breaks
for children/observers), but a new App()-level gate blocks access until
email_confirmed_at is set. Children/observers and already-verified
parents are unaffected.
See docs/superpowers/specs/2026-07-10-parent-email-verification-design.md."
```

---

### Task 2: Restrict parent invite sharing to email only

**Files:**
- Modify: `src/App.jsx` (`ParentInviteShareBtns`, lines 8259-8322)

**Interfaces:**
- Consumes: nothing from Task 1. Independent.
- Produces: nothing consumed elsewhere. Independent, final task boundary.

- [ ] **Step 1: Remove the SMS and WhatsApp channels**

`src/App.jsx:8259-8322` currently reads:

```jsx
function ParentInviteShareBtns({ C, parent, familyName }) {
  const { t } = useApp();
  function cleanPhoneWA(phone) {
    if (!phone) return null;
    let p = phone.replace(/[\s.\-()+]/g, "");
    if (p.startsWith("00")) p = p.slice(2);
    else if (p.startsWith("0")) p = "33" + p.slice(1);
    return p || null;
  }

  const msg = `Bonjour 👋\n${familyName} t'invite à rejoindre la famille sur Duvia.\nCrée ton compte ici :\n${parent.inviteUrl}`;

  function handleSMS() {
    const phone = parent.invitePhone ? parent.invitePhone.replace(/[\s.\-()+]/g,"") : "";
    window.open(`sms:${phone}?&body=${encodeURIComponent(msg)}`, "_blank");
  }

  function handleWhatsApp() {
    const phone = cleanPhoneWA(parent.invitePhone);
    window.open(`https://wa.me/${phone||""}?text=${encodeURIComponent(msg)}`, "_blank");
  }

  function handleEmail() {
    const subject = encodeURIComponent(`Rejoins notre famille sur Duvia 👨‍👩‍👧`);
    const href = `mailto:${parent.inviteEmail||""}?subject=${subject}&body=${encodeURIComponent(msg)}`;
    const a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.bor}`}}>
      <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>
        {t.sendInviteLink}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button onClick={handleSMS} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:"#25D36618",color:"#128C7E",border:"1.5px solid #25D36644",
        }}>💬 SMS</button>
        <button onClick={handleWhatsApp} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:"#25D36618",color:"#25D366",border:"1.5px solid #25D36644",
        }}>📱 WhatsApp</button>
        <button onClick={handleEmail} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`,
        }}>✉️ Email</button>
      </div>
      {!parent.invitePhone && (
        <div style={{fontSize:10,color:C.mut,marginTop:5}}>
          {t.reinviteNumberTip}
        </div>
      )}
      {!parent.invitePhone && (
        <div style={{fontSize:10,color:C.mut,marginTop:5}}>
          {t.reinviteNumberTip}
        </div>
      )}
    </div>
  );
}
```

Replace with (email-only; also drops the phone-tip block entirely, since it referenced SMS/WhatsApp phone requirements that no longer apply, and was duplicated verbatim in the original — not a typo to preserve):

```jsx
function ParentInviteShareBtns({ C, parent, familyName }) {
  const { t } = useApp();
  const msg = `Bonjour 👋\n${familyName} t'invite à rejoindre la famille sur Duvia.\nCrée ton compte ici :\n${parent.inviteUrl}`;

  function handleEmail() {
    const subject = encodeURIComponent(`Rejoins notre famille sur Duvia 👨‍👩‍👧`);
    const href = `mailto:${parent.inviteEmail||""}?subject=${subject}&body=${encodeURIComponent(msg)}`;
    const a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.bor}`}}>
      <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>
        {t.sendInviteLink}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button onClick={handleEmail} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`,
        }}>✉️ Email</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build and test**

Run: `npm run build` — expect success.
Run: `TZ=Europe/Paris npm test` — expect `122 passing`, unchanged.

- [ ] **Step 3: Manual verification with `npm run dev`**

Open the family-config screen as a parent, trigger a parent invite (the two call sites are `App.jsx:7663` and `App.jsx:7914` per the pre-change line numbers — search `<ParentInviteShareBtns` to find them post-Task-1-edits, since Task 1 may have shifted line numbers). Confirm only the "✉️ Email" button appears, no SMS/WhatsApp buttons, and clicking it still opens a `mailto:` draft correctly.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "Restrict parent invite sharing to email only

Removes the SMS and WhatsApp share buttons from ParentInviteShareBtns —
only email proves the recipient controls that inbox, which the new
email-confirmation gate (this session) depends on being the actual
channel used. Child/observer invites are untouched, still all channels.
See docs/superpowers/specs/2026-07-10-parent-email-verification-design.md."
```

---

### Task 3: Remove the legacy parent-join path that bypassed approval

**Files:**
- Modify: `src/App.jsx` (`doReg`, lines 5588-5625)
- Modify: `src/config.js`, `public/sw.js` (version bump — final task of the plan)

**Interfaces:**
- Consumes: nothing from Tasks 1 or 2. Independent.
- Produces: nothing consumed elsewhere. Final task.
- No new i18n keys — reuses the existing `t.invErrInvalid` key already used by the sibling `newStyle` branch's error path.

- [ ] **Step 1: Remove the legacy branch, add a graceful error instead**

`src/App.jsx:5588-5625` currently reads:

```js
    let parentInviteWaiting = false;
    if(finalRole==="parent"){
      if(isParentInvite && obsInviteCode.newStyle){
        // 🔗 Nouveau format : rejoindre en "pending" via le token — écran d'attente.
        const joinRes = await familySync.joinFamilyByToken(obsInviteCode.code, { name: cleanName, gender: parentGender||"M" });
        if(joinRes.ok){
          try{ window.localStorage.setItem("duvia_family_id", joinRes.familyId); }catch{}
          parentInviteWaiting = true;
        } else {
          setErr(
            joinRes.error==="expired" ? t.invErrExpired :
            joinRes.error==="used"    ? t.invErrUsed :
            t.invErrInvalid
          );
        }
      } else if(isParentInvite && obsInviteCode.family){

        // 🔗 Maintenant que le compte Auth existe, rejoindre la famille via le lien d'invitation
        const joinRes = await familySync.joinFamily(obsInviteCode.family);
        if(joinRes.ok){
          // ✅ Délai 100ms pour laisser le useEffect remettre skipNextSave à false
          // après le setCfg(famRow.data) dans joinFamily — sinon cette MAJ n'est pas
          // envoyée à Supabase et le Parent 1 ne voit pas que le Parent 2 a rejoint.
          await new Promise(r => setTimeout(r, 100));
          setCfg(c=>{
            const p=[...(c.parents||[])];
            while(p.length<2) p.push({});
            p[1] = {...p[1], name:cleanName, email:cleanEmail,
              gender:parentGender||p[1]?.gender||"M",
              phone:parentPhone.trim()||p[1]?.phone||"",
              inviteStatus:"accepted"};
            return {...c, parents:p};
          });
        } else {
          console.warn("[Duvia] Auto-join family failed:", joinRes.error);
        }
      }
    }
```

Replace with:

```js
    let parentInviteWaiting = false;
    if(finalRole==="parent"){
      if(isParentInvite && obsInviteCode.newStyle){
        // 🔗 Nouveau format : rejoindre en "pending" via le token — écran d'attente.
        const joinRes = await familySync.joinFamilyByToken(obsInviteCode.code, { name: cleanName, gender: parentGender||"M" });
        if(joinRes.ok){
          try{ window.localStorage.setItem("duvia_family_id", joinRes.familyId); }catch{}
          parentInviteWaiting = true;
        } else {
          setErr(
            joinRes.error==="expired" ? t.invErrExpired :
            joinRes.error==="used"    ? t.invErrUsed :
            t.invErrInvalid
          );
        }
      } else if(isParentInvite && obsInviteCode.family){
        // 🔧 Ancien format de lien d'invitation parent (pré-token) retiré :
        // il contournait la validation du créateur (inviteStatus:"accepted"
        // immédiat, sans passer par le statut pending). Toutes les
        // invitations parent utilisent désormais le format à token —
        // ce cas ne devrait plus survenir qu'avec un très ancien lien
        // enregistré ailleurs (favori, message déjà envoyé, etc.).
        setErr(t.invErrInvalid);
      }
    }
```

Note: `cleanEmail`, `parentPhone`, `setCfg` may become unused-in-this-branch after this edit — check the rest of `doReg` (the full function, not just this snippet) still uses them elsewhere before removing any now-unused local variables; do not remove a variable still referenced later in the same function.

- [ ] **Step 2: Build and test**

Run: `npm run build` — expect success.
Run: `TZ=Europe/Paris npm test` — expect `122 passing`, unchanged.

- [ ] **Step 3: Manual verification with `npm run dev`**

This legacy path is hard to trigger deliberately (it required an old-format invite link/object shape that the app no longer generates) — a full live repro isn't expected. Instead, verify by reading: confirm no other code path still constructs an `obsInviteCode` object with a `.family` property but no `.newStyle` (search `obsInviteCode` assignments), so this branch is confirmed genuinely dead for the current invite-link format going forward, not still reachable through some other flow this plan didn't touch. Report what you found.

- [ ] **Step 4: Bump the app version**

Per `CLAUDE.md`, increment together in `src/config.js` (`APP_VERSION`) and `public/sw.js` (`SW_VERSION`) — read the current value first, don't assume a number, increment by `0.01`. This is the final task of the plan, so this is the one version bump for the whole feature.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Close legacy parent-invite path that bypassed creator approval

The pre-token parent invite format merged a second parent directly with
inviteStatus:\"accepted\", skipping the pending/validateMember review the
modern token-based flow already requires. All parent invites now use the
token format (Task 2 removed the SMS/WhatsApp sharing that made an old
link format's continued existence more likely to matter); this path now
shows the existing invite-error message instead of silently granting
unapproved access.
See docs/superpowers/specs/2026-07-10-parent-email-verification-design.md."
```
