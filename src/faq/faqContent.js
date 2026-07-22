// src/faq/faqContent.js
// ─────────────────────────────────────────────────────────────────────────────
// Contenu de la FAQ affichée en app par FaqModal (src/App.jsx), accessible à
// tous les rôles (parent/observateur/enfant) sans distinction de palier
// d'abonnement — voir docs/superpowers/specs (décision : une FAQ statique
// pour tout le monde, l'assistant IA conversationnel restant réservé au
// palier Premium+IA). Français uniquement pour l'instant (contenu long et
// procédural — traduire une fois la version française stabilisée, pas avant,
// pour éviter de retraduire à chaque ajustement). FaqModal se rabat sur le
// français si la langue courante n'a pas encore de traduction, même
// mécanisme que LEGAL_DOCS (src/legal/legalDocs.js).
//
// Les libellés entre **gras** reprennent EXACTEMENT les textes de boutons/
// onglets affichés dans l'app (voir src/i18n/fr.js) — à garder synchronisés
// si ces libellés changent, sous peine de guider l'utilisateur vers un
// bouton qui n'existe plus sous ce nom.
//
// Structure : {q:"question", a:"réponse (accepte **gras**)"}.
// ─────────────────────────────────────────────────────────────────────────────

export const FAQ_SECTIONS = {
  fr: [
    {
      id: "garde",
      icon: "📅",
      title: "Calendrier de garde",
      items: [
        {
          q: "Comment configurer le modèle de garde (garde alternée, exclusive, personnalisée) ?",
          a: "Ouvre le menu ☰ (en haut) → **Configuration famille** → onglet **Modèle garde** (le 4e des 4 onglets). Choisis un type : **📅 1 semaine sur 2** (alternance simple), **🏠 Garde exclusive + 1 WE/2** (un parent en semaine, l'autre un weekend sur deux), ou **✏️ Personnalisé** (motif sur-mesure de 14 jours qui se répète). Réponds aux questions qui s'affichent (qui a la semaine paire, etc.), puis appuie sur **✓ Confirmer et appliquer** — tant que ce n'est pas confirmé, le calendrier n'utilise pas encore ce motif.",
        },
        {
          q: "Le calendrier semble décalé d'une semaine, que faire ?",
          a: "Vérifie la **Date de départ du calendrier** (champs Mois/Année), réglée dans l'onglet précédent **Dates spéciales** — c'est elle qui détermine quelle semaine compte comme « paire » ou « impaire » pour l'alternance.",
        },
        {
          q: "Comment modifier un jour précis sans changer tout le modèle de garde ?",
          a: "Dans le calendrier (vue **☰ Détaillée** ou **▦ Miniature**), touche le jour concerné : un sélecteur rapide s'ouvre pour assigner ce jour à un parent (ou à un observateur « gardien ») en un tap, ou le remettre à zéro avec **✕**. Pour préciser une heure de prise/fin de garde, un lieu ou une note, touche **✎ Édition complète**.",
        },
        {
          q: "Comment annuler toutes mes modifications ponctuelles d'un coup ?",
          a: "Dans le calendrier, ouvre le menu « … » (actions) → **Réinit.** → confirme. Toutes les modifications manuelles reviennent au modèle de garde de base ; le modèle lui-même n'est pas modifié.",
        },
        {
          q: "Puis-je avoir un planning de garde différent pour chaque enfant ?",
          a: "Oui, en Premium : dans l'onglet **Dates spéciales**, désactive **Même garde pour tous les enfants**, puis configure le modèle enfant par enfant dans l'onglet **Modèle garde** (un sélecteur d'enfant apparaît en haut de cet onglet).",
        },
      ],
    },
    {
      id: "invitations",
      icon: "✉️",
      title: "Inviter un membre de la famille",
      items: [
        {
          q: "Comment inviter l'autre parent ?",
          a: "Menu ☰ → **Configuration famille** → onglet **Famille** → section **Parents** → **+ Ajouter un parent**. Renseigne son email et/ou téléphone, appuie sur **🔗 Générer le lien d'invitation**, puis envoie-le par email ou copie-le pour le transmettre toi-même (lien valable 24h).",
        },
        {
          q: "Comment inviter un enfant à rejoindre l'app ?",
          a: "Même onglet **Famille**, section **Enfants** — une fois son prénom renseigné, un bloc **📨 Inviter [prénom] à rejoindre l'app** apparaît avec un bouton pour générer son lien d'invitation.",
        },
        {
          q: "Comment inviter un observateur (grand-parent, proche...) ?",
          a: "Menu ☰ → **Configuration famille** → onglet **Observateurs** → renseigne email et/ou téléphone, choisis le **Type de relation**, puis **📨 Envoyer l'invitation** (fonctionnalité Premium). Active **🏠 Peut être gardien** si cette personne doit pouvoir apparaître comme gardien ponctuel dans le calendrier.",
        },
        {
          q: "Comment valider l'inscription de quelqu'un que j'ai invité ?",
          a: "Une fois que la personne a cliqué son lien et créé son compte, sa fiche affiche des boutons **✅ Valider** / **❌** dans l'onglet correspondant (Famille ou Observateurs) — tant que tu n'as pas validé, elle n'a pas encore accès aux données de la famille.",
        },
      ],
    },
    {
      id: "depenses",
      icon: "💰",
      title: "Dépenses",
      items: [
        {
          q: "Comment ajouter une dépense ?",
          a: "Onglet **Dépenses** → **+ Ajouter une dépense** → renseigne description, montant, qui a payé, catégorie, date, et le partage (curseur entre les deux parents) → **Enregistrer**. La dépense reste **en attente** jusqu'à ce que l'autre parent la valide.",
        },
        {
          q: "Comment enregistrer un remboursement ?",
          a: "Onglet **Dépenses** → **💸 Remboursement** → indique qui rembourse qui, le montant et la date → **💸 Enregistrer le remboursement**. Le solde affiché en haut de l'onglet n'est mis à jour qu'une fois que l'autre parent confirme avoir bien reçu le remboursement.",
        },
        {
          q: "Comment créer une dépense récurrente (ex. cantine mensuelle) ?",
          a: "Lors de l'ajout d'une dépense, active **Dépense récurrente**, choisis la fréquence (**Hebdo.**, **Mensuelle** ou **Annuelle**) ainsi qu'une date de début/fin — l'app génère automatiquement une occurrence par période.",
        },
      ],
    },
    {
      id: "coffre",
      icon: "🗄️",
      title: "Coffre-fort",
      items: [
        {
          q: "Comment ajouter un document au coffre-fort ?",
          a: "Onglet **Coffre** (réservé Premium) → **+ Ajouter un document** → nom, catégorie, date, notes, puis **📎 Choisir un fichier** → **✓ Enregistrer**. Le document devient visible par l'autre parent.",
        },
        {
          q: "Les observateurs ou les enfants ont-ils accès au coffre-fort ?",
          a: "Non — le coffre-fort n'est accessible qu'aux parents.",
        },
      ],
    },
    {
      id: "edt",
      icon: "🎒",
      title: "Emploi du temps scolaire",
      items: [
        {
          q: "Comment configurer l'emploi du temps d'un enfant ?",
          a: "Onglet **EDT** → sélectionne l'enfant (s'il y en a plusieurs) puis le jour de la semaine → **+ Ajouter** → renseigne matière, professeur, horaires, salle et bâtiment. La formule gratuite limite à 1 cours par jour et par enfant ; le Premium retire cette limite.",
        },
      ],
    },
    {
      id: "messagerie",
      icon: "💬",
      title: "Messagerie",
      items: [
        {
          q: "Comment envoyer un message plus posé en cas de tension avec l'autre parent ?",
          a: "Si ton abonnement inclut l'IA, un bouton **Reformuler** propose une reformulation plus neutre de ton message avant l'envoi — tu choisis ensuite **Envoyer celle-ci** ou **Garder mon texte original**.",
        },
        {
          q: "Que veut dire l'icône 🔒 ou ⚠️ à côté d'un message ?",
          a: "Chaque message est protégé par une empreinte d'intégrité : 🔒 **Intégrité vérifiée** signifie qu'il n'a pas été modifié depuis son envoi ; ⚠️ **Message modifié !** signale une anomalie.",
        },
        {
          q: "Si je supprime une conversation, est-elle supprimée pour l'autre personne aussi ?",
          a: "Non — la suppression ne retire la conversation que de ta propre liste ; elle reste visible pour les autres participants.",
        },
      ],
    },
    {
      id: "notifications",
      icon: "🔔",
      title: "Notifications",
      items: [
        {
          q: "Où voir mes notifications ?",
          a: "Menu ☰ → **🔔 Notifications**, ou l'icône cloche en haut de l'écran pour un accès rapide sans changer d'onglet.",
        },
        {
          q: "Comment choisir par quel canal être notifié (email, notification push) ?",
          a: "Menu ☰ → **⚙️ Préférences** → section **Notifications** : un interrupteur 📧 (email) et 🔔 (push) pour chaque type d'événement (nouveau message, nouvelle dépense, nouveau document, demande à rejoindre la famille).",
        },
      ],
    },
    {
      id: "premium",
      icon: "🎁",
      title: "Premium et parrainage",
      items: [
        {
          q: "Comment passer à Premium ?",
          a: "Touche n'importe quel bandeau ou icône verrouillée 🔒 dans l'app : tu es redirigé vers l'écran d'abonnement, avec le comparatif des formules et le choix entre paiement mensuel ou annuel.",
        },
        {
          q: "Comment fonctionne le parrainage ?",
          a: "Menu ☰ → **🎁 Parrainage** → partage ton lien personnel (copie du lien, email ou SMS). Chaque invitation validée te rapporte des jours Premium et/ou un tour de roue à gratter, selon ta formule actuelle.",
        },
        {
          q: "Comment annuler mon abonnement Premium ?",
          a: "Écran **Premium** → **Annuler mon abonnement** — il reste actif jusqu'à la fin de la période déjà payée, comme pour un abonnement classique.",
        },
      ],
    },
    {
      id: "reglages",
      icon: "⚙️",
      title: "Réglages",
      items: [
        {
          q: "Comment changer la langue de l'application ?",
          a: "Menu ☰ → **⚙️ Préférences** : le sélecteur de langue se trouve tout en haut de cet écran.",
        },
        {
          q: "Comment changer de thème (clair, sombre) ?",
          a: "Touche le petit bouton palette en haut de l'écran, à côté du logo Duvia — il fait défiler les modes 🎨 (thème coloré) → ☀️ (clair) → 🌙 (sombre) à chaque tap.",
        },
        {
          q: "Comment changer le pays ou la zone scolaire ?",
          a: "Menu ☰ → **Configuration famille** → onglet **Dates spéciales** → menus **Pays** et **Zone** (cette zone sert à calculer les bonnes dates de vacances scolaires).",
        },
      ],
    },
  ],
};
