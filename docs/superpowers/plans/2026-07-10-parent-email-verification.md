# Vérification email des parents Implementation Plan (RÉVISÉ)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Révision (2026-07-10)

This plan's original Task 1 (native Supabase `email_confirmed_at`) was implemented, reviewed, and then invalidated by a live test: with the project's "Confirm email" setting off, `email_confirmed_at` is populated immediately at `signUp()`, before any link is sent — it never signals "the user clicked the link." That commit (`008ff6f`) is already on `main`; this plan does not revert it, it replaces the flawed parts with a working mechanism. The controller has already written and the user has already deployed, directly (not via subagent, per this session's established pattern for anything requiring live Supabase/dashboard coordination):
- `supabase/migrations/0029_parent_email_verification.sql` (new `parent_email_verifications` table + `verify_parent_email(token)` RPC) — **run successfully in the SQL editor, confirmed by the user ("Success. No rows returned").**
- `supabase/functions/send-parent-verification-email/index.ts` (new Edge Function, generates the token, sends the email via Resend) — **created and deployed in the dashboard, confirmed by the user ("fait").**

**This plan covers only what's left**: wiring the client (`src/App.jsx`) to use these two new server-side pieces instead of the old native mechanism, plus the two unrelated tasks from the original plan (restrict parent invites to email-only, close the legacy join path) which are unaffected by this change and were never started.

**Goal:** Require a parent (family creator or a second parent joining) to click a real confirmation link sent to the email they typed, before they can use the app — using the new custom token mechanism — and remove the ways that requirement could currently be bypassed (SMS/WhatsApp invite sharing, a legacy invite path that skips creator approval).

**Architecture:** Task 1 (this plan's only remaining complex task) rewires `src/App.jsx`'s already-existing gate scaffolding (state, effect, blocking screen — all already committed) to read `user_metadata.email_verified` instead of `email_confirmed_at`, call the new Edge Function instead of `supabase.auth.resend()`, and add a new URL-param handler that calls the new RPC when `?verify_email=<token>` is present. Tasks 2 and 3 are unrelated, independent, untouched by the revision.

**Tech Stack:** React (single-file `src/App.jsx`), Supabase (`functions.invoke`, `rpc`, `getUser`), i18n via `src/i18n/{fr,en,de,es,pt}.js`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-parent-email-verification-design.md` (see the "Révision" section at the top and the revised sections 1-2) — every requirement in it must map to a task below.
- Applies to parents ONLY. Children and observers are completely unaffected — do not touch their signup, invite-sharing, or approval code paths.
- The `parent_email_verifications` table and `verify_parent_email` RPC already exist live (migration 0029, confirmed run) — do not write another migration for them. The `send-parent-verification-email` Edge Function already exists live (confirmed deployed) — do not write another Edge Function.
- The blocking gate must never flash-render during initial load: `emailVerified` starts `undefined` (never blocks) and only becomes a real value (`false` = unverified, blocks; `true` = verified, doesn't block) after `supabase.auth.getUser()` resolves.
- New/changed i18n keys must be genuinely translated (not French copy-pasted) in `en.js`, `de.js`, `es.js`, `pt.js`.
- Tests: `TZ=Europe/Paris npm test` must show all 122 existing tests passing (no new pure-logic functions).
- Build: `npm run build` must succeed with no new errors/warnings beyond the pre-existing chunk-size warning.
- **Build+tests passing is NOT sufficient to call this plan's tasks done.** This repo has no component/rendering test framework, and this exact feature already had one flawed mechanism ship past build+tests because the flaw was only visible live. Each task's manual-verification step must be actually performed or explicitly disclosed as not performed and why — see `[[feedback-verify-ui-changes-live]]`. **No browser or email tooling is available to subagents in this environment** — an implementer cannot register an account or click an email link; do what's actually possible (static tracing against the diff, dev-server-boot check) and disclose the rest.
- Per `CLAUDE.md`: bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together as the final step of the LAST task only (Task 3).

---

### Task 1: Rewire the client to the new token-based verification

**Files:**
- Modify: `src/App.jsx` (`linkAccount` ~line 2048-2089, state+effect ~line 3109-3126, new mount-time effect for the `?verify_email=` URL param, gate screen's button handlers ~line 4232-4261)
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js` (no new keys — the 5 `parentEmailVerify*` keys from the previous task already exist and are reused as-is; only verify they're still referenced correctly, don't add or remove any)

**Interfaces:**
- Consumes: the live `send-parent-verification-email` Edge Function (invoked via `supabase.functions.invoke("send-parent-verification-email", {body:{user_id, email}})`, requires an `Authorization` header — `supabase.functions.invoke` sends the current session's JWT automatically, no manual header needed) and the live `verify_parent_email(p_token TEXT) RETURNS BOOLEAN` RPC (invoked via `supabase.rpc("verify_parent_email", {p_token: token})`).
- Produces: nothing consumed by later tasks in this plan.

- [ ] **Step 1: Rewrite `linkAccount`**

`src/App.jsx:2048-2089` currently reads:

```js
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

Replace with (drops the now-unnecessary `emailRedirectTo` and native `resend()`; moves `getUser()` earlier so `newUserId` is available for the new Edge Function call; the email-sending failure is caught and logged, never blocks account creation — the "Renvoyer l'email" button on the gate screen is the recovery path if this silently fails):

```js
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
      // 🔧 Vérification email obligatoire pour les parents (créateur ou 2e
      // parent) : mécanisme maison (jeton + Edge Function + RPC), PAS le
      // champ natif Supabase email_confirmed_at — voir
      // docs/superpowers/specs/2026-07-10-parent-email-verification-design.md
      // ("Révision") pour le pourquoi. Voir le garde-fou plein-écran plus
      // bas dans App().
      if (metadata?.role === "parent" && newUserId) {
        try {
          await supabase.functions.invoke("send-parent-verification-email", {
            body: { user_id: newUserId, email },
          });
        } catch (sendErr) {
          console.warn("[Duvia][sync] verification email send failed:", sendErr);
        }
      }
      // ── PostHog : tracking inscription ──
      if (newUserId) posthog.capture("signup", { role: metadata?.role || "unknown" });
      return { ok: true, userId: newUserId };
    } catch (e) {
      console.error("[Duvia][sync] linkAccount error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }
```

- [ ] **Step 2: Rename the state and simplify the effect**

`src/App.jsx:3109-3126` currently reads:

```js
  // 🔧 Vérification email parent : null = confirmé non fait (bloque), une
  // date = confirmé, undefined = pas encore su (ne bloque jamais, évite un
  // flash de l'écran de blocage pendant le chargement initial).
  const [emailConfirmedAt, setEmailConfirmedAt] = useState(undefined);
  const [resendMsg, setResendMsg] = useState("");
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

Replace with (renamed to `emailVerified`, reads `user_metadata.email_verified` — a plain boolean, not a timestamp — instead of the native field; drops the `onAuthStateChange`/`USER_UPDATED` listener entirely, since the RPC updates `auth.users` directly in SQL and does not go through the Auth API, so it never fires that client event — the new mount-time effect in Step 3 and the manual refresh button are the only ways `emailVerified` gets updated after the initial load):

```js
  // 🔧 Vérification email parent : false = pas encore vérifié (bloque),
  // true = vérifié, undefined = pas encore su (ne bloque jamais, évite un
  // flash de l'écran de blocage pendant le chargement initial). Source :
  // user_metadata.email_verified (mécanisme maison, PAS email_confirmed_at
  // — voir linkAccount plus haut pour le pourquoi).
  const [emailVerified, setEmailVerified] = useState(undefined);
  const [resendMsg, setResendMsg] = useState("");
  useEffect(() => {
    if (!user || user.role !== "parent") return;
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setEmailVerified(!!data?.user?.user_metadata?.email_verified);
    });
    return () => { cancelled = true; };
  }, [user?.id, user?.role]);
  // 🔧 Détection du clic sur le lien de vérification : si l'URL contient
  // ?verify_email=<token> au chargement, valide le jeton côté serveur (RPC
  // verify_parent_email) puis nettoie l'URL. Fonctionne que l'utilisateur
  // soit connecté sur CET appareil ou non (le jeton est la preuve, pas la
  // session) — s'il est connecté ici, emailVerified se met à jour tout de
  // suite ; sinon il devra se connecter normalement ensuite, le champ sera
  // déjà à true à ce moment-là.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get("verify_email");
    if (!verifyToken) return;
    (async () => {
      try {
        await supabase.rpc("verify_parent_email", { p_token: verifyToken });
      } catch (e) {
        console.warn("[Duvia][sync] verify_parent_email failed:", e);
      }
      params.delete("verify_email");
      const newSearch = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (newSearch ? `?${newSearch}` : ""));
      if (user?.role === "parent") {
        const { data } = await supabase.auth.getUser();
        setEmailVerified(!!data?.user?.user_metadata?.email_verified);
      }
    })();
  }, []);
```

- [ ] **Step 3: Update the gate screen's button handlers**

`src/App.jsx:4232-4261` currently reads:

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
```

(the block continues after this with a closing `);` and `}` — leave those untouched, only replace the JSX/handlers shown above). Replace with (gate condition and both handlers updated to the new mechanism; add a simple 30-second client-side cooldown on resend per the spec, since the Edge Function has no built-in rate limit like Supabase's native `resend()` did):

```js
  if(user?.role === "parent" && emailVerified === false) {
    async function handleResendVerification() {
      setResendCooldown(true);
      try {
        await supabase.functions.invoke("send-parent-verification-email", {
          body: { user_id: user.id, email: user.email },
        });
        setResendMsg(t.parentEmailVerifyResendOk || "Email renvoyé.");
      } catch (e) {
        setResendMsg(e.message || "Erreur.");
      }
      setTimeout(() => setResendCooldown(false), 30000);
    }
    async function handleRefreshVerification() {
      const { data } = await supabase.auth.getUser();
      setEmailVerified(!!data?.user?.user_metadata?.email_verified);
    }
    return (
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C.bg}}>
        <div style={{textAlign:"center",maxWidth:340}}>
          <div style={{fontSize:40,marginBottom:10}}>✉️</div>
          <div style={{fontWeight:900,fontSize:17,marginBottom:8,color:C.txt}}>{t.parentEmailVerifyTitle||"Vérifie ton email"}</div>
          <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:20}}>{(t.parentEmailVerifyBody||"Un email de confirmation a été envoyé à {email}. Clique sur le lien qu'il contient pour accéder à l'application.").replace("{email}", user.email||"")}</div>
          {resendMsg && <div style={{fontSize:12,color:C.grn,marginBottom:14}}>{resendMsg}</div>}
          <button onClick={handleRefreshVerification} style={{height:44,padding:"0 20px",background:C.vio,color:"#fff",border:"none",fontSize:13,fontWeight:700,borderRadius:10,marginRight:10,marginBottom:10}}>{t.parentEmailVerifyRefresh||"J'ai vérifié, actualiser"}</button>
          <button onClick={handleResendVerification} disabled={resendCooldown} style={{height:44,padding:"0 20px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13,borderRadius:10,marginBottom:10,opacity:resendCooldown?0.5:1,cursor:resendCooldown?"default":"pointer"}}>{t.parentEmailVerifyResend||"Renvoyer l'email"}</button>
          <div>
            <button onClick={()=>handleSetUser(null)} style={{height:36,padding:"0 16px",background:"transparent",color:C.mut,border:"none",fontSize:12,textDecoration:"underline"}}>{t.logout||"Se déconnecter"}</button>
          </div>
        </div>
      </div>
```

Add the `resendCooldown` state right next to `emailVerified`/`resendMsg` (from Step 2):

```js
  const [resendCooldown, setResendCooldown] = useState(false);
```

- [ ] **Step 4: Build and test**

Run: `npm run build` — expect success.
Run: `TZ=Europe/Paris npm test` — expect `122 passing`, unchanged.

- [ ] **Step 5: Static verification (no browser/email tooling available — see Global Constraints)**

Trace through the diff by hand and confirm in the report:
1. `emailVerified === false` (not `== false`, not a truthiness check) is the gate condition — `undefined` (loading) must not trigger it.
2. The `?verify_email=` effect has an empty dependency array (`[]`) — runs exactly once on mount, not on every render.
3. `linkAccount`'s Edge Function call is gated on `metadata?.role === "parent" && newUserId` — cannot fire for child/observer synthetic-email signups (re-confirm via the existing `usingPhoneId`/`finalRolePreCheck !== "parent"` logic already in `doReg`, unchanged by this task, that parents never take the phone-identifier branch).
4. `supabase.rpc("verify_parent_email", ...)` and `supabase.functions.invoke("send-parent-verification-email", ...)` are called with the exact names matching the deployed migration/Edge Function (`verify_parent_email`, `send-parent-verification-email`) — a typo here would fail silently or loudly depending on the error, check character-for-character.
5. Confirm `npm run dev` boots without console/build errors.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Rewire parent email verification to the new token mechanism

Replaces the native-Supabase-based mechanism (invalidated by a live test —
email_confirmed_at gets populated at signUp() regardless of link clicks
when 'Confirm email' is off) with the new custom one: linkAccount() now
calls the send-parent-verification-email Edge Function instead of
auth.resend(), a new mount-time effect handles ?verify_email=<token> via
the verify_parent_email RPC, and the gate/resend button read/write
user_metadata.email_verified instead of email_confirmed_at.
See docs/superpowers/specs/2026-07-10-parent-email-verification-design.md."
```

---

### Task 2: Restrict parent invite sharing to email only

**Files:**
- Modify: `src/App.jsx` (`ParentInviteShareBtns`, search for `function ParentInviteShareBtns` — line number may have shifted from Task 1's edits, search rather than assume)

**Interfaces:**
- Consumes: nothing from Task 1. Independent.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Remove the SMS and WhatsApp channels**

Find `function ParentInviteShareBtns({ C, parent, familyName }) {` in `src/App.jsx`. It currently reads:

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

- [ ] **Step 3: Static verification**

Search for `<ParentInviteShareBtns` call sites (there are 2) and confirm they still pass the same props (`C`, `parent`, `familyName`) — the component's prop signature is unchanged, only its internals/render output shrank.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "Restrict parent invite sharing to email only

Removes the SMS and WhatsApp share buttons from ParentInviteShareBtns —
only email proves the recipient controls that inbox, which the email-
verification gate (this session) depends on being the actual channel
used. Child/observer invites are untouched, still all channels.
See docs/superpowers/specs/2026-07-10-parent-email-verification-design.md."
```

---

### Task 3: Remove the legacy parent-join path that bypassed approval

**Files:**
- Modify: `src/App.jsx` (`doReg`, search for `isParentInvite && obsInviteCode.family` — line number may have shifted, search rather than assume)
- Modify: `src/config.js`, `public/sw.js` (version bump — final task of the plan)

**Interfaces:**
- Consumes: nothing from Tasks 1 or 2. Independent.
- Produces: nothing consumed elsewhere. Final task.
- No new i18n keys — reuses the existing `t.invErrInvalid` key already used by the sibling `newStyle` branch's error path.

- [ ] **Step 1: Remove the legacy branch, add a graceful error instead**

Find the block in `doReg` containing `if(finalRole==="parent"){` followed by `if(isParentInvite && obsInviteCode.newStyle){` and `} else if(isParentInvite && obsInviteCode.family){`. It currently reads:

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

- [ ] **Step 3: Static verification**

This legacy path is hard to trigger deliberately (it required an old-format invite link/object shape the app no longer generates) — a full live repro isn't expected. Instead, verify by reading: confirm no other code path still constructs an `obsInviteCode` object with a `.family` property but no `.newStyle` (search `obsInviteCode` assignments), so this branch is confirmed genuinely dead for the current invite-link format going forward. Report what you found.

- [ ] **Step 4: Bump the app version**

Per `CLAUDE.md`, increment together in `src/config.js` (`APP_VERSION`) and `public/sw.js` (`SW_VERSION`) — read the current value first, don't assume a number, increment by `0.01`. This is the final task of the plan.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Close legacy parent-invite path that bypassed creator approval

The pre-token parent invite format merged a second parent directly with
inviteStatus:\"accepted\", skipping the pending/validateMember review the
modern token-based flow already requires. This path now shows the
existing invite-error message instead of silently granting unapproved
access.
See docs/superpowers/specs/2026-07-10-parent-email-verification-design.md."
```
