# Admin Subscription Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `BETA_END` constant with a DB-backed global bêta toggle+end-date the admin can control without a code deploy, and add a real server-side admin tool to look up any account by email and set its subscription to Freemium / Bêta (with its own end date) / Trial Premium / Premium (monthly or yearly).

**Architecture:** A new Postgres table `app_config` (singleton row, readable by any authenticated client via RLS) replaces the hardcoded constant — `isBeta()` keeps its exact current zero-argument signature by reading a module-level cache populated once via a fetch effect in `App()`, rather than threading a new parameter through `subStatus()`/`getPerms()`/`isPrem()`/etc. and their ~25 call sites. A new Edge Function `admin-manage-subscriptions` (mirroring the existing `delete-account` function's auth-verification style) handles all privileged writes: setting the global toggle, and setting any looked-up account's subscription — both require the caller to be listed in `app_admins`, verified server-side.

**Tech Stack:** Supabase Postgres (SQL migration), Supabase Edge Function (Deno + `@supabase/supabase-js`), React (`src/App.jsx`).

## Global Constraints

- Confirmed by the user: an account's explicit per-account plan (Freemium/Bêta/Trial/Premium, set via the admin tool) always takes precedence over the global bêta toggle for that account — this falls out naturally from `subStatus()`'s check order (per-account `beta`/`premium`/`freemium` are checked before the global toggle) and requires no separate "override flag."
- "Bêta" (per-account) and "Trial Premium" (per-account) are **different actions**, not merged: Bêta requires an end date and expires INTO a fresh 15-day Trial Premium computed from that end date; Trial Premium has no end-date field and just starts a normal 15-day trial from now.
- A real paid Premium subscriber is never affected by either bêta mechanism (global or per-account) — this is already true today (checked first in `subStatus()`) and must stay true.
- No behavior change to the existing Premium-expiry-to-Freemium path, the referral/`earned_premium` mechanics, or `trialExtension` — none of this plan's changes touch those branches.
- `isBeta()`, `subStatus()`, `getPerms()`, `isPrem()`, `isPremFull()`, `isFreemiumPlan()`, `planRankFor()`, `familyMaxObservers()` all keep their EXACT current signatures — no new parameters. `globalBeta` is read via a module-level cache, not threaded through any of these functions or their ~25 call sites.
- `TZ=Europe/Paris npm test` must stay green (136 tests — no new pure logic covered by that suite) after every task.
- `npm run build` must succeed after every task.
- Bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together by +0.01 only in the FINAL task.
- The current version at plan start is **v1.82**.

---

### Task 1: Migration + Edge Function

**Files:**
- Create: `supabase/migrations/0037_admin_subscription_management.sql`
- Create: `supabase/functions/admin-manage-subscriptions/index.ts`

**Interfaces:**
- Produces: table `public.app_config` (`id int primary key default 1`, `beta_enabled boolean`, `beta_end timestamptz`, single row, `SELECT` allowed to any `authenticated` caller, no direct write policy); new column `public.subscriptions.beta_end timestamptz`; Edge Function `admin-manage-subscriptions`, invoked as `supabase.functions.invoke("admin-manage-subscriptions", { body })` with `body` shaped as one of:
  - `{ action: "lookup_user", email }` → `{ user_id, name, email, sub }` or `{ error }`.
  - `{ action: "set_user_plan", user_id, plan, beta_end?, premium_cycle? }` → `{ ok: true }` or `{ error }`.
  - `{ action: "set_global_beta", enabled, end_date }` → `{ ok: true }` or `{ error }`.
- Consumes: existing tables `public.app_admins` (`user_id`, used to verify the caller is a real admin — same table already checked client-side at `App.jsx:3376-3388`), `public.family_members` (`user_id`, `email`, `display_name` — used to resolve an email to a `user_id`, same column already populated by the existing observer-invitation flow, migration `0020_member_email.sql`), `public.subscriptions` (`user_id`, `plan`, `premium_since`, `cycle`, `trial_start`, `trial_extension_days`, `account_created_at`, `beta_end`).

This migration and Edge Function are deployed by the user manually (SQL Editor + dashboard paste) — this environment has no direct Supabase CLI/DB access. Both can be written and are self-contained; end-to-end testing requires the user to deploy them.

- [ ] **Step 1: Write the migration file**

```sql
-- 0037_admin_subscription_management.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Deux ajouts pour la gestion admin des abonnements :
--
-- 1) app_config : table singleton (une seule ligne, id=1) portant la bascule
--    bêta GLOBALE (remplace la constante BETA_END codée en dur dans App.jsx).
--    Lisible par tout compte authentifié (chaque page load doit savoir si la
--    bêta globale est active, sans passer par une Edge Function) ; aucune
--    policy d'écriture directe — seule la Edge Function admin-manage-
--    subscriptions (service role) peut la modifier.
--
-- 2) subscriptions.beta_end : date de fin d'un override "Bêta" PAR COMPTE
--    (distinct de la bascule globale ci-dessus), posé par un admin via le
--    même outil. Nullable, pertinent uniquement quand subscriptions.plan =
--    'beta'.
--
-- À exécuter sur Supabase APRÈS 0036. Idempotent (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  id           int primary key default 1,
  beta_enabled boolean not null default false,
  beta_end     timestamptz,
  constraint app_config_singleton check (id = 1)
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;
drop policy if exists "app_config_select_authenticated" on public.app_config;
create policy "app_config_select_authenticated" on public.app_config
  for select to authenticated using (true);

alter table public.subscriptions add column if not exists beta_end timestamptz;
```

- [ ] **Step 2: Write the Edge Function**

```ts
// supabase/functions/admin-manage-subscriptions/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "bad_json" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 🔒 Vérifie que l'appelant est authentifié ET listé dans app_admins.
  // Sans ce 2e check, n'importe quel compte connecté pourrait modifier
  // l'abonnement de n'importe qui en appelant cette fonction directement.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "missing_authorization" }, 401);
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user?.id) return jsonResponse({ error: "invalid_token" }, 401);
  const { data: adminRow } = await admin.from("app_admins").select("user_id").eq("user_id", callerData.user.id).maybeSingle();
  if (!adminRow) return jsonResponse({ error: "forbidden" }, 403);

  const action: string | undefined = payload?.action;

  if (action === "lookup_user") {
    const email = String(payload?.email || "").trim().toLowerCase();
    if (!email) return jsonResponse({ error: "missing_email" }, 400);
    const { data: member } = await admin
      .from("family_members")
      .select("user_id, display_name, email")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (!member?.user_id) return jsonResponse({ error: "user_not_found" }, 404);
    const { data: subRow } = await admin.from("subscriptions").select("*").eq("user_id", member.user_id).maybeSingle();
    return jsonResponse({ user_id: member.user_id, name: member.display_name || null, email: member.email, sub: subRow || null });
  }

  if (action === "set_user_plan") {
    const userId = String(payload?.user_id || "");
    const plan = String(payload?.plan || "");
    if (!userId || !["freemium", "beta", "trial_premium", "premium"].includes(plan)) {
      return jsonResponse({ error: "invalid_params" }, 400);
    }
    let update: Record<string, unknown> = { plan };
    if (plan === "beta") {
      const betaEnd = payload?.beta_end;
      if (!betaEnd) return jsonResponse({ error: "missing_beta_end" }, 400);
      update.beta_end = betaEnd;
    } else if (plan === "trial_premium") {
      const now = new Date().toISOString();
      update = { ...update, account_created_at: now, trial_start: now, premium_since: null, trial_extension_days: 0 };
    } else if (plan === "premium") {
      const cycle = payload?.premium_cycle;
      if (!["monthly", "yearly"].includes(cycle)) return jsonResponse({ error: "invalid_cycle" }, 400);
      update = { ...update, premium_since: new Date().toISOString(), cycle };
    }
    const { error } = await admin.from("subscriptions").upsert({ user_id: userId, ...update });
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === "set_global_beta") {
    const enabled = !!payload?.enabled;
    const endDate = payload?.end_date || null;
    const { error } = await admin.from("app_config").update({ beta_enabled: enabled, beta_end: endDate }).eq("id", 1);
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "unknown_action" }, 400);
});
```

**Known limitation, not to be "fixed" in this task** (note it in the report, don't attempt a workaround): `lookup_user` resolves an email via `family_members.email`. An account with no `family_members` row carrying a populated `email` (e.g., an account that never completed a flow that writes it) won't be found this way. This is the same resolution mechanism already used elsewhere in this codebase for email-based member lookups (migration `0020_member_email.sql`) — acceptable for this admin tool's scope, not a new gap introduced here.

- [ ] **Step 3: Ask the user to deploy both**

This cannot be run/deployed from this environment. Report the exact file paths and ask the user to: (a) paste the migration into the Supabase SQL Editor and run it, confirming success; (b) paste the Edge Function into the Supabase dashboard as a new function named `admin-manage-subscriptions` and deploy it. Client code in later tasks can still be written and built/unit-tested without this having run yet, but cannot be *live*-verified until it has.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0037_admin_subscription_management.sql supabase/functions/admin-manage-subscriptions/index.ts
git commit -m "Add app_config table, subscriptions.beta_end, and admin-manage-subscriptions function"
```

---

### Task 2: `subStatus()`/`isBeta()` rewrite + global-beta fetch wiring

**Files:**
- Modify: `src/App.jsx` (the `BETA_END` constant and `isBeta()` function, currently `App.jsx:399-419`; `subStatus()`, currently `App.jsx:292-313`; `App()`'s state declarations, right after `App.jsx:3086`)

**Interfaces:**
- Consumes: nothing new from other tasks — this task is self-contained (Task 1's DB objects don't need to exist yet for this task's code to build and pass existing tests, though live behavior needs Task 1 deployed).
- Produces: module-level `_globalBetaCache` (mutated by the new fetch effect, read by `isBeta()`); no changes to any function signature (`isBeta()`, `subStatus(sub)`, `getPerms(sub)`, `isPrem(sub)`, `isPremFull(sub)`, `isFreemiumPlan(sub)`, `planRankFor(sub)`, `familyMaxObservers(parentRows)` all keep their current parameter lists — Task 3 does not need to change any call site of these functions).

- [ ] **Step 1: Replace `BETA_END` with the module-level cache**

Current code (`App.jsx:399-404`):
```js
// ─── BÊTA GRATUITE — Premium offert, date de fin non arrêtée ──────────────────
// ⚠️ Repoussée volontairement loin (pas de date de sortie de bêta connue —
// dépend notamment de l'intégration Stripe, pas encore faite). Ne PAS
// remettre une date proche tant que le passage au payant n'est pas prêt :
// à cette échéance, isBeta() bascule à false pour tout le monde d'un coup.
const BETA_END = new Date("2030-01-01T00:00:00");
```
Replace with:
```js
// ─── BÊTA GRATUITE — pilotée depuis Supabase (table app_config), plus une
// constante codée en dur. _globalBetaCache est rempli une seule fois par un
// effet dans App() (voir plus bas) ; isBeta() le lit directement, exactement
// comme il lisait BETA_END avant — même rôle de constante partagée, juste
// chargée depuis la base pour être pilotable sans redéploiement de code.
let _globalBetaCache = { enabled: false, endMs: null };
```

- [ ] **Step 2: Update `isBeta()`**

Current code (`App.jsx:419`):
```js
function isBeta() { return Date.now() < BETA_END.getTime(); }
```
Replace with:
```js
function isBeta() { return _globalBetaCache.enabled && Date.now() < (_globalBetaCache.endMs ?? 0); }
```

- [ ] **Step 3: Add the per-account "beta" branch to `subStatus()`**

Current code (`App.jsx:292-313`):
```js
function subStatus(sub) {
  if(sub._admin) return "premium";
  if(sub.plan==="premium") {
    // Vérifie l'expiration de l'abonnement payant
    if(sub.premiumSince && sub.cycle) {
      const expiry = new Date(sub.premiumSince);
      sub.cycle==="yearly" ? expiry.setFullYear(expiry.getFullYear()+1) : expiry.setMonth(expiry.getMonth()+1);
      const bonusDays = sub.refMonths ? sub.refMonths * 30 : 0;
      expiry.setDate(expiry.getDate() + bonusDays);
      if(Date.now() > expiry.getTime()) return "freemium"; // abonnement expiré → freemium
    }
    return "premium";
  }
  if(isBeta()) return "trial_premium"; // 🎉 Bêta — Trial Premium offert à tous
  if(sub.plan==="freemium") return "freemium";
  const created = sub.accountCreatedAt || sub.trialStart;
  const ext = sub.trialExtension||0;
  const maxDays = Math.min(TRIAL_BASE_DAYS + ext, TRIAL_MAX_DAYS);
  const d = (Date.now()-new Date(created).getTime())/86400000;
  if(d<=maxDays) return sub.plan==="earned_premium" ? "earned_premium" : "trial_premium";
  return "freemium"; // expiré → freemium
}
```
Replace with:
```js
function subStatus(sub) {
  if(sub._admin) return "premium";
  if(sub.plan==="premium") {
    // Vérifie l'expiration de l'abonnement payant
    if(sub.premiumSince && sub.cycle) {
      const expiry = new Date(sub.premiumSince);
      sub.cycle==="yearly" ? expiry.setFullYear(expiry.getFullYear()+1) : expiry.setMonth(expiry.getMonth()+1);
      const bonusDays = sub.refMonths ? sub.refMonths * 30 : 0;
      expiry.setDate(expiry.getDate() + bonusDays);
      if(Date.now() > expiry.getTime()) return "freemium"; // abonnement expiré → freemium
    }
    return "premium";
  }
  // 🔒 Override admin "Bêta" par compte (date de fin propre à CE compte,
  // distincte de la bascule bêta globale ci-dessous). Tant que non dépassée :
  // accès complet (identique à un trial). Une fois dépassée : redevient un
  // Trial Premium normal de 15 jours qui démarre à CETTE date de fin — calculé
  // à la volée à chaque appel, jamais réécrit en base.
  if(sub.plan==="beta") {
    const betaEndMs = sub.betaEnd ? new Date(sub.betaEnd).getTime() : 0;
    if(Date.now() < betaEndMs) return "trial_premium";
    const d = (Date.now()-betaEndMs)/86400000;
    return d<=TRIAL_BASE_DAYS ? "trial_premium" : "freemium";
  }
  if(isBeta()) return "trial_premium"; // 🎉 Bêta — Trial Premium offert à tous
  if(sub.plan==="freemium") return "freemium";
  const created = sub.accountCreatedAt || sub.trialStart;
  const ext = sub.trialExtension||0;
  const maxDays = Math.min(TRIAL_BASE_DAYS + ext, TRIAL_MAX_DAYS);
  const d = (Date.now()-new Date(created).getTime())/86400000;
  if(d<=maxDays) return sub.plan==="earned_premium" ? "earned_premium" : "trial_premium";
  return "freemium"; // expiré → freemium
}
```

- [ ] **Step 4: Add the fetch effect in `App()`**

Insert immediately after `const [sub,setSub] = useLocalStorage("duvia_sub", makeSub);` (`App.jsx:3086`), before `const [myUid, setMyUid] = useState(null);`:
```js
  // 🌍 Bascule bêta globale (table app_config) — remplace l'ancienne constante
  // BETA_END codée en dur. Un seul fetch au montage ; _globalBetaCache (scope
  // module, voir isBeta()) est mis à jour puis un re-render est forcé pour que
  // tout ce qui appelle isBeta()/subStatus() pendant son rendu (dont App()
  // lui-même) relise la valeur fraîche. Pas d'état React pour la valeur elle-
  // même : isBeta() reste une fonction à zéro argument, comme avant, pour ne
  // rien changer aux nombreux call sites existants.
  const [, forceBetaRerender] = useState(0);
  useEffect(() => {
    supabase.from("app_config").select("beta_enabled, beta_end").eq("id", 1).maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        _globalBetaCache = { enabled: !!data.beta_enabled, endMs: data.beta_end ? new Date(data.beta_end).getTime() : null };
        forceBetaRerender(x => x + 1);
      });
  }, []);
```

- [ ] **Step 5: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 136`, `pass 136`, `fail 0` (unchanged — no pure logic in `core.js` is affected by this task).

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: build succeeds, no new warnings beyond the pre-existing chunk-size notice.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "Replace hardcoded BETA_END with a DB-backed global toggle, add per-account beta override to subStatus()"
```

---

### Task 3: `AdminTab` UI + version bump

**Files:**
- Modify: `src/App.jsx` (replace the "🎁 Offrir Premium à un compte" card, currently `App.jsx:14997-15022`, with two new components rendered from `AdminTab`; add the two new component definitions right before `function AdminTab() {`, currently `App.jsx:14701`)
- Modify: `src/config.js` (version bump)
- Modify: `public/sw.js` (version bump)

**Interfaces:**
- Consumes: `supabase` (already imported at the top of `App.jsx`), `useState`/`useEffect` (already imported).
- Produces: two new standalone components, `GlobalBetaCard` and `AccountSubscriptionCard`, each taking a single `{ C }` prop (the active theme object) — rendered inside `AdminTab`'s existing return, replacing the removed card. Neither needs `useApp()` — they're fully self-contained (their own local state, their own Supabase calls).

- [ ] **Step 1: Add the two new component definitions**

Insert immediately before `function AdminTab() {` (`App.jsx:14701`):
```jsx
function GlobalBetaCard({ C }) {
  const [enabled, setEnabled] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    supabase.from("app_config").select("beta_enabled, beta_end").eq("id", 1).maybeSingle()
      .then(({ data }) => {
        if (data) {
          setEnabled(!!data.beta_enabled);
          setEndDate(data.beta_end ? data.beta_end.slice(0, 10) : "");
        }
        setLoading(false);
      });
  }, []);

  async function save() {
    setSaving(true); setMsg(""); setErr("");
    try {
      const { data, error } = await supabase.functions.invoke("admin-manage-subscriptions", {
        body: { action: "set_global_beta", enabled, end_date: endDate ? new Date(endDate + "T23:59:59").toISOString() : null },
      });
      if (error) throw new Error(error.message || "invoke_failed");
      if (data?.error) throw new Error(data.error);
      setMsg("✅ Bascule bêta globale enregistrée.");
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <div className="card" style={{marginBottom:14,borderColor:`${C.vio}44`,background:`${C.vio}06`}}>
      <div style={{fontSize:11,fontWeight:800,color:C.vio,letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>🌍 Bêta globale</div>
      <div style={{fontSize:11,color:C.mut,marginBottom:12,lineHeight:1.5}}>
        Si activée : tous les comptes passent en Trial Premium jusqu'à la date de fin, sauf ceux ayant un vrai abonnement Premium payé.
      </div>
      <label style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,cursor:"pointer"}}>
        <input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} style={{width:18,height:18}} />
        <span style={{fontSize:13,fontWeight:700,color:C.txt}}>Bêta globale activée</span>
      </label>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{flex:1,minWidth:140}} />
        <button onClick={save} disabled={saving}
          style={{padding:"0 16px",height:38,background:C.vio,color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:800,cursor:saving?"wait":"pointer"}}>
          {saving?"…":"Enregistrer"}
        </button>
      </div>
      {msg && <div style={{marginTop:8,fontSize:11,color:C.grn}}>{msg}</div>}
      {err && <div style={{marginTop:8,fontSize:11,color:C.red}}>⚠️ {err}</div>}
    </div>
  );
}

function AccountSubscriptionCard({ C }) {
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState(null);
  const [betaEndDate, setBetaEndDate] = useState("");
  const [premiumCycle, setPremiumCycle] = useState("yearly");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function call(body) {
    const { data, error } = await supabase.functions.invoke("admin-manage-subscriptions", { body });
    if (error) throw new Error(error.message || "invoke_failed");
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function lookup() {
    const e = email.trim();
    if (!e) return;
    setLoading(true); setErr(""); setMsg(""); setAccount(null);
    try {
      const d = await call({ action: "lookup_user", email: e });
      setAccount(d);
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setLoading(false);
    }
  }

  async function applyPlan(plan) {
    if (!account) return;
    if (plan === "beta" && !betaEndDate) { setErr("Choisis une date de fin pour la Bêta."); return; }
    setApplying(plan); setErr(""); setMsg("");
    try {
      const body = { action: "set_user_plan", user_id: account.user_id, plan };
      if (plan === "beta") body.beta_end = new Date(betaEndDate + "T23:59:59").toISOString();
      if (plan === "premium") body.premium_cycle = premiumCycle;
      await call(body);
      setMsg(`✅ Compte mis à jour : ${plan}.`);
      const refreshed = await call({ action: "lookup_user", email: account.email });
      setAccount(refreshed);
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setApplying("");
    }
  }

  return (
    <div className="card" style={{borderColor:`${C.vio}44`,background:`${C.vio}06`}}>
      <div style={{fontSize:11,fontWeight:800,color:C.vio,letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>👤 Gérer l'abonnement d'un compte</div>
      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <input type="email" placeholder="email@duvia.fr" value={email} onChange={e=>setEmail(e.target.value)}
          style={{flex:1,minWidth:180,padding:"9px 12px",border:`1px solid ${C.bor}`,borderRadius:8,fontSize:13}} />
        <button onClick={lookup} disabled={loading || !email.trim()}
          style={{padding:"0 14px",height:38,background:C.vio,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",opacity:loading?.6:1}}>
          🔍 Chercher
        </button>
      </div>

      {account && (
        <div style={{padding:"10px 12px",background:C.sur,borderRadius:8,marginBottom:12}}>
          <div style={{fontWeight:800,fontSize:13,color:C.txt}}>{account.name || account.email}</div>
          <div style={{fontSize:11,color:C.mut}}>{account.email}</div>
          <div style={{fontSize:11,color:C.mut,marginTop:4}}>Plan actuel : <strong>{account.sub?.plan || "—"}</strong></div>
        </div>
      )}

      {account && (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <button onClick={()=>applyPlan("freemium")} disabled={!!applying}
            style={{height:38,background:C.bor,color:C.txt,border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {applying==="freemium"?"…":"Freemium"}
          </button>

          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <input type="date" value={betaEndDate} onChange={e=>setBetaEndDate(e.target.value)} style={{flex:1,minWidth:140}} />
            <button onClick={()=>applyPlan("beta")} disabled={!!applying}
              style={{padding:"0 16px",height:38,background:"#7c3aed",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
              {applying==="beta"?"…":"🌟 Bêta"}
            </button>
          </div>

          <button onClick={()=>applyPlan("trial_premium")} disabled={!!applying}
            style={{height:38,background:C.blu,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {applying==="trial_premium"?"…":"⏳ Trial Premium (15j)"}
          </button>

          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <select value={premiumCycle} onChange={e=>setPremiumCycle(e.target.value)}
              style={{height:38,borderRadius:8,border:`1.5px solid ${C.bor}`,padding:"0 10px",fontSize:13}}>
              <option value="monthly">Mensuel</option>
              <option value="yearly">Annuel</option>
            </select>
            <button onClick={()=>applyPlan("premium")} disabled={!!applying}
              style={{flex:1,minWidth:140,height:38,background:C.vio,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
              {applying==="premium"?"…":"⭐ Premium"}
            </button>
          </div>
        </div>
      )}

      {msg && <div style={{marginTop:10,fontSize:11,color:C.grn}}>{msg}</div>}
      {err && <div style={{marginTop:10,fontSize:11,color:C.red}}>⚠️ {err}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Replace the old local-only card with the two new components**

Current code (`App.jsx:14997-15022`):
```jsx
      {/* ── 🎁 Offrir Premium à un compte ─────────────────────────────── */}
      <div className="card" style={{borderColor:`${C.vio}44`,background:`${C.vio}06`}}>
        <div style={{fontSize:11,fontWeight:800,color:C.vio,letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>🎁 Offrir Premium à un compte</div>
        <div style={{fontSize:11,color:C.mut,marginBottom:10,lineHeight:1.5}}>
          S'applique à la prochaine connexion de ce compte, sur cet appareil. (Le statut d'abonnement n'est pas encore synchronisé dans le nuage — voir la spec multi-familles.)
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <select value={grantTarget} onChange={e=>setGrantTarget(e.target.value)}
            style={{flex:1,minWidth:180,height:38,borderRadius:8,border:`1.5px solid ${C.bor}`,padding:"0 10px",fontSize:13,background:C.card,color:C.txt}}>
            <option value="">— Choisir un compte —</option>
            {(users||[]).filter(u=>u.role!=="admin").map(u=>(
              <option key={u.id} value={u.id}>{u.name} ({u.email}){u.sub?.plan==="premium"?" ⭐ déjà Premium":""}</option>
            ))}
          </select>
          <button disabled={!grantTarget} onClick={()=>{
              setUsers(prev => prev.map(u => String(u.id)===String(grantTarget) ? {
                ...u,
                sub: { ...(u.sub||{}), plan:"premium", premiumSince:new Date().toISOString(), cycle:"yearly" },
              } : u));
              setGrantTarget("");
            }}
            style={{padding:"8px 16px",background:grantTarget?C.vio:C.bor,color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:800,cursor:grantTarget?"pointer":"not-allowed"}}>
            🎁 Donner Premium (1 an)
          </button>
        </div>
      </div>
```
Replace with:
```jsx
      {/* ── Gestion admin des abonnements ────────────────────────────── */}
      <GlobalBetaCard C={C} />
      <AccountSubscriptionCard C={C} />
```

- [ ] **Step 3: Remove the now-unused `grantTarget` state**

Current code (`App.jsx:14703`):
```jsx
  const [grantTarget, setGrantTarget] = useState("");
```
Delete this line entirely — it was only read/written by the card removed in Step 2, and nothing else in `AdminTab` references `grantTarget`.

- [ ] **Step 4: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 136`, `pass 136`, `fail 0`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build succeeds, no new warnings beyond the pre-existing chunk-size notice.

- [ ] **Step 6: Bump the version**

In `src/config.js`:
```js
export const APP_VERSION = "1.83";
```
In `public/sw.js`:
```js
const SW_VERSION = "1.83";
```

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Replace local-only premium-grant tool with real server-side admin subscription management UI"
```

---

## Post-plan manual verification (not automatable in this environment)

1. User runs Task 1's migration and deploys the Edge Function.
2. Global bêta: enable it with a near-future end date, confirm a Freemium test account sees Trial Premium access; confirm a real Premium test account is unaffected; wait for (or backdate) the end date to pass, confirm the Freemium account reverts.
3. Per-account override: look up a real test account by email, set it to Bêta with a near-future end date, confirm full access; let the date pass, confirm it automatically shows as a fresh 15-day Trial Premium (no manual action needed); confirm Freemium/Trial Premium/Premium (both cycles) each apply correctly and are reflected immediately on lookup-refresh.
4. Confirm a non-admin account cannot call `admin-manage-subscriptions` successfully (test via browser console or by temporarily removing admin status).
