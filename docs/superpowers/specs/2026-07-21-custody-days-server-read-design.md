# Lecture fiable de la garde côté serveur + calcul des jours de garde par le chatbot — design

**Date :** 2026-07-21
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

L'utilisateur veut que l'assistant IA (chatbot) puisse répondre à des questions sur le nombre de jours de garde par parent, sur une période donnée (fixe : "ce mois-ci", "cette année" — ou libre : "entre le 15 mars et le 10 avril"). Cette capacité avait été explicitement exclue du chatbot lors de son design initial (`docs/superpowers/specs/2026-07-20-ai-chatbot-assistant-design.md`, section Non-objectifs) : le planning de garde n'est pas interrogeable par une simple requête serveur — il est calculé **côté client** par `resolveGuard(ds, cfg, childId)` (`App.jsx:1091`), une fonction pure de ~100 lignes qui lit `cfg` (config famille complète : parents, motif de garde, dates spéciales, overrides, enfants) depuis le blob JSON `families.data`.

En creusant, il existe déjà 5 tables dédiées à la garde (`custody_rules`, `custody_pattern_days`, `custody_overrides`, `custody_special_dates`, `custody_custom_dates`), alimentées en écriture parallèle depuis longtemps ("Phase 3", voir `custodyService.ts`) mais jamais lues — l'affichage reste sur le JSON legacy. Ce document couvre la **Phase 4, étape 1 uniquement** : permettre au serveur de lire la garde de façon fiable (vérifiée) à partir de ces tables, pour servir un nouvel outil du chatbot — **sans** toucher à l'affichage du calendrier côté client (voir Non-objectifs). La bascule du calendrier lui-même (Phase 4, étape 2) est une décision séparée, prise plus tard, seulement si l'outil de vérification décrit ici revient à zéro désaccord sur les familles réelles.

## Contexte technique

- `resolveGuard(ds, cfg, childId)` (`App.jsx:1091-1196`) résout la garde d'un jour dans cet ordre : (1) override manuel (`cfg.overrides[ds]`), (2) Fête des Mères/Pères forcée si activée, (3) anniversaire d'un parent forcé si activé, (4) anniversaire d'un enfant (garde paire/impaire), (5) vacances scolaires (par enfant si configuré, sinon global), (6) motif par défaut (`weekAlt` / `exclusive` / `custom`, avec fallback `null` si aucun motif confirmé).
- La plupart des dépendances pures de `resolveGuard` sont **déjà extraites** dans `src/utils/core.js` lors de sessions précédentes : `sameDay`, `getMothersDayDate`, `getEventDate`, `nthWeekday`, `easterDate`. Il manque encore `getFathersDayDate` (dépend de `easterDate`/`getEventDate`, déjà présents) et `wkNum` (numéro de semaine ISO simplifié, `App.jsx:989`) — aucune n'est testée aujourd'hui, ni `resolveGuard` elle-même : un vrai trou de test préexistant, indépendant de cette fonctionnalité.
- Schéma réel des 5 tables (aucune n'existe dans une migration de ce repo — créées uniquement via le dashboard Supabase, confirmé par `information_schema.columns`, voir conversation) :
  - `custody_rules(id, family_id, child_id, type, start_month, start_year, week_alt_even_idx, exclusive_main_idx, exclusive_we_idx, exclusive_parity, confirmed, created_at, updated_at)` — équivalent de `cfg.custody`/`cfg.custodyPerChild[childId]` (hors le tableau `pattern`).
  - `custody_pattern_days(id, rule_id, day_index, parent_idx, time_type, start_time, end_time, location)` — équivalent du tableau `pattern` pour le motif `custom`.
  - `custody_overrides(id, family_id, child_id, override_date, parent_idx, obs_id, obs_name, time_type, source, holiday_name, start_time, end_time, location, note, created_by, created_at)` — couvre à la fois les overrides manuels (`source='manual'`) ET, à confirmer pendant le plan, les assignations de vacances scolaires (`source` + `holiday_name` suggèrent que oui) — plus simple/unifié que la structure JSON (`cfg.overrides` + `cfg.specialDates.schoolHolDetails` séparés).
  - `custody_special_dates(id, family_id, child_id, mother_day_enabled, father_day_enabled, parent_births jsonb, child_births jsonb, even_parent_idx, odd_parent_idx, updated_at)`.
  - `custody_custom_dates(id, family_id, label, day, month, year, yearly, parent_id, created_at)`.
- Ce qui **manque** dans ces 5 tables et reste à lire depuis `families.data` (aucune migration nécessaire, déjà accessible) : dates de naissance et genre des parents/enfants, pays de la famille (`cfg.country`), et le réglage `cfg.sameGuardAll`. L'outil existant `get_family_config` (`ai-chatbot/index.ts`) lit déjà `families.data` et en extrait une partie (enfants avec dates de naissance) — à étendre légèrement en interne (pas nécessairement dans sa réponse publique) pour ce nouvel usage.
- RLS des 5 tables de garde : inconnue à ce jour (pas de migration = pas de policy visible dans le repo). `custodyService.ts` écrit avec le client standard (clé anon + JWT utilisateur, pas service-role), ce qui implique une policy INSERT/UPDATE au moins — la policy SELECT doit être confirmée pendant le plan (requête `information_schema` ou test direct). Si SELECT manque pour les autres membres de la famille, il faudra soit l'ajouter (migration RLS, cohérent avec le reste du projet), soit lire ces tables avec le client service-role comme exception documentée (même modèle que `get_weather`/`parent_locations`) — décision à trancher avec les faits en main pendant le plan, pas ici par supposition.

## Approche retenue

### Lecture hybride côté serveur — deux implémentations, pas une

La vérification de parité (section suivante) compare un résultat "ancien" à un résultat "nouveau" — ça demande donc DEUX fonctions serveur distinctes, pas une seule :

- **`resolveCustodyDayFromJson(ds, cfg, childId)`** — portage fidèle de `resolveGuard` telle qu'elle existe aujourd'hui (lit `families.data`, mêmes 6 étapes dans le même ordre). Sert UNIQUEMENT de référence pour la vérification de parité — jamais utilisée par le chatbot. Transcrite depuis la version **testée** dans `core.js` (voir Contexte technique) plutôt que depuis l'ancien code non testé d'`App.jsx`, pour réduire le risque de transcription.
- **`resolveCustodyDayFromTables(ds, familyId, childId, ...contexte)`** — la nouvelle lecture hybride : une requête sur les 5 tables dédiées (motif, overrides, dates spéciales) + les quelques champs annexes du blob JSON (dates de naissance, genre, pays, `sameGuardAll`). C'est CETTE fonction qui sert à la fois à la vérification ET au nouvel outil du chatbot — jamais `resolveCustodyDayFromJson`.

Les deux sont portées en TypeScript, dupliquées entre l'Edge Function `ai-chatbot` (qui n'a besoin que de `resolveCustodyDayFromTables`, pour son nouvel outil) et l'Edge Function `admin-manage-subscriptions` (qui a besoin des DEUX, pour comparer) — avec un commentaire de renvoi croisé, comme déjà pratiqué dans ce projet pour `_shared/push.ts` et `parisMidnightISO` (déploiement par copier-coller dashboard, pas de build partagé possible).

Requêtes faites avec le client JWT-scopé de l'appelant pour l'outil du chatbot (cohérent avec les autres outils) ; avec le client service-role pour l'action admin de vérification (qui doit lire TOUTES les familles, pas seulement celles de l'appelant — même modèle que les autres actions cross-famille de `admin-manage-subscriptions`).

### Nouvel outil du chatbot : `get_custody_days`

Ajouté à `TOOLS` dans `ai-chatbot/index.ts` :
- Paramètres : `from_date`, `to_date` (YYYY-MM-DD, obligatoires), `child_id` (optionnel — si absent, utilise le motif global famille ; si présent et que la famille a une garde différenciée par enfant, utilise le motif de cet enfant, sinon retombe sur le motif global).
- Plafond : 730 jours (2 ans) maximum entre `from_date` et `to_date` — au-delà, l'outil retourne une erreur explicite (`range_too_large`) que Claude peut relayer poliment, demandant à l'utilisateur de réduire la période.
- Boucle jour par jour sur la période, appelle `resolveCustodyDayFromTables` pour chacun, tallie par index de parent.
- Retourne `{ parent_0_days, parent_1_days, unassigned_days, total_days, from_date, to_date, child_name? }` — jamais laissé au calcul de Claude (même principe que `computeExpenseBalance` : un chiffre fourni par un outil n'est jamais recalculé par le modèle).
- Le prompt système (`SYSTEM_PROMPT`) gagne une mention de cette nouvelle capacité dans la liste numérotée existante, et la ligne "Si une information demandée n'est disponible... (ex. planning de garde, actuellement non disponible)" est mise à jour puisque ce n'est plus vrai pour le DÉCOMPTE de jours (le planning détaillé jour-par-jour/affichage complet reste hors scope, seul le comptage l'est).

### Outil de vérification de fiabilité (admin)

Nouvelle action `verify_custody_parity` sur l'Edge Function existante `admin-manage-subscriptions` (consolidée avec les autres actions cross-famille déjà là, comme `cleanup_anonymous_accounts` — pas une nouvelle fonction dédiée) :
- Pour chaque famille ayant une configuration de garde confirmée (`custody_rules.confirmed = true` ou équivalent JSON), calcule chaque jour sur une fenêtre de 3 ans (2 ans passés + 1 an à venir, depuis aujourd'hui) par `resolveCustodyDayFromJson` et par `resolveCustodyDayFromTables`.
- Compare jour par jour (et enfant par enfant si garde différenciée par enfant).
- Retourne un rapport structuré : nombre de familles vérifiées, nombre de jours comparés, liste des désaccords (`family_id`, `date`, `child_id`, résultat ancien, résultat nouveau).
- Nouvelle carte dans `AdminTab` (`VerifyCustodyParityCard`, même style que `AnonymousCleanupCard`) : bouton "Vérifier la fiabilité du calcul de garde", affiche le rapport après exécution. Action à la demande uniquement (pas de planification automatique dans cette itération).

## Sécurité

- Outil `get_custody_days` : lecture JWT-scopée de l'appelant (RLS déjà en vigueur s'applique automatiquement), aucune donnée d'une autre famille accessible.
- Action `verify_custody_parity` : déjà protégée par le garde-fou existant d'`admin-manage-subscriptions` (réservée aux comptes admin, vérifié côté serveur) — même modèle que les autres actions cross-famille de cette fonction.
- Aucune nouvelle donnée sensible exposée : les 5 tables de garde ne contiennent rien de plus sensible que ce que l'app affiche déjà à la famille elle-même (pas de coordonnées, pas d'email).

## Non-objectifs

- Le calendrier client (`CalTab`, `resolveGuard`, tout le rendu du planning) **n'est pas modifié** dans cette itération — continue de fonctionner exactement comme aujourd'hui.
- Pas de bascule de l'affichage vers les tables dédiées — décision séparée (Phase 4, étape 2), prise uniquement après un rapport de `verify_custody_parity` à zéro désaccord sur les familles réelles, et nécessitant son propre brainstorm (gestion du temps réel, éventuel mode "ombre" progressif plutôt qu'un basculement direct).
- Pas de planification automatique (cron) de la vérification de parité dans cette itération — action à la demande seulement.
- Pas d'affichage détaillé jour-par-jour de la garde par le chatbot (ex. "qui a la garde le 5 août ?") — seul le **comptage** sur une période est dans le périmètre ; une question ponctuelle sur un jour précis reste hors scope (le chatbot explique déjà qu'il ne peut pas répondre aux questions de planning détaillé, cf. prompt système existant, à ajuster uniquement pour le cas du comptage).

## Déploiement (manuel, hors repo)

1. Confirmer les policies RLS réelles des 5 tables de garde (requête `information_schema` ou test direct) avant d'écrire le plan — détermine si une migration RLS est nécessaire.
2. Mettre à jour l'Edge Function `ai-chatbot` (nouvel outil + prompt système).
3. Mettre à jour l'Edge Function `admin-manage-subscriptions` (nouvelle action `verify_custody_parity`).
4. Nouvelle carte dans `AdminTab` côté client.
5. Aucune migration de données requise (lecture seule des tables existantes) — sauf si l'étape 1 révèle un manque de policy RLS SELECT.

## Test / vérification

Aucun test automatisé possible pour la logique dépendant de vraies données Supabase — vérification live :
- Lancer `verify_custody_parity` sur les familles réelles existantes, viser 0 désaccord (ou diagnostiquer/corriger chaque désaccord trouvé avant de considérer la fonctionnalité fiable).
- Poser une question de comptage au chatbot ("combien de jours de garde ce mois-ci ?", "et entre le 15 mars et le 10 avril ?") sur un compte de test → vérifier que le total correspond à un comptage manuel sur le calendrier affiché.
- Tester avec une famille à garde différenciée par enfant → vérifier que préciser un enfant change le résultat, et que ne rien préciser retombe sur le motif global.
- Tester le plafond de 730 jours → vérifier le refus explicite et poli au-delà.
- `getFathersDayDate`, `wkNum` et `resolveGuard` lui-même sont extraits dans `core.js` (import depuis `App.jsx` remplaçant les définitions locales, comportement inchangé) avec de vrais tests unitaires dans `core.test.js` couvrant ses branches (override manuel, chaque date spéciale forcée, vacances scolaires, les 3 types de motif) — comble un trou de test préexistant sur une logique déjà critique aujourd'hui, indépendamment de cette fonctionnalité. Ces tests servent aussi de jeu de référence pour vérifier que le portage serveur (`resolveCustodyDay`) reste équivalent au moment où il est écrit.
