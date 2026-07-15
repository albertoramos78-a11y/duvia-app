# Partage familial du meilleur plan (parents + enfants + observateurs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le statut effectif d'un compte (parent, enfant, ou observateur) devient le meilleur des deux plans parents de sa famille active, pas seulement son propre plan individuel — pour que toutes les fonctionnalités gérées par `getPerms()`/`subStatus()` (messagerie, coffre-fort, dates personnalisées, quotas enfants/observateurs...) reflètent le vrai plan de la famille.

**Architecture:** La RPC `get_family_billing_context()` (migration 0036, déjà déployée) est étendue en place via une nouvelle migration (`create or replace function`, idempotent) pour être appelable par tout membre actif de la famille (pas seulement un observateur) et pour identifier le parent payeur — mais uniquement quand l'appelant est lui-même un parent, jamais un enfant/observateur. Côté client, un seul point de calcul (déjà utilisé aujourd'hui uniquement pour le quota d'observateurs) est élargi pour alimenter `st`/`prem`/`perms`/`days` dans tout `App()`, avec une exception explicite pour `spinWinSub` qui reste basé sur le plan individuel réel. `PremiumTab` affiche un bandeau dédié quand le statut affiché vient du co-parent plutôt que du compte connecté.

**Tech Stack:** React (hooks), Supabase Postgres (fonctions `SECURITY DEFINER` en PL/pgSQL), `@supabase/supabase-js`.

## Global Constraints

- Spec de référence : `docs/superpowers/specs/2026-07-15-family-wide-premium-sharing-design.md` — toute ambiguïté se résout en sa faveur.
- `TZ=Europe/Paris npm test` doit rester vert (136 tests) après chaque tâche — aucune régression tolérée.
- `npm run build` doit rester propre après chaque tâche.
- **Version bump : uniquement dans la Tâche 3** (la dernière, celle qui produit le changement visible pour l'utilisateur final). `src/config.js`'s `APP_VERSION` et `public/sw.js`'s `SW_VERSION` passent tous les deux de `"1.90"` à `"1.91"`. Ne PAS bumper dans les Tâches 1 ou 2.
- Ne jamais dupliquer la logique de `subStatus()`/`getPerms()`/`planRankFor()` (`App.jsx:292-370`) en PL/pgSQL — la comparaison "meilleur des deux plans" reste 100% côté client, réutilisant ces fonctions existantes telles quelles. La RPC ne fait que lever la restriction de rôle et renvoyer les lignes brutes.
- La RPC ne doit JAMAIS renvoyer l'identité (`parent_user_id`) ou l'email d'un parent à un appelant qui n'est pas lui-même un parent actif de la même famille — la vérification se fait côté serveur sur le rôle de l'appelant (`v_role`, lu depuis `family_members` via `auth.uid()`), jamais sur un paramètre fourni par le client.
- Aucune ligne `subscriptions` individuelle n'est jamais réécrite pour refléter le plan familial partagé — c'est une résolution en lecture seule, jamais persistée.
- `perms.spinWinSub` doit toujours être dérivé du `sub` **individuel** de l'utilisateur connecté, jamais de `effectiveSub` — un compte qui bénéficie du plan familial sans payer lui-même ne doit jamais pouvoir gagner un lot Premium à la roue.
- Aucun nouveau test unitaire pur n'est attendu pour la logique d'orchestration réseau (`bestParentSub`, l'effet réseau, `effectiveSub`) — même précédent que le plan `2026-07-14-observer-quota-enforcement.md`, dont le code équivalent (`familyMaxObservers`, l'effet `checkObserverQuota`) n'a lui non plus jamais eu de test unitaire dédié. La vérification passe par la suite de régression existante + une vérification live avec des comptes de test réels fournis en direct par l'utilisateur (un parent Premium réel et son co-parent, dans la même famille).
- **Sécurité** : aucun identifiant réel de compte/famille (UUID, email, code d'invitation) ne doit jamais être écrit dans ce dépôt (code, docs, commits) — uniquement échangés en conversation directe pour du diagnostic ponctuel si besoin.

---

### Task 1: Migration SQL — étendre `get_family_billing_context` + nouvelle RPC `get_coparent_email`

**Files:**
- Create: `supabase/migrations/0039_family_wide_effective_plan.sql`

**Interfaces:**
- Produces: `public.get_family_billing_context(p_family_id uuid default null)` — même nom/signature que la version déjà déployée (migration 0036), remplacée via `create or replace function` (idempotent, pattern déjà utilisé par la migration 0030 sur une fonction antérieure). Callable désormais par tout membre actif (`parent`/`child`/`observer`), plus seulement `observer`. Colonnes de retour inchangées **sauf** l'ajout de `parent_user_id uuid` (8ᵉ colonne, avant `my_observer_rank`), rempli uniquement si l'appelant a lui-même `role='parent'` dans `family_members`, sinon `NULL`.
- Produces: `public.get_coparent_email(p_user_id uuid) returns text` — nouvelle fonction, utilisée uniquement par `PremiumTab` (Tâche 3) pour résoudre l'email à afficher dans le bandeau "Premium via votre famille".

> **Correction post-revue (commit `e844408`)** : le SQL ci-dessous plaçait à l'origine `parent_user_id` **avant** `my_observer_rank` — PostgreSQL n'autorise `CREATE OR REPLACE FUNCTION` à étendre un `RETURNS TABLE` existant qu'en **ajoutant en fin de liste**, jamais en insérant une colonne au milieu (`cannot change return type of existing function`). Le fichier réellement committé place `parent_user_id` **après** `my_observer_rank`. Le SQL ci-dessous est laissé tel quel pour l'historique de la décision de conception ; se fier au fichier `supabase/migrations/0039_family_wide_effective_plan.sql` réel, pas à ce bloc, pour l'ordre exact des colonnes.

- [ ] **Step 1: Écrire la migration complète**

Créer `supabase/migrations/0039_family_wide_effective_plan.sql` avec ce contenu exact :

```sql
-- 0039_family_wide_effective_plan.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Étend get_family_billing_context() (0036, déjà déployée) : jusqu'ici réservée
-- à un observateur qui vérifie son propre quota, elle devient appelable par
-- TOUT membre actif d'une famille (parent/enfant/observateur) pour connaître le
-- statut effectif de sa famille = le meilleur des deux plans parents, pas
-- seulement son propre plan individuel. Voir
-- docs/superpowers/specs/2026-07-15-family-wide-premium-sharing-design.md.
--
-- create or replace function est idempotent — même pattern que 0030 sur une
-- fonction antérieure. Aucune table modifiée, aucune donnée migrée.
--
-- Sécurité : ajoute parent_user_id aux lignes retournées, mais UNIQUEMENT
-- rempli si l'appelant est lui-même un parent actif de cette famille (vérifié
-- côté serveur via v_role, jamais falsifiable par le client) — un enfant ou un
-- observateur qui interroge cette fonction pour son propre statut ne reçoit
-- jamais l'identité d'un parent. Pas de champ email ici (voir
-- get_coparent_email ci-dessous, restreint aux seuls appelants parents).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_family_billing_context(p_family_id uuid default null)
returns table (
  parent_plan                 text,
  parent_premium_since        timestamptz,
  parent_cycle                text,
  parent_trial_start          timestamptz,
  parent_trial_extension_days int,
  parent_account_created_at   timestamptz,
  parent_beta_end              timestamptz,
  parent_user_id               uuid,
  my_observer_rank             int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_family_id   uuid;
  v_role        text;
  v_joined_at   timestamptz;
  v_rank        int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if p_family_id is not null then
    select family_id, role, joined_at into v_family_id, v_role, v_joined_at
      from public.family_members
     where user_id = v_uid and status = 'active' and family_id = p_family_id
     limit 1;
  else
    select family_id, role, joined_at into v_family_id, v_role, v_joined_at
      from public.family_members
     where user_id = v_uid and status = 'active'
     limit 1;
  end if;

  if v_family_id is null then
    raise exception 'no_family';
  end if;

  -- 🔧 La restriction "observateur uniquement" est retirée ici (0036 la posait
  -- via `raise exception 'not_an_observer'`) : tout rôle actif peut désormais
  -- appeler cette fonction pour SA PROPRE famille. my_observer_rank reste
  -- calculé uniquement pour un appelant observateur (0 sinon, inoffensif —
  -- seul familyMaxObservers() côté client en a l'usage, et seulement pour un
  -- observateur).
  if v_role = 'observer' then
    select count(*) into v_rank
      from public.family_members
     where family_id = v_family_id
       and role = 'observer'
       and status = 'active'
       and joined_at < v_joined_at;
  else
    v_rank := 0;
  end if;

  return query
    select
      s.plan, s.premium_since, s.cycle, s.trial_start, s.trial_extension_days,
      s.account_created_at, s.beta_end,
      case when v_role = 'parent' then fm.user_id else null end,
      v_rank
      from public.family_members fm
      left join public.subscriptions s on s.user_id = fm.user_id
     where fm.family_id = v_family_id
       and fm.role = 'parent'
       and fm.status = 'active';
end;
$$;

revoke all     on function public.get_family_billing_context(uuid) from public;
grant  execute on function public.get_family_billing_context(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_coparent_email : résout l'email d'un co-parent pour l'affichage du
-- bandeau "Premium via votre famille" (PremiumTab). Restreinte aux appelants
-- eux-mêmes parents actifs, et à une cible elle-même parent actif de LA MÊME
-- famille que l'appelant — même pattern de vérification que
-- set_member_identity (0020_member_email.sql).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_coparent_email(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_family_id   uuid;
  v_target_role text;
  v_email       text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_user_id is null then
    raise exception 'missing_user_id';
  end if;

  select family_id into v_family_id
    from public.family_members
   where user_id = v_uid and status = 'active' and role = 'parent'
   limit 1;

  if v_family_id is null then
    raise exception 'not_a_parent';
  end if;

  select role into v_target_role
    from public.family_members
   where user_id = p_user_id and status = 'active' and family_id = v_family_id
   limit 1;

  if v_target_role is null or v_target_role <> 'parent' then
    raise exception 'not_a_coparent';
  end if;

  select email into v_email from auth.users where id = p_user_id;
  return v_email;
end;
$$;

revoke all     on function public.get_coparent_email(uuid) from public;
grant  execute on function public.get_coparent_email(uuid) to authenticated;
```

- [ ] **Step 2: Vérifier la syntaxe par relecture**

Pas d'exécution automatisée possible dans cet environnement (pas d'accès CLI Supabase, voir CLAUDE.md). Relire le fichier une fois écrit : vérifier que les deux `create or replace function` sont bien fermés par `$$;`, que les deux `revoke`/`grant` sont présents, et que les noms de colonnes de `get_family_billing_context` correspondent exactement à ceux déjà consommés côté client aujourd'hui (`parent_plan`, `parent_premium_since`, `parent_cycle`, `parent_trial_start`, `parent_trial_extension_days`, `parent_account_created_at`, `parent_beta_end`, `my_observer_rank`) plus le nouveau `parent_user_id`. Le déploiement réel (copier-coller dans le SQL Editor Supabase) sera fait par l'utilisateur après la fin du plan, pas par l'implémenteur.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0039_family_wide_effective_plan.sql
git commit -m "Extend get_family_billing_context + add get_coparent_email for family-wide plan sharing"
```

---

### Task 2: Client — statut effectif partagé (`bestParentSub`, effet réseau élargi, `effectiveSub`)

**Files:**
- Modify: `src/App.jsx:363-408` (extraction de `bestParentSub`, refactor de `familyMaxObservers`)
- Modify: `src/App.jsx:3312-3339` (effet `checkObserverQuota` renommé/élargi en `checkFamilyBilling`)
- Modify: `src/App.jsx:4629` (bouton "🔄 Réessayer" du gate observateur-hors-quota, référence à renommer)
- Modify: `src/App.jsx:4047-4056` (calcul de `effectiveSub`/`st`/`prem`/`perms`/`days`/`familyPremiumFromCoParent`)
- Modify: `src/App.jsx:4676-4680` (exposition dans `ctxValue`)

**Interfaces:**
- Consumes: RPC `get_family_billing_context` de la Tâche 1 (colonne additionnelle `parent_user_id`).
- Produces (consommé par la Tâche 3) : `familyBestSub` (objet `{plan, premiumSince, cycle, trialStart, trialExtension, accountCreatedAt, betaEnd, parentUserId}` ou `null`) et `familyPremiumFromCoParent` (boolean), tous deux exposés via `useApp()`.

- [ ] **Step 1: Extraire `bestParentSub` et refactorer `familyMaxObservers`**

Dans `src/App.jsx`, remplacer (lignes 390-408) :

```js
function familyMaxObservers(parentRows) {
  if (!parentRows || parentRows.length === 0) return 1;
  const subs = parentRows.map(r => r.parent_plan ? {
    plan: r.parent_plan,
    premiumSince: r.parent_premium_since,
    cycle: r.parent_cycle,
    trialStart: r.parent_trial_start,
    trialExtension: r.parent_trial_extension_days,
    accountCreatedAt: r.parent_account_created_at,
    betaEnd: r.parent_beta_end,
  } : {
    plan: "trial_premium",
    accountCreatedAt: new Date().toISOString(),
    trialStart: new Date().toISOString(),
    trialExtension: 0,
  });
  const best = subs.reduce((acc, s) => planRankFor(s) > planRankFor(acc) ? s : acc, subs[0]);
  return getPerms(best).maxObservers;
}
```

par :

```js
// bestParentSub : réduit les lignes brutes de get_family_billing_context() au
// "meilleur des deux plans parents" de la famille — réutilisé à la fois par
// familyMaxObservers() (quota d'observateurs, inchangé) et par le statut
// effectif partagé par toute la famille (voir l'effet checkFamilyBilling et
// effectiveSub plus bas dans App()). Un parent sans encore de ligne
// subscriptions (upsert client-side avec 3s de debounce) est traité comme un
// Trial fraîchement créé, jamais comme Freemium par défaut (voir le
// commentaire détaillé ci-dessus sur le LEFT JOIN de la RPC).
function bestParentSub(parentRows) {
  if (!parentRows || parentRows.length === 0) return null;
  const subs = parentRows.map(r => r.parent_plan ? {
    plan: r.parent_plan,
    premiumSince: r.parent_premium_since,
    cycle: r.parent_cycle,
    trialStart: r.parent_trial_start,
    trialExtension: r.parent_trial_extension_days,
    accountCreatedAt: r.parent_account_created_at,
    betaEnd: r.parent_beta_end,
    parentUserId: r.parent_user_id || null,
  } : {
    plan: "trial_premium",
    accountCreatedAt: new Date().toISOString(),
    trialStart: new Date().toISOString(),
    trialExtension: 0,
    parentUserId: null,
  });
  return subs.reduce((acc, s) => planRankFor(s) > planRankFor(acc) ? s : acc, subs[0]);
}
function familyMaxObservers(parentRows) {
  const best = bestParentSub(parentRows);
  return best ? getPerms(best).maxObservers : 1;
}
```

- [ ] **Step 2: Élargir l'effet réseau à tous les rôles**

Dans `src/App.jsx`, remplacer (lignes 3320-3339) :

```js
  const [observerOverQuota, setObserverOverQuota] = useState(false);
  const checkObserverQuota = useCallback(async () => {
    // 🔧 Pas `isObs` ici (déclaré plus bas dans App(), App.jsx:4001) : le
    // référencer dans ce tableau de dépendances évalué à cet endroit-ci du
    // corps de fonction lèverait un ReferenceError (TDZ) à CHAQUE rendu, pour
    // tout le monde, pas seulement les observateurs — même famille de bug que
    // l'incident notifyIfNewDevice documenté dans CLAUDE.md. Expression
    // équivalente inlinée à la place.
    if (user?.role !== "observer" || !familySync.familyId) { setObserverOverQuota(false); return; }
    try {
      const { data, error } = await supabase.rpc("get_family_billing_context", { p_family_id: familySync.familyId });
      if (error) return;
      const rows = data || [];
      const rank = rows[0]?.my_observer_rank ?? 0;
      setObserverOverQuota(rank >= familyMaxObservers(rows));
    } catch (e) {
      console.error("[Duvia] get_family_billing_context error:", e);
    }
  }, [user?.role, familySync.familyId]);
  useEffect(() => { checkObserverQuota(); }, [checkObserverQuota]);
```

par :

```js
  const [observerOverQuota, setObserverOverQuota] = useState(false);
  // 🔧 2026-07-15 : élargi à tous les rôles (plus seulement l'observateur) —
  // voir docs/superpowers/specs/2026-07-15-family-wide-premium-sharing-design.md.
  // familyBestSub alimente effectiveSub plus bas dans App() : le statut
  // effectif de TOUT membre de la famille devient le meilleur des deux plans
  // parents, pas seulement son propre plan individuel.
  const [familyBestSub, setFamilyBestSub] = useState(null);
  const checkFamilyBilling = useCallback(async () => {
    // 🔧 Pas `isObs` ici (déclaré plus bas dans App(), App.jsx:4001) : le
    // référencer dans ce tableau de dépendances évalué à cet endroit-ci du
    // corps de fonction lèverait un ReferenceError (TDZ) à CHAQUE rendu, pour
    // tout le monde, pas seulement les observateurs — même famille de bug que
    // l'incident notifyIfNewDevice documenté dans CLAUDE.md. Expression
    // équivalente inlinée à la place.
    if (user?.role === "admin" || !familySync.familyId) { setObserverOverQuota(false); setFamilyBestSub(null); return; }
    try {
      const { data, error } = await supabase.rpc("get_family_billing_context", { p_family_id: familySync.familyId });
      if (error) return;
      const rows = data || [];
      setFamilyBestSub(bestParentSub(rows));
      if (user?.role !== "observer") { setObserverOverQuota(false); return; }
      const rank = rows[0]?.my_observer_rank ?? 0;
      setObserverOverQuota(rank >= familyMaxObservers(rows));
    } catch (e) {
      console.error("[Duvia] get_family_billing_context error:", e);
    }
  }, [user?.role, familySync.familyId]);
  useEffect(() => { checkFamilyBilling(); }, [checkFamilyBilling]);
```

**⚠️ Mise à jour obligatoire d'une 3ᵉ référence** : `checkObserverQuota` est aussi appelé directement par le bouton "🔄 Réessayer" de l'écran de blocage observateur-hors-quota (`App.jsx:4629`, à l'intérieur du gate `if (isObs && observerOverQuota) return (...)`). Remplacer, dans ce même bloc :

```js
          <button onClick={checkObserverQuota}
```

par :

```js
          <button onClick={checkFamilyBilling}
```

Sans ce changement, ce bouton lèverait une `ReferenceError` (nom renommé mais pas mis à jour ici) dès qu'un observateur hors quota cliquerait "Réessayer".

- [ ] **Step 3: Calculer `effectiveSub`/`familyPremiumFromCoParent` et rebrancher `st`/`prem`/`perms`/`days`**

Dans `src/App.jsx`, remplacer (lignes 4047-4055) :

```js
  const t     = useMemo(() => TR[lang], [lang]);
  const st    = useMemo(() => subStatus(sub), [sub]);
  const prem  = useMemo(() => isPrem(sub), [sub]);
  const perms = useMemo(() => getPerms(sub), [sub]);
  const days  = useMemo(() => trialLeft(sub), [sub]);
  // isAdm = vrai seulement si Supabase confirme (app_admins) — résiste au localStorage falsifié
  const isAdm = user?.role === "admin" && adminVerified;
  const isObs = user?.role==="observer";
  const isChild = user?.role==="child";
```

par :

```js
  const t     = useMemo(() => TR[lang], [lang]);
  // 🔧 2026-07-15 : le statut effectif de la famille (parent/enfant/observateur)
  // devient le meilleur des deux plans parents, pas seulement le plan
  // individuel du compte connecté — voir docs/superpowers/specs/2026-07-15-
  // family-wide-premium-sharing-design.md. familyBestSub vient de l'effet
  // checkFamilyBilling ci-dessus ; on ne dégrade jamais : si l'appel réseau
  // échoue ou n'a pas encore répondu, effectiveSub retombe sur le sub
  // individuel, exactement comme avant cette fonctionnalité.
  const effectiveSub = useMemo(
    () => (familyBestSub && planRankFor(familyBestSub) > planRankFor(sub)) ? familyBestSub : sub,
    [sub, familyBestSub]
  );
  const st    = useMemo(() => subStatus(effectiveSub), [effectiveSub]);
  const prem  = useMemo(() => isPrem(effectiveSub), [effectiveSub]);
  const perms = useMemo(() => ({
    ...getPerms(effectiveSub),
    // spinWinSub : gagner du Premium à la roue reste réservé à qui est
    // RÉELLEMENT payeur — pas à qui bénéficie du plan familial sans payer.
    spinWinSub: subStatus(sub)==="premium" || sub._admin,
  }), [effectiveSub, sub]);
  const days  = useMemo(() => trialLeft(effectiveSub), [effectiveSub]);
  // familyPremiumFromCoParent : vrai seulement si le statut affiché vient du
  // co-parent (jamais de moi-même) — utilisé par PremiumTab pour la bannière
  // "Premium via votre famille" et pour masquer les actions d'abonnement qui
  // n'ont pas de sens pour qui ne paie pas personnellement.
  const familyPremiumFromCoParent = !!(
    familyBestSub && familyBestSub.parentUserId && familyBestSub.parentUserId !== myUid &&
    planRankFor(familyBestSub) > planRankFor(sub)
  );
  // isAdm = vrai seulement si Supabase confirme (app_admins) — résiste au localStorage falsifié
  const isAdm = user?.role === "admin" && adminVerified;
  const isObs = user?.role==="observer";
  const isChild = user?.role==="child";
```

- [ ] **Step 4: Exposer dans le contexte**

Dans `src/App.jsx`, remplacer (ligne 4680) :

```js
    prem, perms, st, days, isAdm, isObs, isChild, unread, adminVerified,
```

par :

```js
    prem, perms, st, days, isAdm, isObs, isChild, unread, adminVerified,
    familyBestSub, familyPremiumFromCoParent,
```

- [ ] **Step 5: Vérifier qu'il n'y a pas de régression**

Run: `TZ=Europe/Paris npm test`
Expected: 136/136 tests passants (aucun nouveau test dans cette tâche — logique d'orchestration réseau, voir Global Constraints).

Run: `npm run build`
Expected: build propre, sans nouvelle erreur.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Compute effective family-wide plan status (best of both parents) for all roles"
```

---

### Task 3: `PremiumTab` — bandeau "Premium via votre famille" + bump de version

**Files:**
- Modify: `src/App.jsx:15402-15656` (`PremiumTab`)
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: `familyPremiumFromCoParent`, `familyBestSub` (Tâche 2, via `useApp()`) ; RPC `get_coparent_email` (Tâche 1).

- [ ] **Step 1: Résoudre l'email du co-parent**

Dans `src/App.jsx`, dans `PremiumTab`, remplacer la ligne de destructuration (ligne 15403) :

```js
  const {C,t,sub,setSub,st,days,perms,setMenuTab,setShowMenu,users,user,setConfirmDeleteAccount} = useApp();
```

par :

```js
  const {C,t,sub,setSub,st,days,perms,setMenuTab,setShowMenu,users,user,setConfirmDeleteAccount,familyPremiumFromCoParent,familyBestSub} = useApp();
```

Puis, juste après la ligne `const isPremium=st==="premium"||sub._admin;` (ligne 15406), ajouter :

```js
  // Résout l'email du co-parent payeur uniquement quand le statut affiché
  // vient effectivement de lui (jamais un appel réseau pour rien).
  const [coparentEmail, setCoparentEmail] = useState("");
  useEffect(() => {
    if (!familyPremiumFromCoParent || !familyBestSub?.parentUserId) { setCoparentEmail(""); return; }
    let cancelled = false;
    supabase.rpc("get_coparent_email", { p_user_id: familyBestSub.parentUserId }).then(({ data }) => {
      if (!cancelled) setCoparentEmail(data || "");
    });
    return () => { cancelled = true; };
  }, [familyPremiumFromCoParent, familyBestSub?.parentUserId]);
```

- [ ] **Step 2: Ajouter le bandeau dans la carte de statut**

Dans `src/App.jsx`, dans `PremiumTab`, repérer ce bloc (lignes 15513-15515) :

```js
          {isPremium&&sub.premiumSince&&<div style={{fontSize:12,color:C.mut}}>{t.premSince} {new Date(sub.premiumSince).toLocaleDateString()} · {sub.cycle==="monthly"?t.monthly:t.yearly}</div>}
          {st==="trial_premium"&&<div style={{fontSize:12,color:C.mut,marginTop:4}}>Passez à Premium pour un accès illimité</div>}
          {st==="freemium"&&<div style={{fontSize:12,color:C.mut,marginTop:4}}>Compte gratuit permanent — fonctions limitées</div>}
```

Ajouter juste après la ligne `{isPremium&&sub.premiumSince&&...}` :

```js
          {familyPremiumFromCoParent&&<div style={{fontSize:12,color:C.vio,fontWeight:700,marginTop:6}}>👨‍👩‍👧 Premium via votre famille{coparentEmail?` : ${coparentEmail} y a souscrit`:""}</div>}
```

- [ ] **Step 3: Masquer la gestion d'abonnement (annuler/reprendre) pour qui ne paie pas**

Dans `src/App.jsx`, dans `PremiumTab`, remplacer (ligne 15520) :

```js
      {isPremium && !sub._admin && !isBeta() && (
```

par :

```js
      {isPremium && !sub._admin && !isBeta() && !familyPremiumFromCoParent && (
```

- [ ] **Step 4: Masquer le second bloc "annuler" (legacy) pour qui ne paie pas**

Dans `src/App.jsx`, dans `PremiumTab`, remplacer (ligne 15626) :

```js
      {isPremium&&(
```

par :

```js
      {isPremium && !familyPremiumFromCoParent && (
```

- [ ] **Step 5: Vérifier qu'il n'y a pas de régression**

Run: `TZ=Europe/Paris npm test`
Expected: 136/136 tests passants.

Run: `npm run build`
Expected: build propre.

- [ ] **Step 6: Bump de version**

Dans `src/config.js`, remplacer :
```js
export const APP_VERSION = "1.90";
```
par :
```js
export const APP_VERSION = "1.91";
```

Dans `public/sw.js`, remplacer :
```js
const SW_VERSION = "1.90";
```
par :
```js
const SW_VERSION = "1.91";
```

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Show 'Premium via votre famille' banner and hide own-subscription actions for co-parent-covered accounts"
```

---

## Après le plan (à faire par l'utilisateur, pas par l'implémenteur)

- Coller `supabase/migrations/0039_family_wide_effective_plan.sql` dans le SQL Editor Supabase et l'exécuter.
- Vérifier en live avec des comptes de test réels (un parent Premium réel et son co-parent, dans une même famille) — à échanger en conversation directe pour le diagnostic, jamais à écrire dans ce dépôt :
  - Le co-parent voit désormais Premium partout (messagerie, coffre-fort, dates perso, quotas) + le bandeau "Premium via votre famille : {email du parent payeur} y a souscrit" dans `PremiumTab`, sans bouton annuler.
  - Le parent payeur ne voit aucun changement.
  - Un enfant/observateur de cette famille bénéficie aussi de l'accès élargi.
  - Vérifier dans l'onglet Réseau qu'aucun email de parent ne transite vers une session enfant/observateur.
