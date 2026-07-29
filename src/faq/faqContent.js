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
        {
          q: "Comment exporter mon calendrier sur Google (ou Apple) ?",
          a: "Dans le calendrier, ouvre le menu **⋯** (en haut) → **iCal**. Le fichier `.ics` téléchargé s'importe dans Google Calendar, Apple Calendar ou tout autre agenda compatible.",
        },
        {
          q: "Comment exporter le planning en PDF ?",
          a: "Dans le calendrier, menu **⋯** → **Export PDF** (réservé Premium) : génère un récapitulatif imprimable du planning de garde sur l'année.",
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
          a: "Les deux ont accès au **Calendrier**, à la fiche **Enfant**, aux **Contacts** et à la **Messagerie** — mais PAS aux **Dépenses** ni au **Coffre-fort**, réservés aux parents. L'**enfant** a en plus son propre **Emploi du temps** en lecture seule (pas l'observateur) ; l'**observateur**, lui, a en plus accès à la roue de récompenses (**Jeu**), au **Parrainage** et à **Donner mon avis** (pas l'enfant). Seuls les parents peuvent modifier la configuration de la famille (modèle de garde, dates spéciales, invitations) via **Configuration famille** — ni un enfant ni un observateur n'y ont accès.",
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
        {
          q: "Comment démarrer une nouvelle conversation ?",
          a: "Onglet **Messages** → bouton **✏️ Nouveau** en haut de la liste → sélectionne un ou plusieurs contacts → envoie ton premier message pour créer la conversation.",
        },
        {
          q: "Comment savoir si j'ai des messages non lus ?",
          a: "Un badge numéroté apparaît sur l'icône **Messages** du menu, et sur chaque conversation contenant des messages non lus dans la liste.",
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
        {
          q: "Comment supprimer une notification ?",
          a: "Menu ☰ → **🔔 Notifications** → bouton **🗑** sur la notification concernée, ou **🗑 Tout supprimer** en haut de la liste pour toutes les effacer d'un coup.",
        },
        {
          q: "Comment marquer mes notifications comme lues ?",
          a: "Toucher une notification l'ouvre, la marque lue et t'emmène directement vers l'onglet concerné. Le bouton **Tout lu** en haut de la liste marque tout comme lu en un tap.",
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
          q: "Comment créer une deuxième famille (ex. famille recomposée, enfants de plusieurs unions) ?",
          a: "Menu ☰ → **Configuration famille** → onglet **Famille**, section **👪 Mes familles** → **+ Créer Famille**. Confirme, puis un sélecteur de famille apparaît en haut de l'app pour basculer entre tes familles. Réservé aux parents — chaque famille a sa propre configuration, son calendrier et son abonnement indépendants.",
        },
        {
          q: "Comment fonctionne l'abonnement si j'appartiens à plusieurs familles (ex. des enfants avec deux ex-conjoints différents) ?",
          a: "Le statut Premium est calculé **indépendamment pour chaque famille**, à partir des DEUX parents de cette famille précise. Si tu as toi-même un abonnement Premium personnel et que tu es parent actif dans plusieurs familles, il s'applique à chacune d'elles — tu ne payes qu'une fois. En revanche, être Premium dans une famille ne rend pas Premium une autre famille où tu ne serais qu'observateur : dans ce cas, c'est l'abonnement des parents de CETTE famille-là qui compte, pas le tien.",
        },
      ],
    },
    {
      id: "roue",
      icon: "🎡",
      title: "Roue Duvia et thèmes",
      items: [
        {
          q: "Comment fonctionne la roue Duvia ?",
          a: "Onglet **Jeu** (🎡, parents et observateurs uniquement — pas les enfants) → tourne la roue une fois le délai d'attente écoulé, **7 jours** pour tout le monde. Réservée aux familles **Premium** (Trial, Premium, Premium+IA) — verrouillée en formule gratuite, aussi bien pour un parent que pour un observateur. Exception : un tour de roue gagné par parrainage reste jouable même verrouillé (voir ci-dessous), mais sans jamais pouvoir faire gagner un abonnement gratuit.",
        },
        {
          q: "Quels lots peut-on gagner à la roue ?",
          a: "Des thèmes visuels de l'application : **🎮 Jeu vidéo**, **🦄 Licorne** (permanents), et les thèmes saisonniers **🌴 Été**, **🎾 Tennis** (Roland-Garros) et **⚽ Coupe du monde** (uniquement pendant leur période de l'année). Pour le parent qui paie réellement Premium (pas pour un parent couvert par le Premium de son co-parent, ni pour un observateur), la roue peut aussi faire gagner **1 mois** ou **1 an** d'abonnement offert.",
        },
        {
          q: "Comment utiliser les thèmes ?",
          a: "Une fois débloqué (roue, cadeau reçu ou parrainage validé), un bouton **🏆** apparaît en haut de l'écran, à côté du bouton palette. Touche-le pour voir la liste de tes thèmes disponibles, puis **Appliquer** sur celui que tu veux — un seul thème actif à la fois. Pour revenir au mode normal, retouche-le (il affiche alors **Actif ✓**) ou utilise le bouton palette 🎨.",
        },
        {
          q: "Comment gagner des tours de roue supplémentaires ?",
          a: "Chaque filleul parrainé qui valide son compte (menu ☰ → **🎁 Parrainage**, accessible aux parents comme aux observateurs) t'offre un tour de roue en plus. Ce tour reste utilisable même si tu es par ailleurs verrouillé (famille freemium) — il permet de gagner un thème, mais jamais un abonnement gratuit.",
        },
        {
          q: "Peut-on acheter un thème directement, sans passer par la roue ?",
          a: "Une boutique (🎨, dans l'onglet Jeu, réservée aux adultes Premium — parents et observateurs) permet de choisir un thème pour soi ou de l'offrir à un enfant. **Pendant la bêta actuelle, les achats sont désactivés** : la roue reste le seul moyen d'obtenir un thème, gratuitement, en tournant chaque fois que le délai d'attente est passé.",
        },
      ],
    },
    {
      id: "assistant",
      icon: "🤖",
      title: "Assistant IA",
      items: [
        {
          q: "Qu'est-ce que l'assistant et où le trouver ?",
          a: "Un bouton flottant (🤖 ou 📚 selon ton abonnement) en bas de l'écran ouvre une fenêtre de discussion, visible pour **tous les parents**. En Freemium/Premium, il répond gratuitement et instantanément aux questions sur l'utilisation de l'app et sur l'agenda de garde, sans IA. En **Premium+IA**, il devient un assistant conversationnel complet.",
        },
        {
          q: "Que peut-on lui demander ?",
          a: "En Freemium/Premium : questions sur l'utilisation de l'app (\"comment inviter un observateur ?\") et sur l'agenda (\"chez qui est l'enfant aujourd'hui ?\", \"prochain changement de garde ?\", \"planning de la semaine ?\"). En **Premium+IA** en plus : dépenses, météo, résumé de messages, reformulation de message, traduction — il va chercher les vraies données avant de répondre, il n'invente rien.",
        },
        {
          q: "Y a-t-il une limite d'utilisation de l'assistant ?",
          a: "Uniquement pour les questions traitées par l'IA (**Premium+IA**) : un quota quotidien de tokens, affiché en barre de progression en haut de la fenêtre — se réinitialise chaque jour à minuit (heure de Paris). Les réponses FAQ/agenda (Freemium/Premium, sans IA) sont illimitées et gratuites, elles ne consomment pas ce quota.",
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
        {
          q: "Comment configurer la Fête des Mères et la Fête des Pères ?",
          a: "Onglet **Dates spéciales** (Configuration famille) → active **🌸 Fête des Mères** et/ou **🎩 Fête des Pères** : la garde est automatiquement forcée sur ce parent ce jour-là.",
        },
        {
          q: "Anniversaire des parents : comment ça marche ?",
          a: "Onglet **Dates spéciales** (Configuration famille) → **🎂 Anniversaires des parents** : la garde est automatiquement forcée sur le parent dont c'est l'anniversaire.",
        },
        {
          q: "Anniversaire de mon enfant : comment ça marche ?",
          a: "Onglet **Dates spéciales** (Configuration famille) → **🎁 Anniversaires des enfants** : choisis quel parent a la garde selon que l'année est paire ou impaire.",
        },
        {
          q: "Comment changer mon mot de passe (MDP) ?",
          a: "Menu ☰ → **⚙️ Préférences** → **🔒 Changer mon mot de passe** → mot de passe actuel, puis nouveau (8 caractères minimum, une majuscule, un caractère spécial) et confirmation. Si tu t'es connecté(e) avec Google, ça se gère directement sur myaccount.google.com, pas dans Duvia.",
        },
        {
          q: "Comment changer mon adresse email ?",
          a: "Menu ☰ → **⚙️ Préférences** → **✉️ Changer mon adresse email** → saisis la nouvelle adresse → **Envoyer la confirmation**. Un email de validation part sur la nouvelle adresse ; l'ancienne reste active tant que tu n'as pas confirmé.",
        },
        {
          q: "Comment changer ma photo de profil ?",
          a: "Menu ☰ → **Configuration famille** → onglet **Famille** → touche ta propre bulle d'avatar (parent) → icône **🖼️** (galerie) ou **📷** (appareil photo) dans le sélecteur qui s'ouvre. Fonctionne aussi pour l'avatar de chaque enfant ou observateur, depuis leur propre carte.",
        },
      ],
    },
    {
      id: "enfant",
      icon: "🧒",
      title: "Infos enfant",
      items: [
        {
          q: "Comment renseigner les allergies de mon enfant ?",
          a: "Menu ☰ → **Configuration famille** → onglet **Famille**, section **Enfants** → ouvre la fiche de l'enfant concerné → champ **Allergies**. La même fiche a aussi **Groupe sanguin**, **École**, **Médecin** et **Contacts d'urgence**. Un enfant ou un observateur sans accès à Configuration famille peut consulter ces infos (lecture seule) via l'onglet **🧒 Infos enfant**.",
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
          q: "Comment contacter le support Duvia ?",
          a: "Utilise **Signaler un problème** (menu ☰ → **🐛 Signaler un problème**), même pour une question qui n'est pas un bug technique — c'est le canal qui arrive directement à l'équipe Duvia.",
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
