# Rendre le parrainage réellement fonctionnel (multi-appareils) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le système de parrainage fonctionne réellement entre deux vrais comptes sur deux appareils différents — aujourd'hui la vérification du code et le crédit du bonus au parrain passent tous les deux par un tableau `localStorage` propre à l'appareil, et le seuil de validation est mathématiquement impossible à atteindre.

**Architecture:** Deux nouvelles fonctions Supabase `SECURITY DEFINER` (`consume_referral_code`, `credit_referral_validation`) remplacent les deux lookups locaux dans `users`, en réutilisant les colonnes déjà existantes sur `subscriptions` (`ref_code`, `ref_used`, `ref_count`, `validated_ref_count`, `ref_months`, `pending_spins`, `monthly_ref_month`, `monthly_ref_count` — confirmées en production, jamais capturées dans une migration de ce dépôt). Une seule colonne manque (`ref_validated`, anti-rejeu). Le seuil de validation est abaissé pour correspondre aux 3 actions réellement câblées aujourd'hui, et le bouton "Simuler un filleul validé" (un exploit self-service actif en production) est réservé aux admins.

**Tech Stack:** React (hooks), Supabase Postgres (fonctions `SECURITY DEFINER` en PL/pgSQL), `@supabase/supabase-js`.

## Global Constraints

- Spec de référence : `docs/superpowers/specs/2026-07-15-referral-system-fix-design.md` — toute ambiguïté se résout en sa faveur.
- `TZ=Europe/Paris npm test` doit rester vert (136 tests) après chaque tâche.
- `npm run build` doit rester propre après chaque tâche.
- **Version bump : uniquement dans la Tâche 3** (la dernière). `src/config.js`'s `APP_VERSION` et `public/sw.js`'s `SW_VERSION` bumpés ensemble de +0.01. Ne PAS bumper dans les Tâches 1 ou 2.
- Le calcul du bonus (paliers Trial dégressifs, plafond mensuel Premium) DOIT être réimplémenté et vérifié côté serveur dans `credit_referral_validation()` — ne jamais faire confiance à un montant envoyé par le client pour cette fonction précise, car elle modifie les données d'un AUTRE compte (le parrain). C'est une exception délibérée au principe habituel de ce projet (ne pas dupliquer la logique métier en SQL) : ici la duplication protège contre un abus, pas contre un simple risque de dérive d'affichage.
- `consume_referral_code` ne doit PAS exiger que l'appelant soit authentifié — elle est appelée pendant le flux d'inscription, où l'état de la session Supabase Auth de l'appelant n'est pas garanti stable à cet instant précis. Elle doit être accordée (`grant execute`) à la fois à `anon` et `authenticated`, et ne doit jamais utiliser `auth.uid()` en interne.
- `credit_referral_validation` DOIT utiliser `auth.uid()` pour identifier l'appelant (le filleul) — jamais un paramètre fourni par le client.
- Aucune nouvelle table n'est créée — seule une colonne (`ref_validated`) est ajoutée à `subscriptions`.
- Ne câble aucune des 7 actions `REF_ACTION_WEIGHTS` non utilisées aujourd'hui (`UPLOAD_DOC`, `ADD_EVENT`, `PARENT_ACCEPTED`, `OBSERVER_ACCEPTED`, `ADD_CHILD`, `CHANGE_ZONE`, `ACTIVATE_EVENT`) — hors scope, voir Non-objectifs de la spec.

---

### Task 1: Migration SQL — `ref_validated` + `consume_referral_code` + `credit_referral_validation`

**Files:**
- Create: `supabase/migrations/0040_referral_system_fix.sql`

**Interfaces:**
- Produces: `public.consume_referral_code(p_code text) returns json` — `{ "valid": boolean, "referrer_id": uuid | absent }`. Accordée à `anon` ET `authenticated`.
- Produces: `public.credit_referral_validation() returns json` — `{ "ok": true }` en cas de succès, lève une exception sinon (`not_authenticated`, `no_referral_to_credit`, `already_validated`, `referrer_not_found`). Accordée uniquement à `authenticated`.

- [ ] **Step 1: Écrire la migration complète**

Créer `supabase/migrations/0040_referral_system_fix.sql` avec ce contenu exact :

```sql
-- 0040_referral_system_fix.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Rend le parrainage fonctionnel entre deux vrais comptes sur deux appareils
-- différents. Jusqu'ici, la vérification du code parrain à l'inscription et
-- le crédit du bonus au parrain passaient tous les deux par un tableau
-- localStorage propre à l'appareil (`users`, App.jsx) — jamais synchronisé
-- avec Supabase, donc jamais fonctionnel pour deux personnes réelles sur deux
-- appareils. Voir docs/superpowers/specs/2026-07-15-referral-system-fix-design.md.
--
-- La table subscriptions a déjà en production toutes les colonnes
-- nécessaires (ref_code, ref_used, ref_count, validated_ref_count,
-- ref_months, pending_spins, monthly_ref_month, monthly_ref_count) —
-- confirmé via information_schema.columns, jamais capturées dans une
-- migration de ce dépôt (même situation que la table elle-même). Seule
-- ref_validated manque, ajoutée ci-dessous.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.subscriptions add column if not exists ref_validated boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────────────
-- consume_referral_code : vérifie qu'un code parrain correspond à un vrai
-- compte actif, incrémente son ref_count côté serveur. Appelée PENDANT le
-- flux d'inscription (App.jsx, doReg()) — l'état de la session Supabase Auth
-- de l'appelant à cet instant précis n'est pas garanti, donc cette fonction
-- n'utilise JAMAIS auth.uid() et est accordée à anon ET authenticated. Aucune
-- donnée sensible n'est exposée : juste valide/invalide + l'id du parrain,
-- qui ne fuite rien de plus qu'un identifiant déjà destiné à être partagé
-- publiquement par le parrain lui-même (c'est un code de parrainage).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.consume_referral_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_referrer_id uuid;
begin
  if v_code = '' then
    return json_build_object('valid', false);
  end if;

  select s.user_id into v_referrer_id
    from public.subscriptions s
    join auth.users u on u.id = s.user_id
   where s.ref_code = v_code
   limit 1;

  if v_referrer_id is null then
    return json_build_object('valid', false);
  end if;

  update public.subscriptions
     set ref_count = coalesce(ref_count, 0) + 1
   where user_id = v_referrer_id;

  return json_build_object('valid', true, 'referrer_id', v_referrer_id);
end;
$$;

revoke all     on function public.consume_referral_code(text) from public;
grant  execute on function public.consume_referral_code(text) to anon;
grant  execute on function public.consume_referral_code(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- credit_referral_validation : appelée par le FILLEUL une fois son score
-- d'engagement local (App.jsx, refActions) au-dessus du seuil. Recrédite le
-- parrain ET marque le filleul comme validé, en une transaction. Le calcul du
-- bonus est réimplémenté ici (pas transmis par le client) : c'est une
-- exception délibérée au principe de ce projet de ne pas dupliquer la
-- logique métier en SQL — ici la duplication protège contre un client qui
-- s'auto-attribuerait n'importe quel bonus pour un autre compte.
-- Constantes reprises telles quelles de App.jsx : TRIAL_BASE_DAYS=15,
-- TRIAL_MAX_DAYS=30, paliers Trial {1:5, 2:10, 3+:0}, PREM_BONUS_PER_REF=1,
-- PREM_MAX_PER_MONTH=5, SPIN_PER_REF=1.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.credit_referral_validation()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                 uuid := auth.uid();
  v_referee              record;
  v_referrer             record;
  v_referrer_is_premium  boolean;
  v_referrer_premium_expired boolean;
  v_referrer_days_elapsed numeric;
  v_referrer_max_days    numeric;
  v_referrer_is_freemium boolean;
  v_new_validated_count  int;
  v_bonus_days           int := 0;
  v_new_monthly_month    text;
  v_new_monthly_count    int;
  v_this_month           text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_referee from public.subscriptions where user_id = v_uid;
  if v_referee is null or v_referee.ref_used is null then
    raise exception 'no_referral_to_credit';
  end if;
  if v_referee.ref_validated then
    raise exception 'already_validated';
  end if;

  select * into v_referrer from public.subscriptions where ref_code = v_referee.ref_used;
  if v_referrer is null then
    raise exception 'referrer_not_found';
  end if;

  -- Le parrain est-il Premium payant, encore actif (même fenêtre que
  -- subStatus() côté client : premium_since + cycle, pas expiré) ?
  v_referrer_is_premium := v_referrer.plan = 'premium' and (
    v_referrer.premium_since is null or v_referrer.cycle is null or
    (case when v_referrer.cycle = 'yearly'
       then v_referrer.premium_since + interval '1 year'
       else v_referrer.premium_since + interval '1 month'
     end) > now()
  );

  v_new_validated_count := coalesce(v_referrer.validated_ref_count, 0) + 1;

  if v_referrer_is_premium then
    -- Phase Premium abonné : +1j par filleul validé, plafond 5/mois, reset mensuel.
    v_this_month := to_char(now(), 'YYYY-MM');
    v_new_monthly_count := (case when v_referrer.monthly_ref_month = v_this_month
                               then coalesce(v_referrer.monthly_ref_count, 0) else 0 end) + 1;
    v_new_monthly_month := v_this_month;
    v_bonus_days := case when v_new_monthly_count <= 5 then 1 else 0 end;
  else
    v_new_monthly_month := v_referrer.monthly_ref_month;
    v_new_monthly_count := v_referrer.monthly_ref_count;
    -- Le parrain est-il encore dans sa fenêtre Trial (pas Freemium) ?
    v_referrer_days_elapsed := extract(epoch from (now() - coalesce(v_referrer.account_created_at, v_referrer.trial_start))) / 86400.0;
    v_referrer_max_days := least(15 + coalesce(v_referrer.trial_extension_days, 0), 30);
    v_referrer_is_freemium := v_referrer_days_elapsed > v_referrer_max_days;
    if v_referrer_is_freemium then
      v_bonus_days := 0;
    else
      v_bonus_days := case v_new_validated_count when 1 then 5 when 2 then 10 else 0 end;
    end if;
  end if;

  update public.subscriptions
     set validated_ref_count = v_new_validated_count,
         trial_extension_days = coalesce(trial_extension_days, 0) + v_bonus_days,
         pending_spins = coalesce(pending_spins, 0) + 1,
         plan = case when not v_referrer_is_premium and v_new_validated_count >= 1
                       and plan not in ('premium','earned_premium') then 'earned_premium' else plan end,
         monthly_ref_month = v_new_monthly_month,
         monthly_ref_count = v_new_monthly_count
   where user_id = v_referrer.user_id;

  update public.subscriptions
     set ref_validated = true,
         plan = case when plan not in ('premium') then 'earned_premium' else plan end
   where user_id = v_uid;

  return json_build_object('ok', true);
end;
$$;

revoke all     on function public.credit_referral_validation() from public;
grant  execute on function public.credit_referral_validation() to authenticated;
```

- [ ] **Step 2: Vérifier la syntaxe par relecture**

Pas d'exécution automatisée possible dans cet environnement (pas d'accès CLI Supabase). Relire le fichier : les 3 blocs (`alter table`, 2× `create or replace function`) sont bien présents, les 2 fonctions sont fermées par `$$;`, `consume_referral_code` a bien 2 lignes `grant` (anon ET authenticated), `credit_referral_validation` n'a qu'un seul `grant` (authenticated uniquement) et ne référence `p_` aucun paramètre nulle part dans son corps (elle ne doit prendre aucun argument).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0040_referral_system_fix.sql
git commit -m "Add consume_referral_code + credit_referral_validation RPCs for cross-device referrals"
```

---

### Task 2: Client — brancher l'inscription et la validation sur les nouvelles RPC, abaisser le seuil

**Files:**
- Modify: `src/App.jsx:6125-6133` (`doReg()`, vérification du code parrain)
- Modify: `src/App.jsx:3970-4016` (`_onFilleulValidated()`)
- Modify: `src/App.jsx:14422` (`REF_SCORE_TARGET`)

**Interfaces:**
- Consumes: `consume_referral_code` et `credit_referral_validation` (Tâche 1).

- [ ] **Step 1: Brancher `doReg()` sur `consume_referral_code`**

Dans `src/App.jsx`, remplacer :

```js
    let refUsed=null; let trialExtension=0;
    if(refInput.trim()){
      const code=refInput.trim().toUpperCase();
      const referrer=users.find(u=>u.refCode===code);
      if(!referrer){setErr(t.refInvalid||"Code parrain invalide");return;}
      refUsed=code; // filleul → démarre en Trial Premium; bonus parrain déclenché à la validation (score ≥ 5)
      const newRefCount=(referrer.refCount||0)+1;
      setUsers(us=>us.map(u=>u.id===referrer.id?{...u,refCount:newRefCount}:u));
    }
```

par :

```js
    let refUsed=null; let trialExtension=0;
    if(refInput.trim()){
      const code=refInput.trim().toUpperCase();
      // 🔧 2026-07-15 : vérifié côté serveur (plus jamais via le tableau local
      // `users`, propre à cet appareil — voir
      // docs/superpowers/specs/2026-07-15-referral-system-fix-design.md).
      const { data: refResult, error: refErr } = await supabase.rpc("consume_referral_code", { p_code: code });
      if(refErr || !refResult?.valid){ setErr(t.refInvalid||"Code parrain invalide"); return; }
      refUsed=code; // filleul → démarre en Trial Premium; bonus parrain déclenché à la validation (score ≥ 3)
    }
```

`doReg()` est déjà `async function doReg()` (`App.jsx:6095`) — `await` fonctionne directement, aucun changement de signature nécessaire.

- [ ] **Step 2: Brancher `_onFilleulValidated()` sur `credit_referral_validation`**

Dans `src/App.jsx`, remplacer l'intégralité du corps de la fonction :

```js
  function _onFilleulValidated(){
    // 1. Filleul → passe en earned_premium + notification
    setShowReferreePopup(true);
    setSub(s=>({...s, plan:"earned_premium"}));
    setUsers(us=>us.map(u=>u.id===user?.id?{...u,plan:"earned_premium"}:u));
    // 2. Parrain → bonus selon statut
    const parrain = users.find(u=>u.refCode===user?.refUsed);
    if(!parrain) return;
    const parrainIsPrem = isPremFull(parrain.sub||{}) || parrain._admin;
    const newValidatedCount = (parrain.validatedRefCount||0)+1;
    // Vérifier si le parrain est encore dans sa fenêtre trial (pas freemium)
    const parrainCreated = parrain.accountCreatedAt || parrain.trialStart;
    const parrainDaysElapsed = parrainCreated ? (Date.now()-new Date(parrainCreated).getTime())/86400000 : 999;
    const parrainExt = parrain.trialExtension||0;
    const parrainMaxDays = Math.min(TRIAL_BASE_DAYS+parrainExt, TRIAL_MAX_DAYS);
    const parrainIsFreemium = !parrainIsPrem && parrainDaysElapsed > parrainMaxDays;
    let bonusDays = 0;
    let newMonthlyRefMonth = parrain.monthlyRefMonth||null;
    let newMonthlyRefCount = parrain.monthlyRefCount||0;
    if(parrainIsFreemium){
      // Freemium : plus de jours d'extension — seulement un tour de roue
      bonusDays = 0;
    } else if(!parrainIsPrem){
      // Trial / earned_premium : paliers dégressifs
      bonusDays = refBonusDaysTrial(newValidatedCount, parrainExt);
    } else {
      // Premium abonné : plafond mensuel
      const now = new Date();
      const thisMonth = `${now.getFullYear()}-${now.getMonth()}`;
      const mCount = (parrain.monthlyRefMonth===thisMonth ? parrain.monthlyRefCount||0 : 0)+1;
      bonusDays = refBonusDaysPremium(mCount);
      newMonthlyRefMonth = thisMonth;
      newMonthlyRefCount = mCount;
    }
    const shouldUpgrade = !parrainIsPrem && !parrainIsFreemium && newValidatedCount>=1;
    setUsers(us=>us.map(u=>u.id===parrain.id?{
      ...u,
      validatedRefCount: newValidatedCount,
      trialExtension: (u.trialExtension||0)+bonusDays,
      pendingSpins: (u.pendingSpins||0)+SPIN_PER_REF,
      plan: shouldUpgrade ? "earned_premium" : u.plan,
      monthlyRefMonth: newMonthlyRefMonth,
      monthlyRefCount: newMonthlyRefCount,
    }:u));
    // Signal au parrain (cross-session via localStorage)
    try{ localStorage.setItem(`duvia_ref_bonus_pending_family_${parrain.refCode}`, "true"); }catch{}
  }
```

par :

```js
  async function _onFilleulValidated(){
    // 1. Filleul → passe en earned_premium + notification, mise à jour locale
    // optimiste pour la réactivité immédiate de l'UI. La RPC ci-dessous est
    // la source de vérité qui persiste réellement l'état (le filleul comme
    // le parrain) — voir docs/superpowers/specs/2026-07-15-referral-system-fix-design.md.
    setShowReferreePopup(true);
    setSub(s=>({...s, plan:"earned_premium"}));
    // 2. Parrain → crédité côté serveur (jamais via le tableau local `users`,
    // propre à cet appareil — c'était le bug racine empêchant tout crédit
    // cross-appareil).
    try {
      const { error } = await supabase.rpc("credit_referral_validation");
      if (error) console.warn("[Duvia] credit_referral_validation failed:", error);
    } catch (e) {
      console.warn("[Duvia] credit_referral_validation failed:", e);
    }
  }
```

Cette fonction est appelée via `setTimeout(()=>_onFilleulValidated(), 0);` (`App.jsx:3964`) — un appel non-awaité vers une fonction désormais `async` est valide en JS (fire-and-forget), aucun changement nécessaire à l'appelant.

**⚠️ Vérifier le code mort après cette suppression** : `isPremFull(sub)` (`App.jsx:327`, `function isPremFull(sub) { return subStatus(sub)==="premium"||sub._admin; }`) n'était utilisée QUE dans le bloc supprimé ci-dessus (`isPremFull(parrain.sub||{})`, ligne ~3978). Confirmer via `grep -rn "isPremFull(" src/` qu'il ne reste plus aucun appel après cette étape, et si c'est le cas, supprimer entièrement la définition de la fonction (ligne 327) — ne pas laisser de code mort.

- [ ] **Step 3: Abaisser le seuil de validation**

Dans `src/App.jsx`, remplacer :

```js
const REF_SCORE_TARGET = 5;
```

par :

```js
// 🔧 2026-07-15 : abaissé de 5 à 3 — seules 3 des 10 actions définies dans
// REF_ACTION_WEIGHTS sont réellement déclenchées quelque part dans le code
// (ADD_EXPENSE, SEND_MESSAGE, ADD_CONTACT) ; un seuil à 5 était impossible à
// atteindre pour n'importe quel vrai filleul. Voir
// docs/superpowers/specs/2026-07-15-referral-system-fix-design.md.
const REF_SCORE_TARGET = 3;
```

`REF_STRONG_MIN` (déjà à 2, `App.jsx:14423`) n'a pas besoin de changer : n'importe quelles 2 des 3 actions réellement câblées sont déjà "fortes" (`REF_STRONG`, `App.jsx:14409` inclut déjà `ADD_EXPENSE`/`SEND_MESSAGE`/`ADD_CONTACT`).

- [ ] **Step 4: Vérifier qu'il n'y a pas de régression**

Run: `TZ=Europe/Paris npm test`
Expected: 136/136 tests passants (aucun nouveau test — orchestration réseau, cohérent avec les tâches similaires de ce projet).

Run: `npm run build`
Expected: build propre.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Wire referral signup/validation to the new server-side RPCs, lower validation threshold to 3"
```

---

### Task 3: Réserver le bouton "Simuler un filleul validé" aux admins + bump de version

**Files:**
- Modify: `src/App.jsx:14496-14507` (`ParrainageSection`, destructuration + bloc démo)
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: `isAdm` (déjà exposé via `useApp()`, utilisé ailleurs dans `App.jsx` — aucun nouveau champ de contexte nécessaire).

- [ ] **Step 1: Ajouter `isAdm` à la destructuration**

Dans `src/App.jsx`, dans `ParrainageSection`, remplacer :

```js
  const {C,t,sub,setSub,user,setUsers,users,st,days,addRefAction,refActions,showReferreePopup,setShowReferreePopup,showReferrerPopup,setShowReferrerPopup} = useApp();
```

par :

```js
  const {C,t,sub,setSub,user,setUsers,users,st,days,addRefAction,refActions,showReferreePopup,setShowReferreePopup,showReferrerPopup,setShowReferrerPopup,isAdm} = useApp();
```

- [ ] **Step 2: Réserver le bloc démo aux admins**

Dans `src/App.jsx`, dans `ParrainageSection`, repérer ce bloc :

```js
        {/* Simulation démo */}
        <div style={{marginTop:12,paddingTop:12,borderTop:`1px dashed ${C.bor}`}}>
          <div style={{fontSize:10,color:C.mut,marginBottom:5,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em"}}>🧪 Mode démo</div>
          <button onClick={simulateReferral} disabled={showDemo&&demoStep===1} style={{padding:"7px 16px",background:`${C.vio}15`,color:C.vio,border:`1.5px dashed ${C.vio}`,fontSize:12,fontWeight:700,borderRadius:9,opacity:(showDemo&&demoStep===1)?0.5:1}}>
            Simuler un filleul validé ({bonusNext>0?`+${bonusNext}j + `:""}🎰×1)
          </button>
        </div>
```

Remplacer par :

```js
        {/* Simulation démo — réservée aux admins (2026-07-15 : c'était un
            exploit self-service pour n'importe quel compte réel, qui créditait
            du Premium gratuit sans aucun filleul réel). */}
        {isAdm && (
          <div style={{marginTop:12,paddingTop:12,borderTop:`1px dashed ${C.bor}`}}>
            <div style={{fontSize:10,color:C.mut,marginBottom:5,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em"}}>🧪 Mode démo (admin)</div>
            <button onClick={simulateReferral} disabled={showDemo&&demoStep===1} style={{padding:"7px 16px",background:`${C.vio}15`,color:C.vio,border:`1.5px dashed ${C.vio}`,fontSize:12,fontWeight:700,borderRadius:9,opacity:(showDemo&&demoStep===1)?0.5:1}}>
              Simuler un filleul validé ({bonusNext>0?`+${bonusNext}j + `:""}🎰×1)
            </button>
          </div>
        )}
```

Ne pas toucher `simulateReferral()` elle-même ni la "Modale démo" (`showDemo`) plus bas — elles ne peuvent plus jamais se déclencher pour un compte non-admin puisque le seul bouton qui appelle `simulateReferral()` est maintenant cachée.

- [ ] **Step 3: Vérifier qu'il n'y a pas de régression**

Run: `TZ=Europe/Paris npm test`
Expected: 136/136 tests passants.

Run: `npm run build`
Expected: build propre.

- [ ] **Step 4: Bump de version**

Lire `src/config.js` et `public/sw.js` pour connaître la version actuelle (elle peut avoir changé depuis l'écriture de ce plan), puis incrémenter les deux de +0.01, à la même nouvelle valeur.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Restrict the referral demo/simulate button to admin accounts"
```

---

## Après le plan (à faire par l'utilisateur, pas par l'implémenteur)

- Coller `supabase/migrations/0040_referral_system_fix.sql` dans le SQL Editor Supabase et l'exécuter.
- Tester en live avec 2 vrais comptes parents sur 2 appareils/navigateurs différents (le bug principal n'est reproductible qu'ainsi) :
  1. Compte A partage son code. Compte B s'inscrit avec ce code sur un AUTRE appareil — doit être accepté.
  2. B fait les 3 actions (dépense, message, contact ajoutés).
  3. B passe en "Premium – 15j restants", popup filleul affiché.
  4. A reçoit son bonus (+5j la 1ère fois) + 1 tour de roue à sa prochaine connexion.
  5. Le bouton "Simuler un filleul validé" n'apparaît plus pour un compte normal, reste visible pour un compte admin.
