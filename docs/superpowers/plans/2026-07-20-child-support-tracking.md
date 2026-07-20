# Suivi de la pension alimentaire — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two parents configure a recurring monthly child-support payment (amount, payer→recipient, due day), track each month's payment through a propose→confirm workflow (mutual confirmation of the config, payer-marks/recipient-confirms-or-contests each payment), with automatic monthly generation and push reminders — kept entirely separate from the existing shared-expense balance.

**Architecture:** Two new Supabase tables (`pension_configs`, `pension_payments`) mutated exclusively through `SECURITY DEFINER` RPCs (no direct client writes — mirrors this project's established pattern for sensitive family transitions, e.g. `accept_family_invitation`). A service/hook pair (`pensionService.ts` / `usePension.ts`) follows the exact shape of the existing `expenseService.ts` / `useExpenses.ts`. A new UI section inside the existing `ExpTab` (not a new nav tab). A daily `pg_cron`-invoked SQL function generates each month's payment row; a new Edge Function `send-pension-reminders`, invoked by the same cron job, sends push reminders/alerts.

**Tech Stack:** React (no new deps), Supabase Postgres/RLS/RPC, Supabase Edge Functions (Deno), `pg_cron`/`pg_net` (dashboard-configured, standard Supabase pattern already used in this project for `expire_stale_family_data()`).

## Global Constraints

- Pension tracking is **entirely separate from the expense/reimbursement balance** (`ExpTab`'s `balance[i]` calculation) — never read, written, or referenced by the new tables/code, and vice versa. This was an explicit user decision during brainstorming.
- Exactly **one active pension config per family at a time** — `cfg.parents` only ever has 2 entries in this app; no multi-config support needed.
- `day_of_month` is bounded **1–28** (avoids every month-length edge case — no clamping logic needed anywhere, client or server).
- All mutations to `pension_configs`/`pension_payments` go through the 5 `SECURITY DEFINER` RPCs defined in Task 1 — the tables themselves grant **SELECT only** to authenticated clients (family-membership check, same as `expenses`/`reimbursements`), never direct INSERT/UPDATE/DELETE. This was an explicit user choice (stricter than `expenses`/`reimbursements`' looser convention) made when this exact tension was raised during planning.
- A config transitions `proposed → active` only when confirmed by **the other parent** (never the proposer) — enforced inside `confirm_pension_config`, not just in the UI.
- Changing the amount **never** mutates the active config in place — it creates a new `proposed` config; the old one is marked `superseded` only once the new one is confirmed (never before, to avoid a gap if the new one is never confirmed).
- Payment status enum: `pending → marked_paid → confirmed` (happy path) or `marked_paid → contested` (dispute). Only the config's `from_user_id` can mark paid; only `to_user_id` can confirm/contest.
- Reminders: payer gets a push 2–3 days before `due_date`; recipient gets a push once if `due_date` has passed with the payment still `pending`. Each of these fires **at most once per payment** (tracked via `payer_reminder_sent_at`/`overdue_alert_sent_at` columns) — never a repeated daily nag.
- No automated tests are possible for the Supabase-dependent pieces (migration/RPCs/Edge Function) — this repo's established convention for this kind of feature (see the AI chatbot and invite-email plans). The one piece of genuinely pure logic (next-due-date computation) **does** get a real unit test in `core.test.js`, per this repo's stated direction to extract pure logic there.
- Every deployment step against Supabase (migration, Edge Function, `pg_cron` config) is manual/dashboard-driven, per this project's established convention — the plan's final task prints exact instructions and full file contents, nothing left implicit.
- Bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together, once, in the final task.
- New UI text needs real translations in all 5 languages (fr/en/de/es/pt) — not just French with English fallback placeholders.

---

### Task 1: Database migration — tables, RLS, RPCs, generation function

**Files:**
- Create: `supabase/migrations/0046_pension_tracking.sql`

**Interfaces:**
- Produces: tables `public.pension_configs` (columns: `id, family_id, from_parent, from_user_id, to_parent, to_user_id, amount, day_of_month, start_date, end_date, status, created_by_user_id, created_at, confirmed_by_user_id, confirmed_at`) and `public.pension_payments` (columns: `id, family_id, config_id, period, amount, due_date, status, marked_paid_by_user_id, marked_paid_at, confirmed_by_user_id, confirmed_at, note, payer_reminder_sent_at, overdue_alert_sent_at, created_at`, unique on `(config_id, period)`).
- Produces: RPCs `propose_pension_config(p_family_id uuid, p_from_parent int, p_from_user_id uuid, p_to_parent int, p_to_user_id uuid, p_amount numeric, p_day_of_month int, p_start_date date) returns pension_configs`, `confirm_pension_config(p_config_id uuid) returns pension_configs`, `mark_pension_payment_paid(p_payment_id uuid) returns pension_payments`, `confirm_pension_payment(p_payment_id uuid) returns pension_payments`, `contest_pension_payment(p_payment_id uuid, p_note text) returns pension_payments`. Later tasks (service layer) call these by exact name/params.
- Produces: cron-callable function `generate_due_pension_payments() returns void` (no params, not client-callable).

- [ ] **Step 1: Write the migration file**

```sql
-- 0046_pension_tracking.sql
--
-- Suivi de la pension alimentaire (backlog item 14) — voir
-- docs/superpowers/specs/2026-07-20-child-support-tracking-design.md.
--
-- Entièrement séparé du solde des dépenses partagées (expenses/reimbursements) :
-- décision explicite, jamais mélangé dans balance[i] côté client.
--
-- Contrairement à expenses/reimbursements (RLS permissive, "confiance
-- familiale"), ce module impose des règles strictes côté serveur : toutes les
-- mutations passent par les 5 RPC SECURITY DEFINER ci-dessous, les tables
-- elles-mêmes n'accordent que SELECT aux clients authentifiés — décision
-- explicite de l'utilisateur (plus sûr, nouveau pattern dans ce projet,
-- assumé après avoir signalé la tension avec la convention existante).
--
-- À exécuter après 0045. Idempotent (IF NOT EXISTS partout où possible).

-- ── 1. Tables ─────────────────────────────────────────────────────────────

create table if not exists public.pension_configs (
  id                  uuid        primary key default gen_random_uuid(),
  family_id           uuid        not null references public.families(id) on delete cascade,
  from_parent         int         not null,
  from_user_id        uuid        not null,
  to_parent           int         not null,
  to_user_id          uuid        not null,
  amount              numeric(10,2) not null,
  day_of_month        int         not null check (day_of_month between 1 and 28),
  start_date          date        not null,
  end_date            date,
  status              text        not null default 'proposed' check (status in ('proposed','active','superseded')),
  created_by_user_id  uuid        not null,
  created_at          timestamptz not null default now(),
  confirmed_by_user_id uuid,
  confirmed_at        timestamptz
);

create index if not exists pension_configs_family_id_idx on public.pension_configs(family_id);

create table if not exists public.pension_payments (
  id                      uuid        primary key default gen_random_uuid(),
  family_id               uuid        not null references public.families(id) on delete cascade,
  config_id               uuid        not null references public.pension_configs(id) on delete cascade,
  period                  text        not null, -- 'YYYY-MM'
  amount                  numeric(10,2) not null,
  due_date                date        not null,
  status                  text        not null default 'pending' check (status in ('pending','marked_paid','confirmed','contested')),
  marked_paid_by_user_id  uuid,
  marked_paid_at          timestamptz,
  confirmed_by_user_id    uuid,
  confirmed_at            timestamptz,
  note                    text        not null default '',
  payer_reminder_sent_at  timestamptz,
  overdue_alert_sent_at   timestamptz,
  created_at              timestamptz not null default now(),
  unique (config_id, period)
);

create index if not exists pension_payments_family_id_idx on public.pension_payments(family_id);
create index if not exists pension_payments_config_id_idx on public.pension_payments(config_id);
create index if not exists pension_payments_due_date_idx  on public.pension_payments(due_date);

-- ── 2. RLS : lecture seule pour les clients, toute écriture via RPC ──────────

alter table public.pension_configs  enable row level security;
alter table public.pension_payments enable row level security;

drop policy if exists "pension_configs_select" on public.pension_configs;
create policy "pension_configs_select" on public.pension_configs for select
  using (exists (
    select 1 from public.family_members fm
    where fm.family_id = pension_configs.family_id and fm.user_id = auth.uid()
  ));

drop policy if exists "pension_payments_select" on public.pension_payments;
create policy "pension_payments_select" on public.pension_payments for select
  using (exists (
    select 1 from public.family_members fm
    where fm.family_id = pension_payments.family_id and fm.user_id = auth.uid()
  ));

-- Volontairement AUCUNE policy insert/update/delete : tout passe par les RPC
-- SECURITY DEFINER ci-dessous, qui s'exécutent avec les privilèges du
-- propriétaire de la table (contournent RLS) après leurs propres vérifications.

-- ── 3. RPC : proposer une configuration ─────────────────────────────────────

create or replace function public.propose_pension_config(
  p_family_id     uuid,
  p_from_parent   int,
  p_from_user_id  uuid,
  p_to_parent     int,
  p_to_user_id    uuid,
  p_amount        numeric,
  p_day_of_month  int,
  p_start_date    date
) returns public.pension_configs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if auth.uid() not in (p_from_user_id, p_to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = p_family_id and fm.user_id = auth.uid() and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;
  if p_day_of_month < 1 or p_day_of_month > 28 then
    raise exception 'invalid_day_of_month';
  end if;
  if p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  if exists (
    select 1 from public.pension_configs
    where family_id = p_family_id and status in ('proposed','active')
  ) then
    raise exception 'pension_already_configured';
  end if;

  insert into public.pension_configs (
    family_id, from_parent, from_user_id, to_parent, to_user_id,
    amount, day_of_month, start_date, status, created_by_user_id
  ) values (
    p_family_id, p_from_parent, p_from_user_id, p_to_parent, p_to_user_id,
    p_amount, p_day_of_month, p_start_date, 'proposed', auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.propose_pension_config(uuid,int,uuid,int,uuid,numeric,int,date) from public;
grant execute on function public.propose_pension_config(uuid,int,uuid,int,uuid,numeric,int,date) to authenticated;

-- ── 4. RPC : confirmer une configuration (par l'AUTRE parent) ───────────────

create or replace function public.confirm_pension_config(p_config_id uuid)
returns public.pension_configs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_configs where id = p_config_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'not_proposed';
  end if;
  if auth.uid() = v_row.created_by_user_id then
    raise exception 'cannot_confirm_own_proposal';
  end if;
  if auth.uid() not in (v_row.from_user_id, v_row.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;

  -- Clôt toute autre configuration active de la même famille (changement de
  -- montant) — seulement maintenant que la nouvelle est confirmée, jamais avant.
  update public.pension_configs
     set status = 'superseded', end_date = v_row.start_date
   where family_id = v_row.family_id
     and status = 'active'
     and id <> v_row.id;

  update public.pension_configs
     set status = 'active', confirmed_by_user_id = auth.uid(), confirmed_at = now()
   where id = p_config_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.confirm_pension_config(uuid) from public;
grant execute on function public.confirm_pension_config(uuid) to authenticated;

-- ── 5. RPC : le payeur marque un versement comme payé ───────────────────────

create or replace function public.mark_pension_payment_paid(p_payment_id uuid)
returns public.pension_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_payments;
  v_cfg public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_payments where id = p_payment_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;

  if auth.uid() <> v_cfg.from_user_id then
    raise exception 'only_payer_can_mark_paid';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'not_pending';
  end if;

  update public.pension_payments
     set status = 'marked_paid', marked_paid_by_user_id = auth.uid(), marked_paid_at = now()
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.mark_pension_payment_paid(uuid) from public;
grant execute on function public.mark_pension_payment_paid(uuid) to authenticated;

-- ── 6. RPC : le bénéficiaire confirme un versement ──────────────────────────

create or replace function public.confirm_pension_payment(p_payment_id uuid)
returns public.pension_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_payments;
  v_cfg public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_payments where id = p_payment_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;

  if auth.uid() <> v_cfg.to_user_id then
    raise exception 'only_recipient_can_confirm';
  end if;
  if v_row.status <> 'marked_paid' then
    raise exception 'not_marked_paid';
  end if;

  update public.pension_payments
     set status = 'confirmed', confirmed_by_user_id = auth.uid(), confirmed_at = now()
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.confirm_pension_payment(uuid) from public;
grant execute on function public.confirm_pension_payment(uuid) to authenticated;

-- ── 7. RPC : le bénéficiaire conteste un versement ──────────────────────────

create or replace function public.contest_pension_payment(p_payment_id uuid, p_note text default '')
returns public.pension_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_payments;
  v_cfg public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_payments where id = p_payment_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;

  if auth.uid() <> v_cfg.to_user_id then
    raise exception 'only_recipient_can_contest';
  end if;
  if v_row.status <> 'marked_paid' then
    raise exception 'not_marked_paid';
  end if;

  update public.pension_payments
     set status = 'contested', confirmed_by_user_id = auth.uid(), confirmed_at = now(),
         note = coalesce(nullif(btrim(p_note), ''), '')
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.contest_pension_payment(uuid, text) from public;
grant execute on function public.contest_pension_payment(uuid, text) to authenticated;

-- ── 8. Fonction de génération mensuelle (appelée par pg_cron, pas par un client) ──

create extension if not exists pg_net with schema extensions;

create or replace function public.generate_due_pension_payments()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg record;
  v_period   text;
  v_due_date date;
begin
  v_period := to_char(current_date, 'YYYY-MM');
  for cfg in
    select * from public.pension_configs
    where status = 'active' and start_date <= current_date
  loop
    v_due_date := date_trunc('month', current_date)::date + (cfg.day_of_month - 1);
    insert into public.pension_payments (family_id, config_id, period, amount, due_date, status)
    values (cfg.family_id, cfg.id, v_period, cfg.amount, v_due_date, 'pending')
    on conflict (config_id, period) do nothing;
  end loop;
end;
$$;

revoke all on function public.generate_due_pension_payments() from public, authenticated;
```

- [ ] **Step 2: Run the migration**

This is a Supabase dashboard action (SQL Editor), not a local command — paste the full file content and run it. Verify no errors, then confirm the 2 tables and 6 functions exist:

```sql
select table_name from information_schema.tables where table_schema='public' and table_name like 'pension_%';
select proname from pg_proc where proname like '%pension%';
```

Expected: `pension_configs`, `pension_payments` tables; `propose_pension_config`, `confirm_pension_config`, `mark_pension_payment_paid`, `confirm_pension_payment`, `contest_pension_payment`, `generate_due_pension_payments` functions.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0046_pension_tracking.sql
git commit -m "Add pension_configs/pension_payments tables, RPCs, and monthly generation function"
```

---

### Task 2: Pure due-date helper (with real unit tests)

**Files:**
- Modify: `src/utils/core.js`
- Test: `src/utils/core.test.js`

**Interfaces:**
- Produces: `nextPensionDueDate(dayOfMonth: number, fromDate?: Date): string` — returns `"YYYY-MM-DD"` of the next occurrence of `dayOfMonth` on or after `fromDate` (defaults to `new Date()`). Consumed by Task 5 (UI) to preview "prochaine échéance" when configuring, before any server round-trip.

- [ ] **Step 1: Write the failing tests**

Add to `src/utils/core.test.js` (add `nextPensionDueDate` to the existing import block at the top of the file, alongside `toStr, pad, ...`):

```js
test("nextPensionDueDate : jour pas encore atteint ce mois -> échéance ce mois-ci", () => {
  assert.equal(nextPensionDueDate(15, new Date(2026, 6, 10)), "2026-07-15");
});

test("nextPensionDueDate : jour déjà dépassé ce mois -> échéance le mois prochain", () => {
  assert.equal(nextPensionDueDate(5, new Date(2026, 6, 10)), "2026-08-05");
});

test("nextPensionDueDate : jour d'échéance = aujourd'hui -> échéance ce mois-ci", () => {
  assert.equal(nextPensionDueDate(10, new Date(2026, 6, 10)), "2026-07-10");
});

test("nextPensionDueDate : passage d'année (décembre -> janvier)", () => {
  assert.equal(nextPensionDueDate(5, new Date(2026, 11, 10)), "2027-01-05");
});

test("nextPensionDueDate : jour 28 en février (mois court) reste valide", () => {
  assert.equal(nextPensionDueDate(28, new Date(2026, 1, 1)), "2026-02-28");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `nextPensionDueDate is not defined` (or similar import error).

- [ ] **Step 3: Implement the function**

Add to `src/utils/core.js`, right after the existing `toStr`/`pad` block (both already defined there):

```js
// ── Pension alimentaire : prochaine échéance ─────────────────────────────────
// dayOfMonth est toujours 1-28 (imposé côté serveur, voir migration 0046) —
// donc jamais besoin de recaler sur un mois plus court (février).
export function nextPensionDueDate(dayOfMonth, fromDate = new Date()) {
  const y = fromDate.getFullYear();
  const m = fromDate.getMonth();
  const day = fromDate.getDate();
  const targetMonth = day <= dayOfMonth ? m : m + 1;
  return toStr(new Date(y, targetMonth, dayOfMonth));
}
```

Also export it from the same file (it already uses `export function`, so no separate export statement needed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: all 5 new tests PASS, plus all pre-existing tests still pass (run the full suite: `TZ=Europe/Paris npm test` — expect the previous total plus 5, all passing).

- [ ] **Step 5: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add nextPensionDueDate pure helper with unit tests"
```

---

### Task 3: Service + hook (`pensionService.ts` / `usePension.ts`)

**Files:**
- Create: `src/services/supabase/pensionService.ts`
- Create: `src/hooks/usePension.ts`

**Interfaces:**
- Consumes: `supabase` client from `../supabaseClient` (existing, same import path used by `expenseService.ts`).
- Produces: from `pensionService.ts` — types `PensionConfig`, `PensionPayment`; functions `dbToPensionConfig(row)`, `dbToPensionPayment(row)`, `listPensionConfigs(familyId)`, `listPensionPayments(familyId)`, `proposePensionConfig(params)`, `confirmPensionConfig(configId)`, `markPensionPaymentPaid(paymentId)`, `confirmPensionPayment(paymentId)`, `contestPensionPayment(paymentId, note)`.
- Produces: from `usePension.ts` — hook `usePension(familyId: string | null)` returning `{ pensionConfigs, pensionPayments, pensionLoading, pensionError, proposePensionConfig, confirmPensionConfig, markPensionPaymentPaid, confirmPensionPayment, contestPensionPayment }`. Task 5 (`App.jsx`) consumes this hook by these exact field names.

- [ ] **Step 1: Write `pensionService.ts`**

```typescript
import { supabase } from "../../supabaseClient";

export interface PensionConfig {
  id: string;
  familyId: string;
  fromParent: number;
  fromUserId: string;
  toParent: number;
  toUserId: string;
  amount: number;
  dayOfMonth: number;
  startDate: string;
  endDate: string | null;
  status: "proposed" | "active" | "superseded";
  createdByUserId: string;
  createdAt: string;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
}

export interface PensionPayment {
  id: string;
  familyId: string;
  configId: string;
  period: string;
  amount: number;
  dueDate: string;
  status: "pending" | "marked_paid" | "confirmed" | "contested";
  markedPaidByUserId: string | null;
  markedPaidAt: string | null;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  note: string;
  createdAt: string;
}

export function dbToPensionConfig(row: Record<string, any>): PensionConfig {
  return {
    id: row.id,
    familyId: row.family_id,
    fromParent: row.from_parent,
    fromUserId: row.from_user_id,
    toParent: row.to_parent,
    toUserId: row.to_user_id,
    amount: Number(row.amount ?? 0),
    dayOfMonth: row.day_of_month,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    confirmedByUserId: row.confirmed_by_user_id ?? null,
    confirmedAt: row.confirmed_at ?? null,
  };
}

export function dbToPensionPayment(row: Record<string, any>): PensionPayment {
  return {
    id: row.id,
    familyId: row.family_id,
    configId: row.config_id,
    period: row.period,
    amount: Number(row.amount ?? 0),
    dueDate: row.due_date,
    status: row.status,
    markedPaidByUserId: row.marked_paid_by_user_id ?? null,
    markedPaidAt: row.marked_paid_at ?? null,
    confirmedByUserId: row.confirmed_by_user_id ?? null,
    confirmedAt: row.confirmed_at ?? null,
    note: row.note ?? "",
    createdAt: row.created_at,
  };
}

export async function listPensionConfigs(familyId: string): Promise<PensionConfig[]> {
  const { data, error } = await supabase
    .from("pension_configs")
    .select("*")
    .eq("family_id", familyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(dbToPensionConfig);
}

export async function listPensionPayments(familyId: string): Promise<PensionPayment[]> {
  const { data, error } = await supabase
    .from("pension_payments")
    .select("*")
    .eq("family_id", familyId)
    .order("due_date", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(dbToPensionPayment);
}

export async function proposePensionConfig(params: {
  familyId: string;
  fromParent: number;
  fromUserId: string;
  toParent: number;
  toUserId: string;
  amount: number;
  dayOfMonth: number;
  startDate: string;
}): Promise<PensionConfig> {
  const { data, error } = await supabase.rpc("propose_pension_config", {
    p_family_id: params.familyId,
    p_from_parent: params.fromParent,
    p_from_user_id: params.fromUserId,
    p_to_parent: params.toParent,
    p_to_user_id: params.toUserId,
    p_amount: params.amount,
    p_day_of_month: params.dayOfMonth,
    p_start_date: params.startDate,
  });
  if (error) throw error;
  return dbToPensionConfig(data);
}

export async function confirmPensionConfig(configId: string): Promise<PensionConfig> {
  const { data, error } = await supabase.rpc("confirm_pension_config", { p_config_id: configId });
  if (error) throw error;
  return dbToPensionConfig(data);
}

export async function markPensionPaymentPaid(paymentId: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("mark_pension_payment_paid", { p_payment_id: paymentId });
  if (error) throw error;
  return dbToPensionPayment(data);
}

export async function confirmPensionPayment(paymentId: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("confirm_pension_payment", { p_payment_id: paymentId });
  if (error) throw error;
  return dbToPensionPayment(data);
}

export async function contestPensionPayment(paymentId: string, note: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("contest_pension_payment", { p_payment_id: paymentId, p_note: note });
  if (error) throw error;
  return dbToPensionPayment(data);
}
```

- [ ] **Step 2: Write `usePension.ts`**

```typescript
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  type PensionConfig,
  type PensionPayment,
  dbToPensionConfig,
  dbToPensionPayment,
  listPensionConfigs,
  listPensionPayments,
  proposePensionConfig as proposePensionConfigApi,
  confirmPensionConfig as confirmPensionConfigApi,
  markPensionPaymentPaid as markPensionPaymentPaidApi,
  confirmPensionPayment as confirmPensionPaymentApi,
  contestPensionPayment as contestPensionPaymentApi,
} from "../services/supabase/pensionService";

/**
 * Configuration + versements de pension alimentaire. Entièrement séparé du
 * solde des dépenses partagées (useExpenses) — jamais mélangé.
 */
export function usePension(familyId: string | null) {
  const [configs, setConfigs] = useState<PensionConfig[]>([]);
  const [payments, setPayments] = useState<PensionPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!familyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [cfgs, pmts] = await Promise.all([
        listPensionConfigs(familyId),
        listPensionPayments(familyId),
      ]);
      setConfigs(cfgs);
      setPayments(pmts);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Erreur de chargement de la pension");
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!familyId) return;

    const cfgChannel = supabase
      .channel(`pension_configs_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pension_configs", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const incoming = dbToPensionConfig(payload.new);
            setConfigs((prev) => (prev.some((c) => c.id === incoming.id) ? prev : [incoming, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const updated = dbToPensionConfig(payload.new);
            setConfigs((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
          } else if (payload.eventType === "DELETE") {
            setConfigs((prev) => prev.filter((c) => c.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    const pmtChannel = supabase
      .channel(`pension_payments_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pension_payments", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const incoming = dbToPensionPayment(payload.new);
            setPayments((prev) => (prev.some((p) => p.id === incoming.id) ? prev : [incoming, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const updated = dbToPensionPayment(payload.new);
            setPayments((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          } else if (payload.eventType === "DELETE") {
            setPayments((prev) => prev.filter((p) => p.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(cfgChannel);
      supabase.removeChannel(pmtChannel);
    };
  }, [familyId]);

  /** Propose une nouvelle configuration (statut "proposed"). */
  const proposePensionConfig = useCallback(async (params: Parameters<typeof proposePensionConfigApi>[0]) => {
    const created = await proposePensionConfigApi(params);
    setConfigs((prev) => [created, ...prev]);
    return created;
  }, []);

  /** Confirme une configuration proposée par l'AUTRE parent — non optimiste
   * (peut aussi clôturer une autre config active en une seule transaction
   * serveur), on relit simplement l'état après. */
  const confirmPensionConfig = useCallback(async (configId: string) => {
    await confirmPensionConfigApi(configId);
    await refresh();
  }, [refresh]);

  const markPensionPaymentPaid = useCallback(async (paymentId: string) => {
    setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: "marked_paid" as const } : p)));
    try {
      await markPensionPaymentPaidApi(paymentId);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  const confirmPensionPayment = useCallback(async (paymentId: string) => {
    setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: "confirmed" as const } : p)));
    try {
      await confirmPensionPaymentApi(paymentId);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  const contestPensionPayment = useCallback(async (paymentId: string, note: string) => {
    setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: "contested" as const, note } : p)));
    try {
      await contestPensionPaymentApi(paymentId, note);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  return {
    pensionConfigs: configs,
    pensionPayments: payments,
    pensionLoading: loading,
    pensionError: error,
    proposePensionConfig,
    confirmPensionConfig,
    markPensionPaymentPaid,
    confirmPensionPayment,
    contestPensionPayment,
  };
}
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: build succeeds (no TypeScript/import errors). No automated test possible here — both files call live Supabase RPCs/realtime channels, exercised live in Task 5's manual verification.

- [ ] **Step 4: Commit**

```bash
git add src/services/supabase/pensionService.ts src/hooks/usePension.ts
git commit -m "Add pensionService and usePension hook"
```

---

### Task 4: Edge Function `send-pension-reminders`

**Files:**
- Create: `supabase/functions/send-pension-reminders/index.ts`
- Create: `supabase/functions/send-pension-reminders/_shared/push.ts`

**Interfaces:**
- Consumes: `pension_payments`/`pension_configs` tables (Task 1), the existing `push_subscriptions` table (already in prod, used by `notify-expense` et al.).
- Produces: an HTTP endpoint invoked daily by `pg_cron`+`pg_net` (wired in Task 6, manual dashboard step) — no client-facing interface, nothing else in this plan calls it directly.

- [ ] **Step 1: Copy the shared push helper**

This is a byte-for-byte copy of the existing `supabase/functions/notify-expense/_shared/push.ts` (already duplicated per-function in this project — Edge Functions are deployed by pasting into the dashboard, not via shared imports, so this duplication matches established convention, not a new pattern):

```typescript
// supabase/functions/_shared/push.ts
// ─────────────────────────────────────────────────────────────────────────────
// Envoi de notifications Web Push, partagé par toutes les fonctions
// déclenchées par un Database Webhook (notify-expense, notify-message,
// notify-vault, notify-join-request) — copié ici pour send-pension-reminders.
// ─────────────────────────────────────────────────────────────────────────────

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT     = Deno.env.get("VAPID_SUBJECT")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url?: string;
}

/**
 * Envoie `payload` à tous les abonnements push d'un utilisateur (un par
 * appareil). Supprime automatiquement les abonnements qui répondent 404/410
 * (désinstallés côté navigateur). Un échec sur un appareil n'empêche jamais
 * l'envoi aux autres.
 */
export async function sendPushToUser(admin: any, userId: string, payload: PushPayload): Promise<void> {
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .eq("user_id", userId);

  if (error) {
    console.warn(`push: échec lecture des abonnements de ${userId}`, error);
    return;
  }
  if (!subs?.length) return;

  await Promise.all(subs.map(async (sub: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        JSON.stringify(payload)
      );
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        try {
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        } catch (deleteErr) {
          console.warn(`push: échec suppression abonnement mort ${sub.id}`, deleteErr);
        }
      } else {
        console.warn(`push: échec envoi vers ${userId} (sub ${sub.id})`, e?.statusCode ?? e);
      }
    }
  }));
}
```

- [ ] **Step 2: Write the function**

```typescript
// send-pension-reminders/index.ts
//
// Invoquée quotidiennement par pg_cron (via pg_net, voir Task 6 pour le SQL
// de configuration côté dashboard) — jamais appelée par un client. Vérifie un
// secret partagé (CRON_SECRET) plutôt que le JWT d'un utilisateur.
//
// Deux choses par exécution :
// 1. Rappel au parent payeur, 2-3 jours avant l'échéance d'un versement
//    "pending" (une seule fois, voir payer_reminder_sent_at).
// 2. Alerte au parent bénéficiaire si l'échéance est dépassée et toujours
//    "pending" (une seule fois, voir overdue_alert_sent_at) — jamais si déjà
//    marqué "marked_paid" (le payeur a déjà agi, ce n'est plus "en retard"
//    dans ce sens).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUser } from "./_shared/push.ts";

const CRON_SECRET      = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
                      || Deno.env.get("SUPABASE_SECRET_KEYS")!;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const today = isoDate(new Date());

  const winStart = new Date(); winStart.setDate(winStart.getDate() + 2);
  const winEnd   = new Date(); winEnd.setDate(winEnd.getDate() + 3);

  let reminded = 0;
  let alerted  = 0;

  // ── Rappel au payeur ───────────────────────────────────────────────────
  const { data: dueSoon, error: dueSoonErr } = await supabase
    .from("pension_payments")
    .select("id, due_date, amount, pension_configs!inner(from_user_id)")
    .eq("status", "pending")
    .is("payer_reminder_sent_at", null)
    .gte("due_date", isoDate(winStart))
    .lte("due_date", isoDate(winEnd));

  if (dueSoonErr) {
    console.error("dueSoon query error:", dueSoonErr);
  } else {
    for (const payment of dueSoon ?? []) {
      const fromUserId = (payment as any).pension_configs?.from_user_id;
      if (!fromUserId) continue;
      await sendPushToUser(supabase, fromUserId, {
        title: "Duvia",
        body: `📅 Rappel : versement de pension de ${payment.amount}€ à faire le ${payment.due_date}`,
        tag: "pension-reminder",
        url: "/",
      });
      await supabase
        .from("pension_payments")
        .update({ payer_reminder_sent_at: new Date().toISOString() })
        .eq("id", payment.id);
      reminded++;
    }
  }

  // ── Alerte au bénéficiaire (échéance dépassée, toujours "pending") ────────
  const { data: overdue, error: overdueErr } = await supabase
    .from("pension_payments")
    .select("id, due_date, amount, pension_configs!inner(to_user_id)")
    .eq("status", "pending")
    .is("overdue_alert_sent_at", null)
    .lt("due_date", today);

  if (overdueErr) {
    console.error("overdue query error:", overdueErr);
  } else {
    for (const payment of overdue ?? []) {
      const toUserId = (payment as any).pension_configs?.to_user_id;
      if (!toUserId) continue;
      await sendPushToUser(supabase, toUserId, {
        title: "Duvia",
        body: `⚠️ Le versement de pension de ${payment.amount}€ du ${payment.due_date} n'a pas encore été marqué payé`,
        tag: "pension-overdue",
        url: "/",
      });
      await supabase
        .from("pension_payments")
        .update({ overdue_alert_sent_at: new Date().toISOString() })
        .eq("id", payment.id);
      alerted++;
    }
  }

  return new Response(JSON.stringify({ ok: true, reminded, alerted }), {
    headers: { "content-type": "application/json" },
  });
});
```

- [ ] **Step 3: Verify no syntax errors**

No automated test possible (live Supabase/push dependency) — verify with `deno check supabase/functions/send-pension-reminders/index.ts` if Deno is installed locally; otherwise this is verified at deploy time (Task 6) and via the live checklist there.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-pension-reminders/
git commit -m "Add send-pension-reminders Edge Function"
```

---

### Task 5: UI — "Pension alimentaire" section in the Expenses tab

**Files:**
- Modify: `src/App.jsx` (3 separate edits, exact anchors below)

**Interfaces:**
- Consumes: `usePension` (Task 3) — exact field names `pensionConfigs, pensionPayments, pensionLoading, proposePensionConfig, confirmPensionConfig, markPensionPaymentPaid, confirmPensionPayment, contestPensionPayment`; `nextPensionDueDate` (Task 2) from `./utils/core.js`.
- Produces: new component `PensionSection` (no props — reads everything from `useApp()`), mounted once inside `ExpTab`.

- [ ] **Step 1: Wire `usePension` into `App()`'s state**

Find this exact block (currently ends the `useExpenses` destructure):

```jsx
    confirmReim: dbConfirmReim, rejectReim: dbRejectReim,
  } = useExpenses(familySync.familyId);
  const { history: historyData, addHistEntry } = useHistory(familySync.familyId);
```

Replace with (adds the `usePension` call right after):

```jsx
    confirmReim: dbConfirmReim, rejectReim: dbRejectReim,
  } = useExpenses(familySync.familyId);
  const {
    pensionConfigs, pensionPayments, pensionLoading,
    proposePensionConfig, confirmPensionConfig,
    markPensionPaymentPaid, confirmPensionPayment, contestPensionPayment,
  } = usePension(familySync.familyId);
  const { history: historyData, addHistEntry } = useHistory(familySync.familyId);
```

Find this exact line near the top of `App.jsx` (line 20):

```jsx
import { useExpenses } from "./hooks/useExpenses";
```

Add this line immediately after it:

```jsx
import { usePension } from "./hooks/usePension";
```

- [ ] **Step 2: Expose it through `ctxValue`**

Find this exact block:

```jsx
    expenses: allExpenses,
    reimbursements: allReimbursements,
    expensesLoading,
    history: historyData,
```

Replace with:

```jsx
    expenses: allExpenses,
    reimbursements: allReimbursements,
    expensesLoading,
    // ── Pension alimentaire (séparée du solde des dépenses partagées) ───────
    pensionConfigs,
    pensionPayments,
    pensionLoading,
    pensionMethods: {
      proposePensionConfig, confirmPensionConfig,
      markPensionPaymentPaid, confirmPensionPayment, contestPensionPayment,
    },
    history: historyData,
```

- [ ] **Step 3: Write the `PensionSection` component**

Insert this new function immediately before `function ExpTab() {` (search for that exact string — `PensionSection` must be defined above its use):

```jsx
function PensionSection() {
  const { C, t, cfg, user, myUid, familySync, currency = "€",
          pensionConfigs, pensionPayments, pensionLoading, pensionMethods } = useApp();
  const {
    proposePensionConfig, confirmPensionConfig,
    markPensionPaymentPaid, confirmPensionPayment, contestPensionPayment,
  } = pensionMethods;

  const myIdx = user?.role === "parent" && user?.parentIdx !== undefined ? user.parentIdx : 0;

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ payerIdx: myIdx, amount: "", dayOfMonth: "5", startDate: toStr(new Date()) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [contestingId, setContestingId] = useState(null);
  const [contestNote, setContestNote] = useState("");

  if (cfg.parents.length < 2) return null;

  const activeConfig = pensionConfigs.find((c) => c.status === "active");
  const proposedConfig = pensionConfigs.find((c) => c.status === "proposed");
  const iAmProposer = proposedConfig && myUid === proposedConfig.createdByUserId;
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const currentPayment = activeConfig ? pensionPayments.find((p) => p.configId === activeConfig.id && p.period === currentPeriod) : null;
  const pastPayments = activeConfig ? pensionPayments.filter((p) => p.configId === activeConfig.id && p.period !== currentPeriod) : [];

  async function submitProposal() {
    const amount = Number(form.amount);
    const dayOfMonth = Number(form.dayOfMonth);
    if (!amount || amount <= 0) { setErr(t.pensionErrAmount || "Montant invalide"); return; }
    if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 28) { setErr(t.pensionErrDay || "Jour du mois invalide (1-28)"); return; }
    setBusy(true); setErr("");
    try {
      const payerIdx = Number(form.payerIdx);
      const recipientIdx = payerIdx === 0 ? 1 : 0;
      await proposePensionConfig({
        familyId: familySync.familyId,
        fromParent: payerIdx,
        fromUserId: cfg.parents[payerIdx]?.userId,
        toParent: recipientIdx,
        toUserId: cfg.parents[recipientIdx]?.userId,
        amount,
        dayOfMonth,
        startDate: form.startDate,
      });
      setShowForm(false);
    } catch (e) {
      setErr(t.pensionErrGeneric || "Une erreur est survenue.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmConfig() {
    setBusy(true); setErr("");
    try {
      await confirmPensionConfig(proposedConfig.id);
    } catch (e) {
      setErr(t.pensionErrGeneric || "Une erreur est survenue.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkPaid(paymentId) {
    setBusy(true);
    try { await markPensionPaymentPaid(paymentId); }
    catch (e) { setErr(t.pensionErrGeneric || "Une erreur est survenue."); }
    finally { setBusy(false); }
  }

  async function handleConfirmPayment(paymentId) {
    setBusy(true);
    try { await confirmPensionPayment(paymentId); }
    catch (e) { setErr(t.pensionErrGeneric || "Une erreur est survenue."); }
    finally { setBusy(false); }
  }

  async function handleContestSubmit() {
    setBusy(true);
    try {
      await contestPensionPayment(contestingId, contestNote);
      setContestingId(null);
      setContestNote("");
    } catch (e) {
      setErr(t.pensionErrGeneric || "Une erreur est survenue.");
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = {
    pending: t.pensionStatusPending || "En attente",
    marked_paid: t.pensionStatusMarkedPaid || "Marqué payé — en attente de confirmation",
    confirmed: t.pensionStatusConfirmed || "Confirmé",
    contested: t.pensionStatusContested || "Contesté",
  };
  const statusColor = { pending: C.mut, marked_paid: C.yel, confirmed: C.grn, contested: C.red };

  return (
    <div className="card" style={{padding:14,marginBottom:14,border:`1.5px solid ${C.vio}33`}}>
      <div style={{fontSize:13,fontWeight:900,color:C.vio,marginBottom:10}}>💶 {t.pensionTabTitle || "Pension alimentaire"}</div>

      {err && <div style={{fontSize:11,color:C.red,marginBottom:8}}>{err}</div>}

      {!activeConfig && !proposedConfig && !showForm && (
        <button onClick={() => setShowForm(true)} style={{padding:"8px 14px",background:C.vio,color:"#fff",border:"none",borderRadius:10,fontWeight:700,fontSize:12,cursor:"pointer"}}>
          {t.pensionConfigureBtn || "Configurer la pension"}
        </button>
      )}

      {showForm && (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <label style={{fontSize:11,color:C.mut,fontWeight:700}}>{t.pensionFormPayerLabel || "Qui paie la pension ?"}</label>
          <select value={form.payerIdx} onChange={(e) => setForm((f) => ({...f, payerIdx: e.target.value}))} style={{height:38,borderRadius:8,border:`1px solid ${C.bor}`,padding:"0 8px"}}>
            {cfg.parents.map((p, i) => <option key={i} value={i}>{p.name || `P${i+1}`}</option>)}
          </select>
          <label style={{fontSize:11,color:C.mut,fontWeight:700}}>{t.pensionFormAmountLabel || "Montant mensuel"}</label>
          <input type="number" value={form.amount} onChange={(e) => setForm((f) => ({...f, amount: e.target.value}))} style={{height:38,borderRadius:8,border:`1px solid ${C.bor}`,padding:"0 10px"}} />
          <label style={{fontSize:11,color:C.mut,fontWeight:700}}>{t.pensionFormDayLabel || "Jour d'échéance dans le mois (1-28)"}</label>
          <input type="number" min={1} max={28} value={form.dayOfMonth} onChange={(e) => setForm((f) => ({...f, dayOfMonth: e.target.value}))} style={{height:38,borderRadius:8,border:`1px solid ${C.bor}`,padding:"0 10px"}} />
          <label style={{fontSize:11,color:C.mut,fontWeight:700}}>{t.pensionFormStartLabel || "Date de début"}</label>
          <input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({...f, startDate: e.target.value}))} style={{height:38,borderRadius:8,border:`1px solid ${C.bor}`,padding:"0 10px"}} />
          {form.amount && form.dayOfMonth && Number(form.dayOfMonth) >= 1 && Number(form.dayOfMonth) <= 28 && (
            <div style={{fontSize:11,color:C.mut,fontStyle:"italic"}}>
              {t.pensionNextDuePreview || "Prochaine échéance"} : {nextPensionDueDate(Number(form.dayOfMonth))}
            </div>
          )}
          <div style={{display:"flex",gap:8}}>
            <button onClick={submitProposal} disabled={busy} style={{flex:1,height:38,background:C.vio,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",opacity:busy?.6:1}}>
              {t.pensionFormSubmitBtn || "Proposer"}
            </button>
            <button onClick={() => setShowForm(false)} disabled={busy} style={{flex:1,height:38,background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
              {t.pensionFormCancelBtn || "Annuler"}
            </button>
          </div>
        </div>
      )}

      {proposedConfig && !iAmProposer && (
        <div style={{padding:"10px 12px",background:`${C.vio}10`,border:`1.5px solid ${C.vio}44`,borderRadius:10}}>
          <div style={{fontSize:12,color:C.txt,marginBottom:8}}>
            {(t.pensionProposedBanner || "{name} propose une pension de {amount}{currency}/mois, versée le {day} de chaque mois, à partir du {date}.")
              .replace("{name}", cfg.parents[proposedConfig.fromParent]?.name || "")
              .replace("{amount}", proposedConfig.amount)
              .replace("{currency}", currency)
              .replace("{day}", proposedConfig.dayOfMonth)
              .replace("{date}", proposedConfig.startDate)}
          </div>
          <button onClick={handleConfirmConfig} disabled={busy} style={{padding:"7px 14px",background:C.grn,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",marginRight:8}}>
            {t.pensionConfirmBtn || "Confirmer"}
          </button>
        </div>
      )}
      {proposedConfig && iAmProposer && (
        <div style={{fontSize:12,color:C.mut,fontStyle:"italic"}}>
          {t.pensionAwaitingOtherParent || "En attente de confirmation par l'autre parent."}
        </div>
      )}

      {activeConfig && (
        <>
          <div style={{fontSize:11,color:C.mut,marginBottom:8}}>
            {(cfg.parents[activeConfig.fromParent]?.name || "P1")} → {(cfg.parents[activeConfig.toParent]?.name || "P2")} · {activeConfig.amount}{currency}/mois · {t.pensionDayOfMonthShort || "le"} {activeConfig.dayOfMonth}
          </div>

          {currentPayment && (
            <div style={{padding:"10px 12px",background:C.sur,borderRadius:10,marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:13,fontWeight:800,color:C.txt}}>{t.pensionCurrentDue || "Échéance du mois"} — {currentPayment.dueDate}</div>
                  <div style={{fontSize:11,fontWeight:700,color:statusColor[currentPayment.status]}}>{statusLabel[currentPayment.status]}</div>
                </div>
                <div style={{fontSize:16,fontWeight:900,color:C.vio}}>{currentPayment.amount}{currency}</div>
              </div>
              {currentPayment.status === "pending" && myUid === activeConfig.fromUserId && (
                <button onClick={() => handleMarkPaid(currentPayment.id)} disabled={busy} style={{marginTop:8,padding:"7px 14px",background:C.vio,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                  {t.pensionMarkPaidBtn || "Marquer payé"}
                </button>
              )}
              {currentPayment.status === "marked_paid" && myUid === activeConfig.toUserId && contestingId !== currentPayment.id && (
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  <button onClick={() => handleConfirmPayment(currentPayment.id)} disabled={busy} style={{flex:1,height:36,background:C.grn,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                    {t.pensionConfirmPaymentBtn || "Confirmer"}
                  </button>
                  <button onClick={() => setContestingId(currentPayment.id)} disabled={busy} style={{flex:1,height:36,background:C.sur,color:C.red,border:`1px solid ${C.red}44`,borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                    {t.pensionContestBtn || "Contester"}
                  </button>
                </div>
              )}
              {contestingId === currentPayment.id && (
                <div style={{marginTop:8}}>
                  <textarea value={contestNote} onChange={(e) => setContestNote(e.target.value)} placeholder={t.pensionContestNotePlaceholder || "Pourquoi contestes-tu ce versement ?"} style={{width:"100%",minHeight:60,borderRadius:8,border:`1px solid ${C.bor}`,padding:8,fontSize:12}} />
                  <button onClick={handleContestSubmit} disabled={busy} style={{marginTop:6,padding:"7px 14px",background:C.red,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                    {t.pensionContestSubmitBtn || "Envoyer la contestation"}
                  </button>
                </div>
              )}
              {currentPayment.status === "contested" && currentPayment.note && (
                <div style={{marginTop:8,fontSize:11,color:C.red,fontStyle:"italic"}}>{currentPayment.note}</div>
              )}
            </div>
          )}

          {pastPayments.length > 0 && (
            <div style={{marginTop:8}}>
              <div style={{fontSize:11,fontWeight:800,color:C.mut,marginBottom:6}}>{t.pensionHistoryTitle || "Historique"}</div>
              {pastPayments.map((p) => (
                <div key={p.id} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${C.bor}`,fontSize:12}}>
                  <span>{p.dueDate}</span>
                  <span style={{color:statusColor[p.status]}}>{statusLabel[p.status]}</span>
                  <span>{p.amount}{currency}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!pensionLoading && !activeConfig && !proposedConfig && !showForm && (
        <div style={{fontSize:12,color:C.mut,marginTop:8}}>{t.pensionNoConfig || "Aucune pension configurée pour l'instant."}</div>
      )}
    </div>
  );
}

```

- [ ] **Step 4: Add the `nextPensionDueDate` import**

`App.jsx` does not import anything from `./utils/core.js` yet (confirmed: no match for `from "./utils/core.js"` anywhere in the file — `core.js` is currently only consumed by its own test file). Find this exact line (line 25):

```jsx
import { APP_URL, LIMITS, RGPD_NOTICE_VERSION, APP_VERSION } from './config.js';
```

Add this new line immediately after it:

```jsx
import { nextPensionDueDate } from './utils/core.js';
```

- [ ] **Step 5: Mount `PensionSection` inside `ExpTab`**

Find this exact closing pattern (the end of the "Who owes whom" IIFE, immediately followed by the add-expense/add-reimbursement button row):

```jsx
            })()}
          </div>
        );
      })()}
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={()=>{if(showAdd&&!editId){cancelForm();setShowReim(false);}else if(!showAdd){setShowAdd(true);setShowReim(false);}else{cancelForm();setShowReim(false);}}}
```

Replace with (inserts `<PensionSection />` between the two):

```jsx
            })()}
          </div>
        );
      })()}
      <PensionSection />
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={()=>{if(showAdd&&!editId){cancelForm();setShowReim(false);}else if(!showAdd){setShowAdd(true);setShowReim(false);}else{cancelForm();setShowReim(false);}}}
```

- [ ] **Step 6: Verify it builds**

Run: `npm run build`
Expected: build succeeds. No automated test possible (React UI, no component tests in this repo, confirmed established convention) — covered by the manual checklist in Task 7.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "Add PensionSection UI to the Expenses tab"
```

---

### Task 6: i18n keys (5 languages)

**Files:**
- Modify: `src/i18n/fr.js`
- Modify: `src/i18n/en.js`
- Modify: `src/i18n/de.js`
- Modify: `src/i18n/es.js`
- Modify: `src/i18n/pt.js`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces: the 22 `t.pension*` keys read by Task 5's `PensionSection` (all already have inline `||"fallback"` French text, but this repo's convention is proactive translation into all 5 languages, not relying on fallbacks).

- [ ] **Step 1: Add the keys to each file**

In each of the 5 files, add this block anywhere inside the exported translation object (matching the existing style of neighboring entries, e.g. right after the `aiRephraseBtn`/`aiRephraseSuggestionLabel` keys added earlier this session):

`src/i18n/fr.js`:
```js
    pensionTabTitle: "Pension alimentaire",
    pensionConfigureBtn: "Configurer la pension",
    pensionFormPayerLabel: "Qui paie la pension ?",
    pensionFormAmountLabel: "Montant mensuel",
    pensionFormDayLabel: "Jour d'échéance dans le mois (1-28)",
    pensionFormStartLabel: "Date de début",
    pensionFormSubmitBtn: "Proposer",
    pensionFormCancelBtn: "Annuler",
    pensionErrAmount: "Montant invalide",
    pensionErrDay: "Jour du mois invalide (1-28)",
    pensionErrGeneric: "Une erreur est survenue.",
    pensionProposedBanner: "{name} propose une pension de {amount}{currency}/mois, versée le {day} de chaque mois, à partir du {date}.",
    pensionAwaitingOtherParent: "En attente de confirmation par l'autre parent.",
    pensionConfirmBtn: "Confirmer",
    pensionCurrentDue: "Échéance du mois",
    pensionDayOfMonthShort: "le",
    pensionStatusPending: "En attente",
    pensionStatusMarkedPaid: "Marqué payé — en attente de confirmation",
    pensionStatusConfirmed: "Confirmé",
    pensionStatusContested: "Contesté",
    pensionMarkPaidBtn: "Marquer payé",
    pensionConfirmPaymentBtn: "Confirmer",
    pensionContestBtn: "Contester",
    pensionContestNotePlaceholder: "Pourquoi contestes-tu ce versement ?",
    pensionContestSubmitBtn: "Envoyer la contestation",
    pensionHistoryTitle: "Historique",
    pensionNextDuePreview: "Prochaine échéance",
    pensionNoConfig: "Aucune pension configurée pour l'instant.",
```

`src/i18n/en.js`:
```js
    pensionTabTitle: "Child support",
    pensionConfigureBtn: "Set up child support",
    pensionFormPayerLabel: "Who pays the child support?",
    pensionFormAmountLabel: "Monthly amount",
    pensionFormDayLabel: "Due day of the month (1-28)",
    pensionFormStartLabel: "Start date",
    pensionFormSubmitBtn: "Propose",
    pensionFormCancelBtn: "Cancel",
    pensionErrAmount: "Invalid amount",
    pensionErrDay: "Invalid day of month (1-28)",
    pensionErrGeneric: "Something went wrong.",
    pensionProposedBanner: "{name} is proposing a child support payment of {amount}{currency}/month, paid on day {day} of each month, starting {date}.",
    pensionAwaitingOtherParent: "Waiting for the other parent to confirm.",
    pensionConfirmBtn: "Confirm",
    pensionCurrentDue: "This month's payment",
    pensionDayOfMonthShort: "on the",
    pensionStatusPending: "Pending",
    pensionStatusMarkedPaid: "Marked paid — awaiting confirmation",
    pensionStatusConfirmed: "Confirmed",
    pensionStatusContested: "Contested",
    pensionMarkPaidBtn: "Mark paid",
    pensionConfirmPaymentBtn: "Confirm",
    pensionContestBtn: "Contest",
    pensionContestNotePlaceholder: "Why are you contesting this payment?",
    pensionContestSubmitBtn: "Submit contest",
    pensionHistoryTitle: "History",
    pensionNextDuePreview: "Next due date",
    pensionNoConfig: "No child support set up yet.",
```

`src/i18n/de.js`:
```js
    pensionTabTitle: "Unterhalt",
    pensionConfigureBtn: "Unterhalt einrichten",
    pensionFormPayerLabel: "Wer zahlt den Unterhalt?",
    pensionFormAmountLabel: "Monatlicher Betrag",
    pensionFormDayLabel: "Fälligkeitstag im Monat (1-28)",
    pensionFormStartLabel: "Startdatum",
    pensionFormSubmitBtn: "Vorschlagen",
    pensionFormCancelBtn: "Abbrechen",
    pensionErrAmount: "Ungültiger Betrag",
    pensionErrDay: "Ungültiger Tag im Monat (1-28)",
    pensionErrGeneric: "Ein Fehler ist aufgetreten.",
    pensionProposedBanner: "{name} schlägt einen Unterhalt von {amount}{currency}/Monat vor, zahlbar am {day}. jeden Monats, ab dem {date}.",
    pensionAwaitingOtherParent: "Warten auf Bestätigung durch den anderen Elternteil.",
    pensionConfirmBtn: "Bestätigen",
    pensionCurrentDue: "Fälligkeit diesen Monat",
    pensionDayOfMonthShort: "am",
    pensionStatusPending: "Ausstehend",
    pensionStatusMarkedPaid: "Als bezahlt markiert — wartet auf Bestätigung",
    pensionStatusConfirmed: "Bestätigt",
    pensionStatusContested: "Angefochten",
    pensionMarkPaidBtn: "Als bezahlt markieren",
    pensionConfirmPaymentBtn: "Bestätigen",
    pensionContestBtn: "Anfechten",
    pensionContestNotePlaceholder: "Warum fechtest du diese Zahlung an?",
    pensionContestSubmitBtn: "Einspruch senden",
    pensionHistoryTitle: "Verlauf",
    pensionNextDuePreview: "Nächste Fälligkeit",
    pensionNoConfig: "Noch kein Unterhalt eingerichtet.",
```

`src/i18n/es.js`:
```js
    pensionTabTitle: "Pensión alimenticia",
    pensionConfigureBtn: "Configurar la pensión",
    pensionFormPayerLabel: "¿Quién paga la pensión?",
    pensionFormAmountLabel: "Importe mensual",
    pensionFormDayLabel: "Día de vencimiento del mes (1-28)",
    pensionFormStartLabel: "Fecha de inicio",
    pensionFormSubmitBtn: "Proponer",
    pensionFormCancelBtn: "Cancelar",
    pensionErrAmount: "Importe no válido",
    pensionErrDay: "Día del mes no válido (1-28)",
    pensionErrGeneric: "Se ha producido un error.",
    pensionProposedBanner: "{name} propone una pensión de {amount}{currency}/mes, pagada el día {day} de cada mes, a partir del {date}.",
    pensionAwaitingOtherParent: "Esperando la confirmación del otro progenitor.",
    pensionConfirmBtn: "Confirmar",
    pensionCurrentDue: "Pago de este mes",
    pensionDayOfMonthShort: "el",
    pensionStatusPending: "Pendiente",
    pensionStatusMarkedPaid: "Marcado como pagado — pendiente de confirmación",
    pensionStatusConfirmed: "Confirmado",
    pensionStatusContested: "Impugnado",
    pensionMarkPaidBtn: "Marcar como pagado",
    pensionConfirmPaymentBtn: "Confirmar",
    pensionContestBtn: "Impugnar",
    pensionContestNotePlaceholder: "¿Por qué impugnas este pago?",
    pensionContestSubmitBtn: "Enviar impugnación",
    pensionHistoryTitle: "Historial",
    pensionNextDuePreview: "Próximo vencimiento",
    pensionNoConfig: "Todavía no hay ninguna pensión configurada.",
```

`src/i18n/pt.js`:
```js
    pensionTabTitle: "Pensão de alimentos",
    pensionConfigureBtn: "Configurar a pensão",
    pensionFormPayerLabel: "Quem paga a pensão?",
    pensionFormAmountLabel: "Valor mensal",
    pensionFormDayLabel: "Dia de vencimento no mês (1-28)",
    pensionFormStartLabel: "Data de início",
    pensionFormSubmitBtn: "Propor",
    pensionFormCancelBtn: "Cancelar",
    pensionErrAmount: "Valor inválido",
    pensionErrDay: "Dia do mês inválido (1-28)",
    pensionErrGeneric: "Ocorreu um erro.",
    pensionProposedBanner: "{name} propõe uma pensão de {amount}{currency}/mês, paga no dia {day} de cada mês, a partir de {date}.",
    pensionAwaitingOtherParent: "A aguardar confirmação do outro progenitor.",
    pensionConfirmBtn: "Confirmar",
    pensionCurrentDue: "Vencimento deste mês",
    pensionDayOfMonthShort: "no dia",
    pensionStatusPending: "Pendente",
    pensionStatusMarkedPaid: "Marcado como pago — a aguardar confirmação",
    pensionStatusConfirmed: "Confirmado",
    pensionStatusContested: "Contestado",
    pensionMarkPaidBtn: "Marcar como pago",
    pensionConfirmPaymentBtn: "Confirmar",
    pensionContestBtn: "Contestar",
    pensionContestNotePlaceholder: "Porque estás a contestar este pagamento?",
    pensionContestSubmitBtn: "Enviar contestação",
    pensionHistoryTitle: "Histórico",
    pensionNextDuePreview: "Próximo vencimento",
    pensionNoConfig: "Ainda não há nenhuma pensão configurada.",
```

- [ ] **Step 2: Run the test suite**

Run: `TZ=Europe/Paris npm test`
Expected: all tests still pass (i18n files aren't covered by any test, but this catches an accidental syntax error from the edit).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Add pension alimentaire i18n keys (5 languages)"
```

---

### Task 7: Version bump + deployment instructions

**Files:**
- Modify: `src/config.js`
- Modify: `public/sw.js`

**Interfaces:**
- Consumes: nothing (final task).
- Produces: nothing consumed elsewhere — this is the plan's last task.

- [ ] **Step 1: Bump both version constants**

In `src/config.js`, increment `APP_VERSION` by 0.01 from its current value.
In `public/sw.js`, increment `SW_VERSION` to the exact same new value.

- [ ] **Step 2: Run the full verification**

```bash
TZ=Europe/Paris npm test
npm run build
```
Expected: 140+5 = 145 tests passing (the 5 new `nextPensionDueDate` tests from Task 2, plus every pre-existing test), clean build.

- [ ] **Step 3: Commit**

```bash
git add src/config.js public/sw.js
git commit -m "Bump version for pension alimentaire tracking"
```

- [ ] **Step 4: Print deployment instructions for the user**

This feature needs 4 manual steps against the Supabase dashboard, in this exact order (per this project's established convention: full file contents pasted, exact location named, every time):

1. **Run migration `0046_pension_tracking.sql`** (Task 1's file) in the SQL Editor.
2. **Create and deploy the Edge Function `send-pension-reminders`** (Task 4's `index.ts` + its own `_shared/push.ts`) — paste both files into a new Edge Function in the dashboard.
3. **Add a new secret `CRON_SECRET`** (any random string, e.g. generated via `openssl rand -hex 32`) to the Edge Function's environment — reused to authenticate the cron-triggered call in step 4. The existing `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` secrets are already configured project-wide (reused, not new).
4. **Configure the two `pg_cron` jobs** (SQL Editor, one-time) — daily generation of the month's payments, and daily invocation of the reminder function via `pg_net`:

```sql
-- Génération mensuelle (minuit, tous les jours)
select cron.schedule(
  'pension-generate-due-payments',
  '0 0 * * *',
  $$ select public.generate_due_pension_payments(); $$
);

-- Rappels/alertes (tous les jours à 8h, après la génération)
select cron.schedule(
  'pension-send-reminders',
  '0 8 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-pension-reminders',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET_VALUE>', 'content-type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);
```

Replace `<PROJECT_REF>` with the project's actual Supabase ref and `<CRON_SECRET_VALUE>` with the exact value set in step 3.

## Self-Review Notes

- **Spec coverage**: every section of `2026-07-20-child-support-tracking-design.md` is covered — separate tables/no balance mixing (Task 1, Global Constraints), mutual config confirmation (Task 1's `confirm_pension_config`), monthly generation (Task 1's `generate_due_pension_payments`), reminders (Task 4), UI (Task 5), i18n (Task 6), deployment (Task 7).
- **Placeholder scan**: none found — every step has complete, runnable code.
- **Type consistency**: verified `PensionConfig`/`PensionPayment` field names match exactly between `pensionService.ts` (Task 3), `usePension.ts` (Task 3), and `PensionSection`'s usage (Task 5) — e.g. `fromUserId`/`toUserId`/`dayOfMonth`/`configId` used identically everywhere; RPC param names (`p_family_id`, `p_from_user_id`, etc.) match exactly between the migration (Task 1) and the service's `supabase.rpc(...)` calls (Task 3).
- **A note on RLS strictness**: this plan deliberately diverges from `expenses`/`reimbursements`' looser RLS convention (family-wide read/write, no per-row ownership check) — flagged explicitly to the user mid-planning when discovered, who chose the stricter model. Any future work touching this area should not "fix" it back to the loose convention without re-confirming that choice.
