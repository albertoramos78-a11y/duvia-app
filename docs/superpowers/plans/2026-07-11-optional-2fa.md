# Optional 2FA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. **Task 1 is controller-direct** (DB migration, requires the human to run SQL in the Supabase dashboard) — do not dispatch an implementer for it. **Tasks 2 and 3 are subagent-dispatchable** (regular React/JS code, no live dashboard interaction).

**Goal:** Let any account (parent, child, observer, admin) optionally enable TOTP-based two-factor authentication, with backup codes for device loss, using Supabase Auth's native MFA support.

**Architecture:** Supabase's client SDK already provides the full TOTP enroll/challenge/verify/unenroll mechanism (confirmed by inspecting the installed `@supabase/auth-js` package — no new dependency needed). The app adds: (1) a `mfa_backup_codes` table + 2 RPCs for the one piece Supabase doesn't handle natively — recovery codes; (2) a login-time MFA challenge gate, implemented as shared state/functions living in `App()` (the common ancestor of both `LoginScreen` and the Google-OAuth handler) to avoid repeating today's `notifyIfNewDevice` scope bug; (3) an enrollment UI added to the existing "🔒 Sécurité" section already present in `PrefsTab` and `ObserverPrefsTab`.

**Tech Stack:** React (single-file `src/App.jsx`), Supabase (Postgres + Auth's native MFA + pgcrypto for backup-code hashing).

## Global Constraints

- Table name: `mfa_backup_codes`. RPC names: `generate_mfa_backup_codes()`, `redeem_mfa_backup_code(p_code TEXT)`, `clear_mfa_backup_codes()`. Use these exact names.
- 2FA applies to **all account roles** — no role-based exclusion (unlike the parent-only email verification feature).
- The MFA-challenge state and logic (`mfaChallenge`, `mfaResolveRef`, `requestMfaChallenge`, `ensureMfaSatisfied`) MUST live inside `App()`, never inside `LoginScreen` — `LoginScreen` is a separate sibling component with no access to `App()`'s local closures (this exact mistake broke all classic logins earlier today, see commit `43c7125`). `LoginScreen` receives `ensureMfaSatisfied` as a prop.
- The MFA challenge check (`ensureMfaSatisfied()`) applies at exactly 3 login points: `doLogin()`, `doLoginAndJoin()` (both in `LoginScreen`), and the Google OAuth `SIGNED_IN` handler (in `App()`). Never at `doReg()` (a brand-new account has no factors to challenge).
- `getAuthenticatorAssuranceLevel()`/`listFactors()` failures fail OPEN (return `true`, let the user in) — these read local JWT/session state, not attacker-controllable, and given today's incident a bug here must not be able to lock out every user. `challengeAndVerify()` and backup-code redemption fail CLOSED by construction (the promise only resolves `true` on genuine success) — this is the actual security boundary.
- `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) must both be bumped together, by 0.01, in the LAST code-writing task (Task 3).
- Test command: `TZ=Europe/Paris npm test` (122 passing at plan time — no new pure-logic function is expected, don't force one). Build command: `npm run build`.
- No i18n file changes required — all new UI copy uses the existing `t.key||"French fallback"` pattern already used everywhere else in this file (CLAUDE.md's documented incomplete-translation convention).

---

## Task 1: `mfa_backup_codes` table + RPCs (controller-direct, no subagent)

**Files:**
- Create: `supabase/migrations/0032_mfa_backup_codes.sql`

**Interfaces:**
- Produces: table `public.mfa_backup_codes(id, user_id, code_hash, used_at, created_at)`; RPC `public.generate_mfa_backup_codes() RETURNS TEXT[]`; RPC `public.redeem_mfa_backup_code(p_code TEXT) RETURNS BOOLEAN`; RPC `public.clear_mfa_backup_codes() RETURNS VOID`. All three callable by `authenticated`.
- Consumes: nothing (first task).

- [ ] **Step 1: Write the migration file**

```sql
-- 0032_mfa_backup_codes.sql
--
-- Backup codes for optional TOTP-based 2FA (Supabase Auth's native
-- auth.mfa.* handles enrollment/challenge/verify/unenroll itself — this
-- table only covers what Supabase does NOT provide natively: recovery
-- when the user's authenticator device is lost. A valid unused code
-- disables ALL of the user's MFA factors (simpler and safer than trying
-- to elevate the session to aal2 via a non-Supabase-native path — see
-- docs/superpowers/specs/2026-07-11-optional-2fa-design.md).
--
-- Depends on: pgcrypto extension (for crypt()/gen_salt(), same hashing
-- primitive used for password hashing) — enable if not already present.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.mfa_backup_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mfa_backup_codes_user_id_idx ON public.mfa_backup_codes(user_id);

ALTER TABLE public.mfa_backup_codes ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all to anon/authenticated by default. Only reachable
-- via the SECURITY DEFINER RPCs below (same pattern as
-- parent_email_verifications, migration 0029).

CREATE OR REPLACE FUNCTION public.generate_mfa_backup_codes()
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_codes TEXT[] := ARRAY[]::TEXT[];
  v_code TEXT;
  i INT;
BEGIN
  -- On repart de zéro : les anciens codes non utilisés deviennent invalides.
  DELETE FROM public.mfa_backup_codes WHERE user_id = auth.uid() AND used_at IS NULL;

  FOR i IN 1..10 LOOP
    v_code := encode(gen_random_bytes(5), 'hex');
    v_codes := array_append(v_codes, v_code);
    INSERT INTO public.mfa_backup_codes (user_id, code_hash)
    VALUES (auth.uid(), crypt(v_code, gen_salt('bf')));
  END LOOP;

  RETURN v_codes;
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_mfa_backup_code(p_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT id, code_hash FROM public.mfa_backup_codes
    WHERE user_id = auth.uid() AND used_at IS NULL
  LOOP
    IF crypt(p_code, v_row.code_hash) = v_row.code_hash THEN
      UPDATE public.mfa_backup_codes SET used_at = NOW() WHERE id = v_row.id;
      DELETE FROM auth.mfa_factors WHERE user_id = auth.uid();
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_mfa_backup_codes()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  DELETE FROM public.mfa_backup_codes WHERE user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.generate_mfa_backup_codes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_mfa_backup_code(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_mfa_backup_codes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_mfa_backup_codes() TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_mfa_backup_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_mfa_backup_codes() TO authenticated;
```

- [ ] **Step 2: Hand the file to the user to run**

Tell the user: "Peux-tu exécuter `supabase/migrations/0032_mfa_backup_codes.sql` dans le SQL Editor Supabase ?" Wait for confirmation before proceeding to Task 2.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0032_mfa_backup_codes.sql
git commit -m "Add mfa_backup_codes table + generate/redeem/clear RPCs"
git push
```

---

## Task 2: Login-time MFA challenge gate (subagent-dispatchable)

**Files:**
- Modify: `src/App.jsx` (6 touch points, all detailed below)

**Interfaces:**
- Consumes: RPC `redeem_mfa_backup_code` (Task 1, already deployed and confirmed by the user before this task starts).
- Produces: `ensureMfaSatisfied` — an async function living in `App()`, taking no arguments, returning `Promise<boolean>` (`true` = proceed with login, `false` = user cancelled). Task 3 does not consume this (enrollment is independent of the login gate), but must not redefine or conflict with the `mfa*` state/function names introduced here.

This task has no automated test — it's login-flow UI with a real external dependency (an actual authenticator app) that cannot be exercised by an automated test in this repo. Its "test" is: `TZ=Europe/Paris npm test` still shows 122/122 passing, `npm run build` succeeds. Manual verification (noted in Step 8) is the user's responsibility.

- [ ] **Step 1: Add the `MfaChallengeGate` component**

This is a new top-level component, placed near other similar screen components. Find this exact line in `src/App.jsx`:

```js
function ConsentScreen({C,t,user,onAccept,onDecline}) {
```

Insert this new component immediately BEFORE that line:

```js
function MfaChallengeGate({C, t, factorId, onVerified, onCancel}) {
  const [mode, setMode] = useState("totp");
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function verifyTotp() {
    if (!code.trim()) return;
    setBusy(true); setErr("");
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (error) { setErr(t.mfaCodeInvalid || "Code invalide."); setBusy(false); return; }
      onVerified();
    } catch (e) {
      setErr(e.message || "Erreur."); setBusy(false);
    }
  }

  async function verifyBackupCode() {
    if (!backupCode.trim()) return;
    setBusy(true); setErr("");
    try {
      const { data, error } = await supabase.rpc("redeem_mfa_backup_code", { p_code: backupCode.trim() });
      if (error || !data) { setErr(t.mfaBackupInvalid || "Code de secours invalide."); setBusy(false); return; }
      onVerified();
    } catch (e) {
      setErr(e.message || "Erreur."); setBusy(false);
    }
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{width:"100%",maxWidth:340,background:C.card,borderRadius:18,padding:24,textAlign:"center"}}>
        <div style={{fontSize:40,marginBottom:10}}>🔐</div>
        <div style={{fontWeight:900,fontSize:17,marginBottom:8,color:C.txt}}>{t.mfaChallengeTitle||"Vérification en deux étapes"}</div>
        {mode==="totp" ? (
          <>
            <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:16}}>{t.mfaChallengeBody||"Entre le code à 6 chiffres généré par ton appli d'authentification."}</div>
            <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}
              onKeyDown={e=>e.key==="Enter"&&verifyTotp()}
              placeholder="123456" inputMode="numeric" autoFocus
              style={{width:"100%",boxSizing:"border-box",height:44,textAlign:"center",fontSize:20,letterSpacing:4,fontFamily:"JetBrains Mono",border:`1.5px solid ${C.bor}`,borderRadius:10,marginBottom:12,background:C.sur,color:C.txt}} />
            {err && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{err}</div>}
            <button onClick={verifyTotp} disabled={busy||code.length<6} style={{width:"100%",height:44,background:C.vio,color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,marginBottom:10,opacity:busy||code.length<6?.6:1,cursor:busy||code.length<6?"default":"pointer"}}>{t.mfaVerify||"Valider"}</button>
            <button onClick={()=>{setMode("backup");setErr("");}} style={{background:"transparent",border:"none",color:C.mut,fontSize:12,textDecoration:"underline",cursor:"pointer"}}>{t.mfaLostDevice||"J'ai perdu mon appareil"}</button>
          </>
        ) : (
          <>
            <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:16}}>{t.mfaBackupBody||"Entre l'un de tes codes de secours. Cela désactivera la double authentification sur ce compte."}</div>
            <input value={backupCode} onChange={e=>setBackupCode(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&verifyBackupCode()}
              placeholder={t.mfaBackupPlaceholder||"Code de secours"} autoFocus
              style={{width:"100%",boxSizing:"border-box",height:44,textAlign:"center",fontSize:15,fontFamily:"JetBrains Mono",border:`1.5px solid ${C.bor}`,borderRadius:10,marginBottom:12,background:C.sur,color:C.txt}} />
            {err && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{err}</div>}
            <button onClick={verifyBackupCode} disabled={busy||!backupCode.trim()} style={{width:"100%",height:44,background:C.vio,color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,marginBottom:10,opacity:busy||!backupCode.trim()?.6:1,cursor:busy||!backupCode.trim()?"default":"pointer"}}>{t.mfaVerify||"Valider"}</button>
            <button onClick={()=>{setMode("totp");setErr("");}} style={{background:"transparent",border:"none",color:C.mut,fontSize:12,textDecoration:"underline",cursor:"pointer"}}>{t.mfaBackToCode||"Revenir au code de l'appli"}</button>
          </>
        )}
        <div style={{marginTop:14}}>
          <button onClick={onCancel} style={{height:36,padding:"0 16px",background:"transparent",color:C.mut,border:"none",fontSize:12,textDecoration:"underline",cursor:"pointer"}}>{t.logout||"Se déconnecter"}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the MFA challenge state/functions inside `App()`**

Find this exact block in `src/App.jsx` (the Google OAuth `useEffect`, currently starting around line 3543):

```js
  // ── Google OAuth : détecte le retour de redirection et connecte l'utilisateur ──
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
```

Insert this new block immediately BEFORE that comment:

```js
  // ── 2FA (MFA) : vérification à la connexion ─────────────────────────────
  // Un seul mécanisme partagé entre LoginScreen (doLogin/doLoginAndJoin) et
  // ce composant (connexion Google) : LEÇON du 2026-07-11 — notifyIfNewDevice
  // cassait toute connexion classique car défini dans le mauvais composant
  // (voir commit 43c7125). Cette fois, l'état et les fonctions vivent dans
  // App() (l'ancêtre commun des deux), et LoginScreen reçoit juste la
  // fonction ensureMfaSatisfied en prop plutôt que de la redéfinir.
  const [mfaChallenge, setMfaChallenge] = useState(null); // {factorId} pendant un challenge en cours
  const mfaResolveRef = useRef(null);
  function requestMfaChallenge(factorId) {
    return new Promise((resolve) => {
      mfaResolveRef.current = resolve;
      setMfaChallenge({ factorId });
    });
  }
  // Appelée juste après une connexion réussie (mot de passe ou Google),
  // AVANT de finaliser la connexion. Renvoie true si aucun 2FA n'est requis
  // ou si le challenge a été validé ; false si l'utilisateur a annulé.
  async function ensureMfaSatisfied() {
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!data || data.currentLevel === data.nextLevel) return true;
      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      const factor = factorsData?.totp?.[0];
      if (!factor) return true;
      return await requestMfaChallenge(factor.id);
    } catch (e) {
      // 🔧 Échec ouvert (laisse passer) : cette vérification lit uniquement
      // l'état local de session, non manipulable par un attaquant qui ne
      // possède pas déjà les identifiants du compte — un bug ici ne doit
      // jamais pouvoir bloquer 100% des connexions, comme le 2026-07-11.
      // La vraie barrière de sécurité est challengeAndVerify() plus bas,
      // qui échoue fermé par construction (la promesse ne se résout à true
      // que si le code entré est réellement valide).
      console.warn("[Duvia][sync] ensureMfaSatisfied failed:", e);
      return true;
    }
  }

  // ── Google OAuth : détecte le retour de redirection et connecte l'utilisateur ──
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
```

- [ ] **Step 3: Wire the challenge into the Google OAuth handler**

Find this exact block (currently around line 3591-3592):

```js
          if (currentSession === u.email || sessionEmail === u.email) return; // déjà connecté
          await notifyIfNewDevice(u.id, u.email);
          const googleUser = {
```

Replace with:

```js
          if (currentSession === u.email || sessionEmail === u.email) return; // déjà connecté
          const mfaOk = await ensureMfaSatisfied();
          if (!mfaOk) { await supabase.auth.signOut().catch(()=>{}); return; }
          await notifyIfNewDevice(u.id, u.email);
          const googleUser = {
```

- [ ] **Step 4: Render the challenge overlay**

Find this exact line in `src/App.jsx` (currently around line 4316, right after the `LoginScreen`/`ConsentScreen`/etc. ternary closes):

```js
      {legalDocOpen && <LegalDocModal C={C} doc={legalDocOpen} lang={lang} onClose={()=>setLegalDocOpen(null)} />}
```

Replace with:

```js
      {legalDocOpen && <LegalDocModal C={C} doc={legalDocOpen} lang={lang} onClose={()=>setLegalDocOpen(null)} />}
      {mfaChallenge && (
        <MfaChallengeGate C={C} t={t} factorId={mfaChallenge.factorId}
          onVerified={()=>{ mfaResolveRef.current?.(true); setMfaChallenge(null); }}
          onCancel={async ()=>{ await supabase.auth.signOut().catch(()=>{}); mfaResolveRef.current?.(false); setMfaChallenge(null); }} />
      )}
```

- [ ] **Step 5: Pass `ensureMfaSatisfied` to `LoginScreen`**

Find this exact line in `src/App.jsx` (currently around line 4314):

```js
        <LoginScreen C={BRAND} t={t} lang={lang} setLang={setLang} themeMode={themeMode} cycleTheme={cycleTheme} users={users} setUsers={setUsers} onLogin={handleLogin} onObsJoin={handleObsJoin} familySync={familySync} cfg={cfg} setCfg={setCfg} />
```

Replace with:

```js
        <LoginScreen C={BRAND} t={t} lang={lang} setLang={setLang} themeMode={themeMode} cycleTheme={cycleTheme} users={users} setUsers={setUsers} onLogin={handleLogin} onObsJoin={handleObsJoin} familySync={familySync} cfg={cfg} setCfg={setCfg} ensureMfaSatisfied={ensureMfaSatisfied} />
```

- [ ] **Step 6: Accept the prop and wire `doLogin()`**

Find this exact line in `src/App.jsx` (currently around line 5451):

```js
function LoginScreen({C,t,lang,setLang,themeMode,cycleTheme,users,setUsers,onLogin,onObsJoin,familySync,cfg,setCfg}) {
```

Replace with:

```js
function LoginScreen({C,t,lang,setLang,themeMode,cycleTheme,users,setUsers,onLogin,onObsJoin,familySync,cfg,setCfg,ensureMfaSatisfied}) {
```

Find this exact block (currently around line 5488-5492):

```js
    const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(error){
      setOk(""); setErr(t.wrongPw); return;
    }
    notifyIfNewDevice(data.user.id, cleanEmail);
```

Replace with:

```js
    const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(error){
      setOk(""); setErr(t.wrongPw); return;
    }
    const mfaOk = await ensureMfaSatisfied();
    if(!mfaOk){ setOk(""); return; }
    notifyIfNewDevice(data.user.id, cleanEmail);
```

- [ ] **Step 7: Wire `doLoginAndJoin()`**

Find this exact block (currently around line 5886-5888):

```js
    const { data, error: signErr } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(signErr){ setErr(t.wrongPw); return; }
    notifyIfNewDevice(data.user.id, cleanEmail);
```

Replace with:

```js
    const { data, error: signErr } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(signErr){ setErr(t.wrongPw); return; }
    const mfaOk = await ensureMfaSatisfied();
    if(!mfaOk){ return; }
    notifyIfNewDevice(data.user.id, cleanEmail);
```

- [ ] **Step 8: Run tests, build, commit**

Run: `TZ=Europe/Paris npm test` — expect `tests 122`, `pass 122`, `fail 0`.
Run: `npm run build` — expect success (pre-existing chunk-size warning is fine).

```bash
git add src/App.jsx
git commit -m "Add login-time MFA challenge gate (module-scoped, shared by LoginScreen and Google OAuth)"
git push
```

In your DONE report, state: "No browser tooling exists in this environment, and this feature requires a real authenticator app to test meaningfully — the user must verify live after Task 3 ships enrollment: enroll a test account, log out, log back in, confirm the challenge screen appears and a valid code lets you in; confirm an invalid code is rejected; confirm a backup code works and disables 2FA on that account."

---

## Task 3: Enrollment UI in Préférences (subagent-dispatchable)

**Files:**
- Modify: `src/App.jsx` — `PrefsTab` (state near line 6657, JSX insertion near line 7058) and `ObserverPrefsTab` (state near line 7151, JSX insertion near line 7415) — same block, applied twice, matching this codebase's existing convention of duplicating `changePassword`/`changeEmail` logic verbatim across these two components rather than sharing a helper.
- Modify: `src/config.js:13` (`APP_VERSION`)
- Modify: `public/sw.js:13` (`SW_VERSION`)

**Interfaces:**
- Consumes: RPCs `generate_mfa_backup_codes`, `clear_mfa_backup_codes` (Task 1, already deployed). Does not consume anything from Task 2 (enrollment is independent of the login-challenge gate — Supabase's own `auth.mfa.listFactors()` is the only shared source of truth, no in-app dependency).
- Produces: nothing consumed by later tasks (last task).

No automated test — UI + Supabase Auth API calls, same reasoning as Task 2. Manual verification is the user's responsibility (noted in the final step).

- [ ] **Step 1: Add MFA state to `PrefsTab`**

Find this exact line in `src/App.jsx` (currently around line 6685, the last line of `PrefsTab`'s existing state block):

```js
  const [customerId, setCustomerId] = useState("");
  const [cidCopied,  setCidCopied]  = useState(false);
```

Replace with:

```js
  const [customerId, setCustomerId] = useState("");
  const [cidCopied,  setCidCopied]  = useState(false);
  // ── 2FA (double authentification) ──────────────────────────────────────
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState(null);
  const [mfaMode, setMfaMode] = useState(false);
  const [mfaEnrollData, setMfaEnrollData] = useState(null); // {factorId, qrCode, secret}
  const [mfaCode, setMfaCode] = useState("");
  const [mfaErr, setMfaErr] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaBackupCodes, setMfaBackupCodes] = useState(null); // affichés une seule fois

  useEffect(()=>{
    supabase.auth.mfa.listFactors().then(({data})=>{
      const factor = data?.totp?.[0];
      if (factor) { setMfaEnrolled(true); setMfaFactorId(factor.id); }
    });
  },[]);

  async function startMfaEnroll(){
    setMfaErr(""); setMfaBusy(true);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    setMfaBusy(false);
    if (error) { setMfaErr(error.message||"Erreur."); return; }
    setMfaEnrollData({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setMfaMode(true);
  }
  async function confirmMfaEnroll(){
    if (!mfaCode.trim()) return;
    setMfaBusy(true); setMfaErr("");
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: mfaEnrollData.factorId, code: mfaCode.trim() });
    if (error) { setMfaErr(t.mfaCodeInvalid||"Code invalide."); setMfaBusy(false); return; }
    const { data: codes } = await supabase.rpc("generate_mfa_backup_codes");
    setMfaBackupCodes(codes||[]);
    setMfaEnrolled(true); setMfaFactorId(mfaEnrollData.factorId);
    setMfaEnrollData(null); setMfaCode(""); setMfaMode(false); setMfaBusy(false);
  }
  function cancelMfaEnroll(){
    setMfaEnrollData(null); setMfaCode(""); setMfaErr(""); setMfaMode(false);
  }
  async function disableMfa(){
    if (!mfaFactorId) return;
    setMfaBusy(true); setMfaErr("");
    const { error } = await supabase.auth.mfa.unenroll({ factorId: mfaFactorId });
    if (error) { setMfaErr(error.message||"Erreur."); setMfaBusy(false); return; }
    await supabase.rpc("clear_mfa_backup_codes").catch(()=>{});
    setMfaEnrolled(false); setMfaFactorId(null); setMfaBackupCodes(null); setMfaBusy(false);
  }
  async function regenerateBackupCodes(){
    setMfaBusy(true); setMfaErr("");
    const { data, error } = await supabase.rpc("generate_mfa_backup_codes");
    setMfaBusy(false);
    if (error) { setMfaErr(error.message||"Erreur."); return; }
    setMfaBackupCodes(data||[]);
  }
  function downloadBackupCodes(){
    const text = (mfaBackupCodes||[]).join("\n");
    const blob = new Blob([text], {type:"text/plain"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "duvia-codes-secours.txt"; a.click();
    URL.revokeObjectURL(url);
  }
```

- [ ] **Step 2: Add the MFA enrollment JSX to `PrefsTab`**

Find this exact block in `src/App.jsx` (currently around line 7056-7059, the end of the existing "🔒 Sécurité" section):

```js
            )}
          </>
        )}
      </div>

      {/* ── Sauvegarde des données (.duvia) ── */}
```

Replace with:

```js
            )}
          </>
        )}
        {/* ── Double authentification (2FA) ── */}
        <div style={{height:1,background:C.bor,margin:"12px 0"}}/>
        {mfaErr && <div style={{color:C.red,fontSize:12,marginBottom:8,padding:"6px 10px",background:`${C.red}10`,borderRadius:8}}>{mfaErr}</div>}
        {mfaBackupCodes ? (
          <div style={{background:C.sur,borderRadius:12,padding:16,border:`1.5px solid ${C.vio}`}}>
            <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:8}}>🔑 {t.mfaBackupCodesTitle||"Tes codes de secours"}</div>
            <div style={{fontSize:11,color:C.red,fontWeight:700,marginBottom:10}}>{t.mfaBackupCodesWarning||"Note-les maintenant : ils ne seront plus jamais affichés."}</div>
            <div style={{fontFamily:"JetBrains Mono",fontSize:13,color:C.txt,lineHeight:1.8,marginBottom:12,background:C.bg,borderRadius:8,padding:10}}>
              {mfaBackupCodes.map((c,i)=><div key={i}>{c}</div>)}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={downloadBackupCodes} style={{flex:1,height:38,background:C.vio,color:"#fff",borderRadius:8,fontSize:13,fontWeight:800,border:"none",cursor:"pointer"}}>{t.mfaDownloadCodes||"Télécharger"}</button>
              <button onClick={()=>setMfaBackupCodes(null)} style={{height:38,padding:"0 16px",background:C.sur,border:`1px solid ${C.bor}`,borderRadius:8,cursor:"pointer",fontSize:13,color:C.txt}}>{t.mfaBackupCodesDone||"J'ai noté mes codes"}</button>
            </div>
          </div>
        ) : !mfaEnrolled ? (
          !mfaMode ? (
            <button onClick={startMfaEnroll} disabled={mfaBusy} style={{...row}}>
              <span style={{fontSize:13,fontWeight:700,color:C.txt}}>🔐 {t.mfaActivate||"Activer la double authentification"}</span>
            </button>
          ) : (
            <div style={{background:C.sur,borderRadius:12,padding:16,border:`1px solid ${C.bor}`}}>
              {mfaEnrollData?.qrCode && (
                <div style={{textAlign:"center",marginBottom:12}}>
                  <img src={mfaEnrollData.qrCode} alt="QR code" style={{width:160,height:160,background:"#fff",borderRadius:8,padding:8}} />
                  <div style={{fontSize:10,color:C.mut,marginTop:6,wordBreak:"break-all"}}>{mfaEnrollData.secret}</div>
                </div>
              )}
              <div style={{fontSize:11,color:C.mut,marginBottom:10,lineHeight:1.5}}>{t.mfaScanInstructions||"Scanne ce QR code avec ton appli d'authentification, puis entre le code à 6 chiffres généré."}</div>
              <input value={mfaCode} onChange={e=>setMfaCode(e.target.value.replace(/\D/g,"").slice(0,6))}
                placeholder="123456" inputMode="numeric"
                style={{width:"100%",height:42,borderRadius:8,border:`1.5px solid ${C.bor}`,padding:"0 12px",fontSize:16,textAlign:"center",letterSpacing:3,fontFamily:"JetBrains Mono",marginBottom:8,boxSizing:"border-box"}} />
              <div style={{display:"flex",gap:8}}>
                <button onClick={confirmMfaEnroll} disabled={mfaBusy||mfaCode.length<6} style={{flex:1,height:38,background:C.vio,color:"#fff",borderRadius:8,fontSize:13,fontWeight:800,border:"none",cursor:"pointer",opacity:mfaBusy||mfaCode.length<6?.6:1}}>
                  {mfaBusy?"…":(t.confirm||"Confirmer")}
                </button>
                <button onClick={cancelMfaEnroll} style={{height:38,padding:"0 16px",background:C.sur,border:`1px solid ${C.bor}`,borderRadius:8,cursor:"pointer",fontSize:13,color:C.txt}}>
                  {t.cancel||"Annuler"}
                </button>
              </div>
            </div>
          )
        ) : (
          <div style={{background:C.sur,borderRadius:12,padding:16,border:`1px solid ${C.bor}`}}>
            <div style={{fontSize:13,fontWeight:700,color:C.txt,marginBottom:10}}>✅ {t.mfaEnabled||"Double authentification activée"}</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={regenerateBackupCodes} disabled={mfaBusy} style={{flex:1,height:38,background:C.sur,border:`1px solid ${C.bor}`,borderRadius:8,cursor:"pointer",fontSize:12,color:C.txt}}>
                {t.mfaRegenerateCodes||"Régénérer mes codes de secours"}
              </button>
              <button onClick={disableMfa} disabled={mfaBusy} style={{height:38,padding:"0 16px",background:`${C.red}12`,border:`1px solid ${C.red}`,borderRadius:8,cursor:"pointer",fontSize:13,color:C.red,fontWeight:700}}>
                {t.mfaDisable||"Désactiver"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Sauvegarde des données (.duvia) ── */}
```

- [ ] **Step 3: Repeat Steps 1-2 for `ObserverPrefsTab`**

`ObserverPrefsTab` has the exact same state-block and JSX-block shapes as `PrefsTab`, just at different line numbers (state block ends around line 7170 with the same `savingEmail` line pattern — search for it in `ObserverPrefsTab` specifically, not `PrefsTab`'s copy; JSX block ends around line 7413-7416 with the same `)}` / `</>` / `)}` / `</div>` / blank line / `{/* ── Supprimer sauvegarde locale...` pattern). Apply the exact same two insertions (state block after the last existing state line, JSX block before the closing `</div>` of the "🔒 Sécurité" section) — same code, verbatim, matching this codebase's established convention of duplicating this class of logic across `PrefsTab`/`ObserverPrefsTab` rather than extracting a shared component.

- [ ] **Step 4: Bump the version**

In `src/config.js`, change `export const APP_VERSION = "1.47";` to `export const APP_VERSION = "1.48";`.
In `public/sw.js`, change `const SW_VERSION = "1.47";` to `const SW_VERSION = "1.48";`.

- [ ] **Step 5: Run tests, build, commit**

Run: `TZ=Europe/Paris npm test` — expect `tests 122`, `pass 122`, `fail 0`.
Run: `npm run build` — expect success.

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Add 2FA enrollment UI to PrefsTab and ObserverPrefsTab"
git push
```

In your DONE report, state: "No browser tooling exists in this environment, and this feature requires a real authenticator app — the user must verify live: as both a parent and a child/observer test account, activate 2FA (scan QR code, confirm with a real 6-digit code), save the displayed backup codes, log out and back in to confirm the Task 2 challenge gate now appears, try an invalid code (rejected), try a valid backup code (accepted AND disables 2FA on that account), regenerate backup codes while enrolled, and disable 2FA entirely."


