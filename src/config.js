// ── Configuration globale Duvia ──────────────────────────────────────────────

export const APP_URL = "https://app.duvia.fr";

// Version de l'application — à incrémenter à CHAQUE déploiement (1.00, 1.01, 1.02...),
// même pour un simple correctif visuel. Utilisée par le service de diagnostic pour
// horodater les rapports de bug, ET recopiée manuellement dans public/sw.js (le
// service worker ne peut pas importer ce fichier) : c'est ce qui force les
// navigateurs/PWA installées à détecter une nouvelle version et proposer le
// rafraîchissement ("Nouvelle version disponible") — sans ce changement d'octets
// dans sw.js, la mise à jour de l'app peut rester invisible indéfiniment pour un
// utilisateur qui ne ferme jamais complètement l'appli.
export const APP_VERSION = "1.58";

// ── Liens légaux ─────────────────────────────────────────────────────────────
// CGU/CGV/Politique de confidentialité sont affichées directement dans l'app
// (voir LegalDocModal dans App.jsx, contenu source dans docs/legal/) — plus
// besoin d'URL externe pour elles.

// Version de la politique de confidentialité acceptée par l'utilisateur.
// Incrémente cette valeur quand le texte change → le consentement sera
// redemandé (preuve d'acceptation horodatée par version).
export const RGPD_NOTICE_VERSION = "2026-06-01";

export const LIMITS = {
  NAME_MAX:      60,    // longueur max d'un nom
  EMAIL_MAX:     120,   // longueur max d'un email
  PASSWORD_MIN:  8,     // mot de passe minimum
  PASSWORD_MAX:  72,    // bcrypt max
  MSG_MAX:       2000,  // caractères max par message
  MSG_PER_MIN:   10,    // messages max par minute (anti-spam)
  LABEL_MAX:     100,   // description dépense
  NOTES_MAX:     500,   // notes document
  AMOUNT_MAX:    99999, // montant max dépense (€)
  AMOUNT_MIN:    0.01,  // montant minimum
  FILE_MAX_MB:   15,    // taille max fichier vault (MB)
  DOC_NAME_MAX:  100,   // nom document
};

export const PCOLS = ["#f97316","#06b6d4","#10b981","#f59e0b","#ec4899","#ef4444"];