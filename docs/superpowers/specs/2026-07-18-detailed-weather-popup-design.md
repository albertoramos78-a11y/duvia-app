# Detailed weather popup (morning/afternoon/evening) — Design

**Date:** 2026-07-18
**Status:** Approved by user ("go")

## Problem

`CalTab`'s weather strip (`src/App.jsx`, `fetchMyWeatherForecast` + the horizontal
day-card row) only shows one min/max temperature and one weather icon per day,
sourced from Open-Meteo's `daily` block. The user wants to see a breakdown by
time of day (morning/afternoon/evening) when clicking a day card, in a popup.

## Data

Open-Meteo's `/v1/forecast` endpoint supports an `hourly` parameter alongside
`daily` in the same request — no second API call needed. Extend the existing
URL in `fetchMyWeatherForecast` (`src/App.jsx:678`) to add:

```
&hourly=weathercode,temperature_2m,precipitation_probability
```

The response's `hourly.time` array gives one entry per hour, in the location's
local time (`timezone=auto`, already set). For each calendar day, take the 24
hourly entries belonging to that date and split them into three periods:

- **Matin**: hours 6–11
- **Après-midi**: hours 12–17
- **Soir**: hours 18–23

For each period, compute:
- **température**: average of `temperature_2m` across the period's hours, rounded
- **risque de pluie**: max of `precipitation_probability` across the period's hours
- **icône**: the `weathercode` at the hour with that max precipitation probability
  (ties broken by earliest hour) — ties the displayed icon to the period's worst
  moment, consistent with how Open-Meteo's own `daily.weathercode` already
  represents a "worst of the day" summary.

This aggregation (hourly arrays → `{morning, afternoon, evening}` objects) is
pure logic → lives in `src/utils/core.js` as a new exported function
(`aggregateHourlyPeriods` or similar), covered by a unit test in
`core.test.js`, per this repo's convention (CLAUDE.md: "New pure logic should
go here").

`fetchMyWeatherForecast`'s cached return value (`MY_WEATHER_CACHE`) gains one
new field per day entry: `periods: {morning, afternoon, evening}` (each
`{code, temp, rainChance}`), alongside the existing `date/code/tempMax/tempMin`.
No change to the cache key or lifetime.

## UI

The weather strip's day cards (`src/App.jsx:~12141-12155`) become clickable
(`onClick` added to the existing per-day `<div>`), opening a new state
(`weatherDetailDay`, holding the clicked day's data) which renders a popup when
non-null.

Popup follows the app's existing floating-modal convention (same shape as the
referral-bonus popups, `App.jsx:~14895`): a fixed full-screen overlay
(`rgba(23,16,58,.65)`, backdrop-blur) centering a `C.card` rounded panel. Content:

- Header: formatted date (e.g. "Samedi 18 juillet") + close button (✕)
- Three rows, one per period: label (Matin/Après-midi/Soir) + weather emoji
  (via the existing `weatherIconFor()` helper) + temperature + rain % chance
- Closes on: close button click, or clicking the overlay backdrop

No period detail is shown for a day if `periods` is missing (defensive; should
not happen within the 16-day Open-Meteo window, but avoids a crash if the API
ever omits hourly data for a given day).

## i18n

New keys (all 5 languages: fr/en/de/es/pt): period labels (Matin/Après-midi/Soir
and equivalents), popup title format (reuse existing date formatting, no new
key needed there), and nothing else user-facing changes.

## Out of scope (per user's explicit choice during brainstorm)

- No 7-day cap on the popup — available across the same 16-day window as the
  existing strip; forecast accuracy naturally degrades further out, same as
  any weather app, no special-cased "not available" message needed.
- No wind/humidity/other metrics — only temp + rain risk per period, per the
  user's chosen level of detail.
