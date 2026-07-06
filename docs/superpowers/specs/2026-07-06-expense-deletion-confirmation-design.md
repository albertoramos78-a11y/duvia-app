# Confirmation de suppression pour dépenses/remboursements déjà validés — Design

## Contexte et problème

Aujourd'hui, le créateur d'une dépense ou d'un remboursement (`iAmSender`/`iAmExpSender`) peut la supprimer unilatéralement à tout moment via `del(id)`/`delReim(id)` → `expMethods.deleteExpense`/`deleteReimbursement`, sans aucune validation de l'autre parent — même si cette dépense a déjà été **acceptée** par l'autre parent (`status==="confirmed"`). Pour un outil qui sert de preuve dans un contexte de garde partagée, un parent ne devrait pas pouvoir faire disparaître unilatéralement un enregistrement financier déjà validé par l'autre.

## Exigence

Quand le créateur supprime un élément **déjà accepté**, la suppression ne doit pas être immédiate : l'autre parent doit confirmer. S'il refuse, l'élément reste inchangé. Le créateur peut aussi annuler sa propre demande avant que l'autre parent ne réponde.

## Décisions de conception

### 1. Un simple drapeau, pas une nouvelle table

Ajout d'une colonne `pending_delete BOOLEAN NOT NULL DEFAULT false` à `expenses` et `reimbursements` — pas de table `deletion_requests` séparée, ce n'est qu'un état on/off sur la ligne existante, réutilisant le champ `status` existant ("pending"/"confirmed"/"rejected") sans le modifier : `status` continue de refléter la validation de création, `pending_delete` est indépendant et concerne la suppression.

### 2. Ne s'applique qu'aux éléments déjà acceptés

Le nouveau contrôle ne se déclenche que si `status==="confirmed"` au moment du clic sur supprimer. Un élément encore `"pending"` (jamais validé) ou `"rejected"` reste supprimable immédiatement par son créateur, comme aujourd'hui — inchangé.

### 3. Reste compté normalement pendant l'attente

Comme `pending_delete` est indépendant de `status`, les calculs de totaux/solde (`confirmedExpenses`, `totals`, `owed`, `balance`, et leurs équivalents PDF) qui filtrent sur `status==="confirmed"` ne voient aucune différence — l'élément continue de compter normalement tant que la suppression n'est pas confirmée. Aucun changement nécessaire dans cette logique.

### 4. Trois actions, réutilisant le vocabulaire existant du confirm/reject de création

- **Demander la suppression** (créateur, sur un élément `confirmed`) : au lieu d'appeler `deleteExpense`/`deleteReimbursement` directement, on appelle `updateExpense`/`updateReimbursement` avec `{pendingDelete: true}`, puis `addHist` + `pushNotif` (même schéma que la création d'une dépense).
- **Annuler sa demande** (créateur, tant que `pending_delete===true`) : `updateExpense(id, {pendingDelete: false})`, pas de notification (c'est son propre choix, pas besoin de prévenir l'autre parent qu'il a changé d'avis).
- **Confirmer / Refuser** (l'autre parent, celui qui n'a pas demandé) :
  - Confirmer → suppression réelle (`deleteExpense`/`deleteReimbursement`, y compris le nettoyage des pièces jointes déjà géré par `deleteAttFiles` pour les dépenses).
  - Refuser → `updateExpense(id, {pendingDelete: false})` (identique techniquement à "Annuler sa demande", déclenché par l'autre personne).

### 5. Affichage : bandeaux inline, pas de nouvelle popup modale

Pas de popup modale séparée (contrairement au flux de création qui a `pendingExpPopup`/`pendingReimPopup`) — un bandeau inline dans la carte de la liste (et dans la modale de détail pour les dépenses), sur le même modèle visuel que le bandeau "Zone validation receveur" déjà utilisé pour la confirmation de création (fond jaune, boutons Valider/Refuser) :
- Vu par le créateur (`pendingDelete===true` et je suis `iAmExpSender`/`iAmSender`) : "⏳ Suppression en attente de confirmation" + bouton **Annuler la demande**.
- Vu par l'autre parent (`pendingDelete===true` et je suis `iAmExpReceiver`/l'autre) : "🗑️ {nom du créateur} souhaite supprimer cette dépense/ce remboursement" + boutons **Confirmer la suppression** / **Refuser**.
- Le bouton de suppression habituel (✕) est masqué/remplacé par ce bandeau tant que `pendingDelete===true`.

## Portée

Inclus : `expenses` ET `reimbursements` (même mécanique pour les deux, décision utilisateur).

Hors périmètre : garde/planning, dates spéciales — cette confirmation ne concerne que les deux domaines financiers déjà identité-attribués ce soir.

## Fichiers concernés

- `supabase/migrations/0022_expense_deletion_confirmation.sql` (nouveau) — colonne `pending_delete` sur les deux tables, pas de backfill nécessaire (défaut `false`).
- `src/services/supabase/expenseService.ts` — `pendingDelete: boolean` sur `Expense`/`Reimbursement`, mappers `dbToExpense`/`expenseToDb`/`dbToReimbursement`/`reimbursementToDb`.
- `src/App.jsx` — `del(id)`/`doDelete` et `delReim(id)` : brancher sur `status==="confirmed"` pour demander au lieu de supprimer ; nouvelles fonctions `cancelDeleteExp`/`confirmDeleteExp`/`rejectDeleteExp` (et équivalents remboursement) ; bandeaux inline dans la liste (et la modale de détail dépense) conditionnés sur `pendingDelete`.

## Ce que cette fonctionnalité NE fait PAS

- N'ajoute pas de popup modale séparée pour la demande de suppression.
- Ne touche pas aux montants/soldes/calculs déjà corrigés ce soir.
- Ne s'applique pas à la garde, aux dates spéciales, ni à la config famille.
