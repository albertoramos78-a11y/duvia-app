// ─────────────────────────────────────────────────────────────────────────────
// src/utils/core.js
//
// Fonctions PURES extraites de App.jsx, avec les correctifs de cette session.
// But : pouvoir les tester unitairement (App.jsx ≈ 11 500 lignes de React n'est
// pas importable côté Node) ET amorcer une sortie progressive du fichier unique.
//
// Pour brancher dans App.jsx : remplacer les définitions locales correspondantes
// par `import { validatePassword, getMothersDayDate, ... } from "./utils/core.js"`.
// La logique est identique à celle d'App.jsx ; seuls les correctifs documentés
// ci-dessous diffèrent de la version d'origine.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from "../config.js";

// ── Dates locales (corrige le bug de fuseau horaire) ─────────────────────────
// toStr renvoie la date du CALENDRIER LOCAL. `new Date().toISOString().slice(0,10)`
// renvoyait la date UTC → décalée d'un jour pour un utilisateur Europe/Paris
// près de minuit (et systématiquement en heure d'été pour minuit→01:59).
export const pad = (n) => String(n).padStart(2, "0");
export function toStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Nettoyage texte ──────────────────────────────────────────────────────────
export function sanitize(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "")
    .trim();
}

// ── Filtre insultes ───────────────────────────────────────────────────────────
export const LONG_BAD = [
  "connard","connarde","connards","connardes",
  "merde","merdique","merdeuse",
  "putain","putains","salopard","salopards","saloperie","salope","salopes",
  "enculer","encule","enculé","enculée","enculés","enculées",
  "filsdeput","filsdepute","fillesdepute",
  "batard","bâtard","bastard","batards","bâtards","bastards",
  "ordure","ordures","raclure","raclures","pourriture","pourritures",
  "abruti","abrutie","abrutis","cretin","cretins","cretine","imbecile","imbeciles","debile","debiles",
  "gueule","gueules","fermetagueule","tafermerlague",
  "pedale","pedales","tapette","tapettes","faggot","faggots",
  "nazi","nazis","fasciste","fascistes","terroriste","terroristes",
  "suicider","tuetoi","suicide","vadiecrever","vacrever","creve",
  "vatefoutre","vatefaire","niquer",
  "jevaistuer","jevaiskiller","jetuer","jevaistemasser",
  "jedeteste","jetedeteste","jetehais","vatefair",
  "fuck","fucking","fucked","fucker","fuckers","fuckoff",
  "shit","shitty","bullshit",
  "bitch","bitches",
  "asshole","assholes","dickhead","motherfucker","motherfucking",
  "cunt","cunts","whore","whores","slut","sluts",
  "nigger","niggers","nigga",
  "retarded","morons",
  "killurself","killyourself","godie","godieinfiredie",
];

export const SHORT_BAD = [
  "con","conne","cul","culs","pd","pds","tg","fdp","ntm","kys",
  "nique","pute","putes","bite","bites","kike","mdr","lol",
  "fick","kak","scheiss",
];

export function _prepFilter(str) {
  let s = String(str).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
    .replace(/4/g, "a").replace(/5/g, "s").replace(/@/g, "a")
    .replace(/\$/g, "s").replace(/€/g, "e").replace(/!/g, "i")
    .replace(/(.)\1+/g, "$1");
  for (let i = 0; i < 6; i++) s = s.replace(/([a-z])[.\-_*+|]+([a-z])/g, "$1$2");
  return s;
}

export function containsBadWord(text) {
  const prep = _prepFilter(text);
  const noSpc = prep.replace(/\s+/g, "");
  for (const w of LONG_BAD) {
    const nw = _prepFilter(w).replace(/\s/g, "");
    if (noSpc.includes(nw)) return true;
  }
  const words = prep.split(/[\s,!?;:.'"()\[\]]+/).filter(Boolean);
  for (const w of SHORT_BAD) {
    const nw = _prepFilter(w);
    if (words.includes(nw)) return true;
  }
  return false;
}
export function isCleanText(text) { return !containsBadWord(text); }

// ── Email / téléphone ─────────────────────────────────────────────────────────
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
export function normalizePhoneDigits(p) {
  if (!p) return "";
  let c = String(p).trim().replace(/[\s.\-()]/g, "");
  c = c.replace(/^\+/, "");
  if (c.startsWith("00")) c = c.slice(2);
  else if (c.startsWith("0")) c = "33" + c.slice(1);
  return c.replace(/\D/g, "");
}
export function isLikelyPhoneIdentifier(v) {
  if (!v || v.includes("@")) return false;
  return normalizePhoneDigits(v).length >= 8;
}
export function identifierToAuthEmail(v) {
  const raw = (v || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw.toLowerCase();
  return `tel${normalizePhoneDigits(raw)}@phone.duvia.app`;
}

// ── Mot de passe ──────────────────────────────────────────────────────────────
// CORRECTIF : la version d'origine ne vérifiait QUE la longueur. Le cahier des
// charges impose ≥ 1 majuscule + ≥ 1 caractère spécial, avec message dédié.
export function validatePassword(pw) {
  if (!pw || pw.length < LIMITS.PASSWORD_MIN) return `Mot de passe trop court (${LIMITS.PASSWORD_MIN} caractères min.)`;
  if (pw.length > LIMITS.PASSWORD_MAX) return "Mot de passe trop long.";
  if (!/[A-ZÀ-ÖØ-Þ]/.test(pw)) return "Le mot de passe doit contenir au moins une majuscule.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Le mot de passe doit contenir au moins un caractère spécial (ex : ! ? @ # $).";
  return null;
}

// ── Code parrain ──────────────────────────────────────────────────────────────
export function makeRefCode(id, email) {
  const b = (email || "").split("@")[0].replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4).padEnd(4, "X");
  return `DUV-${b}-${String(id).slice(-4).padStart(4, "0")}`;
}

// ── Fichiers coffre-fort ──────────────────────────────────────────────────────
export const ALLOWED_VAULT_TYPES = [
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
  "image/heic", "image/heif",
];
export const ALLOWED_VAULT_EXTS = [".pdf",".jpg",".jpeg",".png",".webp",".gif",".heic",".heif"];
export function validateVaultFile(file) {
  if (!file) return null;
  const ext = "." + file.name.split(".").pop().toLowerCase();
  const typeOk = ALLOWED_VAULT_TYPES.includes(file.type) || ALLOWED_VAULT_EXTS.includes(ext);
  if (!typeOk) return `Type de fichier non autorisé. Formats acceptés : PDF, JPG, PNG, WebP`;
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > LIMITS.FILE_MAX_MB) return `Fichier trop lourd (max ${LIMITS.FILE_MAX_MB} MB). Ce fichier fait ${sizeMB.toFixed(1)} MB.`;
  return null;
}

// ── Anti-spam messages ────────────────────────────────────────────────────────
// Fabrique un limiteur isolé (la version App.jsx utilise un tableau module-level
// partagé ; ici on en fait une factory pour pouvoir le tester proprement).
export function makeMsgRateLimiter(maxPerMin = LIMITS.MSG_PER_MIN, now = Date.now) {
  const stamps = [];
  return function check() {
    const t = now();
    while (stamps.length && stamps[0] < t - 60000) stamps.shift();
    if (stamps.length >= maxPerMin) return false;
    stamps.push(t);
    return true;
  };
}

// ── Jours fériés mobiles / fêtes ──────────────────────────────────────────────
export function easterDate(y) {
  const a = y % 19, b = ~~(y / 100), c = y % 100, d = ~~(b / 4), e = b % 4,
    f = ~~((b + 8) / 25), g = ~~((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = ~~(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m2 = ~~((a + 11 * h + 22 * l) / 451),
    mo = ~~((h + l - 7 * m2 + 114) / 31), dy = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(y, mo - 1, dy);
}
export function pentecostDate(y) {
  const e = easterDate(y);
  const p = new Date(e);
  p.setDate(e.getDate() + 49); // 7e dimanche après Pâques
  return p;
}
export function nthWeekday(y, month, weekday, n) {
  if (n > 0) {
    let d = new Date(y, month, 1), count = 0;
    while (count < n) { if (d.getDay() === weekday) count++; if (count < n) d.setDate(d.getDate() + 1); }
    return d;
  } else {
    let d = new Date(y, month + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }
}
export function sameDay(d1, d2ref) {
  return !!(d1 && d2ref &&
    d1.getFullYear() === d2ref.getFullYear() &&
    d1.getMonth() === d2ref.getMonth() &&
    d1.getDate() === d2ref.getDate());
}
export function getEventDate(y, rule) {
  if (!rule) return null;
  if (rule.fixed) return new Date(y, rule.fixed[0], rule.fixed[1]);
  const [month, weekday, nth] = rule;
  return nthWeekday(y, month, weekday, nth);
}

export const MOTHERS_DAY = {
  FR: [4, 0, -1], BE: [4, 0, 2], LU: [4, 0, -1], CH: [4, 0, 2], AT: [4, 0, 2],
  DE: [4, 0, 2], NL: [4, 0, 2], IT: [4, 0, 2], ES: [4, 0, 1], PT: [4, 0, 1],
  GB: [2, 0, 4], IE: [2, 0, 4], CA: [4, 0, 2], PL: { fixed: [4, 26] },
  CZ: [4, 0, 2], SK: [4, 0, 2], HR: { fixed: [4, 22] },
};

// CORRECTIF : règle légale française (art. D215-1 CASF). La Fête des Mères est le
// dernier dimanche de mai, SAUF si ce jour coïncide avec la Pentecôte, auquel cas
// elle est reportée au 1er dimanche de juin. La version d'origine renvoyait
// toujours le dernier dimanche de mai (faux les années de coïncidence, ex. 2023).
export function getMothersDayDate(y, country) {
  const base = getEventDate(y, MOTHERS_DAY[country] || MOTHERS_DAY["FR"]);
  if (country === "FR" && base && sameDay(base, pentecostDate(y))) {
    return nthWeekday(y, 5, 0, 1); // 1er dimanche de juin
  }
  return base;
}

// ── Verrouillage de l'email d'un parent ──────────────────────────────────────
// L'email est l'identifiant de connexion (« lié au compte »). Il n'est éditable
// que sur un créneau non réclamé par un compte (créateur saisissant l'email du
// parent 2 à la main avant l'invitation). Verrouillé sinon — notamment empêche
// l'invité de modifier l'email de l'autre parent (cas index 0 = créateur).
export function isParentEmailLocked(slot, slotIndex, userParentIdx) {
  if (userParentIdx === slotIndex) return true;           // mon propre email
  if (slot && slot.inviteStatus === "accepted") return true;
  if (slot && slot.userId) return true;                    // a rejoint
  if (slotIndex === 0) return true;                        // créateur
  return false;
}

// ── Consentement RGPD (écran de première utilisation) ────────────────────────
// L'acceptation de la politique de confidentialité est enregistrée UNE fois,
// avec sa version + horodatage (preuve en cas de contrôle CNIL). On la
// redemande uniquement si la version change.
export const RGPD_STORAGE_KEY = "duvia_rgpd_consent";

export function makeRgpdConsentRecord(version, nowIso) {
  return { version, acceptedAt: nowIso || new Date().toISOString() };
}

// Reçoit la chaîne brute stockée (ou null) + la version courante. Renvoie true
// seulement si une acceptation valide pour CETTE version est présente.
export function isRgpdConsentValid(rawStored, currentVersion) {
  if (!rawStored) return false;
  try {
    const rec = typeof rawStored === "string" ? JSON.parse(rawStored) : rawStored;
    return !!rec && rec.version === currentVersion && !!rec.acceptedAt;
  } catch {
    return false;
  }
}

// ── Réconciliation des parents (correctif validation d'invité) ───────────────
// Contexte du bug : dans le flux d'invitation par lien/token, l'invité rejoint
// en `pending` sans pouvoir écrire la donnée famille (RLS). La RPC de validation
// ne fait que basculer family_members.status='active' — elle n'inscrit jamais
// l'invité dans families.data.parents. Résultat : l'invité validé n'apparaît
// nulle part. Ces helpers réparent la donnée partagée côté client.

export const PARENT_COLORS = ["#f97316","#06b6d4","#10b981","#f59e0b","#ec4899","#ef4444"];

export function placeholderNameFromEmail(email) {
  return email ? String(email).split("@")[0] : "";
}

// Côté inviteur : inscrit le membre validé en position parent 2 (index 1).
// Le créateur reste en index 0. N'écrase pas un nom déjà présent.
// Ordre de préférence pour le nom : displayName (renseigné par l'invité côté
// serveur) > nom déjà présent > partie locale de l'email > "Parent 2".
export function insertValidatedParent(parents, member) {
  if ((member?.role || "parent") !== "parent") return parents ? [...parents] : [];
  const out = [...(parents || [])];
  while (out.length < 2) out.push({});
  const idx = 1;
  const existing = out[idx] || {};
  const name = member.displayName || existing.name || placeholderNameFromEmail(member.email) || "Parent 2";
  out[idx] = {
    ...existing,
    userId: member.userId,
    name,
    email: existing.email || member.email || "",
    gender: member.gender || existing.gender || "M",
    color: existing.color || PARENT_COLORS[idx % PARENT_COLORS.length],
    inviteStatus: "accepted",
  };
  return out;
}

// Côté invité : à sa connexion validée, remplace le nom provisoire (partie
// locale de l'email, posé par l'inviteur) par son vrai nom. Retourne le tableau
// `parents` mis à jour, ou null si aucun changement (pas mon créneau, ou un vrai
// nom est déjà là). `me` = profil local, `uid` = identifiant Supabase Auth.
export function reconcileOwnParentSlot(parents, me, uid) {
  if (!me || me.role !== "parent") return null;
  const out = [...(parents || [])];
  let slot = out.findIndex(p => p && (p.userId === uid || (p.email && p.email === me.email)));
  if (slot < 0 && typeof me.parentIdx === "number") slot = me.parentIdx;
  if (slot < 0) return null;
  const existing = out[slot] || {};
  const placeholder = placeholderNameFromEmail(me.email);
  const nameMissing = !existing.name || existing.name === placeholder;
  if (!nameMissing || !me.name) return null;
  out[slot] = {
    ...existing, userId: uid,
    name: me.name,
    email: existing.email || me.email || "",
    gender: existing.gender || me.gender || "M",
    phone: existing.phone || me.phone || "",
    inviteStatus: existing.inviteStatus || "accepted",
  };
  return out;
}

// ── Helpers messagerie (dédup) ────────────────────────────────────────────────
// CORRECTIF : Supabase diffuse l'INSERT realtime à l'émetteur aussi, qui a déjà
// ajouté le message en optimiste → doublon. On déduplique par id.
export function upsertMessageById(list, msg) {
  return list.some((m) => m.id === msg.id) ? list : [...list, msg];
}
export function addReader(msg, userId) {
  const readBy = msg.read_by ?? [];
  if (readBy.includes(userId)) return msg; // pas de doublon de lecteur
  return { ...msg, read_by: [...readBy, userId] };
}

// ── Départ d'un parent (multi-familles) ──────────────────────────────────────
// Marque comme « parti » (left:true) tout parent dont l'adhésion n'est plus
// active, SANS le retirer du tableau : son identité (nom, couleur) reste à sa
// place pour préserver l'attribution des dépenses et de la garde, qui sont
// indexées par POSITION. Un parent redevenu actif (ré-invitation acceptée)
// repasse non-parti. Retourne un nouveau tableau si quelque chose change, sinon
// null (pour éviter un setCfg inutile).
export function markDepartedParents(parents, inactiveUserIds) {
  if (!Array.isArray(parents)) return null;
  const inactive = inactiveUserIds instanceof Set ? inactiveUserIds : new Set(inactiveUserIds || []);
  let changed = false;
  const out = parents.map(p => {
    if (!p) return p;
    const gone = !!(p.userId && inactive.has(p.userId));
    if (gone && !p.left) { changed = true; return { ...p, left: true }; }
    if (!gone && p.left) { changed = true; const { left, ...rest } = p; return rest; }
    return p;
  });
  return changed ? out : null;
}

// Index du parent « créateur » EFFECTIF = premier parent non-parti. Sert à
// étiqueter les cartes (Créateur / Invité) sans dépendre de la position 0 :
// si le créateur d'origine est parti, le parent restant devient créateur de
// fait. Retourne 0 par défaut (tableau vide ou tous partis).
export function effectiveCreatorIdx(parents) {
  if (!Array.isArray(parents)) return 0;
  const i = parents.findIndex(p => p && !p.left);
  return i < 0 ? 0 : i;
}
