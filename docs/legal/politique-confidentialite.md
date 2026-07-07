# Politique de Confidentialité — Duvia

> ⚠️ **BROUILLON DE TRAVAIL — NON PUBLIÉ.** Ce document a été rédigé par un
> assistant IA à partir de la connaissance du produit Duvia (code source,
> fonctionnalités réellement implémentées). Il ne constitue **pas** un avis
> juridique et **doit être relu et validé par un professionnel du droit**
> (avocat ou DPO) avant toute publication. Les champs entre crochets `[...]`
> sont des informations manquantes à confirmer.
>
> Dernière mise à jour du brouillon : 2026-07-08.

---

## Qui traite vos données ?

**[Raison sociale à définir — société non encore immatriculée, SIRET en
cours d'obtention]**, éditrice de l'application Duvia (« l'Application »),
est responsable du traitement des données décrites ci-dessous. Contact :
**duvia.services@gmail.com**.

**⚠️ Duvia est actuellement en version bêta gratuite.** L'ensemble des
fonctionnalités est accessible sans contrepartie financière pendant cette
phase.

## Quelles données sont collectées ?

- **Identité** : nom, genre, date de naissance, email et/ou numéro de
  téléphone, photo de profil (avatar).
- **Données des enfants** : nom, date de naissance, allergies, groupe
  sanguin, école, médecin traitant, informations complémentaires saisies
  par les parents.
- **Planning de garde** : calendrier de garde, modèle d'alternance, dates
  spéciales, jours fériés/vacances scolaires (récupérés depuis un service
  public de jours fériés — aucune donnée personnelle n'est envoyée à ce
  service).
- **Dépenses partagées** : montants, description, justificatifs (photos/
  documents), remboursements entre parents.
- **Messages** : contenu des messages échangés entre membres d'une même
  famille, y compris pièces jointes éventuelles.
- **Coffre-fort documentaire** : documents déposés par les membres de la
  famille (ex. actes, ordonnances, justificatifs).
- **Carnet de contacts** : numéros utiles saisis par la famille.
- **Données techniques** : identifiant de compte, journal des connexions,
  informations minimales de navigation à des fins de mesure d'audience
  (voir « Mesure d'audience » ci-dessous).

## Pourquoi ces données sont-elles collectées ?

Ces données sont strictement nécessaires au fonctionnement du Service :
permettre à des parents séparés de coordonner la garde de leurs enfants
(calendrier, dépenses, communication, documents partagés). Base légale :
exécution du contrat d'utilisation du Service (et consentement explicite
pour la création d'un compte enfant mineur, voir ci-dessous).

## Qui a accès à vos données ?

Les données saisies dans une « famille » Duvia (calendrier, dépenses,
messages, documents, contacts) sont visibles par les membres actifs de
**cette même famille uniquement** (parents, enfants, observateurs invités
avec les droits qui leur ont été accordés) — jamais par d'autres familles
utilisatrices de l'Application, ni revendues à des tiers à des fins
commerciales.

Des prestataires techniques (sous-traitants au sens du RGPD) interviennent
pour le fonctionnement du Service :

- **Supabase** (hébergement de la base de données, authentification,
  stockage de fichiers) — **[région d'hébergement à confirmer]**.
- **[Prestataire d'envoi d'emails transactionnels, ex. Resend]** — pour les
  notifications par email (ex. nouvelle dépense).
- **PostHog** (mesure d'audience, hébergement Union Européenne) — voir
  section dédiée ci-dessous.

Aucune donnée n'est vendue à des tiers, ni utilisée à des fins publicitaires.

## Consentement parental et comptes enfants

La création d'un compte pour un enfant en dessous du seuil légal de
consentement numérique applicable dans son pays de résidence (variable
selon les pays, entre 13 et 16 ans conformément à l'article 8 du RGPD)
requiert l'autorisation expresse d'un titulaire de l'autorité parentale,
recueillie dans l'Application avant la création du compte.

## Mesure d'audience

L'Application utilise PostHog (hébergement UE) à des fins de mesure
d'audience anonymisée (nombre de connexions, pays, usage des
fonctionnalités), **sans capture automatique du contenu de l'écran**
(« autocapture » désactivé) et sans profilage publicitaire. Cette
collecte n'est active que si la variable d'environnement correspondante
est configurée sur le déploiement.

## Cookies et stockage local

L'Application utilise le stockage local du navigateur (`localStorage`/
`sessionStorage`) pour conserver votre session de connexion — de façon
persistante si vous cochez « Rester connecté », sinon uniquement pour la
durée de l'onglet ouvert (choix délibéré : les appareils sont parfois
partagés entre parents). Aucun cookie publicitaire ou de suivi tiers
n'est déposé.

## Durée de conservation

Vos données sont conservées tant que votre compte et votre famille Duvia
sont actifs. Vous pouvez à tout moment :

- **Supprimer votre compte** depuis l'Application : votre compte
  d'authentification est supprimé, vous êtes retiré de toutes vos
  familles, et les fichiers qui vous sont personnellement associés (photo
  de profil) sont effacés.
- **Exporter vos données** (fonction de sauvegarde/export intégrée à
  l'Application) avant suppression, si vous souhaitez en conserver une
  copie.

Les données propres à une famille restent accessibles aux autres membres
actifs de cette famille après le départ d'un membre, sauf demande
spécifique justifiée auprès de **duvia.services@gmail.com**.

## Sécurité

L'accès aux données est cloisonné par famille au niveau de la base de
données (chaque famille ne peut accéder qu'à ses propres données), les
échanges avec le serveur sont chiffrés (HTTPS), et l'authentification est
gérée par un prestataire spécialisé (Supabase Auth). Un mot de passe fort
est exigé à la création du compte.

## Vos droits

Conformément au Règlement Général sur la Protection des Données (RGPD),
vous disposez d'un droit d'accès, de rectification, d'effacement, de
limitation, d'opposition et de portabilité de vos données. Pour un enfant
mineur, ces droits sont exercés par le titulaire de l'autorité parentale.

Vous pouvez exercer ces droits directement depuis l'Application (export/
suppression de compte) ou en écrivant à **duvia.services@gmail.com**.
Vous disposez également du droit d'introduire une réclamation auprès de
la Commission Nationale de l'Informatique et des Libertés (CNIL) —
[www.cnil.fr](https://www.cnil.fr) — ou de l'autorité de protection des
données compétente dans votre pays de résidence au sein de l'Union
Européenne.

## Modification de cette politique

Cette politique peut être mise à jour ; toute modification substantielle
vous sera signalée dans l'Application, avec redemande de votre
consentement si nécessaire.
