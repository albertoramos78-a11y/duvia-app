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
        {
          q: "Que voient un enfant et un observateur dans l'application ?",
          a: "Les deux ont accès au **Calendrier**, à la fiche **Enfant**, aux **Contacts**, à la **Messagerie** et à la roue de récompenses (**Jeu**) — mais PAS aux **Dépenses** ni au **Coffre-fort**, réservés aux parents. L'**enfant** a en plus son propre **Emploi du temps** en lecture seule ; l'**observateur** n'y a pas accès du tout. Seuls les parents peuvent modifier la configuration de la famille (modèle de garde, dates spéciales, invitations) via **Configuration famille** — ni un enfant ni un observateur n'y ont accès.",
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
        {
          q: "Comment supprimer une dépense ?",
          a: "Ouvre la dépense (ou utilise le bouton **✕** dans la liste) puis **🗑 Supprimer**. Si elle n'a pas encore été validée par l'autre parent, elle est supprimée immédiatement. Si elle est déjà **confirmée**, la suppression n'est plus unilatérale : l'autre parent reçoit une demande de suppression qu'il doit accepter ou refuser. Pour une dépense récurrente, une fenêtre demande si tu veux supprimer uniquement cette occurrence ou toute la série.",
        },
      ],
    },
    {
      id: "pension",
      icon: "💶",
      title: "Pension alimentaire",
      items: [
        {
          q: "Comment configurer la pension alimentaire ?",
          a: "Onglet **Dépenses**, section **💶 Pension alimentaire** → **Configurer la pension** → indique qui paie, le montant mensuel, le jour d'échéance dans le mois (1-28) et une date de début → **Proposer**. C'est une proposition : l'autre parent doit **Confirmer** (ou **Refuser**) avant qu'elle devienne active. Le proposeur peut aussi **Annuler** sa proposition tant qu'elle est en attente.",
        },
        {
          q: "Comment signaler qu'un versement de pension a été effectué ?",
          a: "Une fois la pension active, le parent qui paie clique sur **Marquer payé** sur l'échéance du mois. Le parent qui reçoit voit alors apparaître **Confirmer** (le versement est acté) ou **Contester** (avec un motif) s'il estime ne pas l'avoir reçu.",
        },
        {
          q: "Comment modifier le montant ou la date de la pension ?",
          a: "Bouton **Modifier le montant** à côté de la pension active — cela crée une nouvelle proposition (montant, jour, date) que l'autre parent doit à nouveau confirmer, exactement comme à la configuration initiale.",
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
          a: "Onglet **EDT** (réservé Premium/Trial Premium, non disponible en formule gratuite) → sélectionne l'enfant (s'il y en a plusieurs) puis le jour de la semaine → **+ Ajouter** → renseigne matière, professeur, horaires, salle et bâtiment.",
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
        {
          q: "Qui obtient le statut Premium par héritage dans une famille ?",
          a: "Le statut affiché à chaque membre (parent, enfant, observateur) correspond au **meilleur des deux abonnements des parents** de la famille. Si un seul des deux parents souscrit à Premium, toute la famille en profite — l'autre parent voit alors « **Premium hérité** » plutôt que « Premium », avec un bandeau « 👨‍👩‍👧 Premium via votre famille » précisant qui a souscrit. Seul un tour de roue gagné compte comme « payeur réel » : gagner du Premium à la roue reste réservé à qui a effectivement souscrit, pas à qui en bénéficie par héritage.",
        },
        {
          q: "Comment fonctionne l'abonnement si j'appartiens à plusieurs familles (ex. des enfants avec deux ex-conjoints différents) ?",
          a: "Le statut Premium est calculé **indépendamment pour chaque famille**, à partir des DEUX parents de cette famille précise. Si tu as toi-même un abonnement Premium personnel et que tu es parent actif dans plusieurs familles, il s'applique à chacune d'elles — tu ne payes qu'une fois. En revanche, être Premium dans une famille ne rend pas Premium une autre famille où tu ne serais qu'observateur : dans ce cas, c'est l'abonnement des parents de CETTE famille-là qui compte, pas le tien.",
        },
      ],
    },
    {
      id: "assistant",
      icon: "🤖",
      title: "Assistant IA",
      items: [
        {
          q: "Qu'est-ce que l'assistant IA et où le trouver ?",
          a: "Un bouton flottant 🤖 (visible en bas de l'écran) ouvre une fenêtre de discussion. Réservé aux abonnements **Premium+IA** — les autres formules ne voient pas ce bouton.",
        },
        {
          q: "Que peut lui demander l'assistant IA ?",
          a: "Deux types de questions : des questions générales sur l'utilisation de l'app (\"comment inviter un observateur ?\"), et des questions sur les données de TA propre famille (nombre de jours de garde sur une période, solde des dépenses, météo, résumé de messages) — il va chercher les vraies données avant de répondre, il n'invente rien. Il peut aussi reformuler un message tendu avant l'envoi, ou traduire un texte.",
        },
        {
          q: "Y a-t-il une limite d'utilisation de l'assistant IA ?",
          a: "Oui, un quota quotidien de tokens (unité de calcul de l'IA), affiché sous forme de barre de progression en haut de la fenêtre de l'assistant — elle se réinitialise chaque jour à minuit (heure de Paris). Au-delà, l'assistant indique que la limite du jour est atteinte et invite à réessayer le lendemain.",
        },
        {
          q: "Comment masquer rapidement l'assistant IA s'il gêne ce qu'il y a derrière ?",
          a: "Double-tape n'importe où sur l'écran : la bulle (et la fenêtre de discussion si elle était ouverte) se masque instantanément. Un second double-tap la fait réapparaître au même endroit.",
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
    {
      id: "aide",
      icon: "🛟",
      title: "Aide, avis et installation",
      items: [
        {
          q: "Comment signaler un bug ?",
          a: "Menu ☰ → **🐛 Signaler un problème** → décris le souci dans le champ de texte, coche la case pour joindre une capture d'écran de l'app si elle peut aider (elle est prise automatiquement avant l'ouverture de la fenêtre), puis envoie.",
        },
        {
          q: "Comment donner mon avis sur l'application ?",
          a: "Menu ☰ → **⭐ Donner mon avis** → choisis une note de 1 à 5 étoiles et ajoute un commentaire si tu veux. Tu peux revenir modifier ton avis plus tard, un seul avis est conservé par compte.",
        },
        {
          q: "Comment installer Duvia sur mon téléphone (comme une vraie application) ?",
          a: "Menu ☰ → **📱 Installer l'application**. Sur iPhone/iPad (Safari) : ouvre le bouton **Partager** (▢↑) en bas de l'écran → **Ajouter à l'écran d'accueil**. Sur Android (Chrome) : bouton menu (⋮) en haut à droite → **Installer l'application** (ou **Ajouter à l'écran d'accueil**) → **Ajouter**.",
        },
        {
          q: "Où voir l'historique des modifications de la famille ?",
          a: "Menu ☰ → **📋 Historique** : un journal permanent, non modifiable et horodaté par le serveur, de toutes les modifications (calendrier, dépenses, coffre, messages, contacts, famille). Il est conservé même si un parent quitte la famille, et un tap sur une entrée ouvre directement l'onglet concerné.",
        },
      ],
    },
    {
      id: "compte",
      icon: "💾",
      title: "Sauvegarde et compte",
      items: [
        {
          q: "Comment exporter mes données ?",
          a: "Menu ☰ → **⚙️ Préférences** → section **Sauvegarde de mes données** → **📤 Exporter mes données** : télécharge un fichier `.duvia` contenant la configuration famille, le calendrier de garde et l'emploi du temps scolaire.",
        },
        {
          q: "Comment restaurer une sauvegarde ?",
          a: "Même section → **📥 Importer une sauvegarde** → choisis un fichier `.duvia` précédemment exporté.",
        },
        {
          q: "Que fait « Supprimer la sauvegarde locale » et est-ce risqué ?",
          a: "Aucun risque pour tes données réelles : ce bouton efface uniquement une copie de secours stockée SUR CET APPAREIL (dans le navigateur), utilisée en cas de coupure réseau. Toutes les données de la famille restent intactes sur le serveur Duvia — cette action ne supprime rien côté serveur, seulement le cache local de cet appareil.",
        },
        {
          q: "Que se passe-t-il si je supprime mon compte ?",
          a: "Action définitive et immédiate : ton compte est supprimé, tu es retiré(e) des contacts de la famille, et tes messages restent visibles mais marqués « compte supprimé ». Si tu es le dernier parent de la famille, tous les documents, pièces jointes et messages de la famille sont aussi supprimés définitivement. Un abonnement Premium en cours est annulé côté Duvia — pense à le résilier aussi depuis ton gestionnaire de paiement (App Store/Google Play/etc.) pour éviter un prélèvement. La modale de suppression propose un bouton **💾 Télécharger mes données avant** pour garder une sauvegarde `.duvia` en dernier recours (un observateur ou un enfant ne peut télécharger que sa propre fiche d'identité, pas les données de la famille).",
        },
      ],
    },
  ],
};
