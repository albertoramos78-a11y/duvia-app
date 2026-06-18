// ── Configuration globale Duvia ──────────────────────────────────────────────

export const APP_URL = "https://app.duvia.fr";

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