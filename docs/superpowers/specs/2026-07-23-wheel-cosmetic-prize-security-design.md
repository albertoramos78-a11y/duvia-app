# Wheel Cosmetic-Prize Server-Side Security Fix — Design

## Problem

The Duvia wheel (`WheelGame` in `src/App.jsx`) currently decides and persists cosmetic prizes (theme unlocks: `earnedTheme`/`earnedVideo`/`earnedLicorne`/`earnedRG`/`earnedWC`) **entirely client-side**:

- `pickSegment()` runs `Math.random()` in the browser to draw a prize.
- The win is persisted via `setSub(s => ({...s, earnedTheme: ...}))`, which flows into the `sub` React state — backed 100% by `localStorage` (`useLocalStorage("duvia_sub", makeSub)`).
- Cooldown (7 days between spins) is tracked client-side (`spinTimestamps`/`lastSpinByUser` in the `sub` blob).

Any user can grant themselves every cosmetic theme by editing the `duvia_sub` localStorage key in DevTools. This was a **deliberate, documented decision** in migration `0041_lock_subscriptions_paid_columns.sql` ("themes are cosmetic, no exploitable value") — at the time, only the two monetary prizes (1 month/1 year free subscription) were hardened, via `spin_wheel_check_monetary_prize()`.

Investigation for this design revealed the existing monetary-prize RPC is **much thinner than assumed**: it does not check cooldown, does not check family-wide Premium eligibility, and does not persist anything server-side — it only makes the dice roll itself honest (`year`/`month`/`none`), based on the caller's own individual `subscriptions.plan`. There is currently **no server-side cooldown, eligibility, or persistence mechanism for the wheel at all** — not just for cosmetic prizes.

The user has explicitly asked for the same rigor extended to cosmetic prizes. Low urgency in practice today because `GiftShopSection`'s theme purchases are disabled during the beta (`isBeta()` lock), but this becomes a real gap the moment purchases go live. The wheel's visual redesign (v3.15) and motion fixes (v3.14) were confirmed working live by the user on 2026-07-22, unblocking this work.

## Goals

- A single, honest, tamper-proof server-side decision for every wheel spin (monetary **and** cosmetic prizes together), replacing all client-side randomness.
- Real server-side enforcement of: family-wide effective Premium eligibility, the 7-day cooldown, and bonus-spin (`pending_spins`) consumption.
- Persistence of spin history and prize wins server-side, independent of `localStorage`.
- Preserve the wheel's existing visual/motion layer (countdown, easing curves, pointer sync, confetti — all confirmed working 2026-07-22) untouched; this fix only changes *where* the prize decision and persistence happen.

## Non-goals (explicitly out of scope)

- **Securing how `pending_spins` is *credited*** (the referral-validation flow that grants a bonus spin, currently a client-side `+1` synced via the same debounced upsert as before). This design only secures how a spin is *spent*. Crediting is a separate subsystem (`ParrainageSection`, `refActions`, `REF_ACTION_WEIGHTS`) and, if it needs hardening, deserves its own future design — mixing the two would bloat this change and couple two distinct security surfaces. Worst case today: a forged credit grants extra *honest* draws, never a forced monetary win (the draw itself is what this fix locks down).
- Any change to `GiftShopSection` / direct theme purchases (already disabled during beta).
- Any change to the wheel's visual design or spin animation.

## Architecture

One new table, one new RPC, replacing the old monetary-only RPC entirely.

### Table: `wheel_spins`

```sql
create table public.wheel_spins (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  family_id       uuid not null,
  spun_at         timestamptz not null default now(),
  prize_id        text not null,  -- 'year'|'month'|'theme'|'video'|'licorne'|'rg'|'wc'|'nothing'
  used_bonus_spin boolean not null default false
);

alter table public.wheel_spins enable row level security;

create policy wheel_spins_select_own on public.wheel_spins
  for select using (user_id = auth.uid());
-- No insert/update/delete policies for authenticated/anon — only the
-- SECURITY DEFINER spin_wheel() function (executing as table owner) writes.
```

One row per **real** tirage (every call that actually resolves a prize, including `nothing`) — this table is both the cooldown source of truth (`max(spun_at)` for a user) and the theme-ownership source of truth (`distinct prize_id` for a user), plus a free audit trail for support/debugging.

### RPC: `spin_wheel()`

Replaces `spin_wheel_check_monetary_prize()` (dropped once the new client code is live — see Rollout below).

```sql
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
  v_r double precision := random();
  -- probability tables, seasonal windows: see "Draw logic" below
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- 1) Resolve caller's active family (same pattern as get_family_billing_context)
  select family_id into v_family_id
    from public.family_members
   where user_id = v_uid and status = 'active'
   limit 1;
  if v_family_id is null then
    raise exception 'no_family';
  end if;

  -- 2) Family-wide effective Premium — full replica of subStatus()/isPrem()
  --    (trial window, beta cutoff, referral trial extensions, best-of-both-
  --    parents), NOT a simplified plan-string check. See "Premium replica"
  --    section below for the exact ported logic.
  v_family_premium := public._wheel_family_is_premium(v_family_id); -- helper, see below

  -- 3) Test account bypass (mirrors client's WHEEL_UNLIMITED_EMAILS)
  select email into v_email from auth.users where id = v_uid;
  v_is_unlimited := v_email = 'toti78200@gmail.com';

  -- 4) pending_spins (bonus spins from referrals)
  select pending_spins into v_pending_spins
    from public.subscriptions where user_id = v_uid;
  v_pending_spins := coalesce(v_pending_spins, 0);

  -- Eligibility mirrors canAccessWheel (prem || hasBonusSpin) in GameTab —
  -- NOT affected by the unlimited-test-account bypass, which only skips
  -- cooldown (below), never grants access to an otherwise-freemium family.
  if not (v_family_premium or v_pending_spins > 0) then
    raise exception 'not_eligible';
  end if;

  -- 5) Cooldown — applies to EVERYONE, premium included (per the FAQ: "7
  --    jours pour tout le monde" — premium does NOT exempt from cooldown,
  --    matching canSpin's client-side OR-chain, which never checks premium
  --    status at all). Only a bonus spin or the unlimited test account
  --    skips it.
  select max(spun_at) into v_last_spin
    from public.wheel_spins where user_id = v_uid;

  if v_last_spin is not null and now() < v_last_spin + v_cooldown
     and not v_is_unlimited then
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

  -- 6) Draw (monetary + cosmetic together) — see "Draw logic" below
  v_is_individual_subscriber := public._wheel_is_individual_subscriber(v_uid);
  v_prize := public._wheel_draw(v_is_individual_subscriber, v_r);

  -- 7) Persist and return
  insert into public.wheel_spins (user_id, family_id, prize_id, used_bonus_spin)
    values (v_uid, v_family_id, v_prize, v_using_bonus);

  return query select v_prize, v_using_bonus,
    (coalesce(v_last_spin, now()) + v_cooldown);
end;
$$;

revoke all on function public.spin_wheel() from public;
grant execute on function public.spin_wheel() to authenticated;
```

(`_wheel_family_is_premium`, `_wheel_is_individual_subscriber`, `_wheel_draw` are internal `SECURITY DEFINER` helper functions, not exposed to `authenticated` — kept separate from the main function purely for readability/testability, not a security boundary.)

**Premium replica (`_wheel_family_is_premium`)**: full port of `subStatus()`/`isPrem()` — for each active parent of the family (same `family_members` join as `get_family_billing_context`), compute their individual effective status (trial window from `trial_start`/`trial_extension_days`, `beta_end` cutoff, `premium`+`premium_since`+`cycle` expiry, `earned_premium`), then family status = best of both parents. This duplicates business logic that lives in `App.jsx`'s `subStatus()`/`isPrem()` — **flagged as a real maintenance cost**: if trial/beta/extension rules change client-side, this SQL replica must be updated to match, with no automated check that they stay in sync. Comment block in the migration will point back to `subStatus()`/`isPrem()` in `App.jsx` as the reference implementation.

**Draw logic (`_wheel_draw`)**: mirrors `PROBS_SUBSCRIBER`/`PROBS_OTHERS` in `App.jsx` exactly (`year`/`month` only for `v_is_individual_subscriber`, at 0.1%/1.0%; `theme`/`video`/`licorne`/`rg`/`wc` at 20%/10%/10%/5%/5% when their seasonal window is active, redistributed to `nothing` otherwise — same redistribution rule as the client's `pickSegment()`). Seasonal windows (`SUMMER_START`/`END`, `RG_START`/`END`, `WC_START`/`END`) are duplicated as hardcoded SQL date literals, with a comment noting they must be kept in sync with `src/theme.js` manually (same duplication convention already used for `easterDateX` in `ai-chatbot`'s Edge Function).

## Client-side changes (`src/App.jsx`)

- **Pre-flight cooldown display** (gap found during self-review): the wheel screen shows "next spin available in N days" *before* the user taps "Lancer", not only after a failed attempt — this needs `lastSpin` known ahead of the RPC call. Since `wheel_spins` already grants each user `select` on their own rows, the client reads it directly (`supabase.from("wheel_spins").select("spun_at").eq("user_id", ...).order("spun_at",{ascending:false}).limit(1)`) to compute `canSpin`/`daysLeft` for display, exactly like the current `lastSpinByUser`-based computation — no RPC round-trip needed just to *show* cooldown state, only to actually spin.
- **`WheelGame.spin()`**: replace the `spin_wheel_check_monetary_prize()` call + local `pickSegment()` draw with a single `await supabase.rpc("spin_wheel")`. On `not_eligible`/`cooldown_active` errors, show the existing lock/cooldown UI (the client's own `canSpin`/`canAccessWheel` checks remain as a first-pass UX filter to avoid an unnecessary round-trip in the common case — the RPC is the real enforcement regardless of what the client shows).
- **`pickSegment(prize_id)`**: becomes a pure visual mapping function (prize_id → wheel segment index for the animation to land on) — no more `Math.random()`, no more probability tables client-side (those move fully into `_wheel_draw`; the client-side `PROBS_SUBSCRIBER`/`PROBS_OTHERS`/`WHEEL_PRIZES` probability fields become dead weight, removed — `WHEEL_PRIZES`' visual fields like `emoji`/`color`/`labelKey` stay, they're still needed for rendering).
- **`sub.earnedTheme`/`earnedVideo`/`earnedLicorne`/`earnedRG`/`earnedWC`**: kept as client display flags (avoids a round-trip to re-render immediately after a win) but stop being the source of truth — on app load, recompute from `select distinct prize_id from wheel_spins where user_id = auth.uid()` instead of trusting `localStorage`.
- **`WHEEL_UNLIMITED_EMAILS`**: stays as-is client-side (controls the "no cooldown wait" UX affordance), now backed by the equivalent server-side check in `spin_wheel()` rather than being a purely cosmetic client flag.

## Rollout order

1. Migration: create `wheel_spins` (+ RLS), create `spin_wheel()` and its helpers, `grant execute` to `authenticated`. Do **not** drop `spin_wheel_check_monetary_prize()` yet.
2. Deploy client code that calls `spin_wheel()` instead of the old RPC + local draw (via the CLI pipeline now in place).
3. Once confirmed working live, a follow-up migration drops `spin_wheel_check_monetary_prize()` (now unused).

This order avoids ever having a deployed client calling a function that doesn't exist yet, or a stale client silently left calling a removed function.

## Open question surfaced during self-review

The client's `isAdminSub = isAdmin || sub._admin || unlimitedSpins` has **two** distinct bypasses, not one: the specific `toti78200@gmail.com` test account (`unlimitedSpins`, handled above) *and* a general `sub._admin` flag (fed by the `isAdmin` prop, itself just `sub._admin` renamed) used for any admin/dev-testing account. `sub._admin` has no server-verifiable equivalent — it's a plain client/`localStorage` flag, same exploitable nature as everything else this fix removes trust from. This design deliberately does **not** give `sub._admin` a server-side bypass: an account with `sub._admin` set would still hit the real 7-day cooldown via `spin_wheel()`, only `toti78200@gmail.com` specifically skips it. Flagging this explicitly rather than silently picking a side — if admin/dev accounts other than that one email need to bypass cooldown for testing going forward, that needs its own explicit decision (e.g. a real `is_admin` column, or a small hardcoded list of user IDs in `spin_wheel()`), not assumed here.

## Testing

- `TZ=Europe/Paris npm test` + `npm run build` after the client changes (no server-side SQL test harness exists in this repo — the RPC will be manually verified via the Supabase SQL Editor before considering it done, matching how prior migrations in this project were validated).
- Manual checks once deployed: a freemium account is rejected (`not_eligible`), a family-Premium account can spin, cooldown blocks a second immediate spin, a bonus spin (`pending_spins > 0`) bypasses cooldown exactly once and decrements, the test account (`toti78200@gmail.com`) can spin repeatedly, seasonal prizes (`theme`/`rg`/`wc`) are only drawable inside their active window.
