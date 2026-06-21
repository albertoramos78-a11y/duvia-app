// ── Configuration globale Duvia ──────────────────────────────────────────────

export const APP_URL = "https://app.duvia.fr";

// Version de l'application (incrémente à chaque release). Utilisée notamment
// par le service de diagnostic pour horodater les rapports de bug.
export const APP_VERSION = "0.1.0";

// ── Liens légaux ─────────────────────────────────────────────────────────────
// ⚠️ PROVISOIRE : en attendant les vraies pages (à générer via iubenda), les
// deux liens pointent vers le site principal pour ne pas créer de lien cassé.
// Le jour où tes pages existent, remplace simplement ces deux URL.
export const PRIVACY_URL = "https://app.duvia.fr";
export const CGU_URL     = "https://app.duvia.fr";

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