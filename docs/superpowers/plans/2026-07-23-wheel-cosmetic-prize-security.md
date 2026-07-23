# Wheel Cosmetic-Prize Server-Side Security Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Duvia wheel's cosmetic-prize draw, cooldown, eligibility, and persistence entirely server-side, closing the localStorage-tampering exploit while keeping the confirmed-working visual/motion layer untouched.

**Architecture:** One new Postgres table (`wheel_spins`) as the cooldown/ownership source of truth, plus a `spin_wheel()` `SECURITY DEFINER` RPC (built from smaller internal helper functions) that replaces both the client's local `Math.random()` draw and the old `spin_wheel_check_monetary_prize()` RPC. Client changes are confined to `WheelGame`/`GameTab` in `src/App.jsx`.

**Tech Stack:** Supabase Postgres (plpgsql functions, RLS), React (`src/App.jsx`), Supabase CLI for both DB and Edge Function deploys.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-23-wheel-cosmetic-prize-security-design.md` — read it before starting if anything below is unclear on *why*, not just *what*.
- Production Supabase project ref: `ifhriyvvqkwqgzmrjjxp` (dashboard-named "DUVIA-RMS-DEV" — do not confuse with "duvia-staging", a different project). CLI already logged in and linked to this ref.
- **Full DB read/write access is authorized for this task** (user's explicit decision, 2026-07-23) via `npx supabase db query --linked "<sql>"` (ad hoc queries) or `npx supabase db query --linked --file <path>` (whole file) — no DB password needed. Apply migrations directly this way; do not ask the user to paste SQL into the dashboard SQL Editor for this task.
- Next migration number in this repo: `0049` (last is `0048_ai_usage_cache_tokens.sql`). This plan's migration file: `supabase/migrations/0049_wheel_spins_security.sql`.
- Migration idempotency convention in this repo (see `0046_pension_tracking.sql`): `create table if not exists`, `drop policy if exists ... ; create policy ...`, `create or replace function`. Every statement in the new migration file must be safely re-runnable.
- Cooldown: 7 days for everyone (`interval '7 days'`), **including Premium accounts** — Premium does NOT exempt from cooldown (verified against `src/App.jsx`'s `canSpin` logic and the app's own FAQ text: "7 jours pour tout le monde"). Only a bonus spin (`pending_spins > 0`) or the specific test account bypasses it.
- Test-account bypass: exact email `toti78200@gmail.com` (case-sensitive match against `auth.users.email` — the client lowercases before comparing, `auth.users.email` is stored as entered at signup; if this ever mismatches case, that's a pre-existing account data issue, not something this plan fixes).
- Trial constants (from `src/App.jsx` lines 275-276): `TRIAL_BASE_DAYS = 15`, `TRIAL_MAX_DAYS = 30`.
- Prize draw probabilities (from `src/App.jsx`'s `PROBS_SUBSCRIBER`/`PROBS_OTHERS`, lines 19397-19398): `year` 0.001/0, `month` 0.010/0, `theme` 0.200/0.200, `video` 0.100/0.100, `licorne` 0.100/0.100, `rg` 0.050/0.050, `wc` 0.050/0.050 (subscriber/others). `year`/`month` are 0 for non-subscribers.
- Seasonal windows (from `src/theme.js`): `theme` active 2026-06-21 through 2026-07-23 23:59:59; `rg` active 2026-05-24 through 2026-06-04 23:59:59; `wc` active 2026-06-06 through 2026-07-26 23:59:59. Hardcoded as SQL date literals with a comment to resync manually if `src/theme.js` changes.
- Out of scope (per approved spec): securing how `pending_spins` is *credited* (referral validation flow) — only its *consumption* by `spin_wheel()` is in scope. Do not touch `ParrainageSection`/`refActions`/referral-crediting code.
- Out of scope: the general `sub._admin` cooldown-bypass flag — flagged as an open question in the spec, deliberately left server-unenforced in this plan (an account with only `sub._admin` set, not the specific test email, will hit the real cooldown via `spin_wheel()`).
- Standard repo checks before every commit: `TZ=Europe/Paris npm test` and `npm run build` for any client (`src/App.jsx`) change. No automated SQL test framework exists in this repo — SQL verification is manual `db query --linked` checks, as detailed per task below.
- Version bump: after the client tasks (5-6) are complete and verified, bump `APP_VERSION` in `src/config.js` and `SW_VERSION` in `public/sw.js` together (see `CLAUDE.md`) as part of the final commit for those tasks.

---

### Task 1: `wheel_spins` table

**Files:**
- Create: `supabase/migrations/0049_wheel_spins_security.sql` (this task starts the file; later tasks append to it)

**Interfaces:**
- Produces: table `public.wheel_spins(id uuid, user_id uuid, family_id uuid, spun_at timestamptz, prize_id text, used_bonus_spin boolean)`, readable by `authenticated` for their own rows only, writable only via functions from later tasks.

- [ ] **Step 1: Write the migration file with the table and its RLS policy**

```sql
-- 0049_wheel_spins_security.sql
--
-- Wheel cosmetic-prize server-side security fix (backlog item 9c) — see
-- docs/superpowers/specs/2026-07-23-wheel-cosmetic-prize-security-design.md.
-- Moves the wheel's entire prize draw, cooldown, eligibility, and
-- persistence server-side. Idempotent (IF NOT EXISTS / OR REPLACE
-- throughout), safe to re-run.

-- ── 1. Table: one row per real spin (cooldown + ownership source of truth) ──

create table if not exists public.wheel_spins (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  family_id       uuid not null,
  spun_at         timestamptz not null default now(),
  prize_id        text not null,
  used_bonus_spin boolean not null default false
);

create index if not exists wheel_spins_user_id_idx on public.wheel_spins(user_id);

alter table public.wheel_spins enable row level security;

drop policy if exists "wheel_spins_select_own" on public.wheel_spins;
create policy "wheel_spins_select_own" on public.wheel_spins
  for select using (user_id = auth.uid());

-- Deliberately NO insert/update/delete policy for authenticated/anon — only
-- spin_wheel() (SECURITY DEFINER, added in a later step of this file) writes
-- to this table, executing as the table owner regardless of these policies.
```

- [ ] **Step 2: Apply the migration file**

Run: `npx supabase db query --linked --file supabase/migrations/0049_wheel_spins_security.sql`
Expected: no error output (or a JSON result with empty `rows`).

- [ ] **Step 3: Verify the table and policy exist**

Run:
```
npx supabase db query --linked "select column_name, data_type from information_schema.columns where table_name='wheel_spins' order by ordinal_position"
```
Expected: 6 rows — `id`/`uuid`, `user_id`/`uuid`, `family_id`/`uuid`, `spun_at`/`timestamp with time zone`, `prize_id`/`text`, `used_bonus_spin`/`boolean`.

Run:
```
npx supabase db query --linked "select policyname, cmd from pg_policies where tablename='wheel_spins'"
```
Expected: exactly one row — `wheel_spins_select_own` / `SELECT`.

- [ ] **Step 4: Confirm a regular authenticated user genuinely cannot write to the table**

Supabase grants full table-level privileges (including INSERT/UPDATE/DELETE) to `authenticated`/`anon` by default on every new table — RLS is the only thing actually blocking writes here, so this must be verified, not assumed. Pick any real `user_id` (e.g. `select id from auth.users limit 1`) and run:
```
npx supabase db query --linked "
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<ANY_REAL_USER_UUID>', 'role','authenticated')::text, true);
insert into public.wheel_spins (user_id, family_id, prize_id) values ('<ANY_REAL_USER_UUID>'::uuid, gen_random_uuid(), 'theme');
"
```
Expected: an RLS-violation error (`new row violates row-level security policy for table "wheel_spins"`), NOT a successful insert. If it succeeds instead, STOP — the RLS policy from Step 1 didn't apply correctly, do not proceed to Task 2 until fixed (check `alter table ... enable row level security` actually ran).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0049_wheel_spins_security.sql
git commit -m "Add wheel_spins table (server-side cooldown/ownership source of truth)"
```

---

### Task 2: `_wheel_family_is_premium()` — family-wide effective Premium replica

**Files:**
- Modify: `supabase/migrations/0049_wheel_spins_security.sql` (append)

**Interfaces:**
- Consumes: `wheel_spins` table from Task 1 (not directly, but same file/migration sequence).
- Produces: `public._wheel_family_is_premium(p_family_id uuid) returns boolean` — internal helper, NOT granted to `authenticated`. Used by `spin_wheel()` in Task 4.

This function ports `src/App.jsx`'s `subStatus()` (lines 297-334) + `isBeta()` (line 453, backed by the `app_config` table) + `planRankFor()` (lines 374-379) + `bestParentSub()` (lines 407-425) faithfully. Read those functions in `src/App.jsx` before writing this step if anything below is unclear — this is the single most error-prone piece of this plan.

- [ ] **Step 1: Append the plan-rank helper and the family-premium function to the migration file**

```sql
-- ── 2. Family-wide effective Premium — full replica of src/App.jsx's
--    subStatus()+isBeta()+planRankFor()+bestParentSub(). NOT granted to
--    authenticated — only spin_wheel() (Task 4) calls it internally.
--    Resync manually if the client-side logic changes.

create or replace function public._wheel_plan_rank(
  p_user_id uuid,
  p_plan text,
  p_premium_since timestamptz,
  p_cycle text,
  p_ref_months int,
  p_trial_start timestamptz,
  p_account_created_at timestamptz,
  p_trial_extension_days int,
  p_acct_beta_end timestamptz,
  p_global_beta boolean
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_plan text := coalesce(p_plan, 'trial_premium'); -- no subscriptions row yet → fresh-trial default, mirrors bestParentSub()'s fallback
  v_created timestamptz := coalesce(p_account_created_at, p_trial_start, now());
  v_ext int := coalesce(p_trial_extension_days, 0);
  v_expiry timestamptz;
  v_max_days int;
  v_days numeric;
  v_status text;
begin
  select exists(select 1 from public.app_admins where user_id = p_user_id) into v_is_admin;
  if v_is_admin then
    return 2; -- mirrors subStatus(): if(sub._admin) return "premium"
  end if;

  if v_plan = 'premium' then
    if p_premium_since is not null and p_cycle is not null then
      v_expiry := p_premium_since
        + (case when p_cycle = 'yearly' then interval '1 year' else interval '1 month' end)
        + (coalesce(p_ref_months, 0) * interval '30 days');
      v_status := case when now() > v_expiry then 'freemium' else 'premium' end;
    else
      v_status := 'premium';
    end if;
  elsif v_plan = 'beta' then
    if p_acct_beta_end is not null and now() < p_acct_beta_end then
      v_status := 'trial_premium';
    else
      v_days := extract(epoch from (now() - coalesce(p_acct_beta_end, now()))) / 86400;
      v_status := case when v_days <= 15 then 'trial_premium' else 'freemium' end; -- TRIAL_BASE_DAYS
    end if;
  elsif v_plan = 'freemium' then
    v_status := 'freemium';
  else
    -- organic path: trial_premium / earned_premium
    v_max_days := least(15 + v_ext, 30); -- TRIAL_BASE_DAYS + ext, capped at TRIAL_MAX_DAYS
    v_days := extract(epoch from (now() - v_created)) / 86400;
    if v_days <= v_max_days then
      v_status := case when v_plan = 'earned_premium' then 'earned_premium' else 'trial_premium' end;
    elsif p_global_beta then
      v_status := 'trial_premium';
    else
      v_status := 'freemium';
    end if;
  end if;

  return case
    when v_status = 'premium' then 2
    when v_status in ('trial_premium', 'earned_premium') then 1
    else 0
  end;
end;
$$;

revoke all on function public._wheel_plan_rank(uuid,text,timestamptz,text,int,timestamptz,timestamptz,int,timestamptz,boolean) from public;

create or replace function public._wheel_family_is_premium(p_family_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_beta_enabled boolean;
  v_beta_end timestamptz;
  v_global_beta boolean;
  v_best_rank int := -1;
  v_rank int;
  rec record;
begin
  select beta_enabled, beta_end into v_beta_enabled, v_beta_end
    from public.app_config where id = 1;
  v_global_beta := coalesce(v_beta_enabled, false) and v_beta_end is not null and now() < v_beta_end;

  for rec in
    select fm.user_id,
           s.plan, s.premium_since, s.cycle, s.ref_months,
           s.trial_start, s.account_created_at, s.trial_extension_days,
           s.beta_end as acct_beta_end
      from public.family_members fm
      left join public.subscriptions s on s.user_id = fm.user_id
     where fm.family_id = p_family_id
       and fm.role = 'parent'
       and fm.status = 'active'
  loop
    v_rank := public._wheel_plan_rank(
      rec.user_id, rec.plan, rec.premium_since, rec.cycle, rec.ref_months,
      rec.trial_start, rec.account_created_at, rec.trial_extension_days,
      rec.acct_beta_end, v_global_beta
    );
    if v_rank > v_best_rank then v_best_rank := v_rank; end if;
  end loop;

  return v_best_rank >= 1; -- rank 1 (trial/earned) or 2 (premium) both count as family-premium
end;
$$;

revoke all on function public._wheel_family_is_premium(uuid) from public;
```

- [ ] **Step 2: Apply**

Run: `npx supabase db query --linked --file supabase/migrations/0049_wheel_spins_security.sql`
Expected: no error.

- [ ] **Step 3: Verify against a real family — cross-check with what the app actually shows**

Find a real family you know the Premium status of (ideally your own test account):
```
npx supabase db query --linked "select id, family_id, role, status from family_members where role='parent' and status='active' limit 5"
```
Pick a `family_id` from the result, then:
```
npx supabase db query --linked "select public._wheel_family_is_premium('<family_id>'::uuid) as is_premium"
```
Expected: `is_premium` matches whatever the app currently shows for that family (Premium/Trial/Bêta → `true`; Freemium → `false`). If it doesn't match, do NOT proceed to Task 3 — re-read `subStatus()` in `src/App.jsx` and find the discrepancy first.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0049_wheel_spins_security.sql
git commit -m "Add server-side family-wide effective Premium replica for the wheel"
```

---

### Task 3: Draw logic helpers

**Files:**
- Modify: `supabase/migrations/0049_wheel_spins_security.sql` (append)

**Interfaces:**
- Produces: `public._wheel_is_individual_subscriber(p_uid uuid) returns boolean`, `public._wheel_draw(p_is_subscriber boolean) returns text` (one of `'year'|'month'|'theme'|'video'|'licorne'|'rg'|'wc'|'nothing'`) — both internal, NOT granted to `authenticated`.

- [ ] **Step 1: Append both functions to the migration file**

```sql
-- ── 3. Draw logic — individual-subscriber check (extracted verbatim from
--    the soon-to-be-retired spin_wheel_check_monetary_prize(), migration
--    0041) and the weighted draw (mirrors PROBS_SUBSCRIBER/PROBS_OTHERS in
--    src/App.jsx). Neither granted to authenticated — internal to
--    spin_wheel() (Task 4).

create or replace function public._wheel_is_individual_subscriber(p_uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
  v_premium_since timestamptz;
  v_cycle text;
  v_ref_months int;
  v_expiry timestamptz;
begin
  select plan, premium_since, cycle, coalesce(ref_months, 0)
    into v_plan, v_premium_since, v_cycle, v_ref_months
  from public.subscriptions
  where user_id = p_uid;

  if v_plan is distinct from 'premium' then
    return false;
  end if;
  if v_premium_since is not null and v_cycle is not null then
    v_expiry := v_premium_since
      + (case when v_cycle = 'yearly' then interval '1 year' else interval '1 month' end)
      + (v_ref_months * interval '30 days');
    return now() <= v_expiry;
  end if;
  return true;
end;
$$;

revoke all on function public._wheel_is_individual_subscriber(uuid) from public;

create or replace function public._wheel_draw(p_is_subscriber boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r double precision := random();
  v_cum double precision := 0;
  v_year double precision := case when p_is_subscriber then 0.001 else 0 end;
  v_month double precision := case when p_is_subscriber then 0.010 else 0 end;
  v_theme double precision := 0.200;
  v_video double precision := 0.100;
  v_licorne double precision := 0.100;
  v_rg double precision := 0.050;
  v_wc double precision := 0.050;
  -- Seasonal windows — mirrors SUMMER_START/END, RG_START/END, WC_START/END
  -- in src/theme.js. Resync manually if those dates change.
  v_theme_active boolean := now() >= '2026-06-21'::timestamptz and now() <= '2026-07-23 23:59:59'::timestamptz;
  v_rg_active boolean := now() >= '2026-05-24'::timestamptz and now() <= '2026-06-04 23:59:59'::timestamptz;
  v_wc_active boolean := now() >= '2026-06-06'::timestamptz and now() <= '2026-07-26 23:59:59'::timestamptz;
begin
  if not v_theme_active then v_theme := 0; end if;
  if not v_rg_active then v_rg := 0; end if;
  if not v_wc_active then v_wc := 0; end if;

  if v_r < v_cum + v_year then return 'year'; end if;
  v_cum := v_cum + v_year;
  if v_r < v_cum + v_month then return 'month'; end if;
  v_cum := v_cum + v_month;
  if v_r < v_cum + v_theme then return 'theme'; end if;
  v_cum := v_cum + v_theme;
  if v_r < v_cum + v_video then return 'video'; end if;
  v_cum := v_cum + v_video;
  if v_r < v_cum + v_licorne then return 'licorne'; end if;
  v_cum := v_cum + v_licorne;
  if v_r < v_cum + v_rg then return 'rg'; end if;
  v_cum := v_cum + v_rg;
  if v_r < v_cum + v_wc then return 'wc'; end if;
  return 'nothing';
end;
$$;

revoke all on function public._wheel_draw(boolean) from public;
```

- [ ] **Step 2: Apply**

Run: `npx supabase db query --linked --file supabase/migrations/0049_wheel_spins_security.sql`
Expected: no error.

- [ ] **Step 3: Verify the draw distribution statistically**

Run (non-subscriber, all seasonal windows likely inactive by the time this runs — adjust expectations if a window is active):
```
npx supabase db query --linked "select prize_id, count(*) from (select public._wheel_draw(false) as prize_id from generate_series(1,3000)) x group by prize_id order by count(*) desc"
```
Expected: `nothing` roughly half, `theme`/`video`/`licorne` each roughly a fifth/tenth/tenth (or 0 if their season isn't currently active), `year`/`month` at 0 rows (non-subscriber). Run the same with `true` instead of `false` and confirm `year`/`month` now appear at roughly 0.1%/1% of 3000 draws (a handful of rows, not zero, not hundreds).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0049_wheel_spins_security.sql
git commit -m "Add wheel draw logic helpers (subscriber check + weighted draw)"
```

---

### Task 4: `spin_wheel()` — the main RPC

**Files:**
- Modify: `supabase/migrations/0049_wheel_spins_security.sql` (append)

**Interfaces:**
- Consumes: `public._wheel_family_is_premium(p_family_id uuid, p_calling_uid uuid)` — **note the corrected 2-arg signature**: Task 2's review found the original 1-arg design let a co-parent's referral bonus/admin status leak into the whole family's Premium check (a real divergence from the client's `bestParentSub()`, which never applies either to anyone but the caller). Fixed during Task 2 by adding a `p_calling_uid` parameter — pass `v_uid` (see Step 1 below), not just `v_family_id`. `public._wheel_is_individual_subscriber(uuid)` + `public._wheel_draw(boolean)` (Task 3), `public.wheel_spins` (Task 1).
- Produces: `public.spin_wheel() returns table(prize_id text, used_bonus_spin boolean, next_eligible_at timestamptz)`, granted to `authenticated`. Raises `not_authenticated`, `no_family`, `not_eligible`, or `cooldown_active` as needed.

- [ ] **Step 1: Append the RPC to the migration file**

```sql
-- ── 4. spin_wheel() — the single entry point the client calls per spin.
--    Eligibility mirrors canAccessWheel (prem || hasBonusSpin) in GameTab —
--    NOT affected by the unlimited-test-account bypass. Cooldown applies to
--    EVERYONE, Premium included — only a bonus spin or the unlimited test
--    account skips it (see Global Constraints).

create or replace function public.spin_wheel()
returns table (prize_id text, used_bonus_spin boolean, next_eligible_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_family_id uuid;
  v_email text;
  v_is_unlimited boolean;
  v_family_premium boolean;
  v_pending_spins int;
  v_last_spin timestamptz;
  v_cooldown interval := interval '7 days';
  v_using_bonus boolean := false;
  v_is_individual_subscriber boolean;
  v_prize text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select family_id into v_family_id
    from public.family_members
   where user_id = v_uid and status = 'active'
   limit 1;
  if v_family_id is null then
    raise exception 'no_family';
  end if;

  v_family_premium := public._wheel_family_is_premium(v_family_id, v_uid);

  select email into v_email from auth.users where id = v_uid;
  v_is_unlimited := (v_email = 'toti78200@gmail.com');

  select pending_spins into v_pending_spins
    from public.subscriptions where user_id = v_uid;
  v_pending_spins := coalesce(v_pending_spins, 0);

  if not (v_family_premium or v_pending_spins > 0) then
    raise exception 'not_eligible';
  end if;

  select max(spun_at) into v_last_spin
    from public.wheel_spins where user_id = v_uid;

  if v_last_spin is not null and now() < v_last_spin + v_cooldown and not v_is_unlimited then
    if v_pending_spins > 0 then
      update public.subscriptions
         set pending_spins = pending_spins - 1
       where user_id = v_uid and pending_spins > 0;
      if not found then
        raise exception 'cooldown_active';
      end if;
      v_using_bonus := true;
    else
      raise exception 'cooldown_active';
    end if;
  end if;

  v_is_individual_subscriber := public._wheel_is_individual_subscriber(v_uid);
  v_prize := public._wheel_draw(v_is_individual_subscriber);

  insert into public.wheel_spins (user_id, family_id, prize_id, used_bonus_spin)
    values (v_uid, v_family_id, v_prize, v_using_bonus);

  return query select v_prize, v_using_bonus, (coalesce(v_last_spin, now()) + v_cooldown);
end;
$$;

revoke all on function public.spin_wheel() from public;
grant execute on function public.spin_wheel() to authenticated;
```

- [ ] **Step 2: Apply**

Run: `npx supabase db query --linked --file supabase/migrations/0049_wheel_spins_security.sql`
Expected: no error.

- [ ] **Step 3: Verify with a simulated real user session**

Find a real test-account `user_id` you're willing to spend a real spin on (query `select id from auth.users where email = '<your test email>'`), then run, in one `db query --linked` call (all statements together so the session context persists):

```
npx supabase db query --linked "
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_TEST_USER_UUID>', 'role','authenticated')::text, true);
select * from public.spin_wheel();
"
```

Expected first run: either a `not_eligible`/`cooldown_active` error (if that account is freemium with no bonus spin, or already on cooldown from a real prior spin — both are CORRECT behavior, not a bug) or a row with `prize_id`/`used_bonus_spin`/`next_eligible_at`. Then run:
```
npx supabase db query --linked "select * from wheel_spins where user_id = '<REAL_TEST_USER_UUID>'::uuid order by spun_at desc limit 3"
```
Expected: the just-recorded spin appears with a plausible `prize_id`. Run the `spin_wheel()` call a second time immediately — expected: `cooldown_active` (unless that account is the unlimited test account or just consumed a bonus spin).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0049_wheel_spins_security.sql
git commit -m "Add spin_wheel() RPC — server-side eligibility, cooldown, draw, persistence"
```

---

### Task 5: Client — `WheelGame` calls `spin_wheel()` instead of drawing locally

**Files:**
- Modify: `src/App.jsx` (`pickSegment()` ~line 19451, `spin()` inside `WheelGame` ~line 19578, the stale comment block ~lines 19350-19365, `PROBS_SUBSCRIBER`/`PROBS_OTHERS` ~lines 19397-19398)

**Interfaces:**
- Consumes: `public.spin_wheel()` RPC (Task 4) via `supabase.rpc("spin_wheel")`.
- Produces: `pickSegment(prizeId)` — pure visual mapping (prize id → `{segIdx, prize}`), no randomness. Used by Task 6 and the existing render code unchanged.

- [ ] **Step 1: Remove `PROBS_SUBSCRIBER`/`PROBS_OTHERS` and simplify the stale header comment**

In `src/App.jsx`, find:
```js
const WHEEL_UNLIMITED_EMAILS = ["toti78200@gmail.com"];
// Règles du tableau des lots (version 2.0)
// ┌─────────────────────────────────────┬────────────┬──────────┬──────────────┐
// │ LOT                                 │ Souscript. │ Autres   │ Achat        │
// ├─────────────────────────────────────┼────────────┼──────────┼──────────────┤
// │ Perdu                               │ 48,9 %     │ 50,0 %   │ —            │
// │ 1 an offert                         │  0,1 %     │  0,0 %   │ —            │
// │ 1 mois offert                       │  1,0 %     │  0,0 %   │ —            │
// │ Thème Été 26 (21/06–23/07)          │ 20,0 %     │ 20,0 %   │ 0,49 €       │
// │ Thème Jeu vidéo (permanent)         │ 10,0 %     │ 10,0 %   │ 0,29 €       │
// │ Thème Licorne  (permanent)          │ 10,0 %     │ 10,0 %   │ 0,29 €       │
// │ Thème Tennis France 26 (24/05–04/06)│  5,0 %     │  5,0 %   │ 0,99 €       │
// │ Thème Coupe du Monde 26 (06/06–26/07│  5,0 %     │  5,0 %   │ 0,99 €       │
// └─────────────────────────────────────┴────────────┴──────────┴──────────────┘
// Fréquence : 7 jours (parents) · 2 jours (enfants/observateurs)
// Permission : OUI pour tous les rôles
// Si achat : devient permanent pour tous les thèmes
```

Replace with:
```js
const WHEEL_UNLIMITED_EMAILS = ["toti78200@gmail.com"];
// 🔒 (2026-07-23) Le tirage (probabilités, fenêtres saisonnières) est
// désormais décidé côté serveur par spin_wheel() (voir
// supabase/migrations/0049_wheel_spins_security.sql) — les tables de
// probabilités qui vivaient ici ont été retirées, elles ne sont plus la
// source de vérité. Voir la migration pour les valeurs exactes.
```

- [ ] **Step 2: Remove the now-dead `PROBS_SUBSCRIBER`/`PROBS_OTHERS` constants**

Find and delete:
```js
// ─── PROBABILITÉS PAR RÔLE ───────────────────────────────────────────────────
// "Souscripteur" = parent dont le sub INDIVIDUEL (pas le plan familial partagé)
// est premium (perms.spinWinSub, voir GameTab) — celui qui paie réellement.
// "Autres" = autre parent, enfant, observateur
const PROBS_SUBSCRIBER = { year:0.001, month:0.010, theme:0.200, video:0.100, licorne:0.100, rg:0.050, wc:0.050, nothing:0.489 };
const PROBS_OTHERS     = { year:0.000, month:0.000, theme:0.200, video:0.100, licorne:0.100, rg:0.050, wc:0.050, nothing:0.500 };
```
(delete this whole block — `WHEEL_PRIZES`, `isPrizeActive`, `P_NOTHING`...`P_WC`, and `WHEEL_SEGS` right after it are unaffected and stay exactly as-is, they're still needed for rendering and for `pickSegment`'s visual mapping.)

- [ ] **Step 3: Rewrite `pickSegment` as a pure visual mapping**

Find:
```js
function pickSegment(isSubscriber = true, serverMonetary = "none") {
  let prize;
  if(serverMonetary === "year" || serverMonetary === "month") {
    prize = WHEEL_PRIZES.find(p=>p.id===serverMonetary);
  } else {
    const probs = isSubscriber ? PROBS_SUBSCRIBER : PROBS_OTHERS;
    // Redistribue les probabilités des lots hors-période (+ year/month, déjà
    // tranchés par le serveur ci-dessus) vers "nothing"
    const active = { ...probs, year:0, month:0, nothing: probs.nothing + probs.year + probs.month };
    ["theme","rg","wc"].forEach(id=>{
      const p = WHEEL_PRIZES.find(x=>x.id===id);
      if(p && !isPrizeActive(p)) { active.nothing += active[id]; active[id] = 0; }
    });
    // Tirage (lots cosmétiques uniquement — aucune valeur monétaire en jeu)
    const r = Math.random(); let cum = 0;
    prize = WHEEL_PRIZES[7]; // défaut: perdu
    for(const p of WHEEL_PRIZES) {
      const prob = active[p.id] || 0;
      cum += prob;
      if(r < cum) { prize = p; break; }
    }
  }

  // Trouver le segment visuel correspondant (maintenant toujours possible,
  // year/month ayant chacun leur case dédiée — voir WHEEL_SEGS ci-dessus)
  const matchIdxs = WHEEL_SEGS.reduce((a,s,i)=>{ if(s.id===prize.id) a.push(i); return a; },[]);
  let segIdx;
  if(matchIdxs.length > 0) {
    segIdx = matchIdxs[Math.floor(Math.random()*matchIdxs.length)];
  } else {
    const nothingIdxs = WHEEL_SEGS.reduce((a,s,i)=>{ if(s.id==="nothing") a.push(i); return a; },[]);
    segIdx = nothingIdxs[Math.floor(Math.random()*nothingIdxs.length)];
  }
  return { segIdx, prize };
}
```

Replace with:
```js
// 🔒 (2026-07-23) Le tirage lui-même vient désormais TOUJOURS de spin_wheel()
// côté serveur (voir WheelGame.spin() plus bas) — cette fonction ne fait plus
// que trouver un segment visuel correspondant au prize_id déjà décidé, pour
// que la roue animée s'arrête au bon endroit. Plus aucun Math.random() ici.
function pickSegment(prizeId) {
  const prize = WHEEL_PRIZES.find(p=>p.id===prizeId) || WHEEL_PRIZES.find(p=>p.id==="nothing");
  const matchIdxs = WHEEL_SEGS.reduce((a,s,i)=>{ if(s.id===prize.id) a.push(i); return a; },[]);
  let segIdx;
  if(matchIdxs.length > 0) {
    segIdx = matchIdxs[Math.floor(Math.random()*matchIdxs.length)];
  } else {
    const nothingIdxs = WHEEL_SEGS.reduce((a,s,i)=>{ if(s.id==="nothing") a.push(i); return a; },[]);
    segIdx = nothingIdxs[Math.floor(Math.random()*nothingIdxs.length)];
  }
  return { segIdx, prize };
}
```

- [ ] **Step 4: Rewrite the draw section of `spin()`**

Find (inside `WheelGame`'s `spin()`):
```js
    // 🔒 2026-07-18 : "year"/"month" (les 2 seuls lots à valeur monétaire réelle)
    // ne peuvent plus être décidés localement — un aller-retour serveur honnête
    // (le random() tourne côté Postgres, pas dans le navigateur) tranche
    // d'abord la question, pickSegment() ne fait plus que le tirage cosmétique.
    // Seuls les vrais souscripteurs y sont éligibles (0% sinon côté client de
    // toute façon) — évite un aller-retour réseau inutile pour tout le monde.
    let serverMonetary = "none";
    if(isSubscriber) {
      try {
        const { data, error } = await supabase.rpc("spin_wheel_check_monetary_prize");
        if(!error && data) serverMonetary = data;
      } catch(e) { console.warn("[Duvia] spin_wheel_check_monetary_prize failed:", e); }
    }

    const { segIdx, prize } = pickSegment(isSubscriber, serverMonetary);
```

Replace with:
```js
    // 🔒 (2026-07-23) Le tirage ENTIER (éligibilité, cooldown, décrément d'un
    // tour bonus, tirage mensuel/annuel ET cosmétique, persistance) est
    // désormais décidé par spin_wheel() côté serveur — plus aucun
    // Math.random() ni logique d'éligibilité/cooldown en local. En cas
    // d'erreur (not_eligible/cooldown_active — le serveur a le dernier mot
    // même si le filtre client canSpin/canAccessWheel a laissé passer un
    // clic), on arrête l'enchaînement proprement sans faire tourner la roue.
    let spinData;
    try {
      const { data, error } = await supabase.rpc("spin_wheel");
      if(error) throw error;
      spinData = data?.[0];
    } catch(e) {
      console.warn("[Duvia] spin_wheel failed:", e);
      setSpinning(false);
      return;
    }
    if(!spinData) { setSpinning(false); return; }
    const usingBonus = spinData.used_bonus_spin;

    const { segIdx, prize } = pickSegment(spinData.prize_id);
```

- [ ] **Step 5: Remove the now-redundant local `usingBonus` computation and use the server's value**

Find, near the top of `spin()`:
```js
  async function spin() {
    if(spinning || (!canSpin && !isAdminSub) || !isPremium) return;
    const usingBonus = !isAdminSub && hasBonusSpin && lastSpin && (now - new Date(lastSpin).getTime()) < cooldownMs;
    setShowResult(false); setResult(null); setParticles([]);
    setSpinning(true);
```

Replace with:
```js
  async function spin() {
    if(spinning || (!canSpin && !isAdminSub) || !isPremium) return;
    setShowResult(false); setResult(null); setParticles([]);
    setSpinning(true);
```
(`usingBonus` is now declared later in Step 4's replacement code, from the server's `spinData.used_bonus_spin` — this removes the duplicate/stale local declaration. `canSpin`/`isAdminSub`/`hasBonusSpin` stay exactly as-is: they remain the client's pre-flight UX filter, per the design spec — the real enforcement is now `spin_wheel()` itself.)

- [ ] **Step 6: Update `setSub()` after a spin to use the server's `usingBonus`**

This code (further down in `spin()`, inside the animation-complete branch) already reads a variable named `usingBonus` — after Steps 4-5 it now refers to `spinData.used_bonus_spin` instead of the removed local computation, so **no change needed to this block itself**:
```js
          setSub(s=>({...s,
            lastSpinByUser: { ...(s.lastSpinByUser||{}), [spinKey]: now_ts },
            pendingSpins: usingBonus ? Math.max(0,(s.pendingSpins||0)-1) : (s.pendingSpins||0),
            earnedTheme:   prize.id==="theme"   || s.earnedTheme,
            earnedVideo:   prize.id==="video"   || s.earnedVideo,
            earnedLicorne: prize.id==="licorne" || s.earnedLicorne,
            earnedRG:      prize.id==="rg"      || s.earnedRG,
            earnedWC:      prize.id==="wc"      || s.earnedWC,
          }));
```
Just confirm (read the file) that this block is unchanged and now correctly reads the outer `usingBonus` from Step 4.

- [ ] **Step 7: Run tests and build**

Run: `TZ=Europe/Paris npm test`
Expected: 173 passed (no test touches `WheelGame` directly, this confirms nothing else broke).

Run: `npm run build`
Expected: build succeeds (the pre-existing >500kB chunk-size warning is normal, not a failure).

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "WheelGame: draw via server-side spin_wheel() RPC instead of local Math.random()"
```

---

### Task 6: Client — cooldown display and theme ownership from `wheel_spins`, not `localStorage`

**Files:**
- Modify: `src/App.jsx` (`WheelGame` function, ~line 19519 onward — the `lastSpin`/`hasBonusSpin`/`canSpin` block and the `sub.earnedTheme` etc. initial state)

**Interfaces:**
- Consumes: `wheel_spins` table (Task 1) via a direct `supabase.from("wheel_spins")` read (RLS already restricts to the caller's own rows — no RPC needed for a read).
- Produces: `WheelGame` now shows accurate cooldown/ownership state even if `localStorage` was tampered with or cleared.

- [ ] **Step 1: Read the current `lastSpin`-computation block precisely**

In `src/App.jsx`, find this exact block inside `WheelGame`:
```js
  const spinKey = myUid || userId;
  // ── lastSpin : clé dédiée résistante aux rechargements du sub ────────────
  // duvia_spin_ts est une clé séparée, jamais écrasée par setSub()
  const [spinTimestamps, setSpinTimestamps] = useLocalStorage("duvia_spin_ts", {});
  const lastSpinByUser = useMemo(() => {
    const fromSub = sub.lastSpinByUser || {};
    // Fusionner sub (legacy) + spinTimestamps (nouvelle clé) → prend le plus récent
    const merged = {...fromSub};
    Object.entries(spinTimestamps).forEach(([uid, ts]) => {
      if (!merged[uid] || ts > merged[uid]) merged[uid] = ts;
    });
    return merged;
  }, [sub.lastSpinByUser, spinTimestamps]);
  const lastSpin = lastSpinByUser[spinKey] || null;
```

- [ ] **Step 2: Replace it with a server-backed fetch, dropping `spinKey`/`spinTimestamps`/`lastSpinByUser` entirely**

`spinKey` (and everything derived from it) exists only to key `lastSpinByUser`/`spinTimestamps` — both removed by this task, so `spinKey` itself becomes dead too (confirmed: `grep -n "lastSpinByUser\|spinKey" src/App.jsx` shows no usage outside `WheelGame` and `makeAdminSub()`'s default object, handled in Step 4). Replace the whole block above with:

```js
  // 🔒 (2026-07-23) lastSpin vient désormais de wheel_spins (source de vérité
  // serveur, voir spin_wheel() dans supabase/migrations/0049_wheel_spins_
  // security.sql), gardé par myUid directement — plus besoin de spinKey/
  // duvia_spin_ts/sub.lastSpinByUser (localStorage, manipulable, retirés).
  // Toujours utilisé uniquement comme filtre d'AFFICHAGE (canSpin ci-dessous)
  // — spin_wheel() est la vraie barrière, ce fetch ne sert qu'à ne pas
  // montrer un bouton "Lancer" trompeur.
  const [lastSpin, setLastSpin] = useState(null);
  useEffect(() => {
    if(!myUid) return;
    let cancelled = false;
    supabase.from("wheel_spins")
      .select("spun_at")
      .eq("user_id", myUid)
      .order("spun_at", { ascending: false })
      .limit(1)
      .then(({ data }) => { if(!cancelled) setLastSpin(data?.[0]?.spun_at || null); });
    return () => { cancelled = true; };
  }, [myUid]);
```

- [ ] **Step 3: Refresh `lastSpin` after a successful spin, and stop writing the now-dead `sub.lastSpinByUser`**

In the animation-complete branch of `spin()` (same block from Task 5 Step 6), find:
```js
        {
          const now_ts = new Date().toISOString();
          setSpinTimestamps(h=>({...h,[spinKey]:now_ts}));
          setSub(s=>({...s,
            lastSpinByUser: { ...(s.lastSpinByUser||{}), [spinKey]: now_ts },
            pendingSpins: usingBonus ? Math.max(0,(s.pendingSpins||0)-1) : (s.pendingSpins||0),
```
Replace with:
```js
        {
          const now_ts = new Date().toISOString();
          setLastSpin(now_ts);
          setSub(s=>({...s,
            pendingSpins: usingBonus ? Math.max(0,(s.pendingSpins||0)-1) : (s.pendingSpins||0),
```
(`sub.lastSpinByUser` is no longer read anywhere after Step 2 — dropping the write here too, rather than leaving a stale field nothing consumes.)

- [ ] **Step 4: Recompute `earnedTheme`/etc. into `sub` from `wheel_spins`, not the other way around**

**Correction from initial drafting of this plan:** `WheelGame` itself never reads `sub.earnedTheme`/etc. for display (only writes them, in the `setSub()` call from Task 5 Step 6) — the actual read sites are in unrelated places (`GameTab`'s own rewards section ~line 20337-20373, a header theme-picker ~line 5272-5348). Threading a parallel `earnedFromServer` value into every one of those distant read sites would be a much bigger, riskier change than this task calls for. The simpler, correctly-scoped fix: merge the server truth **into `sub` itself**, once, from `WheelGame` (where `myUid`/`setSub` are already available) — every existing read site then automatically sees the correct value with no changes needed there at all.

This merge is intentionally **one-directional** (only sets a flag to `true` if `wheel_spins` confirms it, never forces an existing `true` back to `false`): these flags were never pushed to any server column before this fix (confirmed — `subscriptions` has no `earned_*` columns), so a pre-existing forged `true` in one browser's `localStorage` is purely cosmetic to that one browser/device and was never exploitable (per migration `0041`'s own reasoning) — this task's goal is filling in what's *missing* after a device switch or cleared `localStorage`, not retroactively policing old local values. Add, inside `WheelGame`, alongside the fetch from Step 2:

```js
  // 🔒 (2026-07-23) Recale sub.earnedX sur la vérité serveur (wheel_spins) —
  // n'AJOUTE un flag vrai que si wheel_spins le confirme, ne retire jamais un
  // flag déjà à true localement (voir le correctif ci-dessus pour le
  // raisonnement). Volontairement scopé à WheelGame (monté seulement quand
  // l'onglet Jeu est ouvert), pas à l'initialisation globale de App() — plus
  // simple, au prix d'un très bref délai avant que d'autres écrans (menu
  // thèmes) reflètent un changement d'appareil si l'utilisateur ne passe pas
  // par l'onglet Jeu en premier ; acceptable car ceci reste une amélioration
  // de cohérence des données, pas la barrière de sécurité elle-même (celle-ci
  // est déjà assurée par spin_wheel() ci-dessus).
  useEffect(() => {
    if(!myUid) return;
    let cancelled = false;
    supabase.from("wheel_spins")
      .select("prize_id")
      .eq("user_id", myUid)
      .then(({ data }) => {
        if(cancelled || !data?.length) return;
        const ids = new Set(data.map(r=>r.prize_id));
        setSub(s=>({...s,
          earnedTheme:   ids.has("theme")   || s.earnedTheme,
          earnedVideo:   ids.has("video")   || s.earnedVideo,
          earnedLicorne: ids.has("licorne") || s.earnedLicorne,
          earnedRG:      ids.has("rg")      || s.earnedRG,
          earnedWC:      ids.has("wc")      || s.earnedWC,
        }));
      });
    return () => { cancelled = true; };
  }, [myUid]);
```

- [ ] **Step 5: Run tests and build**

Run: `TZ=Europe/Paris npm test`
Expected: 173 passed.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Bump the app version**

In `src/config.js`, increment `APP_VERSION` (check the current value first, e.g. if it's `"3.17"`, change to `"3.18"`). In `public/sw.js`, increment `SW_VERSION` to the exact same new value.

- [ ] **Step 7: Commit and push**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "WheelGame: source cooldown and theme ownership from wheel_spins, not localStorage"
git push origin main
```

- [ ] **Step 8: Manual live verification (no automated UI test exists in this repo)**

Once Vercel finishes auto-deploying (a few minutes after the push), open the app as a real test account and spin the wheel. Confirm: the spin completes and lands on a segment matching the result card, the cooldown card appears correctly on a second attempt, and (if you have access to an eligible-but-not-yet-cooled-down account) that a genuinely ineligible/on-cooldown attempt is blocked. This is the point where a bug in Task 2's family-premium replica would surface as a real user being wrongly locked out or wrongly let in — re-check Task 2's Step 3 verification against this live account if anything looks wrong.

---

### Task 7 (gated — do not start until Task 6 is confirmed live and stable): Retire the old monetary-only RPC

**Files:**
- Modify: `supabase/migrations/0049_wheel_spins_security.sql` (append) — or a new follow-up migration file if enough time has passed that `0049` feels like the wrong place for it; either is fine, prefer appending if this happens within the same work session.

**Interfaces:**
- Consumes: nothing new.
- Removes: `public.spin_wheel_check_monetary_prize()` (migration `0041`), now fully superseded by `spin_wheel()`.

**Do not do this task until Task 6's Step 8 live verification has been confirmed working for real spins over at least a few days** — this is the safety window against a deployed-but-broken client still calling the old function while a bug in the new path gets sorted out. Jumping straight to this task defeats that safety margin (see the design spec's "Rollout order").

- [ ] **Step 1: Confirm nothing still calls the old RPC**

Run: `grep -n "spin_wheel_check_monetary_prize" src/App.jsx`
Expected: no matches (Task 5 removed the only call site).

- [ ] **Step 2: Append the drop statement**

```sql
-- ── 5. Retire the old monetary-only RPC (migration 0041), fully superseded
--    by spin_wheel() above. Only run this once the new client code (Task 5/6
--    of the wheel-security plan) has been confirmed live and stable.
drop function if exists public.spin_wheel_check_monetary_prize();
```

- [ ] **Step 3: Apply**

Run: `npx supabase db query --linked --file supabase/migrations/0049_wheel_spins_security.sql`
Expected: no error.

- [ ] **Step 4: Verify it's gone**

Run: `npx supabase db query --linked "select proname from pg_proc where proname = 'spin_wheel_check_monetary_prize'"`
Expected: empty `rows` array.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0049_wheel_spins_security.sql
git commit -m "Retire spin_wheel_check_monetary_prize(), superseded by spin_wheel()"
git push origin main
```
