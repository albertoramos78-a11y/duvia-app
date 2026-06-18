# Duvia — Rapport de correction (session ingénierie)

Tous les fichiers passent `esbuild` (App.jsx + modules `.ts`) et `node --check`
(`.js`). La suite de tests (`npm test`) compte **39 tests, 39 passés**.
Lancer : `TZ=Europe/Paris npm test`.

## Bugs corrigés

| # | Fichier | Bug | Correctif |
|---|---------|-----|-----------|
| B0 | App.jsx + `supabase/migrations/0015_member_identity.sql` | **Validation d'invité : l'invité validé n'apparaissait pas.** Le flux par token rejoint en `pending` sans écrire `families.data.parents` (RLS) ; la RPC de validation ne bascule que `family_members.status='active'` et n'inscrit jamais l'invité dans le blob partagé. | **Solution serveur-autoritaire** : l'invité enregistre son vrai nom + genre sur sa ligne `family_members` via la nouvelle RPC `set_member_identity` (appelée dans `joinFamilyByToken`). À la validation, l'inviteur lit `display_name` et inscrit l'invité en parent 2 (`insertValidatedParent`). `reconcileOwnParentSlot` reste un filet de sécurité côté invité. |
| B1 | App.jsx `validatePassword` | Ne vérifiait que la longueur ; mots de passe faibles acceptés. | Exige ≥1 majuscule + ≥1 caractère spécial, messages dédiés. |
| B2 | App.jsx `doForgot` | « Mot de passe oublié » factice : aucun email envoyé, vérifiait la liste **locale** (vide sur nouvel appareil), et **énumérait les comptes**. | Vrai `supabase.auth.resetPasswordForEmail`, message neutre systématique. |
| B3 | hooks/useMessages.ts | Message envoyé **affiché en double** (optimiste + INSERT realtime rediffusé à l'émetteur) ; crash possible si `read_by` null. | Déduplication par id (`upsertMessageById`) ; garde `read_by` (`addReader`). |
| B4 | App.jsx `getMothersDayDate` | Fête des Mères FR : ignorait l'exception légale de la Pentecôte (ex. 2023 → 28 mai au lieu du 4 juin). | Report au 1er dimanche de juin si coïncidence avec la Pentecôte. |
| B5 | App.jsx (14 occurrences) | `new Date().toISOString().slice(0,10)` = date **UTC** → décalée d'un jour (Europe/Paris). | Remplacé par `toStr()` (date locale). |
| B6 | services/migrations/localStorageMigration.ts | Insert vault : colonne `name` (NOT NULL) jamais renseignée, `file_name` mal mappé. | `name` + `file_name` correctement alimentés. |

## Durcissements
- **useIdLinks.ts** : `ready` basé sur « requête aboutie », plus sur `length>0` (une famille sans liens était bloquée).
- **useVault.ts** : resync realtime en mode silencieux (plus de spinner clignotant).
- **RGPD** : seuil de consentement aligné à **15 ans** (France, art. 8 RGPD) dans la logique et les 5 langues. *Note : le seuil varie par pays (DE 16, ES 14, PT 13) — un seuil par pays serait l'évolution propre.*

## Limites connues (non corrigées ici, hors périmètre client)
- Filtre insultes : `containsBadWord` fait du substring sur les mots longs → faux positifs possibles (ex. « crevette » contient « creve »).
- Mots de passe encore en clair dans localStorage (hachage SHA-256 à faire).
- `expire_stale_family_data()` jamais planifiée ; rôle par famille ; doublons clients Supabase — voir le point d'étape.

## Migration SQL à exécuter

`supabase/migrations/0015_member_identity.sql` (après 0014, idempotent) :
ajoute les colonnes `display_name`/`gender` sur `family_members` et la RPC
`set_member_identity(p_family_id, p_display_name, p_gender)` — `SECURITY DEFINER`,
réservée aux comptes authentifiés, limitée à la ligne de l'appelant. La RPC
`accept_family_invitation` n'est PAS modifiée (ses messages d'erreur restent
intacts). À lancer dans l'éditeur SQL Supabase.

## Refactor amorcé
`src/utils/core.js` regroupe les fonctions pures corrigées (testées). App.jsx
importe désormais `insertValidatedParent` et `reconcileOwnParentSlot` depuis ce
module : déplacer d'autres helpers vers `core.js` réduira progressivement App.jsx.

---

## Session 2 — UX validation + aperçu d'invitation

| # | Fichier | Amélioration |
|---|---------|--------------|
| U1 | App.jsx `StepId` | **Validation déplacée dans l'onglet FAMILLE.** Quand l'invité a rejoint (en attente), les boutons **✅ Valider / ❌ Refuser** apparaissent directement sur la carte « Parent 2 — En attente d'inscription », là où l'inviteur envoie le lien. Plus besoin d'aller dans l'onglet Accès. (La section Accès reste disponible.) |
| U2 | App.jsx `LoginScreen` + `supabase/migrations/0016_peek_invitation.sql` | **Pré-remplissage email + détection de compte.** À l'ouverture d'un lien « jeton », l'app appelle la RPC `peek_invitation(token)` → reçoit l'email invité + si le compte existe. L'email se remplit tout seul, et l'app ouvre le bon écran : « Se connecter et rejoindre » si le compte existe, « Créer un compte » sinon. |

### Migration SQL (session 2)
`supabase/migrations/0016_peek_invitation.sql` (après 0015, idempotent) : RPC
`peek_invitation(p_token)` `SECURITY DEFINER`, accessible `anon` (l'invité n'a pas
encore de session) mais protégée par le secret du jeton. Renvoie `email` +
`has_account`. Ne révèle rien si le jeton est invalide/expiré/déjà utilisé.

**Note technique** : `doLogin` (connexion simple) ne rattache PAS à la famille ;
seul `doLoginAndJoin` (écran « compte existant ») le fait. C'est pourquoi un
compte existant est routé vers `showExistingAccount`, pas vers le login normal.

### Ordre d'exécution des migrations
0015 puis 0016, dans l'éditeur SQL Supabase, avant de déployer le code.

---

## Session 3 — Écran RGPD de première utilisation

| # | Fichier | Ajout |
|---|---------|-------|
| L1 | App.jsx `RgpdConsentScreen` + `config.js` + `utils/core.js` | **Écran de consentement RGPD à la première utilisation**, distinct de la charte d'engagement (conservée telle quelle). Informe sur les données + droits (accès, rectification, suppression, portabilité, CNIL), liens vers Politique de confidentialité et CGU, case « J'ai lu et j'accepte ». L'acceptation est **enregistrée avec sa version + horodatage** (`duvia_rgpd_consent` en localStorage) — preuve en cas de contrôle. Redemandée seulement si `RGPD_NOTICE_VERSION` change. |

### À compléter côté produit
- Renseigner les vraies URL dans `config.js` : `PRIVACY_URL`, `CGU_URL` (pages iubenda).
- Traduire les clés `rgpd*` dans `i18n/{en,de,es,pt}.js` (fallback FR actif en attendant, via le pattern `t.key||"…"`).
- Conformité RGPD complète (rappel point d'étape) : la politique de confidentialité doit être **distincte** des CGU et des mentions légales ; prévoir la gestion des demandes de droits sous 1 mois.

### Reste à traiter (validé / à coder)
- **Suppression** (modèle conforme proposé) : inviteur peut supprimer son compte + retirer l'invité de la famille ; invité garde le droit d'effacer **son propre** compte (RGPD art. 17) mais ne peut ni retirer l'autre parent ni supprimer la famille.
- **Abonnement au niveau famille** (#4) : migrer `sub` (localStorage par appareil) vers Supabase lié à `family_id` ; famille premium = (un parent premium actif) OU (trial en cours), sinon freemium pour tous. Étape dédiée (couplée au paiement Stripe).

---

## Session 4 — Verrouillage email parent

| # | Fichier | Correctif |
|---|---------|-----------|
| S1 | App.jsx `StepId` + `utils/core.js` `isParentEmailLocked` | **L'invité pouvait éditer l'email du créateur.** L'ancienne règle (`user.parentIdx===i || inviteStatus==="accepted"`) laissait le créneau du créateur (index 0, sans `inviteStatus`) éditable pour l'invité. Nouvelle règle : email verrouillé si mon propre créneau, OU parent ayant rejoint (`userId`), OU `inviteStatus==="accepted"`, OU créateur (index 0). Reste éditable uniquement sur un créneau vierge (créateur saisissant l'email du parent 2 avant invitation). |

**Persistance (réponse #2)** : `phone`, `birthDay`, `birthMonth` (et tous les champs de `cfg.parents[i]`) sont stockés dans Supabase — l'autosave écrit `cfg` entier dans `families.data` ~1,5 s après chaque modif. Ils survivent à un changement d'appareil. Rien à corriger.
