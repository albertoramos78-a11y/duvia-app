# Carte info enfant en lecture seule — Design

## Contexte

L'écran « Config famille » (`StepId`, `App.jsx`) est le seul endroit où les infos d'un enfant (école, médecin, contacts d'urgence, allergie, groupe sanguin, notes) sont visibles — et il n'apparaît pas dans les onglets (`TABS`) des observateurs et des enfants (`App.jsx:4142-4151`). Résultat : un grand-parent ou l'enfant lui-même n'a aujourd'hui aucun moyen de consulter ces infos dans l'app (backlog, item 7, demande du 2026-07-08). Demande : une fiche accessible depuis la barre du haut, en lecture seule.

Point vérifié avant de concevoir : `cfg` (contexte `useApp()`) est le même objet complet pour tous les rôles — `ContactsTab`, déjà utilisé par les observateurs/enfants (`App.jsx:15666-15691`), lit `cfg.children` sans filtrage. Aucune donnée supplémentaire à exposer côté serveur : c'est une nouvelle vue sur une donnée déjà présente côté client.

## Décisions de conception

### 1. Point d'entrée : icône dans la barre du haut, visible uniquement pour observateurs/enfants

Un nouveau bouton (🧒) dans la rangée « Right controls » du HEADER existant (`App.jsx:4314-4325`, à côté du bouton thème et du bouton 🏆), rendu seulement si `isObs || isChild`. Les parents ont déjà l'écran Config famille complet ; pas de doublon pour eux. Au clic, ouvre une modale plein-écran (état local `showChildInfoModal`, même registre que les autres modales du header comme `showLicenseModal`).

### 2. Sélecteur d'enfant + une carte à la fois

Si `cfg.children.length > 1`, une rangée de pills en haut de la modale (une par enfant, libellé = `ch.name || \`${t.childN} ${i+1}\``, cohérent avec le titre de carte dans `StepId`) sélectionne l'enfant affiché (état local `selectedChildIdx`, initialisé à 0). Si un seul enfant, la carte s'affiche directement sans sélecteur. Si `cfg.children.length === 0`, message d'état vide (nouvelle clé i18n `childInfoCardEmpty`) à la place de la carte.

### 3. Contenu de la carte : mêmes champs que `StepId`, en texte, pas en `<input>`

Repris à l'identique de la carte enfant de `StepId` (`App.jsx:8016-8129`), en lecture seule :
- Avatar (`ch.avatar`) + nom (`ch.name`)
- Date de naissance, formatée `JJ/MM` (`String(ch.birthDay).padStart(2,"0")}/${String(ch.birthMonth).padStart(2,"0")`, même format que l'export PDF existant, `App.jsx:12187`) + année si renseignée
- Allergie (`ch.allergy`), groupe sanguin (`ch.bloodType`)
- École (`ch.school`), médecin (`ch.doctor`), contacts d'urgence (`ch.emergencyContacts`), notes (`ch.notes`) — champs à plat depuis le fix du 2026-07-09 (commit `68dde16`), avec le même repli `ch.home?.x` pour les données pas encore migrées
- Un champ vide (`""`, `null` ou absent) n'affiche pas sa ligne du tout (pas de placeholder de saisie, puisqu'il n'y a rien à saisir ici) — pour ne pas surcharger une fiche qui doit rester lisible d'un coup d'œil.

### 4. Composant et style de modale : réutilise le patron existant

Nouveau composant `ChildInfoModal` dans `App.jsx`, calqué sur la modale Licence (`App.jsx:4569-4594` : overlay `position:fixed,inset:0`, carte centrée, croix ✕ de fermeture). Pas de nouveau fichier service/hook — aucune écriture, aucun appel réseau, tout vient du `cfg` déjà en contexte.

## Portée

Inclus : bouton header conditionnel au rôle, modale avec sélecteur multi-enfants, affichage lecture seule des champs listés ci-dessus, état vide.

Hors périmètre : toute modification des données (édition, suppression), tout changement RLS/backend, la « bulle jour sur le calendrier » (fera l'objet d'un design séparé), l'affichage aux parents (ils gardent l'écran Config famille comme seul point d'entrée).

## Nouvelles clés i18n

`childInfoCardTitle` (titre de la modale), `childInfoCardEmpty` (état vide) — à ajouter dans `fr/en/de/es/pt`, français comme référence.
