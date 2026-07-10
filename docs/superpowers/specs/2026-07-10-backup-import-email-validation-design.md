# Validation email à l'import de backup — Design

## Contexte

L'import d'un fichier `.duvia` (`handleImportBackupFile`, `App.jsx:6591-6624`) a aujourd'hui une seule protection : si `backup._familyId` diffère de l'ID de la famille actuelle, une pop-up (`window.confirm`) avertit et laisse continuer si l'utilisateur confirme. Ensuite, `applyDuviaBackupToCfg` (`App.jsx:14454`) remplace intégralement `cfg.parents`/`children`/`observers`/`contacts`, sans aucune autre vérification. Demandé (backlog, promu priorité urgente le 2026-07-10) : bloquer l'import quand rien ne prouve que le fichier appartient à cette famille, et ne jamais laisser un import écraser un email/téléphone déjà saisi dans l'app.

## Décisions de conception

### 1. Blocage net, uniquement dans le cas « famille différente/inconnue »

Quand `backup._familyId` diffère de l'ID de la famille actuelle (ou est absent), on vérifie maintenant si au moins un email de parent du fichier correspond à un email de parent de la famille actuelle. **Aucune correspondance → import bloqué net**, message d'erreur affiché (réutilise le mécanisme d'erreur existant, `setBackupImportErr`), aucune pop-up « continuer quand même » pour ce cas précis. Si au moins un email correspond, le comportement actuel est inchangé : la pop-up d'avertissement « fichier d'une autre famille, continuer ? » s'affiche toujours (contexte utile même quand un email correspond, ex. restaurer son propre backup sur une famille recréée).

Si la famille du fichier correspond déjà (même ID), **aucune vérification supplémentaire** — comportement actuel inchangé.

Cas où la comparaison est impossible (la famille actuelle n'a encore aucun parent avec un email renseigné, ou le fichier n'a aucun email de parent) : on laisse passer plutôt que de bloquer sur une vérification qui ne prouve rien — ça ne doit pas casser une première restauration légitime.

### 2. Email et téléphone déjà saisis = jamais écrasés par l'import

Pour parents, enfants et observateurs : au moment de fusionner le fichier importé dans la config actuelle, chaque entrée du fichier est associée à l'entrée actuelle à la **même position** dans le tableau. Si cette entrée actuelle a déjà un email et/ou un téléphone non vide, cette valeur est conservée telle quelle — celle du fichier est ignorée pour ce champ précis. Tout le reste (nom, avatar, couleur, date de naissance, école/médecin/allergie...) vient du fichier, sans changement. Un membre présent uniquement dans le fichier (pas d'entrée actuelle à cette position) n'a rien à protéger : son email/téléphone du fichier est conservé tel quel.

## Architecture

Deux nouvelles fonctions pures dans `src/utils/core.js` (avec tests dans `core.test.js`, suivant la convention du projet) :

- `hasMatchingParentEmail(currentParents, backupParents)` → `boolean`. Compare les emails (normalisés : `trim().toLowerCase()`), retourne `true` s'il y a au moins une correspondance OU si la comparaison est impossible (l'une des deux listes n'a aucun email exploitable) — `false` uniquement quand les deux listes ont des emails et qu'aucun ne correspond.
- `mergeBackupArrayPreservingContact(currentArr, backupArr)` → tableau fusionné. Pour chaque élément du tableau backup, s'il existe un élément actuel à la même position ET que celui-ci a un `email`/`phone` non vide, ces deux champs sont écrasés dans le résultat par les valeurs actuelles ; le reste de l'élément vient du backup tel quel.

Câblage :

- `applyDuviaBackupToCfg` (`App.jsx:14454`) applique `mergeBackupArrayPreservingContact` sur `parents`, `children` et `observers` au lieu de les remplacer bruts par `fam.parents`/`fam.children`/`fam.observers`.
- `handleImportBackupFile` (`App.jsx:6591`), dans le bloc `if (backupFid && currentFid && backupFid !== currentFid)` déjà existant : avant d'afficher la pop-up de confirmation actuelle, appelle `hasMatchingParentEmail(cfg.parents, parsed?.family?.parents)`. Si `false`, lève une erreur avec un nouveau code (`parent_email_mismatch`) au lieu d'afficher la pop-up — ce code rejoint le mapping `codes` déjà présent dans le `catch` de cette fonction (même mécanisme que `no_file`/`file_too_large`/etc.), avec une nouvelle clé i18n `backupErrEmailMismatch` dans les 5 langues.

## Portée

Inclus : les deux fonctions pures + tests, le câblage des deux points d'intégration ci-dessus, la nouvelle clé i18n.

Hors périmètre : `contacts` (carnet d'adresses, pas des comptes famille — pas concerné par la protection email/téléphone) ; toute modification du flux d'export ; tout changement RLS/backend (tout se passe côté client, sur des données déjà en mémoire).
