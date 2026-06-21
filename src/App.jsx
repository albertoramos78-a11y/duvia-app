import { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from "react";
import { supabase } from "./supabaseClient";
import { initDiagnostics, retryPendingReport, submitBugReport } from "./services/diagnostics";
import { useVault } from "./hooks/useVault";
import { useMessages } from "./hooks/useMessages";
import { useIdLinks } from "./hooks/useIdLinks";
import { TR } from './i18n/index.js';
import { APP_URL, LIMITS, PRIVACY_URL, CGU_URL, RGPD_NOTICE_VERSION } from './config.js';
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked } from './utils/core.js';
import { DARK, LIGHT, SUMMER, RG, RG_START, RG_END, WC, WC_START, WC_END, SUMMER_START, SUMMER_END, VIDEO, BRAND, PCOLS, isRGPeriod, isWCPeriod, isSummerPeriod } from './theme.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT — léger, basé sur fetch (pas de npm supplémentaire)
// Variables à définir dans .env :
//   VITE_SUPABASE_URL=https://xxx.supabase.co
//   VITE_SUPABASE_ANON_KEY=eyJhbG...
// ═══════════════════════════════════════════════════════════════════════════════
// ⚠️  Avant déploiement Vercel : remplace les "" par tes vraies clés Supabase
//     URL  → https://xxx.supabase.co
//     KEY  → eyJhbGci... (clé anon publique)
// ═══════════════════════════════════════════════════════════════════════════════
const _SUPA_URL = "https://ifhriyvvqkwqgzmrjjxp.supabase.co";
const _SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmaHJpeXZ2cWt3cWd6bXJqanhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDg0NjEsImV4cCI6MjA5NzAyNDQ2MX0.7OoRpsQccKcM6OdNU6gD-sQEqZpV8HnXSDIA5HJSZ4Q";
const _supaReady = Boolean(_SUPA_URL && _SUPA_KEY);

async function _supaFetch(path, options = {}) {
  if (!_supaReady) throw new Error("Supabase non configuré (variables VITE_ manquantes).");
  const res = await fetch(`${_SUPA_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": _SUPA_KEY,
      "Authorization": `Bearer ${_SUPA_KEY}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `Erreur HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function _supaFunction(name, body = {}) {
  if (!_supaReady) throw new Error("Supabase non configuré.");
  const res = await fetch(`${_SUPA_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${_SUPA_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `Erreur Edge Function ${res.status}`);
  }
  return res.json().catch(() => null);
}

// Edge Function → voir fichier séparé : supabase/functions/delete-account/index.ts


// Preserve scroll position when expanding accordions
// ═══════════════════════════════════════════════════════════════════════════════
// SÉCURITÉ — Validation & Sanitization
// ═══════════════════════════════════════════════════════════════════════════════

// Limites globales
// LIMITS imported from src/config.js

// Types de fichiers autorisés dans le vault
const ALLOWED_VAULT_TYPES = [
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
  "image/heic", "image/heif",
];
const ALLOWED_VAULT_EXTS = [".pdf",".jpg",".jpeg",".png",".webp",".gif",".heic",".heif"];

// Supprime les balises HTML et caractères dangereux d'un texte
function sanitize(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/<[^>]*>/g, "")           // supprime les balises HTML
    .replace(/javascript:/gi, "")       // supprime javascript:
    .replace(/on\w+\s*=/gi, "")         // supprime onXxx=
    .trim();
}

// ── Filtre insultes ───────────────────────────────────────────────────────────
// Deux listes séparées pour éviter les faux positifs :
// - LONG_BAD : sous-chaîne (mots longs, sans risque de collision)
// - SHORT_BAD : mot entier seulement (mots courts, évite "technique" → "nique")
const LONG_BAD = [
  // Français — insultes longues
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
  // Anglais
  "fuck","fucking","fucked","fucker","fuckers","fuckoff",
  "shit","shitty","bullshit",
  "bitch","bitches",
  "asshole","assholes","dickhead","motherfucker","motherfucking",
  "cunt","cunts","whore","whores","slut","sluts",
  "nigger","niggers","nigga",
  "retarded","morons",
  "killurself","killyourself","godie","godieinfiredie",
];

const SHORT_BAD = [
  // Mots courts — uniquement en tant que mot entier
  "con","conne","cul","culs","pd","pds","tg","fdp","ntm","kys",
  "nique","pute","putes","bite","bites","kike","mdr","lol",
  "fick","kak","scheiss",
];

// Prépare le texte pour le filtre : accents + leet speak + collapse f.u.c.k
function _prepFilter(str) {
  let s = str.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // accents
    .replace(/0/g,"o").replace(/1/g,"i").replace(/3/g,"e")
    .replace(/4/g,"a").replace(/5/g,"s").replace(/@/g,"a")
    .replace(/\$/g,"s").replace(/€/g,"e").replace(/!/g,"i")
    .replace(/(.)\1+/g,"$1");                       // meeeerde→merde, enculle→encule
  // Collapse f.u.c.k / f-u-c-k / f_u_c_k → fuck (6 passes pour les mots longs)
  for(let i=0;i<6;i++) s = s.replace(/([a-z])[.\-_*+|]+([a-z])/g,"$1$2");
  return s;
}

function containsBadWord(text) {
  const prep   = _prepFilter(text);
  const noSpc  = prep.replace(/\s+/g,""); // version sans espaces (détecte les mots collés)

  // Long words — substring dans le texte sans espaces
  for(const w of LONG_BAD){
    const nw = _prepFilter(w).replace(/\s/g,"");
    if(noSpc.includes(nw)) return true;
  }

  // Short words — mot entier seulement (split par espaces/ponctuation)
  const words = prep.split(/[\s,!?;:.'"()\[\]]+/).filter(Boolean);
  for(const w of SHORT_BAD){
    const nw = _prepFilter(w);
    if(words.includes(nw)) return true;
  }

  return false;
}

function isCleanText(text) { return !containsBadWord(text); }

// Valide le format email
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ── Identifiant Email OU Téléphone (observateurs / enfants) ──────────────────
// Supabase Auth (configuré ici en email+mot de passe uniquement) n'a pas
// d'authentification téléphone native activée. Pour permettre aux observateurs
// et enfants de s'identifier avec leur numéro de téléphone, on génère une
// adresse email technique stable et invisible pour l'utilisateur, dérivée du
// numéro normalisé. Le vrai numéro reste stocké dans le profil (champ `phone`).
function normalizePhoneDigits(p) {
  if (!p) return "";
  let c = String(p).trim().replace(/[\s.\-()]/g, "");
  c = c.replace(/^\+/, "");
  if (c.startsWith("00")) c = c.slice(2);
  else if (c.startsWith("0")) c = "33" + c.slice(1);
  return c.replace(/\D/g, "");
}
function isLikelyPhoneIdentifier(v) {
  if (!v || v.includes("@")) return false;
  return normalizePhoneDigits(v).length >= 8;
}
// Transforme un identifiant (email réel OU numéro de téléphone) en adresse
// email "technique" utilisée pour les appels Supabase Auth.
function identifierToAuthEmail(v) {
  const raw = (v || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw.toLowerCase();
  return `tel${normalizePhoneDigits(raw)}@phone.duvia.app`;
}

// Valide le mot de passe : longueur + au moins une majuscule + un caractère spécial.
function validatePassword(pw) {
  if (!pw || pw.length < LIMITS.PASSWORD_MIN) return `Mot de passe trop court (${LIMITS.PASSWORD_MIN} caractères min.)`;
  if (pw.length > LIMITS.PASSWORD_MAX) return "Mot de passe trop long.";
  if (!/[A-ZÀ-ÖØ-Þ]/.test(pw)) return "Le mot de passe doit contenir au moins une majuscule.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Le mot de passe doit contenir au moins un caractère spécial (ex : ! ? @ # $).";
  return null;
}

// Compteur anti-spam messages (en mémoire session)
const _msgTimestamps = [];
function checkMsgRateLimit() {
  const now = Date.now();
  // Garder uniquement les messages des 60 dernières secondes
  while (_msgTimestamps.length && _msgTimestamps[0] < now - 60000) _msgTimestamps.shift();
  if (_msgTimestamps.length >= LIMITS.MSG_PER_MIN) return false;
  _msgTimestamps.push(now);
  return true;
}

// Valide un fichier vault
function validateVaultFile(file) {
  if (!file) return null;
  const ext = "." + file.name.split(".").pop().toLowerCase();
  const typeOk = ALLOWED_VAULT_TYPES.includes(file.type) || ALLOWED_VAULT_EXTS.includes(ext);
  if (!typeOk) return `Type de fichier non autorisé. Formats acceptés : PDF, JPG, PNG, WebP`;
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > LIMITS.FILE_MAX_MB) return `Fichier trop lourd (max ${LIMITS.FILE_MAX_MB} MB). Ce fichier fait ${sizeMB.toFixed(1)} MB.`;
  return null;
}

function lockScroll(el) {
  if (!el) return ()=>{};
  const pos = el.scrollTop;
  return () => { el.scrollTop = pos; };
}
function nearestScroller(node) {
  while (node && node !== document.body) {
    const s = window.getComputedStyle(node);
    if (s.overflowY === "auto" || s.overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}



const APP_LOGO = "/app-logo.jpeg";
const APP_LOGO_PNG = "/logo.png";

// ─── THEMES ───────────────────────────────────────────────────────────────────
// Theme constants imported from src/theme.js

// ─── TRANSLATIONS ─────────────────────────────────────────────────────────────
const LANGS = {
  fr:{flag:"🇫🇷",name:"Français"},
  en:{flag:"🇬🇧",name:"English"},
  de:{flag:"🇩🇪",name:"Deutsch"},
  es:{flag:"🇪🇸",name:"Español"},
  pt:{flag:"🇵🇹",name:"Português"},
};

// TR imported from src/i18n/index.js

// ─── SUBSCRIPTION & PLANS : freemium | trial_premium | earned_premium | premium ──
const TRIAL_DAYS      = 15;   // alias backward compat
const TRIAL_BASE_DAYS = 15;   // jours trial automatique à l'inscription
const TRIAL_MAX_DAYS  = 30;   // plafond absolu depuis la date de création du compte
const FILLEUL_BONUS_DAYS = 15; // jours "Premium – x j restants" offerts au filleul validé
const REF_TRIAL_PALIERS = { 1: 5, 2: 10 }; // bonus parrain phase trial (3+ = 0j)
const PREM_BONUS_PER_REF = 1;  // jours/filleul validé phase premium abonné
const PREM_MAX_PER_MONTH = 5;  // plafond jours bonus/mois premium
const SPIN_PER_REF = 1;        // tours de roue par filleul validé (tous statuts)
function makeRefCode(id,email){ const b=(email||"").split("@")[0].replace(/[^a-z0-9]/gi,"").toUpperCase().slice(0,4).padEnd(4,"X"); return `DUV-${b}-${String(id).slice(-4).padStart(4,"0")}`; }
function makeSub() { return { plan:"trial_premium", accountCreatedAt:new Date().toISOString(), trialStart:new Date().toISOString(), premiumSince:null, cycle:"yearly", refCode:null, refUsed:null, refCount:0, validatedRefCount:0, refMonths:0, trialExtension:0, pendingSpins:0, monthlyRefMonth:null, monthlyRefCount:0 }; }
function refBonusDaysTrial(validatedCount, extSoFar) {
  const remaining = TRIAL_MAX_DAYS - TRIAL_BASE_DAYS - extSoFar;
  if(remaining <= 0) return 0;
  const palier = REF_TRIAL_PALIERS[validatedCount] ?? 0;
  return Math.min(palier, remaining);
}
function refBonusDaysPremium(monthlyCount) {
  return monthlyCount <= PREM_MAX_PER_MONTH ? PREM_BONUS_PER_REF : 0;
}
// backward compat
function refBonusDays(n) { return REF_TRIAL_PALIERS[n] ?? 0; }
function refBonusDaysFor(n, isPF) { return isPF ? refBonusDaysPremium(n) : refBonusDaysTrial(n, 0); }
function makeAdminSub() { return { plan:"premium", premiumSince:new Date().toISOString(), cycle:"yearly", earnedTheme:true, earnedBadge:true, earnedRG:true, earnedWC:true, earnedVideo:true, earnedLicorne:true, lastSpinByUser:{}, giftedPrizes:{}, _admin:true }; }
function subStatus(sub) {
  if(sub._admin) return "premium";
  if(sub.plan==="premium") {
    // Vérifie l'expiration de l'abonnement payant
    if(sub.premiumSince && sub.cycle) {
      const expiry = new Date(sub.premiumSince);
      sub.cycle==="yearly" ? expiry.setFullYear(expiry.getFullYear()+1) : expiry.setMonth(expiry.getMonth()+1);
      const bonusDays = sub.refMonths ? sub.refMonths * 30 : 0;
      expiry.setDate(expiry.getDate() + bonusDays);
      if(Date.now() > expiry.getTime()) return "freemium"; // abonnement expiré → freemium
    }
    return "premium";
  }
  if(isBeta()) return "trial_premium"; // 🎉 Bêta — Trial Premium offert à tous
  if(sub.plan==="freemium") return "freemium";
  const created = sub.accountCreatedAt || sub.trialStart;
  const ext = sub.trialExtension||0;
  const maxDays = Math.min(TRIAL_BASE_DAYS + ext, TRIAL_MAX_DAYS);
  const d = (Date.now()-new Date(created).getTime())/86400000;
  if(d<=maxDays) return sub.plan==="earned_premium" ? "earned_premium" : "trial_premium";
  return "freemium"; // expiré → freemium
}
function trialLeft(sub) { const created=sub.accountCreatedAt||sub.trialStart; const ext=sub.trialExtension||0; const maxDays=Math.min(TRIAL_BASE_DAYS+ext,TRIAL_MAX_DAYS); return Math.max(0,Math.ceil(maxDays-(Date.now()-new Date(created).getTime())/86400000)); }
function isPrem(sub) { const st=subStatus(sub); return st==="premium"||st==="trial_premium"||st==="earned_premium"||sub._admin; }
function isPremFull(sub) { return subStatus(sub)==="premium"||sub._admin; }
function isFreemiumPlan(sub) { return subStatus(sub)==="freemium"; }
function getPerms(sub) {
  const st=subStatus(sub);
  const isFree    = st==="freemium";
  const isTrial   = st==="trial_premium"||st==="earned_premium"; // inclut la bêta
  const isPremium = st==="premium"||sub._admin;
  return {
    maxParents:    2,
    maxChildren:   isFree?1:isTrial?2:Infinity,
    sameGuardAll:  !isFree,
    zoneChoice:    !isFree,
    feteMere:      !isFree,
    fetePere:      !isFree,
    birthParents:  !isFree,
    birthChildren: !isFree,
    customDates:   !isFree,
    maxCustomDates:isPremium?Infinity:isTrial?2:0,
    customGuard:   !isFree,
    maxObservers:  isFree?1:Infinity,
    calendarEdit:  true,
    scheduleAdd:   !isFree,
    expenseAdd:    true,
    refundAdd:     true,
    balanceVisible:!isFree,
    contactAdd:    !isFree,
    maxVaultDocs:  (isPremium||isTrial) ? Infinity : 0,   // Coffre-fort : Premium + Bêta/trial
    maxVaultSizeGB: (isPremium||isTrial) ? 1 : 0,          // Limite 1 Go total
    canSpin:       !isFree,
    spinWinSub:    isPremium,
  };
}
function isAdmin(user) { return user?.role==="admin"; }

// ─── BÊTA GRATUITE — Premium offert jusqu'au 30 septembre 2026 ────────────────
const BETA_END = new Date("2026-10-01T00:00:00"); // 1er octobre = fin bêta
// Âge du consentement numérique : 15 ans en France (RGPD art. 8, transposé par
// la loi Informatique et Libertés). En dessous, le consentement d'un titulaire
// de l'autorité parentale est requis.
const RGPD_CONSENT_AGE = 15;
function isBeta() { return Date.now() < BETA_END.getTime(); }
const BETA_DAYS_LEFT = () => Math.max(0, Math.ceil((BETA_END - Date.now()) / 86400000));

// ─── DATA ─────────────────────────────────────────────────────────────────────
// 🔧 L'admin n'est plus un compte local codé en dur (faille de sécurité :
// le mot de passe était visible par n'importe qui dans le code envoyé au
// navigateur). L'admin est maintenant un vrai compte Supabase Auth, vérifié
// côté serveur via la table app_admins (voir doLogin et 0003_app_admins.sql).
const DEMO_USERS = [];

const ZONE_ACADEMIES = {
  A:"Besançon, Bordeaux, Clermont-Ferrand, Dijon, Grenoble, Limoges, Lyon, Poitiers",
  B:"Aix-Marseille, Amiens, Caen, Lille, Nancy-Metz, Nantes, Nice, Orléans-Tours, Reims, Rennes, Rouen, Strasbourg",
  C:"Créteil, Montpellier, Paris, Toulouse, Versailles",
};

function schoolYearStart() { const n=new Date(); return n.getMonth()>=8?n.getFullYear():n.getFullYear()-1; }

// ─── COUNTRIES ────────────────────────────────────────────────────────────────
const COUNTRIES = [
  {code:"FR", flag:"🇫🇷", name:"France",         ohCode:"FR"},
  {code:"BE", flag:"🇧🇪", name:"Belgique",        ohCode:"BE"},
  {code:"CH", flag:"🇨🇭", name:"Suisse",          ohCode:"CH"},
  {code:"LU", flag:"🇱🇺", name:"Luxembourg",      ohCode:"LU"},
  {code:"DE", flag:"🇩🇪", name:"Deutschland",     ohCode:"DE"},
  {code:"AT", flag:"🇦🇹", name:"Österreich",      ohCode:"AT"},
  {code:"NL", flag:"🇳🇱", name:"Nederland",       ohCode:"NL"},
  {code:"ES", flag:"🇪🇸", name:"España",          ohCode:"ES"},
  {code:"PT", flag:"🇵🇹", name:"Portugal",        ohCode:"PT"},
  {code:"IT", flag:"🇮🇹", name:"Italia",          ohCode:"IT"},
  {code:"GB", flag:"🇬🇧", name:"United Kingdom",  ohCode:"GB"},
  {code:"PL", flag:"🇵🇱", name:"Polska",          ohCode:"PL"},
  {code:"CZ", flag:"🇨🇿", name:"Česká republika", ohCode:"CZ"},
  {code:"SK", flag:"🇸🇰", name:"Slovensko",       ohCode:"SK"},
  {code:"HR", flag:"🇭🇷", name:"Hrvatska",        ohCode:"HR"},
  {code:"CA", flag:"🇨🇦", name:"Canada (QC)",     ohCode:null},
];

// ─── OPENHOLIDAYS API ─────────────────────────────────────────────────────────
// https://openholidaysapi.org
const OH_BASE = "https://openholidaysapi.org";

// Full subdivisions catalog per country
// Each entry: { code, label } — used for the zone picker UI + API calls
const OH_SUBS_CATALOG = {
  FR: [
    {code:"FR-ARA", label:"Zone A — Auvergne-Rhône-Alpes"},
    {code:"FR-BRE", label:"Zone B — Bretagne"},
    {code:"FR-COR", label:"Zone B — Corse"},
    {code:"FR-GES", label:"Zone B — Grand Est"},
    {code:"FR-HDF", label:"Zone B — Hauts-de-France"},
    {code:"FR-HNO", label:"Zone A — Hauts-Normandie"},
    {code:"FR-IDF", label:"Zone C — Île-de-France"},
    {code:"FR-NAQ", label:"Zone A — Nouvelle-Aquitaine"},
    {code:"FR-NOR", label:"Zone B — Normandie"},
    {code:"FR-OCC", label:"Zone C — Occitanie"},
    {code:"FR-PAC", label:"Zone B — Provence-Alpes-Côte d'Azur"},
    {code:"FR-PDL", label:"Zone B — Pays de la Loire"},
  ],
  DE: [
    {code:"DE-BB", label:"Brandenburg"},
    {code:"DE-BE", label:"Berlin"},
    {code:"DE-BW", label:"Baden-Württemberg"},
    {code:"DE-BY", label:"Bayern"},
    {code:"DE-HB", label:"Bremen"},
    {code:"DE-HE", label:"Hessen"},
    {code:"DE-HH", label:"Hamburg"},
    {code:"DE-MV", label:"Mecklenburg-Vorpommern"},
    {code:"DE-NI", label:"Niedersachsen"},
    {code:"DE-NW", label:"Nordrhein-Westfalen"},
    {code:"DE-RP", label:"Rheinland-Pfalz"},
    {code:"DE-SH", label:"Schleswig-Holstein"},
    {code:"DE-SL", label:"Saarland"},
    {code:"DE-SN", label:"Sachsen"},
    {code:"DE-ST", label:"Sachsen-Anhalt"},
    {code:"DE-TH", label:"Thüringen"},
  ],
  AT: [
    {code:"AT-1", label:"Burgenland"},
    {code:"AT-2", label:"Kärnten"},
    {code:"AT-3", label:"Niederösterreich"},
    {code:"AT-4", label:"Oberösterreich"},
    {code:"AT-5", label:"Salzburg"},
    {code:"AT-6", label:"Steiermark"},
    {code:"AT-7", label:"Tirol"},
    {code:"AT-8", label:"Vorarlberg"},
    {code:"AT-9", label:"Wien"},
  ],
  CH: [
    {code:"CH-AG", label:"Aargau"},
    {code:"CH-BE", label:"Bern"},
    {code:"CH-BL", label:"Basel-Landschaft"},
    {code:"CH-BS", label:"Basel-Stadt"},
    {code:"CH-FR", label:"Fribourg"},
    {code:"CH-GE", label:"Genève"},
    {code:"CH-GL", label:"Glarus"},
    {code:"CH-GR", label:"Graubünden"},
    {code:"CH-JU", label:"Jura"},
    {code:"CH-LU", label:"Luzern"},
    {code:"CH-NE", label:"Neuchâtel"},
    {code:"CH-NW", label:"Nidwalden"},
    {code:"CH-OW", label:"Obwalden"},
    {code:"CH-SG", label:"St. Gallen"},
    {code:"CH-SH", label:"Schaffhausen"},
    {code:"CH-SO", label:"Solothurn"},
    {code:"CH-SZ", label:"Schwyz"},
    {code:"CH-TG", label:"Thurgau"},
    {code:"CH-TI", label:"Ticino"},
    {code:"CH-UR", label:"Uri"},
    {code:"CH-VD", label:"Vaud"},
    {code:"CH-VS", label:"Valais"},
    {code:"CH-ZG", label:"Zug"},
    {code:"CH-ZH", label:"Zürich"},
  ],
  GB: [
    {code:"GB-ENG", label:"England"},
    {code:"GB-NIR", label:"Northern Ireland"},
    {code:"GB-SCT", label:"Scotland"},
    {code:"GB-WLS", label:"Wales"},
  ],
  ES: [
    {code:"ES-AN", label:"Andalucía"},
    {code:"ES-AR", label:"Aragón"},
    {code:"ES-AS", label:"Asturias"},
    {code:"ES-CB", label:"Cantabria"},
    {code:"ES-CL", label:"Castilla y León"},
    {code:"ES-CM", label:"Castilla-La Mancha"},
    {code:"ES-CN", label:"Canarias"},
    {code:"ES-CT", label:"Catalunya"},
    {code:"ES-EX", label:"Extremadura"},
    {code:"ES-GA", label:"Galicia"},
    {code:"ES-IB", label:"Illes Balears"},
    {code:"ES-MC", label:"Murcia"},
    {code:"ES-MD", label:"Madrid"},
    {code:"ES-NC", label:"Navarra"},
    {code:"ES-PV", label:"País Vasco"},
    {code:"ES-RI", label:"La Rioja"},
    {code:"ES-VC", label:"Valencia"},
  ],
  BE: [
    {code:"BE-BRU", label:"Bruxelles-Capitale"},
    {code:"BE-VAN", label:"Flandre"},
    {code:"BE-WAL", label:"Wallonie"},
  ],
  NL: [
    {code:"NL-DR", label:"Drenthe"},
    {code:"NL-FL", label:"Flevoland"},
    {code:"NL-FR", label:"Friesland"},
    {code:"NL-GE", label:"Gelderland"},
    {code:"NL-GR", label:"Groningen"},
    {code:"NL-LI", label:"Limburg"},
    {code:"NL-NB", label:"Noord-Brabant"},
    {code:"NL-NH", label:"Noord-Holland"},
    {code:"NL-OV", label:"Overijssel"},
    {code:"NL-UT", label:"Utrecht"},
    {code:"NL-ZE", label:"Zeeland"},
    {code:"NL-ZH", label:"Zuid-Holland"},
  ],
  IT: [
    {code:"IT-21", label:"Piemonte"},
    {code:"IT-23", label:"Valle d'Aosta"},
    {code:"IT-25", label:"Lombardia"},
    {code:"IT-32", label:"Trentino-Alto Adige"},
    {code:"IT-34", label:"Veneto"},
    {code:"IT-36", label:"Friuli-Venezia Giulia"},
    {code:"IT-42", label:"Liguria"},
    {code:"IT-45", label:"Emilia-Romagna"},
    {code:"IT-52", label:"Toscana"},
    {code:"IT-55", label:"Umbria"},
    {code:"IT-57", label:"Marche"},
    {code:"IT-62", label:"Lazio"},
    {code:"IT-65", label:"Abruzzo"},
    {code:"IT-67", label:"Molise"},
    {code:"IT-72", label:"Campania"},
    {code:"IT-75", label:"Puglia"},
    {code:"IT-77", label:"Basilicata"},
    {code:"IT-78", label:"Calabria"},
    {code:"IT-82", label:"Sicilia"},
    {code:"IT-88", label:"Sardegna"},
  ],
  PL: [
    {code:"PL-02", label:"Dolnośląskie"},
    {code:"PL-04", label:"Kujawsko-Pomorskie"},
    {code:"PL-06", label:"Lubelskie"},
    {code:"PL-08", label:"Lubuskie"},
    {code:"PL-10", label:"Łódzkie"},
    {code:"PL-12", label:"Małopolskie"},
    {code:"PL-14", label:"Mazowieckie"},
    {code:"PL-16", label:"Opolskie"},
    {code:"PL-18", label:"Podkarpackie"},
    {code:"PL-20", label:"Podlaskie"},
    {code:"PL-22", label:"Pomorskie"},
    {code:"PL-24", label:"Śląskie"},
    {code:"PL-26", label:"Świętokrzyskie"},
    {code:"PL-28", label:"Warmińsko-Mazurskie"},
    {code:"PL-30", label:"Wielkopolskie"},
    {code:"PL-32", label:"Zachodniopomorskie"},
  ],
  // Single subdivision countries (no picker needed)
  LU: [{code:"LU-L", label:"Luxembourg"}],
  PT: [{code:"PT-11", label:"Portugal"}],
  CZ: [{code:"CZ-10", label:"Česká republika"}],
  SK: [{code:"SK-BL", label:"Slovensko"}],
  HR: [{code:"HR-21", label:"Hrvatska"}],
};

// Returns the default subdivision code for a country (first in list)
function getDefaultSub(country) {
  const subs = OH_SUBS_CATALOG[country];
  return subs?.[0]?.code || null;
}

// Returns whether a country has multiple zones to choose from
function hasMultipleZones(country) {
  return (OH_SUBS_CATALOG[country]?.length || 0) > 1;
}

// In-memory cache: key → { schoolHols, publicHols, ts }
const OH_CACHE = {};
function ohCacheKey(country, zone, year) { return `${country}|${zone||""}|${year}`; }

async function fetchOHSchoolHols(country, zone, year) {
  // zone is a full subdivisionCode e.g. "FR-IDF", "DE-BY"
  const sub = zone || getDefaultSub(country);
  if (!sub) return null;
  try {
    const url = `${OH_BASE}/SchoolHolidays?countryIsoCode=${country}&subdivisionCode=${sub}&validFrom=${year}-01-01&validTo=${year+1}-12-31&languageIsoCode=FR`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return (data||[]).map(h => ({
      n: (h.name||[]).find(x=>x.language==="FR")?.text || (h.name||[])[0]?.text || h.id,
      s: h.startDate.slice(0,10),
      e: h.endDate.slice(0,10),
    }));
  } catch { return null; }
}

async function fetchOHPublicHols(country, year) {
  if (!COUNTRIES.find(c=>c.code===country)?.ohCode) return null;
  try {
    const url = `${OH_BASE}/PublicHolidays?countryIsoCode=${country}&validFrom=${year}-01-01&validTo=${year}-12-31&languageIsoCode=FR`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return (data||[]).map(h => ({
      date: h.startDate.slice(0,10),
      n: (h.name||[]).find(x=>x.language==="FR")?.text || (h.name||[])[0]?.text || h.id,
    }));
  } catch { return null; }
}

async function fetchOHData(country, zone, year) {
  const key = ohCacheKey(country, zone, year);
  if (OH_CACHE[key]) return OH_CACHE[key];
  const [schoolHols, publicHols] = await Promise.all([
    fetchOHSchoolHols(country, zone, year),
    fetchOHPublicHols(country, year),
  ]);
  const result = { schoolHols, publicHols, ts: Date.now() };
  OH_CACHE[key] = result;
  return result;
}

// ─── STATIC FALLBACK (countries not covered by OpenHolidays, or API failure) ──
const STATIC_SCHOOL_HOLS = {
  CA:[{n:"Noël 2025",s:"2025-12-22",e:"2026-01-04"},{n:"Relâche 2026",s:"2026-03-02",e:"2026-03-06"},{n:"Pâques 2026",s:"2026-04-03",e:"2026-04-10"},{n:"Été 2026",s:"2026-06-26",e:"2026-09-07"},{n:"Noël 2026",s:"2026-12-21",e:"2027-01-03"}],
  // Fallbacks pour pays couverts par OpenHolidays (si API indisponible)
  DE:[{n:"Weihnachten 2025",s:"2025-12-22",e:"2026-01-05"},{n:"Winterferien 2026",s:"2026-02-02",e:"2026-02-15"},{n:"Osterferien 2026",s:"2026-03-28",e:"2026-04-10"},{n:"Sommerferien 2026",s:"2026-06-22",e:"2026-08-01"},{n:"Herbstferien 2026",s:"2026-10-26",e:"2026-11-06"},{n:"Weihnachten 2026",s:"2026-12-21",e:"2027-01-03"}],
  ES:[{n:"Navidad 2025",s:"2025-12-22",e:"2026-01-07"},{n:"Semana Santa 2026",s:"2026-03-28",e:"2026-04-05"},{n:"Verano 2026",s:"2026-06-22",e:"2026-09-13"},{n:"Navidad 2026",s:"2026-12-21",e:"2027-01-06"}],
  BE:[{n:"Vacances Noël 2025",s:"2025-12-22",e:"2026-01-04"},{n:"Carnaval 2026",s:"2026-03-02",e:"2026-03-13"},{n:"Pâques 2026",s:"2026-04-04",e:"2026-04-19"},{n:"Été 2026",s:"2026-07-01",e:"2026-08-31"},{n:"Toussaint 2026",s:"2026-10-26",e:"2026-11-06"},{n:"Noël 2026",s:"2026-12-21",e:"2027-01-03"}],
  CH:[{n:"Weihnachten 2025",s:"2025-12-22",e:"2026-01-04"},{n:"Sportferien 2026",s:"2026-02-09",e:"2026-02-22"},{n:"Osterferien 2026",s:"2026-04-04",e:"2026-04-19"},{n:"Sommerferien 2026",s:"2026-07-06",e:"2026-08-16"},{n:"Herbstferien 2026",s:"2026-10-05",e:"2026-10-18"},{n:"Weihnachten 2026",s:"2026-12-21",e:"2027-01-03"}],
  GB:[{n:"Christmas 2025",s:"2025-12-20",e:"2026-01-04"},{n:"Half-term Feb 2026",s:"2026-02-16",e:"2026-02-22"},{n:"Easter 2026",s:"2026-04-04",e:"2026-04-19"},{n:"Summer 2026",s:"2026-07-20",e:"2026-09-06"},{n:"Half-term Oct 2026",s:"2026-10-26",e:"2026-11-01"},{n:"Christmas 2026",s:"2026-12-19",e:"2027-01-03"}],
  NL:[{n:"Kerstvakantie 2025",s:"2025-12-22",e:"2026-01-04"},{n:"Voorjaarsvakantie 2026",s:"2026-02-23",e:"2026-03-01"},{n:"Meivakantie 2026",s:"2026-04-25",e:"2026-05-10"},{n:"Zomervakantie 2026",s:"2026-07-13",e:"2026-08-23"},{n:"Herfstvakantie 2026",s:"2026-10-19",e:"2026-10-25"},{n:"Kerstvakantie 2026",s:"2026-12-21",e:"2027-01-03"}],
  AT:[{n:"Weihnachten 2025",s:"2025-12-24",e:"2026-01-06"},{n:"Semesterferien 2026",s:"2026-02-09",e:"2026-02-13"},{n:"Osterferien 2026",s:"2026-04-01",e:"2026-04-12"},{n:"Sommerferien 2026",s:"2026-06-27",e:"2026-09-06"},{n:"Herbstferien 2026",s:"2026-10-24",e:"2026-10-27"},{n:"Weihnachten 2026",s:"2026-12-24",e:"2027-01-06"}],
  IT:[{n:"Natale 2025",s:"2025-12-20",e:"2026-01-07"},{n:"Carnevale 2026",s:"2026-02-16",e:"2026-02-17"},{n:"Pasqua 2026",s:"2026-04-02",e:"2026-04-07"},{n:"Estate 2026",s:"2026-06-13",e:"2026-09-13"},{n:"Natale 2026",s:"2026-12-20",e:"2027-01-07"}],
  PT:[{n:"Natal 2025",s:"2025-12-20",e:"2026-01-04"},{n:"Carnaval 2026",s:"2026-03-03",e:"2026-03-04"},{n:"Páscoa 2026",s:"2026-03-28",e:"2026-04-05"},{n:"Verão 2026",s:"2026-06-22",e:"2026-09-13"},{n:"Todos os Santos 2026",s:"2026-10-31",e:"2026-11-02"},{n:"Natal 2026",s:"2026-12-19",e:"2027-01-04"}],
  LU:[{n:"Noël 2025",s:"2025-12-20",e:"2026-01-04"},{n:"Carnaval 2026",s:"2026-02-28",e:"2026-03-01"},{n:"Pâques 2026",s:"2026-04-04",e:"2026-04-19"},{n:"Été 2026",s:"2026-07-15",e:"2026-09-14"},{n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-01"},{n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"}],
  PL:[{n:"Boże Narodzenie 2025",s:"2025-12-23",e:"2026-01-04"},{n:"Ferie zimowe 2026",s:"2026-01-17",e:"2026-02-01"},{n:"Wielkanoc 2026",s:"2026-04-09",e:"2026-04-14"},{n:"Wakacje 2026",s:"2026-06-27",e:"2026-08-31"},{n:"Przerwa jesienna 2026",s:"2026-10-31",e:"2026-11-01"},{n:"Boże Narodzenie 2026",s:"2026-12-22",e:"2027-01-03"}],
  CZ:[{n:"Vánoce 2025",s:"2025-12-22",e:"2026-01-02"},{n:"Jarní prázdniny 2026",s:"2026-03-02",e:"2026-03-06"},{n:"Velikonoce 2026",s:"2026-04-02",e:"2026-04-07"},{n:"Léto 2026",s:"2026-06-29",e:"2026-08-31"},{n:"Vánoce 2026",s:"2026-12-21",e:"2027-01-02"}],
  SK:[{n:"Vianoce 2025",s:"2025-12-22",e:"2026-01-07"},{n:"Jarné 2026",s:"2026-04-02",e:"2026-04-09"},{n:"Léto 2026",s:"2026-06-29",e:"2026-08-31"},{n:"Jeseň 2026",s:"2026-10-26",e:"2026-10-30"},{n:"Vianoce 2026",s:"2026-12-21",e:"2027-01-07"}],
  HR:[{n:"Božić 2025",s:"2025-12-22",e:"2026-01-07"},{n:"Uskrs 2026",s:"2026-04-02",e:"2026-04-07"},{n:"Ljeto 2026",s:"2026-06-15",e:"2026-09-06"},{n:"Božić 2026",s:"2026-12-21",e:"2027-01-07"}],
};
const STATIC_PUBLIC_HOLS = {
  // Pays non couverts par OpenHolidays
  CA:[{date:"2026-01-01",n:"Jour de l'An"},{date:"2026-02-16",n:"Family Day"},{date:"2026-04-03",n:"Vendredi Saint"},{date:"2026-05-18",n:"Fête de la Reine"},{date:"2026-07-01",n:"Fête du Canada"},{date:"2026-09-07",n:"Fête du Travail"},{date:"2026-10-12",n:"Action de grâces"},{date:"2026-11-11",n:"Jour du Souvenir"},{date:"2026-12-25",n:"Noël"},{date:"2026-12-26",n:"Lendemain de Noël"}],
  // Fallbacks pour pays couverts par OpenHolidays (si API indisponible)
  FR:[{date:"2026-01-01",n:"Jour de l'An"},{date:"2026-04-06",n:"Lundi de Pâques"},{date:"2026-05-01",n:"Fête du Travail"},{date:"2026-05-08",n:"Victoire 1945"},{date:"2026-05-14",n:"Ascension"},{date:"2026-05-25",n:"Lundi de Pentecôte"},{date:"2026-07-14",n:"Fête Nationale"},{date:"2026-08-15",n:"Assomption"},{date:"2026-11-01",n:"Toussaint"},{date:"2026-11-11",n:"Armistice"},{date:"2026-12-25",n:"Noël"}],
  DE:[{date:"2026-01-01",n:"Neujahr"},{date:"2026-01-06",n:"Heilige Drei Könige"},{date:"2026-04-03",n:"Karfreitag"},{date:"2026-04-06",n:"Ostermontag"},{date:"2026-05-01",n:"Tag der Arbeit"},{date:"2026-05-14",n:"Christi Himmelfahrt"},{date:"2026-05-25",n:"Pfingstmontag"},{date:"2026-10-03",n:"Tag der Deutschen Einheit"},{date:"2026-12-25",n:"1. Weihnachtstag"},{date:"2026-12-26",n:"2. Weihnachtstag"}],
  ES:[{date:"2026-01-01",n:"Año Nuevo"},{date:"2026-01-06",n:"Reyes Magos"},{date:"2026-04-03",n:"Viernes Santo"},{date:"2026-05-01",n:"Día del Trabajo"},{date:"2026-08-15",n:"Asunción"},{date:"2026-10-12",n:"Fiesta Nacional"},{date:"2026-11-01",n:"Todos los Santos"},{date:"2026-12-06",n:"Día de la Constitución"},{date:"2026-12-08",n:"Inmaculada Concepción"},{date:"2026-12-25",n:"Navidad"}],
  BE:[{date:"2026-01-01",n:"Jour de l'An"},{date:"2026-04-06",n:"Lundi de Pâques"},{date:"2026-05-01",n:"Fête du Travail"},{date:"2026-05-14",n:"Ascension"},{date:"2026-05-25",n:"Lundi de Pentecôte"},{date:"2026-07-21",n:"Fête Nationale"},{date:"2026-08-15",n:"Assomption"},{date:"2026-11-01",n:"Toussaint"},{date:"2026-11-11",n:"Armistice"},{date:"2026-12-25",n:"Noël"}],
  CH:[{date:"2026-01-01",n:"Neujahr"},{date:"2026-04-03",n:"Karfreitag"},{date:"2026-04-06",n:"Ostermontag"},{date:"2026-05-01",n:"Tag der Arbeit"},{date:"2026-05-14",n:"Auffahrt"},{date:"2026-05-25",n:"Pfingstmontag"},{date:"2026-08-01",n:"Nationalfeiertag"},{date:"2026-12-25",n:"Weihnachten"},{date:"2026-12-26",n:"Stephanstag"}],
  AT:[{date:"2026-01-01",n:"Neujahr"},{date:"2026-01-06",n:"Heilige Drei Könige"},{date:"2026-04-06",n:"Ostermontag"},{date:"2026-05-01",n:"Staatsfeiertag"},{date:"2026-05-14",n:"Christi Himmelfahrt"},{date:"2026-05-25",n:"Pfingstmontag"},{date:"2026-06-04",n:"Fronleichnam"},{date:"2026-08-15",n:"Mariä Himmelfahrt"},{date:"2026-10-26",n:"Nationalfeiertag"},{date:"2026-11-01",n:"Allerheiligen"},{date:"2026-12-08",n:"Mariä Empfängnis"},{date:"2026-12-25",n:"Christtag"},{date:"2026-12-26",n:"Stefanitag"}],
  GB:[{date:"2026-01-01",n:"New Year's Day"},{date:"2026-04-03",n:"Good Friday"},{date:"2026-04-06",n:"Easter Monday"},{date:"2026-05-04",n:"Early May Bank Holiday"},{date:"2026-05-25",n:"Spring Bank Holiday"},{date:"2026-08-31",n:"Summer Bank Holiday"},{date:"2026-12-25",n:"Christmas Day"},{date:"2026-12-28",n:"Boxing Day"}],
  NL:[{date:"2026-01-01",n:"Nieuwjaarsdag"},{date:"2026-04-03",n:"Goede Vrijdag"},{date:"2026-04-05",n:"Eerste Paasdag"},{date:"2026-04-06",n:"Tweede Paasdag"},{date:"2026-04-27",n:"Koningsdag"},{date:"2026-05-05",n:"Bevrijdingsdag"},{date:"2026-05-14",n:"Hemelvaartsdag"},{date:"2026-05-24",n:"Eerste Pinksterdag"},{date:"2026-05-25",n:"Tweede Pinksterdag"},{date:"2026-12-25",n:"Eerste Kerstdag"},{date:"2026-12-26",n:"Tweede Kerstdag"}],
  IT:[{date:"2026-01-01",n:"Capodanno"},{date:"2026-01-06",n:"Epifania"},{date:"2026-04-05",n:"Pasqua"},{date:"2026-04-06",n:"Lunedì dell'Angelo"},{date:"2026-04-25",n:"Festa della Liberazione"},{date:"2026-05-01",n:"Festa del Lavoro"},{date:"2026-06-02",n:"Festa della Repubblica"},{date:"2026-08-15",n:"Ferragosto"},{date:"2026-11-01",n:"Ognissanti"},{date:"2026-12-08",n:"Immacolata Concezione"},{date:"2026-12-25",n:"Natale"},{date:"2026-12-26",n:"Santo Stefano"}],
  PT:[{date:"2026-01-01",n:"Ano Novo"},{date:"2026-02-17",n:"Terça-feira de Carnaval"},{date:"2026-04-03",n:"Sexta-feira Santa"},{date:"2026-04-05",n:"Páscoa"},{date:"2026-04-25",n:"Dia da Liberdade"},{date:"2026-05-01",n:"Dia do Trabalho"},{date:"2026-06-10",n:"Dia de Portugal"},{date:"2026-08-15",n:"Assunção"},{date:"2026-10-05",n:"Implantação da República"},{date:"2026-11-01",n:"Todos-os-Santos"},{date:"2026-12-01",n:"Restauração da Independência"},{date:"2026-12-08",n:"Imaculada Conceição"},{date:"2026-12-25",n:"Natal"}],
  LU:[{date:"2026-01-01",n:"Nouvel An"},{date:"2026-04-06",n:"Lundi de Pâques"},{date:"2026-05-01",n:"Fête du Travail"},{date:"2026-05-14",n:"Ascension"},{date:"2026-05-25",n:"Lundi de Pentecôte"},{date:"2026-06-23",n:"Fête Nationale"},{date:"2026-08-15",n:"Assomption"},{date:"2026-11-01",n:"Toussaint"},{date:"2026-12-25",n:"Noël"},{date:"2026-12-26",n:"Saint-Étienne"}],
  PL:[{date:"2026-01-01",n:"Nowy Rok"},{date:"2026-01-06",n:"Trzech Króli"},{date:"2026-04-05",n:"Niedziela Wielkanocna"},{date:"2026-04-06",n:"Poniedziałek Wielkanocny"},{date:"2026-05-01",n:"Święto Pracy"},{date:"2026-05-03",n:"Konstytucji 3 Maja"},{date:"2026-05-24",n:"Zielone Świątki"},{date:"2026-06-04",n:"Boże Ciało"},{date:"2026-08-15",n:"Wniebowzięcie NMP"},{date:"2026-11-01",n:"Wszystkich Świętych"},{date:"2026-11-11",n:"Święto Niepodległości"},{date:"2026-12-25",n:"Boże Narodzenie"},{date:"2026-12-26",n:"Drugi dzień Bożego Narodzenia"}],
  CZ:[{date:"2026-01-01",n:"Nový rok"},{date:"2026-04-03",n:"Velký pátek"},{date:"2026-04-06",n:"Velikonoční pondělí"},{date:"2026-05-01",n:"Svátek práce"},{date:"2026-05-08",n:"Den vítězství"},{date:"2026-07-05",n:"Den slovanských věrozvěstů"},{date:"2026-07-06",n:"Den upálení Mistra Jana Husa"},{date:"2026-09-28",n:"Den české státnosti"},{date:"2026-10-28",n:"Den vzniku Československa"},{date:"2026-11-17",n:"Den boje za svobodu"},{date:"2026-12-24",n:"Štědrý den"},{date:"2026-12-25",n:"1. svátek vánoční"},{date:"2026-12-26",n:"2. svátek vánoční"}],
  SK:[{date:"2026-01-01",n:"Nový rok"},{date:"2026-01-06",n:"Traja králi"},{date:"2026-04-03",n:"Veľký piatok"},{date:"2026-04-06",n:"Veľkonočný pondelok"},{date:"2026-05-01",n:"Sviatok práce"},{date:"2026-05-08",n:"Deň víťazstva"},{date:"2026-07-05",n:"Cyril a Metod"},{date:"2026-08-29",n:"SNP"},{date:"2026-09-01",n:"Ústava SR"},{date:"2026-09-15",n:"Sedembolestná Panna Mária"},{date:"2026-11-01",n:"Sviatok všetkých svätých"},{date:"2026-11-17",n:"Deň boja za slobodu"},{date:"2026-12-24",n:"Štedrý deň"},{date:"2026-12-25",n:"Vianoce"},{date:"2026-12-26",n:"Štefan"}],
  HR:[{date:"2026-01-01",n:"Nova godina"},{date:"2026-01-06",n:"Sveta tri kralja"},{date:"2026-04-05",n:"Uskrs"},{date:"2026-04-06",n:"Uskrsni ponedjeljak"},{date:"2026-05-01",n:"Praznik rada"},{date:"2026-05-30",n:"Dan državnosti"},{date:"2026-06-04",n:"Tijelovo"},{date:"2026-06-22",n:"Dan antifašizma"},{date:"2026-08-05",n:"Dan domovinske zahvalnosti"},{date:"2026-08-15",n:"Velika Gospa"},{date:"2026-11-01",n:"Svi sveti"},{date:"2026-11-18",n:"Dan sjećanja"},{date:"2026-12-25",n:"Božić"},{date:"2026-12-26",n:"Sveti Stjepan"}],
};

// Helpers that read apiData prop (merged school+public hols from App)
// Vacances FR statiques par zone (fallback quand l'API n'a pas encore répondu)
const FR_STATIC_HOLS = {
  "FR-ARA":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-07",e:"2026-02-23"},
    {n:"Printemps 2026",s:"2026-04-04",e:"2026-04-20"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-13",e:"2027-03-01"},
    {n:"Printemps 2027",s:"2027-04-10",e:"2027-04-26"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-BRE":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-14",e:"2026-03-02"},
    {n:"Printemps 2026",s:"2026-04-11",e:"2026-04-27"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-20",e:"2027-03-08"},
    {n:"Printemps 2027",s:"2027-04-17",e:"2027-05-03"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-COR":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-14",e:"2026-03-02"},
    {n:"Printemps 2026",s:"2026-04-11",e:"2026-04-27"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-20",e:"2027-03-08"},
    {n:"Printemps 2027",s:"2027-04-17",e:"2027-05-03"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-GES":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-14",e:"2026-03-02"},
    {n:"Printemps 2026",s:"2026-04-11",e:"2026-04-27"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-20",e:"2027-03-08"},
    {n:"Printemps 2027",s:"2027-04-17",e:"2027-05-03"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-HDF":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-14",e:"2026-03-02"},
    {n:"Printemps 2026",s:"2026-04-11",e:"2026-04-27"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-20",e:"2027-03-08"},
    {n:"Printemps 2027",s:"2027-04-17",e:"2027-05-03"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-HNO":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-07",e:"2026-02-23"},
    {n:"Printemps 2026",s:"2026-04-04",e:"2026-04-20"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-13",e:"2027-03-01"},
    {n:"Printemps 2027",s:"2027-04-10",e:"2027-04-26"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-IDF":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-21",e:"2026-03-09"},
    {n:"Printemps 2026",s:"2026-04-18",e:"2026-05-04"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-06",e:"2027-02-22"},
    {n:"Printemps 2027",s:"2027-04-03",e:"2027-04-19"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-NAQ":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-07",e:"2026-02-23"},
    {n:"Printemps 2026",s:"2026-04-04",e:"2026-04-20"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-13",e:"2027-03-01"},
    {n:"Printemps 2027",s:"2027-04-10",e:"2027-04-26"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-NOR":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-14",e:"2026-03-02"},
    {n:"Printemps 2026",s:"2026-04-11",e:"2026-04-27"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-20",e:"2027-03-08"},
    {n:"Printemps 2027",s:"2027-04-17",e:"2027-05-03"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-OCC":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-21",e:"2026-03-09"},
    {n:"Printemps 2026",s:"2026-04-18",e:"2026-05-04"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-06",e:"2027-02-22"},
    {n:"Printemps 2027",s:"2027-04-03",e:"2027-04-19"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-PAC":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-14",e:"2026-03-02"},
    {n:"Printemps 2026",s:"2026-04-11",e:"2026-04-27"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-20",e:"2027-03-08"},
    {n:"Printemps 2027",s:"2027-04-17",e:"2027-05-03"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
  "FR-PDL":[
    {n:"Toussaint 2025",s:"2025-10-18",e:"2025-11-03"},
    {n:"Noël 2025",s:"2025-12-20",e:"2026-01-05"},
    {n:"Hiver 2026",s:"2026-02-14",e:"2026-03-02"},
    {n:"Printemps 2026",s:"2026-04-11",e:"2026-04-27"},
    {n:"Été 2026",s:"2026-07-05",e:"2026-09-01"},
    {n:"Toussaint 2026",s:"2026-10-17",e:"2026-11-02"},
    {n:"Noël 2026",s:"2026-12-19",e:"2027-01-04"},
    {n:"Hiver 2027",s:"2027-02-20",e:"2027-03-08"},
    {n:"Printemps 2027",s:"2027-04-17",e:"2027-05-03"},
    {n:"Été 2027",s:"2027-07-04",e:"2027-09-01"},
  ],
};
function getHolsFromData(country, apiData, subdivisionCode) {
  // 1. API data has priority (live or cached)
  if (apiData?.schoolHols?.length) return apiData.schoolHols;
  // 2. Static fallback by subdivision for FR
  if (country === "FR" && subdivisionCode && FR_STATIC_HOLS[subdivisionCode]) return FR_STATIC_HOLS[subdivisionCode];
  // 3. Generic static fallback for all countries (DE, ES, BE, CH, GB, PT, etc.)
  return STATIC_SCHOOL_HOLS[country] || [];
}
function getPublicHolName(dateStr, country, apiData) {
  if (apiData?.publicHols) {
    const h = (apiData.publicHols||[]).find(h=>h.date===dateStr);
    return h ? h.n : null;
  }
  const h = (STATIC_PUBLIC_HOLS[country]||[]).find(h=>h.date===dateStr);
  return h ? h.n : null;
}

// ─── DATE UTILS ───────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2,"0");
function toStr(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function dInMonth(y,m) { return new Date(y,m+1,0).getDate(); }
function dow(y,m,d) { return (new Date(y,m,d).getDay()+6)%7; }
function wkNum(date) {
  const d=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));
  d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));
  return Math.ceil((((d-new Date(Date.UTC(d.getUTCFullYear(),0,1)))/864e5)+1)/7);
}
function easterDate(y) {
  const a=y%19,b=~~(y/100),c=y%100,d=~~(b/4),e=b%4,f=~~((b+8)/25),g=~~((b-f+1)/3),
    h=(19*a+b-d-g+15)%30,i=~~(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,
    m2=~~((a+11*h+22*l)/451),mo=~~((h+l-7*m2+114)/31),dy=((h+l-7*m2+114)%31)+1;
  return new Date(y,mo-1,dy);
}
function isFerie(date, countryCode, apiData) {
  // Uses API data if available, falls back to static
  const ds=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
  return !!getPublicHolName(ds, countryCode||"FR", apiData);
}
function isSco(ds,zone,country,apiData) { return getHolsFromData(country,apiData,zone).some(h=>ds>=h.s&&ds<=h.e); }
function getHolName(ds,zone,country,apiData) { const h=getHolsFromData(country,apiData,zone).find(h=>ds>=h.s&&ds<=h.e); return h?h.n:null; }
function daysRange(s,e) {
  const out=[],cur=new Date(s+"T12:00:00"),end=new Date(e+"T12:00:00");
  while(cur<=end){out.push(toStr(cur));cur.setDate(cur.getDate()+1);}
  return out;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Rechargement « interne » à l'app (éjection, quitter, nouvelle version, etc.) :
// pose un drapeau pour que la déconnexion-à-la-sortie NE se déclenche PAS sur ces
// rechargements (sinon l'utilisateur serait éjecté vers l'écran de connexion).
function duviaReload(){
  try { window.sessionStorage.setItem("duvia_internal_reload","1"); } catch {}
  window.location.reload();
}

function makeCfg() {
  return {
    parents:[{id:1,name:"",gender:"F",birthDay:"",birthMonth:"",color:PCOLS[0]}],
    children:[{id:1,name:"",birthDay:"",birthMonth:""}],
    observers:[],sameGuardAll:true,zone:"",subdivisionCode:"",country:"FR",activeNatHols:null,
    specialDates:{
      motherDay:{enabled:false},fatherDay:{enabled:false},
      parentBirths:[],childBirths:[],schoolHolDetails:{},custom:[],
    },
    custody:{startMonth:pad(new Date().getMonth()+1),startYear:String(new Date().getFullYear()),
      type:"weekAlt",weekAlt:{evenIdx:0},exclusive:{mainIdx:0,weIdx:1,parity:"even"},
      pattern:[],confirmed:false},
    custodyPerChild:{},childrenZones:{},overrides:{},history:[],expenses:[],notifs:[],
    shareCode:Math.random().toString(36).slice(2,8).toUpperCase(),
  };
}

function resolveGuard(ds,cfg,childId) {
  // 1. Sélectionner le bon planning : per-child ou global
  const usePerChild = !cfg.sameGuardAll && childId && cfg.custodyPerChild?.[childId]?.confirmed;
  const custody = usePerChild ? cfg.custodyPerChild[childId] : cfg.custody;

  // 2. Manual overrides (global)
  if(cfg.overrides?.[ds]) return cfg.overrides[ds];

  // 3. Fête des Mères / Fête des Pères — garde forcée si activée
  const sd = cfg.specialDates || {};
  const country = cfg.country || "FR";
  const dsDate = new Date(ds+"T12:00:00");
  const y = dsDate.getFullYear();
  if(sd.motherDay?.enabled) {
    const mdDate = getMothersDayDate(y, country);
    if(sameDay(mdDate, dsDate)) {
      const motherIdx = cfg.parents.findIndex(p => p.gender === "F");
      if(motherIdx !== -1) return {parentIdx:motherIdx, timeType:"full", source:"motherDay"};
    }
  }
  if(sd.fatherDay?.enabled) {
    const fdDate = getFathersDayDate(y, country);
    if(sameDay(fdDate, dsDate)) {
      const fatherIdx = cfg.parents.findIndex(p => p.gender === "M");
      if(fatherIdx !== -1) return {parentIdx:fatherIdx, timeType:"full", source:"fatherDay"};
    }
  }

  // 4. Anniversaires des parents — garde forcée si activée
  const parentBirths = sd.parentBirths || [];
  const dsM = dsDate.getMonth() + 1;
  const dsD = dsDate.getDate();
  for(let pi = 0; pi < cfg.parents.length; pi++) {
    const pb = parentBirths[pi];
    if(!pb?.enabled) continue;
    const p = cfg.parents[pi];
    if(!p?.birthDay || !p?.birthMonth) continue;
    if(+p.birthDay === dsD && +p.birthMonth === dsM) {
      return {parentIdx:pi, timeType:"full", source:"parentBirthday"};
    }
  }

  // 4b. Anniversaires des enfants — garde paire/impaire si configurée
  const perChildSD = cfg.specialDates?.perChild || {};
  for(let ci = 0; ci < cfg.children.length; ci++) {
    const ch = cfg.children[ci];
    if(!ch?.birthDay || !ch?.birthMonth) continue;
    if(+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    // Cet enfant fête son anniversaire ce jour
    // Récupérer les préférences : per-child si disponible, sinon global
    const chSdLocal = childId && perChildSD[ch.id] ? perChildSD[ch.id] : null;
    const evenIdx = chSdLocal?.evenParentIdx ?? sd.evenParentIdx ?? 0;
    const oddIdx  = chSdLocal?.oddParentIdx  ?? sd.oddParentIdx  ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if(parentIdx === -1) return {parentIdx:-1, timeType:"full", source:"childBirthday", allParents:true};
    return {parentIdx, timeType:"full", source:"childBirthday"};
  }

  // 5. Vacances scolaires — per-child si disponible, sinon global
  const holDetails = (childId && cfg.specialDates?.schoolHolDetailsPerChild?.[childId])
    || cfg.specialDates?.schoolHolDetails || {};
  for(const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if(det[ds]!==undefined) return {parentIdx:det[ds],timeType:"full",source:"schoolHol"};
  }

  // 5. Pattern de garde
  if(!custody?.confirmed) return null;
  const {type,weekAlt,exclusive,pattern} = custody;
  // startYear/startMonth : depuis custody ou fallback cfg.custody
  const startYear = custody.startYear || cfg.custody.startYear;
  const startMonth = custody.startMonth || cfg.custody.startMonth;
  const start=new Date(+startYear,+startMonth-1,1);
  // 🔧 Fix : la grille personnalisée suppose que sa colonne 1 = un LUNDI.
  // Si le 1er du mois choisi n'est pas un lundi, tout le pattern se
  // retrouvait décalé par rapport à ce qui est affiché dans la grille
  // (ex: "albe" coché sur la colonne Mardi pouvait s'appliquer un autre
  // jour). On recale "start" sur le lundi de cette même semaine, pour que
  // diff=0 tombe toujours un lundi, comme le suggère visuellement la grille.
  start.setDate(start.getDate() - ((start.getDay()+6)%7));
  const target=new Date(ds+"T12:00:00");
  const diff=Math.floor((target-start)/864e5);
  if(diff<0) return null;
  if(type==="weekAlt"){
    const wn=wkNum(target);
    return {parentIdx:wn%2===0?weekAlt.evenIdx:1-weekAlt.evenIdx,timeType:"full"};
  }
  if(type==="exclusive"){
    const dw=(target.getDay()+6)%7;
    if(dw<5) return {parentIdx:exclusive.mainIdx,timeType:"full"};
    const wn=wkNum(target);
    return {parentIdx:wn%2===(exclusive.parity==="even"?0:1)?exclusive.weIdx:exclusive.mainIdx,timeType:"full"};
  }
  if(type==="custom"&&pattern?.length) return pattern[diff%pattern.length]||null;
  return null;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
function css(C) {
  const wcExtras = C._wc ? `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
body{background:linear-gradient(160deg,#f0f7ff 0%,#dbeafe 40%,#d1fae5 100%)!important;min-height:100vh;}
body::after{content:"🏆";position:fixed;bottom:80px;right:16px;font-size:28px;opacity:.25;pointer-events:none;animation:wcPulse 2s ease-in-out infinite;}
@keyframes wcBall{0%,100%{transform:rotate(-15deg) translateY(0)}50%{transform:rotate(15deg) translateY(-8px)}}
@keyframes wcPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}
@keyframes wcShine{0%{left:-100%}100%{left:200%}}
.card{border-radius:16px!important;border-color:#bfdbfe!important;border-top:3px solid #2563eb!important;box-shadow:0 2px 8px rgba(37,99,235,.08)!important;}
.card:hover{box-shadow:0 4px 20px rgba(37,99,235,.15)!important;}
.sec{color:#1d4ed8!important;font-family:'Bebas Neue',sans-serif!important;font-size:13px!important;letter-spacing:.15em!important;}
input,select{border-radius:10px!important;border-color:#bfdbfe!important;height:44px!important;}
input:focus,select:focus{border-color:#16a34a!important;box-shadow:0 0 0 3px rgba(22,163,74,.15)!important;}
button{border-radius:10px!important;}
` : '';
  const rgExtras = C._rg ? `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
body{background:linear-gradient(160deg,#f5ede6 0%,#eedfd6 50%,#e8d5c8 100%)!important;min-height:100vh;}
body::before{content:"🎾";position:fixed;top:14px;right:72px;font-size:24px;animation:spinBall 4s linear infinite;pointer-events:none;z-index:9999;}
body::after{content:"";position:fixed;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#c2745a,#1a6b3c,#c2745a,#1a6b3c);pointer-events:none;z-index:9998;}
@keyframes spinBall{from{transform:rotate(0deg) translateX(4px)}to{transform:rotate(360deg) translateX(4px)}}
.card{border-radius:6px!important;border-color:#c2745a55!important;border-left:3px solid #c2745a!important;box-shadow:2px 2px 0 #eedfd6!important;}
.card:hover{box-shadow:3px 3px 0 #c2745a88!important;}
.sec{color:#7a4a35!important;font-family:'Playfair Display',serif!important;letter-spacing:.04em!important;}
input,select{border-radius:6px!important;border-color:#c2745a!important;border-left:3px solid #c2745a!important;height:44px!important;}
input:focus,select:focus{border-color:#1a6b3c!important;box-shadow:0 0 0 2px rgba(26,107,60,.2)!important;}
button{border-radius:6px!important;}
` : '';
  const summerExtras = C._summer ? `
@import url('https://fonts.googleapis.com/css2?family=Pacifico&family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
body{background:linear-gradient(160deg,#fff8e7 0%,#fff3cc 40%,#e0f7fa 100%);min-height:100vh;}
body::before{content:"☀️";position:fixed;top:14px;right:70px;font-size:28px;animation:sunPulse 3s ease-in-out infinite;pointer-events:none;z-index:9999;}
body::after{content:"🌊 🌊 🌊";position:fixed;bottom:0;left:0;right:0;font-size:18px;letter-spacing:8px;opacity:.3;pointer-events:none;animation:waveDrift 4s ease-in-out infinite alternate;text-align:center;}
@keyframes sunPulse{0%,100%{transform:scale(1) rotate(-5deg)}50%{transform:scale(1.1) rotate(5deg)}}
@keyframes waveDrift{from{transform:translateX(-10px)}to{transform:translateX(10px)}}
.card{border-radius:20px!important;border-color:#fde68a!important;box-shadow:0 2px 12px rgba(249,115,22,.1)!important;}
.card:hover{box-shadow:0 4px 20px rgba(249,115,22,.18)!important;}
input,select{border-radius:12px!important;border-color:#fde68a!important;height:44px!important;}
input:focus,select:focus{border-color:#f97316!important;box-shadow:0 0 0 3px rgba(249,115,22,.15)!important;}
button{border-radius:12px!important;}
.sec{color:#b45309!important;}
` : '';
  const videoExtras = C._video ? `
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
body{background:#07071a!important;background-image:linear-gradient(rgba(91,33,182,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(91,33,182,.04) 1px,transparent 1px)!important;background-size:32px 32px!important;min-height:100vh;}
body::before{content:"🎮";position:fixed;top:14px;right:70px;font-size:22px;animation:gameFloat 2.5s ease-in-out infinite;pointer-events:none;z-index:9999;}
body::after{content:"";position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(139,92,246,.025) 3px,rgba(139,92,246,.025) 4px);pointer-events:none;z-index:0;}
@keyframes gameFloat{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-7px) rotate(8deg)}}
@keyframes neonPulse{0%,100%{box-shadow:0 0 8px rgba(139,92,246,.5),0 0 20px rgba(139,92,246,.2),inset 0 1px 0 rgba(139,92,246,.15)}50%{box-shadow:0 0 18px rgba(139,92,246,.9),0 0 40px rgba(139,92,246,.45),inset 0 1px 0 rgba(139,92,246,.3)}}
@keyframes neonSlide{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes pixelBlink{0%,49%{opacity:1}50%,100%{opacity:0}}
.card{background:linear-gradient(150deg,#0f0f2a 0%,#0b0b20 100%)!important;border:1.5px solid #5b21b6!important;border-radius:10px!important;box-shadow:0 0 14px rgba(139,92,246,.18),inset 0 1px 0 rgba(139,92,246,.12)!important;}
.card:hover{border-color:#8b5cf6!important;box-shadow:0 0 24px rgba(139,92,246,.38),inset 0 1px 0 rgba(139,92,246,.25)!important;transform:translateY(-1px);}
.sec{font-family:'Orbitron',sans-serif!important;color:#8b5cf6!important;font-size:10px!important;letter-spacing:.18em!important;text-shadow:0 0 10px rgba(139,92,246,.7)!important;}
.fi{background:transparent!important;}
input,select{background:#0b0b22!important;border:1.5px solid #5b21b6!important;border-radius:8px!important;color:#ede9fe!important;height:44px!important;}
input:focus,select:focus{border-color:#8b5cf6!important;box-shadow:0 0 0 3px rgba(139,92,246,.25),0 0 14px rgba(139,92,246,.35)!important;}
button{border-radius:8px!important;}
.nav-tab{background:#0a0a1e!important;}
.nav-tab.active{background:#181835!important;border-bottom-color:#8b5cf6!important;filter:drop-shadow(0 0 6px rgba(139,92,246,.5));}
` : '';
  const brandExtras = C._brand ? `
body{background:linear-gradient(145deg,#7BA8F5 0%,#9D8FF0 26%,#F8F2FF 52%,#FF9FD2 76%,#FF6BB5 100%)!important;min-height:100vh;}
` : '';
  return `
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
${wcExtras}
${rgExtras}
${summerExtras}
${videoExtras}
${brandExtras}

/* ── Reset & Base ── */
*{box-sizing:border-box;margin:0;padding:0;}
body{background:${C.bg};color:${C.txt};font-family:'Nunito',sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased;}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:4px;height:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:${C.bor};border-radius:4px;}
::-webkit-scrollbar-thumb:hover{background:${C.mut};}

/* ── Form inputs — uniform 44px height, consistent radius & border ── */
input,select,textarea{
  background:${C.inp};
  border:1.5px solid ${C.bor};
  color:${C.txt};
  border-radius:10px;
  padding:0 13px;
  height:44px;
  font-family:inherit;
  font-size:14px;
  width:100%;
  outline:none;
  transition:border-color .18s, box-shadow .18s;
  line-height:1;
}
textarea{height:auto;padding:11px 13px;line-height:1.5;}
input:focus,select:focus,textarea:focus{
  border-color:${C.vio};
  box-shadow:0 0 0 3px ${C.vio}20;
}
input::placeholder,textarea::placeholder{color:${C.mut};opacity:.7;}
input[type=color]{padding:3px 4px;height:44px;width:48px;min-width:48px;cursor:pointer;border-radius:10px;}
input[type=checkbox]{width:17px;height:17px;accent-color:${C.vio};cursor:pointer;flex-shrink:0;}

/* ── Buttons — uniform 44px touch target, consistent radius ── */
button{
  font-family:inherit;
  cursor:pointer;
  border:none;
  border-radius:10px;
  font-size:14px;
  font-weight:700;
  height:44px;
  padding:0 16px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:7px;
  transition:all .15s;
  white-space:nowrap;
}
button:active{transform:scale(.97);}
button:disabled{opacity:.5;cursor:not-allowed;}

/* Small button variant */
button.btn-sm{height:34px;padding:0 12px;font-size:12px;border-radius:8px;}
/* Icon-only button */
button.btn-icon{width:44px;height:44px;padding:0;border-radius:10px;}

/* ── Labels & Fields ── */
.lbl{
  font-size:11px;
  color:${C.mut};
  display:block;
  margin-bottom:6px;
  font-weight:800;
  letter-spacing:.07em;
  text-transform:uppercase;
}
.field{margin-bottom:16px;}
.row{display:flex;gap:12px;align-items:flex-end;}
.row > *{flex:1;min-width:0;}

/* ── Cards ── */
.card{
  background:${C.card};
  border:1.5px solid ${C.bor};
  border-radius:14px;
  padding:16px;
  transition:box-shadow .18s;
}
.card:hover{box-shadow:0 3px 12px rgba(0,0,0,.08);}

/* ── Section headers ── */
.sec{
  font-size:10px;
  font-weight:800;
  letter-spacing:.13em;
  text-transform:uppercase;
  color:${C.mut};
  margin-bottom:14px;
  padding-bottom:8px;
  border-bottom:1.5px solid ${C.bor};
  display:flex;
  align-items:center;
  gap:8px;
}

/* ── Badges & chips ── */
.badge{
  display:inline-flex;
  align-items:center;
  font-size:10px;
  padding:3px 9px;
  border-radius:6px;
  font-weight:800;
  line-height:1;
}
.chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  background:${C.sur};
  border:1.5px solid ${C.bor};
  border-radius:20px;
  padding:5px 12px;
  font-size:12px;
  font-weight:600;
}

/* ── Animations ── */
@keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.fi{animation:fi .22s ease;}
@keyframes menuPulse{
  0%,100%{opacity:1;box-shadow:0 0 0 0 ${C.vio}88}
  50%{opacity:.7;box-shadow:0 0 0 7px ${C.vio}00}
}
@keyframes slideIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}
@keyframes fadeInDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulseFade{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.8;transform:scale(1.03)}}

/* ── Nav tabs ── */
.nav-tab{
  flex:1;
  padding:10px 4px 8px;
  background:transparent;
  border-bottom:2.5px solid transparent;
  border-radius:0;
  font-size:20px;
  height:auto;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:2px;
  position:relative;
  transition:background .15s,color .15s,border-color .15s;
}
.nav-tab.active{background:${C.sur};border-bottom-color:${C.vio};}
.nav-tab-label{font-size:9px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;}

/* ── Menu items ── */
.menu-item{
  width:100%;
  padding:0 16px;
  height:48px;
  background:transparent;
  color:${C.txt};
  text-align:left;
  display:flex;
  align-items:center;
  gap:12px;
  border-bottom:1px solid ${C.bor};
  font-size:13px;
  font-weight:700;
  border-radius:0;
  transition:background .12s;
}
.menu-item:hover{background:${C.sur};}
.menu-item:active{transform:none;background:${C.bor};}

/* ── Form sections in Config ── */
.config-section{
  background:${C.card};
  border:1.5px solid ${C.bor};
  border-radius:14px;
  padding:18px;
  margin-bottom:14px;
}

/* ── Upgrade / premium lock ── */
.lock-card{
  background:linear-gradient(135deg,${C.vio}12,${C.blu}0a);
  border:1.5px dashed ${C.vio}66;
  border-radius:14px;
  padding:28px 20px;
  text-align:center;
}

/* ── Expense / history cards ── */
.list-item{
  background:${C.card};
  border:1.5px solid ${C.bor};
  border-radius:12px;
  padding:14px 16px;
  margin-bottom:10px;
  display:flex;
  align-items:center;
  gap:12px;
  transition:box-shadow .15s;
}
.list-item:hover{box-shadow:0 2px 10px rgba(0,0,0,.07);}

/* ── Step indicators ── */
.step-dot{
  width:28px;height:28px;
  border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:900;
  flex-shrink:0;
}

/* ── Tab pill selector ── */
.tab-pill{
  display:flex;
  background:${C.sur};
  border-radius:10px;
  padding:4px;
  gap:2px;
  margin-bottom:16px;
}
.tab-pill button{
  flex:1;
  height:36px;
  padding:0 10px;
  font-size:12px;
  border-radius:7px;
  background:transparent;
  color:${C.mut};
  transition:all .15s;
}
.tab-pill button.active{
  background:${C.card};
  color:${C.vio};
  box-shadow:0 1px 4px rgba(0,0,0,.1);
}
@keyframes duvia-shake{
  0%,100%{ transform:translateX(0); }
  15%    { transform:translateX(-9px) rotate(-1deg); }
  30%    { transform:translateX(8px)  rotate(1deg); }
  45%    { transform:translateX(-7px) rotate(-0.5deg); }
  60%    { transform:translateX(6px); }
  75%    { transform:translateX(-4px); }
  90%    { transform:translateX(2px); }
}
@keyframes spin{ to{ transform:rotate(360deg); } }
.duvia-shake{
  animation: duvia-shake 0.55s cubic-bezier(.36,.07,.19,.97) both;
  border-color: ${C.red} !important;
  box-shadow: 0 0 0 3px ${C.red}33 !important;
}
`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK — localStorage persistence
// ═══════════════════════════════════════════════════════════════════════════════
function useLocalStorage(key, initialValue) {
  const [state, setState] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      if (item !== null) return JSON.parse(item);
    } catch {}
    return typeof initialValue === "function" ? initialValue() : initialValue;
  });

  // Sync to localStorage after each state change (non-blocking)
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(state)); } catch {}
  }, [key, state]); // ✅ key ajoutée (était absent — bug potentiel)

  // useCallback : setValue ne change plus à chaque render
  const setValue = useCallback((value) => {
    setState(prev => typeof value === "function" ? value(prev) : value);
  }, []); // ✅ référence stable

  return [state, setValue];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNCHRONISATION FAMILLE — Phase 1 Supabase
// Chaque appareil obtient un "badge invisible" (compte anonyme Supabase).
// Les données de la famille (cfg) sont sauvegardées dans la table `families`,
// identifiées par `cfg.shareCode`. Un 2e parent peut "rejoindre" cette même
// famille en saisissant ce code.
// ═══════════════════════════════════════════════════════════════════════════════
function useFamilySync(cfg, setCfg) {
  const [syncStatus, setSyncStatus] = useState("connecting"); // connecting | synced | offline | error
  const [familyId, setFamilyIdState] = useState(null);
  const [families, setFamilies] = useState([]); // [{id,label}] — familles validées (status=active) de ce compte
  const [pendingMembers, setPendingMembers] = useState([]); // [{userId,email,role,joinedAt}] — en attente de ma validation
  const [pendingApproval, setPendingApproval] = useState(false); // ce compte n'a qu'une adhésion "pending", pas d'accès
  const familyIdRef = useRef(null);
  const skipNextSave = useRef(true);
  const saveTimer = useRef(null);
  const cfgRef = useRef(cfg); cfgRef.current = cfg; // snapshot courant pour l'éjection
  const uidRef = useRef(null);

  function setFamilyIdBoth(id){ familyIdRef.current = id; setFamilyIdState(id); }

  // ── Éjection INSTANTANÉE ──────────────────────────────────────────────────
  // Si mon adhésion à la famille active passe à un statut ≠ 'active' (retiré par
  // le créateur, ou la famille est dissoute), on le détecte en temps réel : on
  // sauvegarde une synthèse locale des données puis on recharge → boot me fait
  // repartir sur une famille vierge, et un message explicatif s'affiche.
  useEffect(() => {
    if (!familyId) return;
    let ch; let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data?.user?.id; uidRef.current = uid;
      if (!uid || cancelled) return;
      ch = supabase
        .channel(`fm_self_${familyId}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "family_members", filter: `family_id=eq.${familyId}` },
          (payload) => {
            const row = payload.new;
            // (a) Quelqu'un rejoint / change de statut → rafraîchir mes demandes
            //     en attente pour pouvoir valider EN DIRECT (sans recharger).
            try { refreshPendingMembers(); } catch {}
            // (b) Mon propre statut passe à ≠ 'active' → je suis éjecté.
            if (row?.user_id === uid && row?.status && row.status !== "active") {
              const voluntary = (() => { try { return window.localStorage.getItem("duvia_left") === "1"; } catch { return false; } })();
              try {
                window.localStorage.setItem("duvia_family_snapshot", JSON.stringify({ at: new Date().toISOString(), cfg: cfgRef.current || null }));
                if (!voluntary) window.localStorage.setItem("duvia_ejected", "1");
              } catch {}
              duviaReload();
              return;
            }
            // (c) Un AUTRE membre s'est retiré/a quitté → le retirer de ma donnée
            //     partagée (cfg.parents) et prévenir (notification au créateur).
            if (row?.user_id && row.user_id !== uid && (row.status === "removed" || row.status === "left")) {
              const parents = cfgRef.current?.parents || [];
              const idx = parents.findIndex(p => p && p.userId === row.user_id);
              if (idx > 0) {
                const leftName = parents[idx]?.name || "L'invité";
                setCfg(c => ({ ...c, parents: c.parents.filter((_, j) => j !== idx) }));
                try { window.dispatchEvent(new CustomEvent("duvia-invite-left", { detail: leftName })); } catch {}
              }
            }
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) supabase.removeChannel(ch); };
  }, [familyId]);

  // ── Rafraîchissement des demandes en attente, SANS dépendre du Realtime ──
  // Garantit que le créateur voit la demande de validation d'un invité même si
  // le Realtime n'est pas activé sur family_members : au focus de la fenêtre,
  // au retour sur l'onglet, et par sécurité toutes les 12 s.
  useEffect(() => {
    if (!familyId) return;
    const tick = () => { try { refreshPendingMembers(); } catch {} };
    const onVis = () => { if (!document.hidden) tick(); };
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVis);
    const id = setInterval(tick, 12000);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [familyId]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. S'assurer d'avoir une session (compte anonyme automatique)
        const { data: sessData } = await supabase.auth.getSession();
        if (!sessData?.session) {
          const { error: signErr } = await supabase.auth.signInAnonymously();
          if (signErr) throw signErr;
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData?.user?.id;
        if (!uid) throw new Error("no-uid");

        // 2. 🔧 Le serveur fait toujours autorité : on vérifie d'abord si ce
        // compte appartient déjà à une famille connue, AVANT de faire
        // confiance à la note locale (duvia_family_id). Cette note peut
        // disparaître (cache vidé, nouvel appareil/navigateur) alors que le
        // compte, lui, reste bien lié — sans ça, l'app créait une nouvelle
        // famille vide à chaque fois que la note locale manquait.
        let familyId = null;
        let hasPendingOnly = false;
        let wasRemoved = false;
        let membershipQueryFailed = false;
        try {
          const { data: memberships, error: memErr } = await supabase
            .from("family_members")
            .select("family_id, status")
            .eq("user_id", uid);
          if (memErr) throw memErr;
          const actives = (memberships || []).filter(m => m.status === "active");
          // 🔧 Multi-familles : si plusieurs familles actives, préférer celle
          // notée localement (duvia_family_id) — typiquement celle rejointe via
          // un lien d'invitation — plutôt que « la première venue » (qui pouvait
          // être une famille vierge laissée par un départ précédent).
          let active = null;
          try {
            const noted = window.localStorage.getItem("duvia_family_id");
            if (noted) active = actives.find(m => m.family_id === noted) || null;
          } catch {}
          if (!active) active = actives[0] || null;
          if (active?.family_id) {
            familyId = active.family_id;
            try { window.localStorage.setItem("duvia_family_id", familyId); } catch {}
          } else if ((memberships || []).some(m => m.status === "pending")) {
            // 🔒 Le compte n'a QUE des adhésions en attente de validation —
            // on ne charge rien et on ne crée surtout pas de nouvelle famille.
            hasPendingOnly = true;
          } else if ((memberships || []).some(m => m.status === "removed")) {
            // 🔧 Le compte a été RETIRÉ de sa (seule) famille par l'inviteur →
            // on repart sur une famille vierge, seul (cf. branche plus bas).
            wasRemoved = true;
          }
        } catch (e) {
          console.warn("[Duvia][sync] membership lookup failed:", e);
          membershipQueryFailed = true;
        }

        if (hasPendingOnly) {
          if (!cancelled) { setPendingApproval(true); setSyncStatus("synced"); }
          return;
        }

        // 🔧 Membre retiré : créer une famille vierge (profil seul, index 0),
        // effacer toute trace de l'ancienne famille, puis recharger proprement.
        // Garde anti-boucle : on ne tente ça qu'UNE fois par session.
        if (wasRemoved && !familyId) {
          let alreadyTried = false;
          try { alreadyTried = window.sessionStorage.getItem("duvia_fresh_try") === "1"; } catch {}
          if (alreadyTried) {
            // La tentative précédente n'a pas abouti → on n'insiste pas (évite la
            // page blanche / boucle). On laisse l'utilisateur sur un état stable.
            if (!cancelled) { setPendingApproval(false); setSyncStatus("error"); }
            return;
          }
          try { window.sessionStorage.setItem("duvia_fresh_try", "1"); } catch {}
          try {
            const newId = crypto.randomUUID();
            const fresh = makeCfg();
            try {
              const list = JSON.parse(window.localStorage.getItem("duvia_users") || "[]");
              const sessEmail = JSON.parse(window.localStorage.getItem("duvia_session") || "null");
              const me = list.find(u2 => u2.email === sessEmail);
              if (me) {
                fresh.parents[0] = {
                  ...fresh.parents[0],
                  id: me.id || 1, name: me.name || "", email: me.email || "",
                  gender: me.gender || fresh.parents[0].gender, phone: me.phone || "",
                };
                window.localStorage.setItem("duvia_users", JSON.stringify(
                  list.map(u2 => u2.email === sessEmail ? { ...u2, parentIdx: 0 } : u2)
                ));
              }
            } catch {}
            const { error: famErr } = await supabase.from("families").insert({ id: newId, share_code: fresh.shareCode, data: fresh });
            if (famErr) throw famErr;
            const { error: memErr2 } = await supabase.from("family_members").insert({ family_id: newId, user_id: uid, role: "parent" });
            if (memErr2) throw memErr2;
            try { window.localStorage.setItem("duvia_family_id", newId); } catch {}
            try { window.localStorage.removeItem("duvia_left"); } catch {}
            if (!cancelled) { duviaReload(); }
          } catch (e) {
            console.error("[Duvia][sync] fresh-family-after-removal failed:", e);
            if (!cancelled) setSyncStatus("error");
          }
          return;
        }

        if (membershipQueryFailed) {
          // 🔒 On ne sait pas si ce compte a déjà une famille (erreur réseau/serveur) —
          // surtout ne pas en créer une nouvelle ni faire confiance à une note locale
          // potentiellement périmée (compte précédent sur cet appareil). On s'arrête
          // proprement plutôt que de risquer une fuite ou un doublon.
          if (!cancelled) setSyncStatus("error");
          return;
        }

        if (!familyId) {
          // 🔧 Le serveur a confirmé qu'aucune famille n'est liée à ce compte —
          // on en crée une nouvelle directement. On ne passe plus par la note
          // locale (duvia_family_id) ni par un code de partage en fallback
          // automatique : ça pourrait appartenir à un compte précédent sur cet
          // appareil (la vérification serveur ci-dessus est désormais fiable).
          familyId = crypto.randomUUID();
          // 🔧 Pré-remplir le profil du créateur DANS la donnée insérée elle-même
          // (pas seulement en local après coup) — sinon le prochain fetch écrase
          // la version vide qui vient d'être enregistrée, et le nom disparaît.
          let seedCfg = cfg;
          try {
            const rawUsers   = window.localStorage.getItem("duvia_users");
            const sessEmail  = JSON.parse(window.localStorage.getItem("duvia_session") || "null");
            const list = rawUsers ? JSON.parse(rawUsers) : [];
            const me = list.find(u2 => u2.email === sessEmail);
            if (me && me.role === "parent" && typeof me.parentIdx === "number") {
              const parents = [...(cfg.parents || [])];
              const idx = me.parentIdx;
              const existing = parents[idx] || {};
              parents[idx] = {
                ...existing,
                id:     existing.id || me.id,
                name:   me.name   || existing.name   || "",
                email:  me.email  || existing.email  || "",
                gender: me.gender || existing.gender || "M",
                phone:  me.phone  || existing.phone  || "",
                color:  existing.color || PCOLS[idx % PCOLS.length],
              };
              seedCfg = { ...cfg, parents };
            }
          } catch {}
          await supabase.from("families").insert({ id: familyId, share_code: seedCfg.shareCode, data: seedCfg });
          await supabase.from("family_members").insert({ family_id: familyId, user_id: uid, role: "parent" });
          try { window.localStorage.setItem("duvia_family_id", familyId); } catch {}
        } else {
          // S'assurer que ce compte est bien membre (sécurité) — le serveur a
          // confirmé ci-dessus que cette famille est bien la sienne.
          await supabase.from("family_members").upsert(
            { family_id: familyId, user_id: uid, role: "parent" },
            { onConflict: "family_id,user_id" }
          );
        }

        setFamilyIdBoth(familyId);

        // 5. Charger les données du cloud (le cloud fait foi au démarrage)
        const { data: famRow, error: fetchErr } = await supabase
          .from("families").select("data").eq("id", familyId).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!cancelled && famRow?.data && Object.keys(famRow.data).length > 0) {
          setCfg(() => famRow.data);

          // 🔧 CORRECTIF (suite) : si je viens d'être validé, l'inviteur n'a pu
          // écrire qu'un nom provisoire (partie locale de mon email). Je remplace
          // par mon vrai nom depuis mon profil local — sans écraser un nom déjà
          // saisi par quelqu'un d'autre, et uniquement sur MON propre créneau
          // (repéré par userId === uid, ou nom vide).
          try {
            const rawUsers  = window.localStorage.getItem("duvia_users");
            const sessEmail = JSON.parse(window.localStorage.getItem("duvia_session") || "null");
            const list = rawUsers ? JSON.parse(rawUsers) : [];
            const me = list.find(u2 => u2.email === sessEmail);
            const patched = reconcileOwnParentSlot(famRow.data.parents, me, uid);
            if (patched && !cancelled) setCfg(c => ({ ...c, parents: patched }));
          } catch {}

          // 🔧 Réconciliation : retirer de cfg.parents tout parent dont l'adhésion
          // n'est plus active (l'invité a quitté/été retiré pendant que j'étais
          // hors-ligne). Le créateur (index 0) n'est jamais retiré.
          try {
            const { data: mems } = await supabase
              .from("family_members").select("user_id,status").eq("family_id", familyId);
            const inactive = new Set((mems || []).filter(m => m.status !== "active").map(m => m.user_id));
            if (inactive.size && !cancelled) {
              setCfg(c => {
                const kept = (c.parents || []).filter((p, j) => j === 0 || !(p && p.userId && inactive.has(p.userId)));
                return kept.length !== (c.parents || []).length ? { ...c, parents: kept } : c;
              });
            }
          } catch {}
        }
        if (!cancelled) refreshFamilies(uid);
        if (!cancelled) refreshPendingMembers();
        if (!cancelled) setSyncStatus("synced");
      } catch (e) {
        console.error("[Duvia][sync] init error:", e);
        if (!cancelled) setSyncStatus("offline");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Sauvegarde automatique (avec petit délai) ───────────────────────────
  useEffect(() => {
    if (!familyIdRef.current) return;
    if (skipNextSave.current) { skipNextSave.current = false; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const { error } = await supabase
          .from("families")
          .update({ data: cfg, updated_at: new Date().toISOString() })
          .eq("id", familyIdRef.current);
        if (error) throw error;
        setSyncStatus("synced");
      } catch (e) {
        console.error("[Duvia][sync] save error:", e);
        setSyncStatus("error");
      }
    }, 1500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [cfg]);

  // ── Mise à jour automatique : écoute les changements faits par l'autre
  // appareil (Supabase Realtime) et met à jour l'écran sans recharger ─────
  useEffect(() => {
    if (!familyId) return;
    const channel = supabase
      .channel(`family_${familyId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "families", filter: `id=eq.${familyId}` },
        (payload) => {
          if (payload.new?.data && payload.new.data.parents) {
            skipNextSave.current = true;
            setCfg(() => payload.new.data);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [familyId]);

  // ── Rejoindre la famille d'un autre appareil avec son code ──────────────
  async function joinFamily(code) {
    const cleanCode = (code || "").trim().toUpperCase();
    if (!cleanCode) return { ok: false, error: "empty" };
    try {
      setSyncStatus("connecting");
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData?.user?.id;
      const { data: foundId, error: rpcErr } = await supabase.rpc("find_family_by_share_code", { p_code: cleanCode });
      if (rpcErr) throw rpcErr;
      if (!foundId) { setSyncStatus("synced"); return { ok: false, error: "notfound" }; }

      await supabase.from("family_members").upsert(
        { family_id: foundId, user_id: uid, role: "parent" },
        { onConflict: "family_id,user_id" }
      );
      const { data: famRow, error: fetchErr } = await supabase
        .from("families").select("data").eq("id", foundId).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!famRow?.data || !famRow.data.parents) {
        setSyncStatus("error");
        return { ok: false, error: "error" };
      }

      // ⚠️ Annule toute sauvegarde "en attente" des anciennes données locales —
      // sinon elle écraserait les données de la famille qu'on vient de rejoindre.
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }

      setFamilyIdBoth(foundId);
      try { window.localStorage.setItem("duvia_family_id", foundId); } catch {}
      // On skip ce setCfg (données brutes Supabase) mais PAS les suivants (ex: inviteStatus:accepted)
      // afin que le Parent 1 voie bien que le Parent 2 a rejoint la famille.
      skipNextSave.current = true;
      setCfg(() => ({ ...famRow.data, shareCode: cleanCode }));
      setSyncStatus("synced");
      return { ok: true, _familyId: foundId };
    } catch (e) {
      console.error("[Duvia][sync] join error:", e);
      setSyncStatus("error");
      return { ok: false, error: "error" };
    }
  }

  // ── Inscription : crée le compte Supabase Auth et ouvre la session ────────
  async function linkAccount(email, password, metadata) {
    try {
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { data: metadata || {} },
      });
      if (error) {
        if (error.message?.includes("already registered"))
          return { ok: false, error: "already_registered" };
        throw error;
      }
      // signUp retourne une session directement si "Confirm email" est OFF
      if (!data?.session) {
        // Pas de session → on force la connexion
        const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
        if (signInErr) throw signInErr;
      }
      return { ok: true };
    } catch (e) {
      console.error("[Duvia][sync] linkAccount error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  // ── Connexion sur un autre appareil avec un compte existant ─────────────
  async function signInExisting(email, password) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const uid = data?.user?.id;
      if (!uid) throw new Error("no-uid");

      // Retrouver la famille liée à ce compte (uniquement si adhésion validée)
      const { data: members, error: memErr } = await supabase
        .from("family_members").select("family_id").eq("user_id", uid).eq("status","active").limit(1);
      if (memErr) throw memErr;
      const familyId = members?.[0]?.family_id;
      if (familyId) {
        const { data: famRow, error: fetchErr } = await supabase
          .from("families").select("data").eq("id", familyId).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (famRow?.data && famRow.data.parents) {
          if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
          setFamilyIdBoth(familyId);
          try { window.localStorage.setItem("duvia_family_id", familyId); } catch {}
          skipNextSave.current = true;
          setCfg(() => famRow.data);
        }
      }
      setSyncStatus("synced");
      return { ok: true, metadata: data?.user?.user_metadata || {} };
    } catch (e) {
      console.error("[Duvia][sync] signInExisting error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  // ── Liste des familles validées (status=active) de ce compte ────────────
  async function refreshFamilies(uid) {
    try {
      const { data, error } = await supabase
        .from("family_members")
        .select("family_id, families(data)")
        .eq("user_id", uid)
        .eq("status", "active");
      if (error) throw error;
      const list = (data || []).map(r => ({
        id: r.family_id,
        label: (r.families?.data?.parents || []).map(p => p?.name).filter(Boolean).join(" & ") || "Famille",
      }));
      setFamilies(list);
    } catch (e) {
      console.warn("[Duvia][sync] refreshFamilies failed:", e);
    }
  }

  // ── Basculer vers une autre famille déjà validée (menu déroulant) ───────
  async function switchFamily(newFamilyId) {
    if (!newFamilyId || newFamilyId === familyIdRef.current) return { ok: true };
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    setSyncStatus("connecting");
    try {
      const { data: famRow, error } = await supabase
        .from("families").select("data").eq("id", newFamilyId).maybeSingle();
      if (error || !famRow?.data) { setSyncStatus("error"); return { ok: false, error: "error" }; }
      skipNextSave.current = true;
      setFamilyIdBoth(newFamilyId);
      try { window.localStorage.setItem("duvia_family_id", newFamilyId); } catch {}
      setCfg(() => famRow.data);
      setSyncStatus("synced");
      return { ok: true };
    } catch (e) {
      console.error("[Duvia][sync] switchFamily error:", e);
      setSyncStatus("error");
      return { ok: false, error: e.message || "error" };
    }
  }

  // ── Créer une nouvelle famille (ex: 2e fratrie) et basculer sur elle ────
  async function createNewFamily(prefillParent) {
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData?.user?.id;
      if (!uid) return { ok: false, error: "no-uid" };
      const newId = crypto.randomUUID();
      const base = makeCfg();
      const blankCfg = {
        ...base,
        parents: [{ ...base.parents[0], ...(prefillParent || {}) }],
        shareCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
      };
      const { error: insFamErr } = await supabase
        .from("families").insert({ id: newId, share_code: blankCfg.shareCode, data: blankCfg });
      if (insFamErr) throw insFamErr;
      const { error: insMemErr } = await supabase
        .from("family_members").insert({ family_id: newId, user_id: uid, role: "parent", status: "active" });
      if (insMemErr) throw insMemErr;

      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      skipNextSave.current = true;
      setFamilyIdBoth(newId);
      try { window.localStorage.setItem("duvia_family_id", newId); } catch {}
      setCfg(() => blankCfg);
      await refreshFamilies(uid);
      setSyncStatus("synced");
      return { ok: true, familyId: newId };
    } catch (e) {
      console.error("[Duvia][sync] createNewFamily error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  // ── Rejoindre une famille via un token d'invitation (validation en 2 temps) ─
  // 🔒 Ne charge jamais les données de la famille ici : le statut est "pending",
  // l'invité ne doit rien voir tant qu'il n'est pas validé par l'inviteur.
  async function joinFamilyByToken(token, identity) {
    try {
      const { data: familyId, error } = await supabase.rpc("accept_family_invitation", { p_token: token });
      if (error || !familyId) {
        const msg = error?.message || "";
        if (msg.includes("invitation_expired")) return { ok: false, error: "expired" };
        if (msg.includes("invitation_already_used")) return { ok: false, error: "used" };
        if (msg.includes("invitation_not_found")) return { ok: false, error: "not_found" };
        return { ok: false, error: msg || "error" };
      }
      // 🔧 Enregistre le vrai nom/genre de l'invité sur SA ligne family_members,
      // côté serveur (source autoritaire). Non bloquant : si la RPC échoue, la
      // réconciliation côté invité au prochain chargement reste un filet de
      // sécurité.
      if (identity && (identity.name || identity.gender)) {
        try {
          await supabase.rpc("set_member_identity", {
            p_family_id: familyId,
            p_display_name: identity.name || null,
            p_gender: identity.gender || null,
          });
        } catch (e) { console.warn("[Duvia][sync] set_member_identity:", e); }
      }
      return { ok: true, familyId, pending: true };
    } catch (e) {
      console.error("[Duvia][sync] joinFamilyByToken error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  // ── Demandes en attente de validation pour la famille active ────────────
  async function refreshPendingMembers() {
    if (!familyIdRef.current) { setPendingMembers([]); return; }
    try {
      const { data: pendingRows, error } = await supabase
        .from("family_members")
        .select("user_id, role, joined_at, display_name, gender")
        .eq("family_id", familyIdRef.current)
        .eq("status", "pending");
      if (error) throw error;
      if (!pendingRows?.length) { setPendingMembers([]); return; }
      // L'email reste un complément d'affichage (le nom fait foi côté serveur).
      const { data: invRows } = await supabase
        .from("family_invitations")
        .select("used_by, email")
        .eq("family_id", familyIdRef.current)
        .not("used_by", "is", null);
      const emailByUid = {};
      (invRows || []).forEach(r => { if (r.used_by) emailByUid[r.used_by] = r.email; });
      setPendingMembers(pendingRows.map(r => ({
        userId: r.user_id, role: r.role, joinedAt: r.joined_at,
        displayName: r.display_name || null,
        gender: r.gender || null,
        email: emailByUid[r.user_id] || null,
      })));
    } catch (e) {
      console.warn("[Duvia][sync] refreshPendingMembers failed:", e);
    }
  }

  async function validateMember(member) {
    // Accepte soit l'objet membre complet {userId,email,role,...}, soit (compat)
    // un simple userId — on retrouve alors les infos dans pendingMembers.
    const m = typeof member === "object" && member
      ? member
      : (pendingMembers.find(p => p.userId === member) || { userId: member });
    const userId = m.userId;
    try {
      const { error } = await supabase.rpc("validate_family_member", { p_family_id: familyIdRef.current, p_user_id: userId });
      if (error) throw error;

      // 🔧 CORRECTIF : la RPC bascule seulement family_members.status='active'.
      // Sans écriture ici, le membre validé n'apparaissait JAMAIS dans la donnée
      // partagée (families.data.parents) — ni chez l'inviteur, ni chez l'invité
      // au rechargement. On l'inscrit donc dans cfg.parents (l'autosave pousse
      // ensuite vers Supabase). L'invité affinera son propre nom à sa connexion.
      if ((m.role || "parent") === "parent") {
        setCfg(c => ({ ...c, parents: insertValidatedParent(c.parents, m) }));
      }

      await refreshPendingMembers();
      await refreshFamilies((await supabase.auth.getUser()).data?.user?.id);
      return { ok: true };
    } catch (e) {
      console.error("[Duvia][sync] validateMember error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  async function rejectMember(userId) {
    try {
      const { error } = await supabase.rpc("reject_family_member", { p_family_id: familyIdRef.current, p_user_id: userId });
      if (error) throw error;
      await refreshPendingMembers();
      return { ok: true };
    } catch (e) {
      console.error("[Duvia][sync] rejectMember error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  // Retire un membre ACTIF de la famille (inviteur → invité). Le serveur passe
  // son adhésion à 'removed' ; le membre retiré repartira sur une famille
  // vierge à sa prochaine connexion (détecté dans le boot ci-dessus).
  async function removeFamilyMember(userId) {
    if (!userId || !familyIdRef.current) return { ok: false, error: "missing" };
    try {
      const { error } = await supabase.rpc("remove_family_member", { p_family_id: familyIdRef.current, p_user_id: userId });
      if (error) throw error;
      const { data } = await supabase.auth.getUser();
      await refreshFamilies(data?.user?.id);
      return { ok: true };
    } catch (e) {
      console.error("[Duvia][sync] removeFamilyMember error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  // « Quitter la famille » (créateur ou invité) : retire ma propre adhésion.
  async function leaveFamily() {
    const fid = familyIdRef.current;
    if (!fid) return { ok: false, error: "no-family" };
    try {
      // Mémorise la synthèse + marque le départ volontaire (pas de message d'éjection).
      try {
        window.localStorage.setItem("duvia_family_snapshot", JSON.stringify({ at: new Date().toISOString(), cfg: cfgRef.current || null }));
        window.localStorage.setItem("duvia_left", "1");
      } catch {}
      // 🔧 Retirer MON propre créneau de la donnée PARTAGÉE pour que l'autre
      // parent ne me voie plus (la réconciliation par userId n'était pas fiable).
      // On m'identifie par mon uid (posé sur mon créneau au boot) OU par mon email.
      try {
        const uid = uidRef.current;
        const myEmail = (cfgRef.current?.parents || []).find(p => p && p.userId === uid)?.email;
        const { data: fam } = await supabase.from("families").select("data").eq("id", fid).maybeSingle();
        if (fam?.data?.parents) {
          const parents = fam.data.parents.filter((p, j) =>
            j === 0 ? true : !(p && ((uid && p.userId === uid) || (myEmail && p.email && p.email.toLowerCase() === myEmail.toLowerCase())))
          );
          if (parents.length !== fam.data.parents.length) {
            await supabase.from("families").update({ data: { ...fam.data, parents } }).eq("id", fid);
          }
        }
      } catch (e) { console.warn("[Duvia][sync] leaveFamily: nettoyage créneau partagé:", e); }
      const { error } = await supabase.rpc("leave_family", { p_family_id: fid });
      if (error) throw error;

      // 🔧 Si je n'ai plus AUCUNE autre famille active, m'en attribuer une
      // vierge TOUT DE SUITE (avec un nouveau code) — sinon je me retrouve sans
      // famille et bloqué sur l'écran « Impossible de vérifier ta famille ».
      try {
        const uid = uidRef.current;
        const { data: others } = await supabase
          .from("family_members").select("family_id")
          .eq("user_id", uid).eq("status", "active");
        if (!others || others.length === 0) {
          const newId = crypto.randomUUID();
          const fresh = makeCfg();
          try {
            const myOld = (cfgRef.current?.parents || []).find(p => p && p.userId === uid)
                       || (cfgRef.current?.parents || [])[0] || {};
            fresh.parents[0] = {
              ...fresh.parents[0],
              id: myOld.id || 1, name: myOld.name || "", email: myOld.email || "",
              gender: myOld.gender || fresh.parents[0].gender, phone: myOld.phone || "",
            };
          } catch {}
          // Même schéma d'insertion que la création de famille normale (qui marche) :
          // family_members sans 'status' explicite → le défaut (actif) s'applique.
          await supabase.from("families").insert({ id: newId, share_code: fresh.shareCode, data: fresh });
          await supabase.from("family_members").insert({ family_id: newId, user_id: uid, role: "parent" });
          try { window.localStorage.setItem("duvia_family_id", newId); } catch {}
          try { window.localStorage.removeItem("duvia_left"); } catch {}
          // 🔧 Dans ma nouvelle famille je suis le parent UNIQUE (index 0) : il faut
          // mettre à jour mon parentIdx, sinon ma fiche d'identité complète reste
          // masquée (elle ne s'affiche que sur « ma » carte, i === parentIdx).
          try {
            const list = JSON.parse(window.localStorage.getItem("duvia_users") || "[]");
            const sessEmail = JSON.parse(window.localStorage.getItem("duvia_session") || "null");
            window.localStorage.setItem("duvia_users", JSON.stringify(
              list.map(u2 => u2.email === sessEmail ? { ...u2, parentIdx: 0 } : u2)
            ));
          } catch {}
        }
      } catch (e) { console.warn("[Duvia][sync] leaveFamily: création famille vierge:", e); }
      return { ok: true };
    } catch (e) {
      console.error("[Duvia][sync] leaveFamily error:", e);
      return { ok: false, error: e.message || "error" };
    }
  }

  return { syncStatus, familyId, families, joinFamily, linkAccount, signInExisting, switchFamily, createNewFamily, refreshFamilies, joinFamilyByToken, pendingMembers, refreshPendingMembers, validateMember, rejectMember, removeFamilyMember, leaveFamily, pendingApproval };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT — shared app state accessible anywhere without prop-drilling
// ═══════════════════════════════════════════════════════════════════════════════
const AppContext = createContext(null);
function useApp() { return useContext(AppContext); }

// ═══════════════════════════════════════════════════════════════════════════════
// INFO BUBBLE (générique) — icône 👋, ouverte automatiquement une seule fois
// puis togglable manuellement. Persisté via localStorage par clé+utilisateur.
// ═══════════════════════════════════════════════════════════════════════════════
function InfoBubble({C,tipKey,title,children,autoOpen=true}) {
  const {t} = useApp();
  const [open, setOpen] = useState(() => {
    if (!autoOpen) return false;
    try { return !window.localStorage.getItem(tipKey); } catch { return true; }
  });
  function close() {
    setOpen(false);
    try { window.localStorage.setItem(tipKey, "1"); } catch {}
  }
  function toggle() {
    setOpen(o => {
      const next = !o;
      if (!next) { try { window.localStorage.setItem(tipKey, "1"); } catch {} }
      return next;
    });
  }

  return (
    <div style={{position:"relative"}}>
      <button onClick={toggle} style={{width:28,height:28,borderRadius:"50%",background:open?C.vio:`${C.vio}18`,border:`1.5px solid ${C.vio}`,color:open?"#fff":C.vio,fontSize:13,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
        👋
      </button>
      {open && (
        <div onClick={close} style={{position:"absolute",top:36,right:0,zIndex:50,cursor:"pointer",animation:"fadeInDown .35s ease",width:230}}>
          <div style={{position:"absolute",top:-7,right:8,width:0,height:0,borderLeft:"8px solid transparent",borderRight:"8px solid transparent",borderBottom:`8px solid ${C.vio}`}} />
          <div style={{background:C.vio,color:"#fff",borderRadius:14,padding:"12px 16px",boxShadow:"0 8px 28px rgba(0,0,0,.22)",position:"relative"}}>
            <div style={{fontSize:18,marginBottom:6,textAlign:"center"}}>👋</div>
            <div style={{fontSize:13,fontWeight:800,marginBottom:4,lineHeight:1.3,textAlign:"center"}}>
              {title}
            </div>
            <div style={{fontSize:12,opacity:.92,lineHeight:1.45}}>
              {children}
            </div>
            <div style={{fontSize:10,opacity:.7,marginTop:8,textAlign:"right"}}>
              {t.tapToClose||"Appuyer pour fermer"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFO BUBBLE — icône 👋 avec bulle style "Bienvenue sur Duvia"
// ═══════════════════════════════════════════════════════════════════════════════
function StepIdInfoButton({C,t}) {
  const tipKey = "duvia_stepid_info_seen";
  const [open, setOpen] = useState(() => {
    try { return !window.localStorage.getItem(tipKey); } catch { return true; }
  });
  const btnRef = useRef(null);
  const [pos, setPos] = useState({top:0, right:0, arrowRight:0});

  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      setPos({ top: r.bottom + 10, right: vw - r.right - 4, arrowRight: 10 });
      // Marquer comme vu
      try { window.localStorage.setItem(tipKey, "1"); } catch {}
    }
  }, [open]);

  return (
    <div style={{position:"relative",marginLeft:"auto"}}>
      <button ref={btnRef} onClick={()=>setOpen(o=>!o)}
        style={{width:30,height:30,borderRadius:"50%",background:open?C.vio:`${C.vio}22`,border:`1.5px solid ${C.vio}55`,color:open?"#fff":C.vio,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s",flexShrink:0}}>
        👋
      </button>
      {open && (
        <div onClick={()=>setOpen(false)} style={{position:"fixed",top:pos.top,right:pos.right,zIndex:400,cursor:"pointer",animation:"fadeInDown .25s ease",maxWidth:240}}>
          <div style={{position:"absolute",top:-7,right:pos.arrowRight,width:0,height:0,borderLeft:"8px solid transparent",borderRight:"8px solid transparent",borderBottom:`8px solid ${C.vio}`}} />
          <div style={{background:C.vio,color:"#fff",borderRadius:14,padding:"14px 16px",boxShadow:"0 8px 28px rgba(0,0,0,.25)"}}>
            <div style={{fontSize:18,marginBottom:6,textAlign:"center"}}>👋</div>
            <div style={{fontSize:13,fontWeight:800,marginBottom:8,lineHeight:1.3}}>{t.helpIdTitle}</div>
            <div style={{fontSize:12,opacity:.95,lineHeight:1.6,display:"flex",flexDirection:"column",gap:8}}>
              <div>
                <strong>{t.helpIdParentTitle}</strong><br/>
                {t.helpIdParentBody}
              </div>
              <div>
                <strong>{t.helpIdChildTitle}</strong><br/>
                {t.helpIdChildBody}
              </div>
              <div>
                <strong>{t.helpIdInviteTitle}</strong><br/>
                {t.helpIdInviteBody}
              </div>
            </div>
            <div style={{fontSize:10,opacity:.7,marginTop:10,textAlign:"right"}}>{t.tapToClose}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFO BUBBLE — Dates spéciales
// ═══════════════════════════════════════════════════════════════════════════════
function StepDatesInfoButton({C,t}) {
  const tipKey = "duvia_stepdates_info_seen";
  const [open, setOpen] = useState(() => {
    try { return !window.localStorage.getItem(tipKey); } catch { return true; }
  });
  const btnRef = useRef(null);
  const [pos, setPos] = useState({top:0, right:0});

  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      setPos({ top: r.bottom + 10, right: vw - r.right - 4 });
      try { window.localStorage.setItem(tipKey, "1"); } catch {}
    }
  }, [open]);

  return (
    <div style={{position:"relative",marginLeft:"auto"}}>
      <button ref={btnRef} onClick={()=>setOpen(o=>!o)}
        style={{width:30,height:30,borderRadius:"50%",background:open?C.vio:`${C.vio}22`,border:`1.5px solid ${C.vio}55`,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s",flexShrink:0}}>
        👋
      </button>
      {open && (
        <div onClick={()=>setOpen(false)} style={{position:"fixed",top:pos.top,right:pos.right,zIndex:400,cursor:"pointer",animation:"fadeInDown .25s ease",maxWidth:250}}>
          <div style={{position:"absolute",top:-7,right:10,width:0,height:0,borderLeft:"8px solid transparent",borderRight:"8px solid transparent",borderBottom:`8px solid ${C.vio}`}} />
          <div style={{background:C.vio,color:"#fff",borderRadius:14,padding:"14px 16px",boxShadow:"0 8px 28px rgba(0,0,0,.25)"}}>
            <div style={{fontSize:18,marginBottom:6,textAlign:"center"}}>📅</div>
            <div style={{fontSize:13,fontWeight:800,marginBottom:8,lineHeight:1.3}}>{t.helpDatesTitle}</div>
            <div style={{fontSize:12,opacity:.95,lineHeight:1.6,display:"flex",flexDirection:"column",gap:8}}>
              <div>
                <strong>{t.helpDatesMothersTitle}</strong><br/>
                {t.helpDatesMothersBody}
              </div>
              <div>
                <strong>{t.helpDatesParentBdayTitle}</strong><br/>
                {t.helpDatesParentBdayBody}
              </div>
              <div>
                <strong>{t.helpDatesChildBdayTitle}</strong><br/>
                {t.helpDatesChildBdayBody}
              </div>
              <div>
                <strong>{t.helpDatesHolidaysTitle}</strong><br/>
                {t.helpDatesHolidaysBody}
              </div>
            </div>
            <div style={{fontSize:10,opacity:.7,marginTop:10,textAlign:"right"}}>{t.tapToClose}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFO BUBBLE — Modèle de garde
// ═══════════════════════════════════════════════════════════════════════════════
function StepGardeInfoButton({C,t}) {
  const tipKey = "duvia_stepgarde_info_seen";
  const [open, setOpen] = useState(() => {
    try { return !window.localStorage.getItem(tipKey); } catch { return true; }
  });
  const btnRef = useRef(null);
  const [pos, setPos] = useState({top:0, right:0});

  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      setPos({ top: r.bottom + 10, right: vw - r.right - 4 });
      try { window.localStorage.setItem(tipKey, "1"); } catch {}
    }
  }, [open]);

  return (
    <div style={{position:"relative",marginLeft:"auto"}}>
      <button ref={btnRef} onClick={()=>setOpen(o=>!o)}
        style={{width:30,height:30,borderRadius:"50%",background:open?C.vio:`${C.vio}22`,border:`1.5px solid ${C.vio}55`,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s",flexShrink:0}}>
        👋
      </button>
      {open && (
        <div onClick={()=>setOpen(false)} style={{position:"fixed",top:pos.top,right:pos.right,zIndex:400,cursor:"pointer",animation:"fadeInDown .25s ease",maxWidth:250}}>
          <div style={{position:"absolute",top:-7,right:10,width:0,height:0,borderLeft:"8px solid transparent",borderRight:"8px solid transparent",borderBottom:`8px solid ${C.vio}`}} />
          <div style={{background:C.vio,color:"#fff",borderRadius:14,padding:"14px 16px",boxShadow:"0 8px 28px rgba(0,0,0,.25)"}}>
            <div style={{fontSize:18,marginBottom:6,textAlign:"center"}}>📆</div>
            <div style={{fontSize:13,fontWeight:800,marginBottom:8,lineHeight:1.3}}>{t.helpGardeTitle}</div>
            <div style={{fontSize:12,opacity:.95,lineHeight:1.6,display:"flex",flexDirection:"column",gap:8}}>
              <div>
                <strong>{t.helpGardeAltTitle}</strong><br/>
                {t.helpGardeAltBody}
              </div>
              <div>
                <strong>{t.helpGardeExclTitle}</strong><br/>
                {t.helpGardeExclBody}
              </div>
              <div>
                <strong>{t.helpGardeCustomTitle}</strong><br/>
                {t.helpGardeCustomBody}
              </div>
            </div>
            <div style={{fontSize:10,opacity:.7,marginTop:10,textAlign:"right"}}>{t.tapToClose}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFO BUBBLE — Accès
// ═══════════════════════════════════════════════════════════════════════════════
function StepAccessInfoButton({C,t}) {
  const tipKey = "duvia_stepaccess_info_seen";
  const [open, setOpen] = useState(() => {
    try { return !window.localStorage.getItem(tipKey); } catch { return true; }
  });
  const btnRef = useRef(null);
  const [pos, setPos] = useState({top:0, right:0});

  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      setPos({ top: r.bottom + 10, right: vw - r.right - 4 });
      try { window.localStorage.setItem(tipKey, "1"); } catch {}
    }
  }, [open]);

  return (
    <div style={{position:"relative",marginLeft:"auto"}}>
      <button ref={btnRef} onClick={()=>setOpen(o=>!o)}
        style={{width:30,height:30,borderRadius:"50%",background:open?C.vio:`${C.vio}22`,border:`1.5px solid ${C.vio}55`,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s",flexShrink:0}}>
        👋
      </button>
      {open && (
        <div onClick={()=>setOpen(false)} style={{position:"fixed",top:pos.top,right:pos.right,zIndex:400,cursor:"pointer",animation:"fadeInDown .25s ease",maxWidth:250}}>
          <div style={{position:"absolute",top:-7,right:10,width:0,height:0,borderLeft:"8px solid transparent",borderRight:"8px solid transparent",borderBottom:`8px solid ${C.vio}`}} />
          <div style={{background:C.vio,color:"#fff",borderRadius:14,padding:"14px 16px",boxShadow:"0 8px 28px rgba(0,0,0,.25)"}}>
            <div style={{fontSize:18,marginBottom:6,textAlign:"center"}}>👥</div>
            <div style={{fontSize:13,fontWeight:800,marginBottom:8,lineHeight:1.3}}>{t.helpAccessTitle}</div>
            <div style={{fontSize:12,opacity:.95,lineHeight:1.6,display:"flex",flexDirection:"column",gap:8}}>
              <div>
                <strong>{t.helpAccessLinkTitle}</strong><br/>
                {t.helpAccessLinkBody}
              </div>
              <div>
                <strong>{t.helpAccessObsTitle}</strong><br/>
                {t.helpAccessObsBody}
              </div>
              <div>
                <strong>{t.helpAccessApprovalTitle}</strong><br/>
                {t.helpAccessApprovalBody}
              </div>
            </div>
            <div style={{fontSize:10,opacity:.7,marginTop:10,textAlign:"right"}}>{t.tapToClose}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════════
// ── Modale "Installer l'application" (réutilisable) ─────────────────────────
function BugReportModal({ C, t, open, onClose, getContext }) {
  const [comment, setComment] = useState("");
  const [withShot, setWithShot] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus]   = useState(null); // "ok" | "err" | null
  if (!open) return null;
  const close = () => { if (sending) return; setComment(""); setWithShot(false); setStatus(null); onClose(); };
  const send = async () => {
    if (sending || !comment.trim()) return;
    setSending(true); setStatus(null);
    try {
      await submitBugReport({ comment, withScreenshot: withShot, context: getContext ? getContext() : {} });
      setStatus("ok");
    } catch { setStatus("err"); }
    finally { setSending(false); }
  };
  return (
    <div onClick={close} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:18,maxWidth:420,width:"100%",padding:22,boxShadow:"0 12px 40px rgba(0,0,0,.25)",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{fontSize:16,fontWeight:900,color:C.txt,textAlign:"center",marginBottom:4}}>🐛 {t.bugReportTitle}</div>
        {status==="ok" ? (
          <>
            <div style={{fontSize:38,textAlign:"center",margin:"10px 0"}}>✅</div>
            <div style={{fontSize:13,color:C.mut,textAlign:"center",lineHeight:1.5,marginBottom:16}}>{t.bugReportThanks}</div>
            <button onClick={close} style={{width:"100%",height:44,background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:13}}>{t.doneBtn}</button>
          </>
        ) : (
          <>
            <div style={{fontSize:12.5,color:C.mut,textAlign:"center",lineHeight:1.5,margin:"4px 0 14px"}}>{t.bugReportDesc}</div>
            <textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder={t.bugReportPlaceholder} rows={4} maxLength={4000}
              style={{width:"100%",boxSizing:"border-box",padding:12,borderRadius:12,border:`1.5px solid ${C.bor}`,fontSize:13,fontFamily:"inherit",resize:"vertical",marginBottom:12,background:C.sur,color:C.txt}} />
            <label style={{display:"flex",alignItems:"flex-start",gap:8,cursor:"pointer",marginBottom:6,fontSize:12.5,color:C.txt}}>
              <input type="checkbox" checked={withShot} onChange={e=>setWithShot(e.target.checked)} style={{width:16,height:16,marginTop:2,accentColor:C.vio,cursor:"pointer"}} />
              <span>{t.bugReportScreenshot}</span>
            </label>
            {withShot && <div style={{fontSize:11,color:C.ora,lineHeight:1.4,marginBottom:12}}>⚠️ {t.bugReportScreenshotWarn}</div>}
            {status==="err" && <div style={{fontSize:12,color:C.red,lineHeight:1.4,marginBottom:10}}>{t.bugReportError}</div>}
            <button disabled={sending || !comment.trim()} onClick={send}
              style={{width:"100%",height:46,background:(sending||!comment.trim())?C.bor:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:14,marginBottom:8,cursor:(sending||!comment.trim())?"not-allowed":"pointer"}}>
              {sending ? t.bugReportSending : t.bugReportSend}
            </button>
            <button onClick={close} disabled={sending} style={{width:"100%",height:40,background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13}}>{t.cancel}</button>
          </>
        )}
      </div>
    </div>
  );
}

function InstallAppModal({C,t,onClose}) {
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:16,padding:20,maxWidth:400,width:"100%",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:16,fontWeight:900,color:C.txt}}>{t.installAppTitle}</div>
          <button onClick={onClose} style={{width:30,height:30,background:C.sur,border:`1px solid ${C.bor}`,borderRadius:8,color:C.mut,fontSize:14,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{fontSize:13,color:C.mut,lineHeight:1.5,marginBottom:16}}>{t.installAppDesc}</div>

        <div style={{background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:12,padding:"12px 14px",marginBottom:10}}>
          <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:6,display:"flex",alignItems:"center",gap:6}}>🍏 {t.installAppIosTitle}</div>
          <ol style={{margin:0,paddingLeft:18,fontSize:12,color:C.mut,lineHeight:1.6}}>
            {t.installAppIos.map((step,i)=><li key={i} style={{marginBottom:4}}>{step}</li>)}
          </ol>
        </div>

        <div style={{background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:12,padding:"12px 14px"}}>
          <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:6,display:"flex",alignItems:"center",gap:6}}>🤖 {t.installAppAndroidTitle}</div>
          <ol style={{margin:0,paddingLeft:18,fontSize:12,color:C.mut,lineHeight:1.6}}>
            {t.installAppAndroid.map((step,i)=><li key={i} style={{marginBottom:4}}>{step}</li>)}
          </ol>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // ── Persistent state (survives refresh) ──────────────────────────────────
  const [cfg,setCfg]     = useLocalStorage("duvia_cfg", makeCfg);
  const familySync = useFamilySync(cfg, setCfg);
  const [users,setUsers] = useLocalStorage("duvia_users", DEMO_USERS);

  // 🔧 Migration : l'admin n'est plus un compte local — on retire toute
  // ancienne entrée admin qui aurait pu rester enregistrée sur cet appareil
  // (avec l'ancien mot de passe codé en dur, maintenant invalide de toute façon).
  useEffect(()=>{
    // 🔒 Purge le mot de passe stocké en clair (héritage) : la connexion passe
    // par Supabase Auth — ce champ ne sert à rien et ne doit pas rester sur l'appareil.
    setUsers(u => u.filter(x => x.role !== "admin").map(({password, ...rest}) => rest));
  },[]);

  const [sub,setSub]     = useLocalStorage("duvia_sub", makeSub);
  const { msgs: cloudMsgs, send: _sendCloudMsg, markRead: markCloudMessageRead } = useMessages(familySync.familyId);
  const { localToUid, uidToLocal } = useIdLinks(familySync.familyId);
  const [myUid, setMyUid] = useState(null);
  const [pendingUser,setPendingUser] = useState(null); // parent en attente d'accepter la charte d'engagement
  // 🔧 Traduit les messages du nuage (uuid Supabase) vers le format local
  // (id de connexion de l'appli) pour que toute la logique existante de
  // regroupement par conversation (ck, allConvs…) continue de fonctionner
  // sans y toucher. Le nom de l'expéditeur est gardé tel quel (sender_name,
  // une copie prise au moment de l'envoi) même si ce compte est supprimé
  // plus tard — exactement comme l'ancien système, mais côté serveur.
  const msgs = (cloudMsgs||[]).map(cm => {
    const fromLocal = uidToLocal.get(cm.sender_id) || cm.sender_id;
    const toLocal = (cm.recipient_ids||[]).map(u => uidToLocal.get(u) || u);
    const readByLocal = (cm.read_by||[]).map(u => uidToLocal.get(u) || u);
    return {
      id: cm.id, from: fromLocal, fromName: cm.sender_name || "?",
      to: toLocal, content: cm.content, ts: cm.created_at, readBy: readByLocal,
      hash: hashMsg(fromLocal, toLocal, cm.content, cm.created_at),
    };
  });
  function sendCloudMessage(senderName, recipientLocalIds, content){
    const recipientUids = recipientLocalIds.map(id=>localToUid.get(id)).filter(Boolean);
    if(!myUid || recipientUids.length !== recipientLocalIds.length){
      return Promise.reject(new Error("Un destinataire n'a pas encore synchronisé son compte — demande-lui de se reconnecter une fois, puis réessaie."));
    }
    return _sendCloudMsg(myUid, senderName, recipientUids, content);
  }
  const [activity,setActivity] = useLocalStorage("duvia_activity", {vault:"",contacts:"",expenses:""});
  const [simDate,setSimDate]   = useLocalStorage("duvia_simdate", null); // admin: simulate future date
  const [themeMode,setThemeMode] = useLocalStorage("duvia_theme", "palette"); // "palette"|"clair"|"sombre"
  function cycleTheme(){ setThemeMode(m=>m==="palette"?"clair":m==="clair"?"sombre":"palette"); }
  const dark = themeMode==="sombre";
  const [lang,setLang]   = useLocalStorage("duvia_lang", "fr");
  const [summerActive,setSummerActive] = useLocalStorage("duvia_summer", false);
  const [rgActive,setRgActive]         = useLocalStorage("duvia_rg", false);
  const [wcActive,setWcActive]         = useLocalStorage("duvia_wc", false);
  const [videoActive,setVideoActive]   = useLocalStorage("duvia_video", false);
  const brandActive = themeMode==="palette";

  // ── Session (email stored, user object restored from users list) ──────────
  const [sessionEmail, setSessionEmail] = useLocalStorage("duvia_session", null);
  const [user, setUser] = useState(() => {
    if (!sessionEmail) return null;
    // 🔒 Sécurité appareil partagé : on ne restaure la session de l'app QUE si
    // un jeton Supabase est présent dans sessionStorage (donc même onglet, non
    // fermé). Sur un nouvel onglet/visite, pas de jeton → pas de restauration
    // (évite d'afficher brièvement les données de l'utilisateur précédent).
    try {
      const hasSupaToken =
        Object.keys(window.sessionStorage).some(k => k.startsWith("sb-") && k.includes("auth-token")) ||
        Object.keys(window.localStorage).some(k => k.startsWith("sb-") && k.includes("auth-token"));
      if (!hasSupaToken) return null;
    } catch {}
    // Priorité : liste users persistée en localStorage, fallback DEMO_USERS
    try {
      const raw = window.localStorage.getItem("duvia_users");
      if (raw) {
        const saved = JSON.parse(raw);
        const found = saved.find(u => u.email === sessionEmail);
        if (found) return found;
      }
    } catch {}
    return DEMO_USERS.find(u => u.email === sessionEmail) || null;
  });
  // handleSetUser défini plus bas, après tous les useState

  // ── 🪪 Carte d'identité cloud ───────────────────────────────────────────
  // Relie l'id local de cette personne (ex: 1718000000000) à son uuid
  // Supabase, dès qu'on connaît les deux. Sert à retrouver "qui est qui"
  // quand on migre les messages vers le cloud (table id_links).
  useEffect(() => {
    if (!familySync.familyId || !user?.id) return;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const uid = data?.user?.id;
        if (!uid) return;
        setMyUid(uid);
        await supabase.from("id_links").upsert(
          { family_id: familySync.familyId, local_id: String(user.id), supabase_uid: uid },
          { onConflict: "family_id,local_id" }
        );
      } catch (e) {
        console.error("[Duvia][id_links] échec d'enregistrement de la carte d'identité:", e);
      }
    })();
  }, [familySync.familyId, user?.id]);

  // ── Diagnostic : capture d'erreurs globales + réessai d'un rapport en attente ─
  useEffect(() => {
    initDiagnostics();
    retryPendingReport();
  }, []);

  // ── Vérification Supabase Auth au démarrage ───────────────────────────────
  // Si la session Supabase a expiré ou le compte a été supprimé → déconnexion forcée.
  // (L'admin est maintenant un vrai compte Supabase, plus d'exemption nécessaire.)
  useEffect(() => {
    if (!sessionEmail) return;
    // ⏱️ « Rester connecté » plafonné à 24h : passé l'échéance, déconnexion
    // forcée. Vérif LOCALE (basée sur l'horloge) → s'applique même hors-ligne.
    try {
      const until = parseInt(window.localStorage.getItem("duvia_remember_until") || "0", 10);
      if (window.localStorage.getItem("duvia_remember") === "1" && until && Date.now() > until) {
        ["duvia_remember","duvia_remember_until","duvia_session"].forEach(k => window.localStorage.removeItem(k));
        [window.sessionStorage, window.localStorage].forEach(store => {
          Object.keys(store).filter(k => k.startsWith("sb-")).forEach(k => store.removeItem(k));
        });
        supabase.auth.signOut().catch(()=>{});
        setUser(null);
        setSessionEmail(null);
        return;
      }
    } catch {}
    (async () => {
      try {
        const { data: sessData } = await supabase.auth.getSession();
        if (!sessData?.session) {
          // Session Supabase absente ou expirée → déconnexion forcée
          setUser(null);
          setSessionEmail(null);
        }
      } catch {
        // Pas de réseau → on garde la session locale (mode hors-ligne)
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 🔒 Déconnexion à la sortie de page (sauf « Rester connecté »).
  // Quand l'utilisateur QUITTE/recharge la page sans avoir coché « Rester
  // connecté », on efface les jetons de session → il devra se reconnecter en
  // revenant. Les rechargements INTERNES de l'app (éjection, quitter, nouvelle
  // version…) posent un drapeau via duviaReload() et sont donc épargnés.
  useEffect(() => {
    // Consomme un éventuel drapeau laissé par le rechargement précédent.
    try { window.sessionStorage.removeItem("duvia_internal_reload"); } catch {}
    const onLeave = () => {
      try {
        if (window.localStorage.getItem("duvia_remember") === "1") return; // rester connecté
        if (window.sessionStorage.getItem("duvia_internal_reload") === "1") { // reload interne
          window.sessionStorage.removeItem("duvia_internal_reload"); return;
        }
        // Efface les jetons d'auth (les deux stockages) + la session locale.
        [window.sessionStorage, window.localStorage].forEach(store => {
          Object.keys(store).filter(k => k.startsWith("sb-")).forEach(k => store.removeItem(k));
        });
        window.localStorage.removeItem("duvia_session");
      } catch {}
    };
    window.addEventListener("pagehide", onLeave);
    return () => { window.removeEventListener("pagehide", onLeave); };
  }, []);

  // Consentement RGPD (politique de confidentialité) — accepté une fois par
  // appareil, redemandé si la version change. Lu au démarrage depuis localStorage.
  const [rgpdOk,setRgpdOk] = useState(()=>{
    try { return isRgpdConsentValid(window.localStorage.getItem(RGPD_STORAGE_KEY), RGPD_NOTICE_VERSION); }
    catch { return false; }
  });
  function acceptRgpd(){
    try { window.localStorage.setItem(RGPD_STORAGE_KEY, JSON.stringify(makeRgpdConsentRecord(RGPD_NOTICE_VERSION))); } catch {}
    setRgpdOk(true);
  }
  // Message après éjection (retiré de la famille par le créateur / dissolution).
  const [ejectedNotice,setEjectedNotice] = useState(()=>{ try{return window.localStorage.getItem("duvia_ejected")==="1";}catch{return false;} });
  function dismissEjected(){ try{window.localStorage.removeItem("duvia_ejected");}catch{} setEjectedNotice(false); }
  // Notification au créateur quand un invité quitte/est retiré (temps réel).
  const [inviteLeftNotice,setInviteLeftNotice] = useState(null);
  useEffect(()=>{
    const h = (e)=> setInviteLeftNotice((e && e.detail) || "L'invité");
    window.addEventListener("duvia-invite-left", h);
    return ()=> window.removeEventListener("duvia-invite-left", h);
  },[]);
  const [tab,setTab]   = useState(0);
  const [bell,setBell] = useState(false);
  const [showMenu,setShowMenu] = useState(false);
  const [showBugModal,setShowBugModal] = useState(false);
  const [showInstallModal,setShowInstallModal] = useState(false);
  const [showLicenseModal,setShowLicenseModal] = useState(false);
  const [showPrizesMenu,setShowPrizesMenu] = useState(false);
  const [menuHighlight,setMenuHighlight] = useState(true);
  const [showOnboardingTip,setShowOnboardingTip] = useState(false);
  const [configStep,setConfigStep] = useState(0);
  const [showRefPrompt,setShowRefPrompt] = useState(false);
  const [showResetConfirm,setShowResetConfirm] = useState(false);
  // ✅ showRefPrompt accessible via Context (useApp()) — plus de référence globale window.__
  const [menuTab,setMenuTab] = useState(null);
  const [pendingReimPopup,setPendingReimPopup] = useState(null); // {reim, fromName}
  const [pendingExpPopup,setPendingExpPopup]   = useState(null); // expense pending
  const [expSubmittedPopup,setExpSubmittedPopup] = useState(false); // toast after adding expense
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    const onUpdateReady = () => setUpdateAvailable(true);
    window.addEventListener("duvia-update-ready", onUpdateReady);
    return () => window.removeEventListener("duvia-update-ready", onUpdateReady);
  }, []);
  useEffect(()=>{ if(!expSubmittedPopup) return; const t=setTimeout(()=>setExpSubmittedPopup(false),2500); return ()=>clearTimeout(t); },[expSubmittedPopup]);
  const [confirmDeleteAccount,setConfirmDeleteAccount] = useState(false);
  const [deletingAccount,setDeletingAccount]           = useState(false);
  const [deleteAccountError,setDeleteAccountError]     = useState("");

  // ── Garde le user en mémoire synchronisé avec la liste users persistée ──────
  // (ex: après setUsers suite à un achat, upgrade, parrainage, etc.)
  useEffect(()=>{
    if(!sessionEmail) return;
    const fresh = users.find(u=>u.email===sessionEmail);
    if(fresh && fresh !== user) setUser(fresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[users, sessionEmail]);

  // ── handleSetUser — défini ici pour avoir accès à tous les setters useState ──
  const handleSetUser = useCallback((u) => {
    // 🔒 Compte différent de celui actif dans cet onglet (ou 1re connexion) →
    // on ne fait JAMAIS confiance au cfg/family_id déjà en mémoire/localStorage,
    // peu importe le chemin pris (inscription, connexion classique, invitation).
    // On recharge entièrement la page pour repartir d'une résolution fraîche
    // côté serveur, pour CE compte précis.
    if (u && u.email && u.email !== sessionEmail) {
      try {
        const rawUsers = window.localStorage.getItem("duvia_users");
        const list = rawUsers ? JSON.parse(rawUsers) : [];
        if (!list.some(u2 => u2.email === u.email)) list.push(u);
        window.localStorage.setItem("duvia_users", JSON.stringify(list));
        window.localStorage.setItem("duvia_session", JSON.stringify(u.email));
        window.localStorage.removeItem("duvia_family_id");
        window.localStorage.removeItem("duvia_cfg");
      } catch {}
      duviaReload();
      return;
    }
    setUser(u);
    setSessionEmail(u ? u.email : null);

    // Première connexion parent → afficher la bulle d'onboarding
    if (u && u.role === "parent") {
      const seenKey = `duvia_onboarding_${u.id}`;
      try {
        if (!window.localStorage.getItem(seenKey)) {
          setShowOnboardingTip(true);
          window.localStorage.setItem(seenKey, "1");
        }
      } catch {}
    }
    // Déconnexion → retour au thème par défaut
    if (!u) {
      setSummerActive(false);
      setRgActive(false);
      setWcActive(false);
      setVideoActive(false);
      setThemeMode("palette");
      setShowPrizesMenu(false);
      // 🔧 Repartir de zéro pour le prochain compte qui se connecte sur cet
      // appareil — sans ça, ses données se mélangeraient avec celles du
      // compte précédent (cfg/family_id restaient en mémoire/localStorage).
      try {
        window.localStorage.removeItem("duvia_family_id");
        window.localStorage.removeItem("duvia_cfg");
      } catch {}
      setUser(null);
      // 🔒 Indispensable : sans ça, la session Supabase du compte précédent
      // reste active et le rechargement la reprend telle quelle.
      supabase.auth.signOut().catch(()=>{}).finally(()=>{ duviaReload(); });
      return;
    }
  }, [sessionEmail, setSessionEmail, setShowOnboardingTip, setSummerActive, setRgActive, setWcActive, setVideoActive, setThemeMode, setShowPrizesMenu]); // ✅ tous les setters existent à ce stade

  // ── Sync automatique des infos du parent connecté → cfg.parents ──────────
  // Découplé de handleSetUser : doit aussi s'exécuter après un rechargement
  // de page (nouveau compte / nouvelle famille créée), une fois que la
  // famille a fini de charger.
  useEffect(() => {
    if (!user || user.role !== "parent" || typeof user.parentIdx !== "number") return;
    if (!familySync.familyId) return;
    setCfg(c => {
      const parents = [...(c.parents || [])];
      const idx      = user.parentIdx;
      const existing = parents[idx] || {};
      // 🔒 Ne JAMAIS écraser le créneau d'un AUTRE parent : si ce créneau a déjà
      // un email différent du mien, mon parentIdx est périmé (cas multi-familles)
      // → on ne touche à rien (évite de corrompre la fiche de l'autre parent).
      if (existing.email && user.email && existing.email.toLowerCase() !== user.email.toLowerCase()) return c;
      if (existing.name && existing.email === user.email) return c; // déjà à jour
      parents[idx] = {
        ...existing,
        id:        existing.id || user.id,
        name:      existing.name || user.name || "",
        email:     user.email || existing.email || "",
        gender:    existing.gender || user.gender || "M",
        phone:     existing.phone || user.phone || "",
        color:     existing.color || PCOLS[idx % PCOLS.length],
        birthDay:  existing.birthDay || "",
        birthMonth:existing.birthMonth || "",
        inviteStatus: undefined,
      };
      return { ...c, parents };
    });
  }, [user, familySync.familyId]);

  // 🔧 Auto-correction du parentIdx : en multi-familles, le parentIdx stocké
  // peut être périmé (ex. créatrice ailleurs → parentIdx 0, mais invitée ici →
  // créneau 1). On déduit le VRAI créneau (celui dont l'email correspond au
  // mien) et on corrige, sinon l'app croit que la carte de l'autre parent est
  // la mienne (champs éditables, bouton « Quitter » au mauvais endroit).
  useEffect(() => {
    if (!user || user.role !== "parent" || !familySync.familyId) return;
    const parents = cfg.parents || [];
    if (!parents.length || !user.email) return;
    const mail = user.email.toLowerCase();
    const realIdx = parents.findIndex(p => p && p.email && p.email.toLowerCase() === mail);
    if (realIdx >= 0 && realIdx !== user.parentIdx) {
      try {
        const list = JSON.parse(window.localStorage.getItem("duvia_users") || "[]");
        window.localStorage.setItem("duvia_users", JSON.stringify(
          list.map(u2 => u2.email === user.email ? { ...u2, parentIdx: realIdx } : u2)
        ));
      } catch {}
      setUser(u => (u ? { ...u, parentIdx: realIdx } : u));
    }
  }, [user, cfg.parents, familySync.familyId]);

  // ── Referral tracking — scope filleul (pour le user courant) ─────────────
  const refActionsKey = `duvia_ref_actions_${user?.id||"default"}`;
  const [refActions, setRefActions] = useLocalStorage(refActionsKey, []);
  const [showReferreePopup, setShowReferreePopup] = useState(false);
  const [showReferrerPopup, setShowReferrerPopup] = useState(false);

  // Parrain : afficher popup si bonus en attente (après login)
  useEffect(()=>{
    if(!user?.refCode) return;
    const bonusKey = `duvia_ref_bonus_pending_family_${user.refCode}`;
    const pending = localStorage.getItem(bonusKey);
    if(pending){ setShowReferrerPopup(true); localStorage.removeItem(bonusKey); }
  },[user?.id]);

  // Popup remboursement en attente à la connexion
  useEffect(()=>{
    if(!user || user.role!=="parent") return;
    const idx = user.parentIdx;
    if(idx===undefined||idx===null) return;
    const pending=(cfg.reimbursements||[]).filter(r=>r.to===idx && r.status==="pending");
    if(pending.length>0) setPendingReimPopup(pending[0]);
  },[user?.id]);

  // Popup dépense en attente à la connexion
  useEffect(()=>{
    if(!user || user.role!=="parent") return;
    const idx = user.parentIdx;
    if(idx===undefined||idx===null) return;
    const pending=(cfg.expenses||[]).filter(e=>e.status==="pending" && e.createdBy!==undefined && e.createdBy!==idx);
    if(pending.length>0) setPendingExpPopup(pending[0]);
  },[user?.id]);

  const addRefAction = useCallback((actionType) => {
    if(!user?.refUsed) return; // seuls les filleuls (qui ont un parrain) trackent leurs actions
    if(!REF_ACTION_WEIGHTS[actionType]) return;
    setRefActions(prev=>{
      if(prev.includes(actionType)) return prev;
      const next=[...prev, actionType];
      if(!refIsUnlocked(prev) && refIsUnlocked(next)){
        setTimeout(()=>_onFilleulValidated(), 0);
      }
      return next;
    });
  }, [user?.refUsed, setRefActions]); // ✅ référence stable

  function _onFilleulValidated(){
    // 1. Filleul → passe en earned_premium + notification
    setShowReferreePopup(true);
    setSub(s=>({...s, plan:"earned_premium"}));
    setUsers(us=>us.map(u=>u.id===user?.id?{...u,plan:"earned_premium"}:u));
    // 2. Parrain → bonus selon statut
    const parrain = users.find(u=>u.refCode===user?.refUsed);
    if(!parrain) return;
    const parrainIsPrem = isPremFull(parrain.sub||{}) || parrain._admin;
    const newValidatedCount = (parrain.validatedRefCount||0)+1;
    // Vérifier si le parrain est encore dans sa fenêtre trial (pas freemium)
    const parrainCreated = parrain.accountCreatedAt || parrain.trialStart;
    const parrainDaysElapsed = parrainCreated ? (Date.now()-new Date(parrainCreated).getTime())/86400000 : 999;
    const parrainExt = parrain.trialExtension||0;
    const parrainMaxDays = Math.min(TRIAL_BASE_DAYS+parrainExt, TRIAL_MAX_DAYS);
    const parrainIsFreemium = !parrainIsPrem && parrainDaysElapsed > parrainMaxDays;
    let bonusDays = 0;
    let newMonthlyRefMonth = parrain.monthlyRefMonth||null;
    let newMonthlyRefCount = parrain.monthlyRefCount||0;
    if(parrainIsFreemium){
      // Freemium : plus de jours d'extension — seulement un tour de roue
      bonusDays = 0;
    } else if(!parrainIsPrem){
      // Trial / earned_premium : paliers dégressifs
      bonusDays = refBonusDaysTrial(newValidatedCount, parrainExt);
    } else {
      // Premium abonné : plafond mensuel
      const now = new Date();
      const thisMonth = `${now.getFullYear()}-${now.getMonth()}`;
      const mCount = (parrain.monthlyRefMonth===thisMonth ? parrain.monthlyRefCount||0 : 0)+1;
      bonusDays = refBonusDaysPremium(mCount);
      newMonthlyRefMonth = thisMonth;
      newMonthlyRefCount = mCount;
    }
    const shouldUpgrade = !parrainIsPrem && !parrainIsFreemium && newValidatedCount>=1;
    setUsers(us=>us.map(u=>u.id===parrain.id?{
      ...u,
      validatedRefCount: newValidatedCount,
      trialExtension: (u.trialExtension||0)+bonusDays,
      pendingSpins: (u.pendingSpins||0)+SPIN_PER_REF,
      plan: shouldUpgrade ? "earned_premium" : u.plan,
      monthlyRefMonth: newMonthlyRefMonth,
      monthlyRefCount: newMonthlyRefCount,
    }:u));
    // Signal au parrain (cross-session via localStorage)
    try{ localStorage.setItem(`duvia_ref_bonus_pending_family_${parrain.refCode}`, "true"); }catch{}
  }
  // Auto-disable RG / WC theme outside their period — SAUF si le thème a été acheté (cadeau permanent)
  useEffect(()=>{
    const uid = String(user?.id||"");
    const gifted = sub.giftedPrizes?.[uid] || {};
    if(!isRGPeriod() && rgActive && !gifted.rg && !sub.earnedRG) setRgActive(false);
  },[rgActive, user?.id]);
  useEffect(()=>{
    const uid = String(user?.id||"");
    const gifted = sub.giftedPrizes?.[uid] || {};
    if(!isWCPeriod() && wcActive && !gifted.wc && !sub.earnedWC) setWcActive(false);
  },[wcActive, user?.id]);
  // ─── OpenHolidays API data ────────────────────────────────────────────────
  const [apiData, setApiData] = useState(null);
  const [apiLoading, setApiLoading] = useState(false);
  useEffect(() => {
    if (!cfg.country) return;
    const country = cfg.country;
    const zone = cfg.subdivisionCode || cfg.zone || "";
    const year = new Date().getFullYear();
    setApiLoading(true);
    Promise.all([
      fetchOHData(country, zone, year),
      fetchOHData(country, zone, year + 1),
    ]).then(([cur, nxt]) => {
      // Merge school hols deduplicated
      const schoolHols = [...(cur.schoolHols||[])];
      if (nxt.schoolHols) {
        const seen = new Set(schoolHols.map(h=>h.n));
        nxt.schoolHols.forEach(h=>{ if(!seen.has(h.n)) schoolHols.push(h); });
      }
      // Merge public hols
      const publicHols = [...(cur.publicHols||[]), ...(nxt.publicHols||[])];
      setApiData({ schoolHols: schoolHols.length ? schoolHols : null, publicHols: publicHols.length ? publicHols : null });
      setApiLoading(false);
    }).catch(() => setApiLoading(false));
  }, [cfg.country, cfg.subdivisionCode, cfg.zone]);
  // ─────────────────────────────────────────────────────────────────────────

  const C = useMemo(() =>
    videoActive ? VIDEO : wcActive ? WC : rgActive ? RG :
    summerActive ? SUMMER : themeMode==="sombre" ? DARK :
    themeMode==="clair" ? LIGHT : BRAND,
  [videoActive, wcActive, rgActive, summerActive, themeMode]); // ✅ recalculé uniquement si le thème change
  const cssString = useMemo(() => css(C), [C]); // ✅ ~300 lignes CSS générées une seule fois par thème
  const headerBG = C._brand ? `linear-gradient(rgba(255,255,255,.5),rgba(255,255,255,.5)),linear-gradient(145deg,#7BA8F5 0%,#9D8FF0 26%,#F8F2FF 52%,#FF9FD2 76%,#FF6BB5 100%)` : C.card;
  const t     = useMemo(() => TR[lang], [lang]);
  const st    = useMemo(() => subStatus(sub), [sub]);
  const prem  = useMemo(() => isPrem(sub), [sub]);
  const perms = useMemo(() => getPerms(sub), [sub]);
  const days  = useMemo(() => trialLeft(sub), [sub]);
  const isAdm = user?.role==="admin";
  const isObs = user?.role==="observer";
  const isChild = user?.role==="child";
  const _myId = String(user?.id||"");
  const unreadMsgs = useMemo(() =>
    msgs.filter(m =>
      (m.to||[]).map(String).includes(_myId) &&
      !(m.readBy||[]).map(String).includes(_myId)
    ).length,
  [msgs, _myId]); // ✅ recalculé uniquement si msgs ou user change
  // seen: clé fixe, objet {[userId]: {vault,contacts,expenses}}
  const [allSeen,setAllSeen] = useLocalStorage("duvia_seen_all", {});
  const _seen = allSeen[_myId] || {vault:"",contacts:"",expenses:""};
  function _setSeen(updater){
    setAllSeen(prev=>{
      const cur=prev[_myId]||{vault:"",contacts:"",expenses:""};
      return {...prev,[_myId]:typeof updater==="function"?updater(cur):updater};
    });
  }
  // Sync activity depuis localStorage quand un autre user écrit (cross-session)
  const [activityTick,setActivityTick] = useState(0);
  useEffect(()=>{
    function onStorage(e){if(e.key==="duvia_activity")setActivityTick(t=>t+1);}
    window.addEventListener("storage",onStorage);
    return()=>window.removeEventListener("storage",onStorage);
  },[]);
  // Relire activity depuis localStorage si tick change — memoïsé
  const liveActivity = useMemo(() => {
    try{ const raw=window.localStorage.getItem("duvia_activity"); if(raw)return JSON.parse(raw); }catch{}
    return activity;
  }, [activity, activityTick]); // ✅ recalculé uniquement si activity ou tick change
  const vaultDot   = liveActivity.vault?.by   && liveActivity.vault.by!==_myId   && liveActivity.vault.ts   >(_seen.vault  ||"");
  const contactsDot= liveActivity.contacts?.by && liveActivity.contacts.by!==_myId && liveActivity.contacts.ts>(_seen.contacts||"");
  const expDot     = liveActivity.expenses?.by  && liveActivity.expenses.by!==_myId  && liveActivity.expenses.ts >(_seen.expenses||"");
  // Sync current user's sub into the users list (so admin can see all subscribers)
  useEffect(()=>{
    if(!user || user.role==="admin") return;
    setUsers(us => us.map(u => u.id===user.id ? {...u, sub: sub} : u));
  },[sub?.plan, sub?.premiumSince, sub?.cycle, user?.id]);
  // Auto-set admin subscription on login
  useEffect(()=>{
    if(user?.role==="admin"){ setSub(makeAdminSub()); return; }
    if(!user) return;
    // 🔧 Fix : on repart TOUJOURS de l'abonnement propre à CE compte (sa
    // dernière sauvegarde dans user.sub), ou d'un essai neuf si c'est la
    // 1ère connexion — jamais de ce qu'avait laissé la session précédente
    // (ex: Premium simulé en admin) sur cet appareil.
    const ownBase = user.sub || makeSub();
    if(!user.refCode){ setSub(ownBase); return; }
    const base = {
      ...ownBase,
      refCode: ownBase.refCode||user.refCode,
      refCount: Math.max(ownBase.refCount||0, user.refCount||0),
      validatedRefCount: Math.max(ownBase.validatedRefCount||0, user.validatedRefCount||0),
      refMonths: Math.max(ownBase.refMonths||0, user.refMonths||0),
      trialExtension: Math.max(ownBase.trialExtension||0, user.trialExtension||0),
      pendingSpins: Math.max(ownBase.pendingSpins||0, user.pendingSpins||0),
      accountCreatedAt: ownBase.accountCreatedAt||user.accountCreatedAt||ownBase.trialStart,
      monthlyRefMonth: user.monthlyRefMonth||ownBase.monthlyRefMonth,
      monthlyRefCount: Math.max(ownBase.monthlyRefCount||0, user.monthlyRefCount||0),
    };
    const upgradePlan = user.plan==="earned_premium" ? "earned_premium" : "trial_premium";
    if((user.plan==="earned_premium"||user.startsAsPremiumTrial) && base.plan!=="premium" && base.plan!=="earned_premium"){
      setSub({...base, plan: upgradePlan, trialStart:base.trialStart||new Date().toISOString()});
    } else {
      setSub(base);
    }
  },[user?.id]);
  // Trial end warning — handled by header bubble
  useEffect(()=>{
    if(tab===2) _setSeen(s=>({...s,expenses:new Date().toISOString()}));
    if(tab===3) _setSeen(s=>({...s,contacts:new Date().toISOString()}));
    if(tab===4) _setSeen(s=>({...s,vault:new Date().toISOString()}));
  },[tab]);
  const unread = (cfg.notifs||[]).filter(n=>!n.read).length;
  const pendingObsCount = (cfg.observers||[]).filter(o=>o.status==="pending").length;

  useEffect(()=>{ if(window.Notification&&Notification.permission==="default") Notification.requestPermission(); },[]);

  const pushNotif = useCallback((msg,type="info") => {
    const n={id:Date.now(),msg,type,read:false,date:new Date().toISOString()};
    setCfg(c=>({...c,notifs:[n,...(c.notifs||[])]}));
    if(window.Notification&&Notification.permission==="granted") new Notification(t.appName,{body:msg});
  }, [setCfg, t]); // ✅ référence stable

  // Called when an observer registers via invite link — adds them as pending + notifies parents
  function handleObsJoin(obsData){
    if(obsData.role === "child"){
      // Enfant invité — active directement, notification aux parents
      setCfg(c=>({
        ...c,
        pendingChildInvites:(c.pendingChildInvites||[]).map(inv=>
          inv.code===obsData.inviteCode ? {...inv, used:true} : inv
        ),
      }));
      pushNotif(`🧒 ${obsData.name} (${obsData.childAge} ans) a rejoint la famille — messagerie activée`, "info");
      return;
    }
    // Observateur standard
    setCfg(c=>{
      const invite=(c.pendingInvites||[]).find(inv=>inv.code===obsData.inviteCode);
      return {...c,
        observers:[...(c.observers||[]),{id:obsData.id,name:obsData.name,email:obsData.email,role:obsData.role||"grandparent",status:"pending",inviteCode:obsData.inviteCode,canGuard:invite?.canGuard||false}],
        pendingInvites:(c.pendingInvites||[]).map(inv=>inv.code===obsData.inviteCode?{...inv,used:true}:inv),
      };
    });
    pushNotif(`👥 ${obsData.name} — ${t.obsPendingInfo||"demande à rejoindre la famille"}`, "info");
  }
  function addHist(action,detail,type="") {
    setCfg(c=>({...c,history:[{id:Date.now(),date:new Date().toISOString(),who:user?.name||"Système",action,detail,type},...(c.history||[])]}));
  }
  function updateCal(ds,data) {
    setCfg(c=>({...c,overrides:{...c.overrides,[ds]:{...(c.overrides[ds]||{}),...data}}}));
    addHist(t.tabCal,ds,"cal");
    pushNotif(`📅 ${ds}`,"cal");
  }

  // ── Suppression de mon propre compte ───────────────────────────────────────
  async function deleteMyAccount(){
    if(!user || deletingAccount) return;
    const myEmail  = user.email;
    const myId     = user.id;
    const myName   = user.name;
    const familyId = cfg?.familyId || null;

    setDeletingAccount(true);
    setDeleteAccountError("");

    // ── 1. Suppression réelle en base via Edge Function Supabase ──────────────
    if(_supaReady){
      try {
        await _supaFunction("delete-account", {
          userId:   String(myId),
          email:    myEmail,
          familyId: familyId,
        });
      } catch(err) {
        setDeleteAccountError(`Erreur serveur : ${err.message}. Réessaie ou contacte le support.`);
        setDeletingAccount(false);
        return;
      }
    }
    // Supabase non configuré → suppression locale uniquement (mode dev/demo)

    // ── 2. Nettoyage local ────────────────────────────────────────────────────
    // 🔧 Plus besoin de marquer les messages ici : le nom de l'expéditeur
    // (sender_name) est déjà enregistré sur chaque message au moment de
    // l'envoi, côté serveur — il reste affiché tel quel même après la
    // suppression du compte, sans action supplémentaire à faire.

    if(user.role === "parent" && typeof user.parentIdx === "number"){
      setCfg(c => {
        const i = user.parentIdx;
        const parent = c.parents[i];
        if(!parent) return c;
        const impacted = (c.custody?.pattern||[]).some(d => d.parentIdx === i);
        return {
          ...c,
          parents: c.parents.filter((_,j) => j !== i),
          expenses: [],
          custody: impacted ? { ...c.custody, pattern: [], confirmed: false } : c.custody,
          deletedParents: [...(c.deletedParents||[]), {
            id: parent.id, name: parent.name || myName, email: myEmail,
            deletedAt: new Date().toISOString(),
          }],
        };
      });
    }

    setUsers(us => (us||[]).filter(u => u.email !== myEmail));

    try {
      [`duvia_ref_actions_${myId}`, `duvia_onboarding_${myId}`].forEach(k => {
        try { window.localStorage.removeItem(k); } catch {}
      });
    } catch {}

    // ── 3. Déconnexion ────────────────────────────────────────────────────────
    setDeletingAccount(false);
    setConfirmDeleteAccount(false);
    setShowMenu(false);
    setTab(0);
    handleSetUser(null);
  }

  // Called by LoginScreen — intercept parent role for consent
  function handleLogin(u) {
    if(u.role==="parent") { setPendingUser(u); }
    else { handleSetUser(u); }
  }

  if(!user) return (
    <div>
      <style>{cssString}</style>
      {updateAvailable && (
        <div style={{position:"fixed",top:14,left:"50%",transform:"translateX(-50%)",zIndex:9999,
          background:C.card,border:`1.5px solid ${C.vio}`,borderRadius:14,padding:"10px 14px",
          display:"flex",alignItems:"center",gap:10,boxShadow:"0 8px 30px rgba(0,0,0,.22)",maxWidth:"90vw"}}>
          <span style={{fontSize:18}}>🔄</span>
          <span style={{fontSize:12,fontWeight:700,color:C.txt}}>Nouvelle version disponible</span>
          <button onClick={()=>duviaReload()} style={{padding:"6px 12px",background:C.vio,color:"#fff",fontSize:11,fontWeight:800,borderRadius:8}}>Rafraîchir</button>
        </div>
      )}
      {!rgpdOk ? (
        <RgpdConsentScreen C={C} t={t} lang={lang} setLang={setLang} onAccept={acceptRgpd} />
      ) : pendingUser ? (
        <ConsentScreen C={C} t={t} user={pendingUser}
          onAccept={()=>{ handleSetUser(pendingUser); setPendingUser(null); }}
          onDecline={()=>setPendingUser(null)} />
      ) : (
        <LoginScreen C={C} t={t} lang={lang} setLang={setLang} themeMode={themeMode} cycleTheme={cycleTheme} users={users} setUsers={setUsers} onLogin={handleLogin} onObsJoin={handleObsJoin} familySync={familySync} cfg={cfg} setCfg={setCfg} />
      )}
    </div>
  );

  if(familySync.pendingApproval) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C.bg}}>
      <div style={{textAlign:"center",maxWidth:320}}>
        <div style={{fontSize:40,marginBottom:10}}>⏳</div>
        <div style={{fontWeight:900,fontSize:17,marginBottom:8,color:C.txt}}>En attente d'approbation</div>
        <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:20}}>Ta demande pour rejoindre cette famille a été envoyée. L'autre parent doit la valider avant que tu puisses accéder à l'application.</div>
        <button onClick={()=>handleSetUser(null)} style={{height:40,padding:"0 20px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13,borderRadius:10}}>Se déconnecter</button>
      </div>
    </div>
  );

  if(familySync.syncStatus==="error" && !familySync.familyId) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C.bg}}>
      <div style={{textAlign:"center",maxWidth:320}}>
        <div style={{fontSize:40,marginBottom:10}}>⚠️</div>
        <div style={{fontWeight:900,fontSize:17,marginBottom:8,color:C.txt}}>Problème de connexion</div>
        <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:20}}>Impossible de vérifier ta famille pour le moment. Vérifie ta connexion internet et réessaie.</div>
        <button onClick={()=>duviaReload()} style={{height:40,padding:"0 20px",background:C.vio,color:"#fff",border:"none",fontSize:13,fontWeight:700,borderRadius:10,marginRight:10}}>Réessayer</button>
        <button onClick={()=>handleSetUser(null)} style={{height:40,padding:"0 20px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13,borderRadius:10}}>Se déconnecter</button>
      </div>
    </div>
  );

  const TABS = (isObs && !isAdm)
    ? [{icon:"📅",label:t.tabCal},{icon:"📞",label:t.tabContacts||"Contacts"},{icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},{icon:"🎡",label:t.tabGame||"Jeu"}]
    : (isChild && !isAdm)
    ? [
        {icon:"📅",label:t.tabCal},
        {icon:"🎒",label:t.tabSchedule||"EDT"},
        {icon:"📞",label:t.tabContacts||"Contacts"},
        {icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},
      ]
    : [{icon:"📅",label:t.tabCal},{icon:"🎒",label:t.tabSchedule||"EDT"},{icon:"💰",label:t.tabExp,badge:expDot?1:0},{icon:"📞",label:t.tabContacts||"Contacts",badge:contactsDot?1:0},{icon:"🗄️",label:t.tabVault||"Coffre",badge:vaultDot?1:0},{icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},{icon:"🎡",label:t.tabGame||"Jeu"}];

  // ── Context value ─────────────────────────────────────────────────────────
  const onUpgrade = () => { setMenuTab("premium"); setShowMenu(false); };
  const ctxValue = {
    C, t, lang, setLang, dark, themeMode, cycleTheme,
    cfg, setCfg, sub, setSub, user, users, setUsers,
    prem, perms, st, days, isAdm, isObs, isChild, unread,
    addHist, pushNotif, updateCal, onUpgrade, handleObsJoin,
    apiData, apiLoading,
    setMenuTab, setShowMenu,
    msgs, sendCloudMessage, markCloudMessageRead, myUid,
    activity, setActivity, allSeen, setAllSeen, _setSeen,
    summerActive, setSummerActive, rgActive, setRgActive, wcActive, setWcActive, videoActive, setVideoActive,
    brandActive,
    handleSetUser,
    configStep, setConfigStep,
    tab, setTab,
    addRefAction, refActions, showReferreePopup, setShowReferreePopup, showReferrerPopup, setShowReferrerPopup,
    setShowResetConfirm,
    simDate, setSimDate,
    pendingReimPopup, setPendingReimPopup,
    pendingExpPopup, setPendingExpPopup,
    expSubmittedPopup, setExpSubmittedPopup,
    setConfirmDeleteAccount,
    familySync,
  };

  return (
    <AppContext.Provider value={ctxValue}>
    <div style={{display:"flex",flexDirection:"column",height:"100vh",maxWidth:940,margin:"0 auto",overflow:"hidden",width:"100%"}}>
      <style>{cssString}</style>

      {inviteLeftNotice && (
        <div style={{position:"fixed",top:14,left:"50%",transform:"translateX(-50%)",zIndex:10000,background:C.card,border:`1.5px solid ${C.vio}`,borderRadius:14,padding:"12px 16px",maxWidth:420,width:"90%",boxShadow:"0 8px 30px rgba(0,0,0,.18)",display:"flex",alignItems:"center",gap:12}}>
          <div style={{fontSize:13.5,color:C.txt,fontWeight:600,lineHeight:1.5,flex:1}}>👋 <b>{inviteLeftNotice}</b> s'est retiré(e) de la famille.</div>
          <button onClick={()=>setInviteLeftNotice(null)} style={{padding:"6px 12px",background:C.vio,color:"#fff",fontSize:12,fontWeight:800,borderRadius:8,flexShrink:0}}>OK</button>
        </div>
      )}

      {ejectedNotice && (
        <div style={{position:"fixed",inset:0,zIndex:10000,background:"rgba(0,0,0,.55)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:18,padding:"24px 22px",maxWidth:420,width:"100%",boxShadow:"0 10px 40px rgba(0,0,0,.3)"}}>
            <div style={{fontSize:20,fontWeight:900,color:C.txt,marginBottom:10}}>👋 Vous avez quitté cette famille</div>
            <div style={{fontSize:13.5,color:C.mut,lineHeight:1.6,marginBottom:18}}>
              Vous avez été retiré(e) de la famille par le créateur. Vous repartez sur une famille personnelle vierge. Une synthèse de vos anciennes données (planning, comptes, messages) a été conservée sur cet appareil — l'export PDF sera bientôt disponible.
            </div>
            <button onClick={dismissEjected} style={{width:"100%",padding:"13px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:15,fontWeight:800,borderRadius:12}}>J'ai compris</button>
          </div>
        </div>
      )}

      {updateAvailable && (
        <div style={{position:"fixed",top:14,left:"50%",transform:"translateX(-50%)",zIndex:9999,
          background:C.card,border:`1.5px solid ${C.vio}`,borderRadius:14,padding:"10px 14px",
          display:"flex",alignItems:"center",gap:10,boxShadow:"0 8px 30px rgba(0,0,0,.22)",maxWidth:"90vw"}}>
          <span style={{fontSize:18}}>🔄</span>
          <span style={{fontSize:12,fontWeight:700,color:C.txt}}>Nouvelle version disponible</span>
          <button onClick={()=>duviaReload()} style={{padding:"6px 12px",background:C.vio,color:"#fff",fontSize:11,fontWeight:800,borderRadius:8}}>Rafraîchir</button>
        </div>
      )}

      {/* ── Toast dépense soumise (global) ── */}
      {expSubmittedPopup && (
        <div style={{position:"fixed",top:14,left:"50%",transform:"translateX(-50%)",zIndex:9999,
          background:C.card,border:`1.5px solid ${C.grn}`,borderRadius:14,padding:"12px 18px",
          display:"flex",alignItems:"center",gap:10,boxShadow:"0 8px 30px rgba(0,0,0,.22)",
          maxWidth:"90vw",animation:"fadeInDown .25s ease",pointerEvents:"none"}}>
          <span style={{fontSize:20}}>✅</span>
          <div>
            <div style={{fontSize:13,fontWeight:800,color:C.txt}}>{t.expSubmittedTitle||"Dépense soumise"}</div>
            <div style={{fontSize:11,color:C.mut}}>{t.expSubmittedBody||"Elle sera visible par l'autre parent pour validation."}</div>
          </div>
        </div>
      )}

      {/* ── Popup remboursement en attente ── */}
      {pendingReimPopup && (()=>{
        const r=pendingReimPopup;
        const fromP=cfg.parents[r.from];
        const dateStr=(r.date||"").split("-").reverse().join("/");
        const doConfirm=()=>{ setCfg(c=>({...c,reimbursements:(c.reimbursements||[]).map(x=>x.id===r.id?{...x,status:"confirmed"}:x)})); setPendingReimPopup(null); };
        const doReject=()=>{ setCfg(c=>({...c,reimbursements:(c.reimbursements||[]).map(x=>x.id===r.id?{...x,status:"rejected"}:x)})); setPendingReimPopup(null); };
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <div style={{background:C.card,borderRadius:22,padding:"28px 24px",maxWidth:340,width:"100%",border:`1.5px solid ${C.yel}`,boxShadow:"0 16px 48px rgba(0,0,0,.28)",animation:"popIn .35s cubic-bezier(.34,1.56,.64,1)"}}>
              <div style={{fontSize:40,textAlign:"center",marginBottom:10}}>💸</div>
              <div style={{fontSize:16,fontWeight:800,marginBottom:6,textAlign:"center",color:C.txt}}>Remboursement reçu</div>
              <div style={{fontSize:13,color:C.mut,marginBottom:20,textAlign:"center",lineHeight:1.6}}>
                <strong style={{color:fromP?.color||C.grn}}>{fromP?.name||`Parent ${r.from+1}`}</strong> vous a envoyé un remboursement de{" "}
                <strong style={{color:C.txt}}>{r.amount.toFixed(2)} €</strong>{" "}le {dateStr}.
                {r.note && <><br/><em>"{r.note}"</em></>}<br/><br/>
                Pouvez-vous confirmer la réception ?
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <button onClick={doConfirm} style={{width:"100%",padding:"13px",background:C.grn,color:"#fff",borderRadius:12,fontWeight:800,fontSize:14}}>✅ Valider le remboursement</button>
                <button onClick={doReject} style={{width:"100%",padding:"13px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:12,fontWeight:700,fontSize:14}}>❌ Refuser</button>
                <button onClick={()=>setPendingReimPopup(null)} style={{width:"100%",padding:"10px",background:"transparent",color:C.mut,fontSize:12}}>Plus tard</button>
              </div>
            </div>
            <style>{`@keyframes popIn{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}`}</style>
          </div>
        );
      })()}

      {/* ── Popup dépense en attente ── */}
      {pendingExpPopup && (()=>{
        const e=pendingExpPopup;
        const creatorP=cfg.parents[e.createdBy];
        const dateStr=(e.date||"").split("-").reverse().join("/");
        const doConfirmE=()=>{ setCfg(c=>({...c,expenses:(c.expenses||[]).map(x=>x.id===e.id?{...x,status:"confirmed"}:x)})); setPendingExpPopup(null); };
        const doRejectE=()=>{ setCfg(c=>({...c,expenses:(c.expenses||[]).map(x=>x.id===e.id?{...x,status:"rejected"}:x)})); setPendingExpPopup(null); };
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <div style={{background:C.card,borderRadius:22,padding:"28px 24px",maxWidth:340,width:"100%",border:`1.5px solid ${C.yel}`,boxShadow:"0 16px 48px rgba(0,0,0,.28)",animation:"popIn .35s cubic-bezier(.34,1.56,.64,1)"}}>
              <div style={{fontSize:40,textAlign:"center",marginBottom:10}}>💰</div>
              <div style={{fontSize:16,fontWeight:800,marginBottom:6,textAlign:"center",color:C.txt}}>{t.expPendingPopupTitle||"Dépense à confirmer"}</div>
              <div style={{fontSize:13,color:C.mut,marginBottom:20,textAlign:"center",lineHeight:1.6}}>
                <strong style={{color:creatorP?.color||C.blu}}>{creatorP?.name||`Parent ${(e.createdBy||0)+1}`}</strong>{" "}
                {t.expPendingConfirmMsg||"a ajouté une dépense de"}{" "}
                <strong style={{color:C.txt}}>{e.amount.toFixed(2)} €</strong>{" "}—{" "}
                <em>{e.label}</em>{" "}le {dateStr}.
                {e.note && <><br/><em>"{e.note}"</em></>}<br/><br/>
                {t.expPendingConfirmQ||"Pouvez-vous confirmer ?"}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <button onClick={doConfirmE} style={{width:"100%",padding:"13px",background:C.grn,color:"#fff",borderRadius:12,fontWeight:800,fontSize:14}}>{t.expValidateBtn||"✅ Valider la dépense"}</button>
                <button onClick={doRejectE} style={{width:"100%",padding:"13px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:12,fontWeight:700,fontSize:14}}>{t.expRejectBtn||"❌ Refuser"}</button>
                <button onClick={()=>setPendingExpPopup(null)} style={{width:"100%",padding:"10px",background:"transparent",color:C.mut,fontSize:12}}>{t.expPendingLater||"Plus tard"}</button>
              </div>
            </div>
            <style>{`@keyframes popIn{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}`}</style>
          </div>
        );
      })()}

      {/* HEADER */}
      <div style={{flexShrink:0,background:headerBG,borderBottom:`1.5px solid ${C.bor}`,boxShadow:"0 1px 6px rgba(0,0,0,.06)"}}>
      <div style={{padding:"0 14px",display:"flex",alignItems:"center",gap:12,height:58}}>
        <img src="/logo-nav.png" alt="Duvia" style={{width:42,height:42,borderRadius:0,objectFit:"contain",flexShrink:0}} />
        {/* Left block: tagline */}
        <div style={{display:"flex",flexDirection:"column",justifyContent:"center",minWidth:0,flex:1}}>
          <div style={{fontSize:10,color:C.mut,fontStyle:"italic",lineHeight:1.2}}>
            <span>Two homes · One family</span>
            {C._wc && <span style={{fontSize:14,display:"inline-block",animation:"wcBall 3s ease-in-out infinite",transformOrigin:"center",marginLeft:4}}>⚽</span>}
          </div>
        </div>
        {/* Right controls: palette → 🏆 lots → ☰ */}
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <button onClick={()=>{cycleTheme();setSummerActive(false);setRgActive(false);setWcActive(false);setVideoActive(false);}} title={themeMode==="palette"?"→ Clair":themeMode==="clair"?"→ Sombre":"→ Palette"} style={{height:36,padding:"0 14px",background:themeMode==="palette"&&!summerActive&&!rgActive&&!wcActive?`${C.vio}18`:C.card,border:`1.5px solid ${themeMode==="palette"&&!summerActive&&!rgActive&&!wcActive?C.vio:C.bor}`,color:themeMode==="palette"&&!summerActive&&!rgActive&&!wcActive?C.vio:C.txt,fontSize:15,fontWeight:700,flexShrink:0,borderRadius:20,display:"flex",alignItems:"center",cursor:"pointer"}}>
            {themeMode==="sombre"?"🌙":themeMode==="clair"?"☀️":"🎨"}
          </button>
          {/* ── Bouton lots gagnés ──────────────────────────────────────── */}
          {(()=>{
            const myG = sub.giftedPrizes?.[String(user?.id||"")] || {};
            const selfB = {theme:sub.earnedSelf_theme,video:sub.earnedSelf_video,licorne:sub.earnedSelf_licorne,rg:sub.earnedSelf_rg,wc:sub.earnedSelf_wc};
            const hasAny = sub.earnedBadge||sub.earnedTheme||sub.earnedVideo||sub.earnedLicorne||sub.earnedRG||sub.earnedWC
                           ||myG.theme||myG.video||myG.licorne||myG.rg||myG.wc
                           ||selfB.theme||selfB.video||selfB.licorne||selfB.rg||selfB.wc;
            if(!hasAny) return null;
            // Y a-t-il un lot activable mais pas encore actif ?
            const hasActivatable =
              ((sub.earnedTheme||myG.theme||selfB.theme) && !summerActive) ||
              ((sub.earnedVideo||myG.video||selfB.video) && !videoActive) ||
              ((sub.earnedLicorne||myG.licorne||selfB.licorne)) ||
              ((sub.earnedWC||myG.wc||selfB.wc) && (isWCPeriod()||myG.wc||selfB.wc) && !wcActive) ||
              ((sub.earnedRG||myG.rg||selfB.rg) && (isRGPeriod()||myG.rg||selfB.rg) && !rgActive);
            return (
              <div style={{position:"relative",flexShrink:0}}>
                <button onClick={()=>setShowPrizesMenu(v=>!v)}
                  style={{height:36,padding:"0 12px",
                    background:showPrizesMenu?`${C.yel}22`:hasActivatable?`${C.yel}15`:C.card,
                    border:`1.5px solid ${showPrizesMenu||hasActivatable?C.yel:C.bor}`,
                    color:showPrizesMenu||hasActivatable?C.yel:C.mut,
                    fontSize:16,fontWeight:700,borderRadius:20,display:"flex",alignItems:"center",gap:4,cursor:"pointer",transition:"all .2s"}}>
                  🏆
                  {hasActivatable && <span style={{width:7,height:7,borderRadius:"50%",background:C.yel,flexShrink:0}} />}
                </button>
                {showPrizesMenu && (
                  <>
                    <div onClick={()=>setShowPrizesMenu(false)} style={{position:"fixed",inset:0,zIndex:199}} />
                    <div style={{position:"fixed",top:62,right:14,background:C.card,border:`1.5px solid ${C.bor}`,borderRadius:16,minWidth:240,maxWidth:"88vw",zIndex:300,boxShadow:"0 12px 40px rgba(0,0,0,.2)",overflow:"hidden"}}>
                      <div style={{padding:"10px 14px 8px",fontSize:10,fontWeight:800,color:C.mut,letterSpacing:".08em",textTransform:"uppercase",borderBottom:`1px solid ${C.bor}`,background:C.sur}}>
                        🏆 {isChild?t.wheelMyPrizesChild.replace("🏆 ",""):t.wheelMyPrizesAdult.replace("🏆 ","")}
                      </div>
                      {sub.earnedBadge && !isChild && (
                        <div style={{padding:"0 14px",height:40,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,color:"#7c6fcd",background:"#7c6fcd08"}}>
                          <span style={{fontSize:16}}>🏅</span>
                          <span style={{flex:1}}>{t.wheelExclusiveBadge}</span>
                          <span style={{background:"#7c6fcd22",color:"#7c6fcd",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{t.wheelWon.replace(" ✓","")}</span>
                        </div>
                      )}
                      {(sub.earnedTheme||myG.theme||sub.earnedSelf_theme) && (
                        <button onClick={()=>{setSummerActive(s=>!s);setRgActive(false);setWcActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
                          style={{width:"100%",padding:"0 14px",height:40,background:summerActive?"#3ecf8e15":"#3ecf8e08",color:"#3ecf8e",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                          <span style={{fontSize:16}}>🌴</span>
                          <span style={{flex:1}}>{t.shopTheme}{sub.earnedSelf_theme&&!sub.earnedTheme?" 🛒":myG.theme&&!sub.earnedTheme?" 🎁":""}</span>
                          <span style={{background:summerActive?"#3ecf8e33":"#3ecf8e18",color:"#3ecf8e",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{summerActive?t.wheelActiveCheck:t.wheelApply}</span>
                        </button>
                      )}
                      {(sub.earnedVideo||myG.video||sub.earnedSelf_video) && (
                        <button onClick={()=>{setVideoActive(s=>!s);setSummerActive(false);setRgActive(false);setWcActive(false);setShowPrizesMenu(false);}}
                          style={{width:"100%",padding:"0 14px",height:40,background:videoActive?"#8b5cf615":"#8b5cf608",color:"#8b5cf6",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                          <span style={{fontSize:16}}>🎮</span>
                          <span style={{flex:1}}>{t.shopVideo}{sub.earnedSelf_video&&!sub.earnedVideo?" 🛒":myG.video&&!sub.earnedVideo?" 🎁":""}</span>
                          <span style={{background:videoActive?"#8b5cf633":"#8b5cf618",color:"#8b5cf6",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{videoActive?t.wheelActiveCheck:t.wheelApply}</span>
                        </button>
                      )}
                      {(sub.earnedLicorne||myG.licorne||sub.earnedSelf_licorne) && (
                        <div style={{padding:"0 14px",height:40,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,color:"#ec4899",background:"#ec489908"}}>
                          <span style={{fontSize:16}}>🦄</span>
                          <span style={{flex:1}}>{t.shopLicorne}{sub.earnedSelf_licorne&&!sub.earnedLicorne?" 🛒":myG.licorne&&!sub.earnedLicorne?" 🎁":""}</span>
                          <span style={{background:"#ec489922",color:"#ec4899",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{t.wheelSoon}</span>
                        </div>
                      )}
                      {(sub.earnedWC||myG.wc||sub.earnedSelf_wc) && (isWCPeriod()||myG.wc||sub.earnedSelf_wc) && (
                        <button onClick={()=>{setWcActive(s=>!s);setSummerActive(false);setRgActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
                          style={{width:"100%",padding:"0 14px",height:40,background:wcActive?"#2563eb15":"#2563eb08",color:"#2563eb",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                          <span style={{fontSize:16}}>⚽</span>
                          <span style={{flex:1}}>{t.shopWC}{sub.earnedSelf_wc&&!sub.earnedWC?" 🛒":myG.wc&&!sub.earnedWC?" 🎁":""}</span>
                          <span style={{background:wcActive?"#2563eb33":"#2563eb18",color:"#2563eb",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{wcActive?t.wheelActiveCheck:t.wheelApply}</span>
                        </button>
                      )}
                      {(sub.earnedRG||myG.rg||sub.earnedSelf_rg) && (isRGPeriod()||myG.rg||sub.earnedSelf_rg) && (
                        <button onClick={()=>{setRgActive(s=>!s);setSummerActive(false);setWcActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
                          style={{width:"100%",padding:"0 14px",height:40,background:rgActive?"#c2745a15":"#c2745a08",color:"#c2745a",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                          <span style={{fontSize:16}}>🎾</span>
                          <span style={{flex:1}}>{t.shopRG}{sub.earnedSelf_rg&&!sub.earnedRG?" 🛒":myG.rg&&!sub.earnedRG?" 🎁":""}</span>
                          <span style={{background:rgActive?"#c2745a33":"#c2745a18",color:"#c2745a",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{rgActive?t.wheelActiveCheck:t.wheelApply}</span>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
          <div style={{position:"relative",flexShrink:0}}>
          {menuHighlight && (
            <span style={{position:"absolute",inset:-4,borderRadius:10,border:`2.5px solid ${C.vio}`,animation:"menuPulse 1.2s ease-in-out infinite",pointerEvents:"none",zIndex:1}} />
          )}
          <button onClick={()=>{setShowMenu(v=>!v);setShowPrizesMenu(false);if(menuHighlight){setMenuHighlight(false);}if(showOnboardingTip){setShowOnboardingTip(false);}}} style={{height:36,padding:"0 14px",background:menuHighlight?`${C.vio}18`:showMenu?`${C.vio}18`:C.card,border:`1.5px solid ${menuHighlight||showMenu?C.vio:C.bor}`,color:menuHighlight||showMenu?C.vio:C.txt,fontSize:13,fontWeight:700,borderRadius:20,display:"flex",alignItems:"center",gap:6,position:"relative",transition:"all .2s",cursor:"pointer"}}>
            <span>☰</span>
            {!isObs && !isChild && unread>0 && <span style={{position:"absolute",top:-4,right:-4,background:C.red,borderRadius:"50%",width:16,height:16,fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:"#fff",border:`2px solid ${C.card}`}}>{unread}</span>}
          </button>
          {/* ── Bulle d'onboarding première connexion ── */}
          {showOnboardingTip && (
            <div onClick={()=>setShowOnboardingTip(false)} style={{position:"fixed",top:66,right:14,zIndex:400,cursor:"pointer",animation:"fadeInDown .35s ease"}}>
              {/* flèche pointant vers le bouton ☰ */}
              <div style={{position:"absolute",top:-7,right:18,width:0,height:0,borderLeft:"8px solid transparent",borderRight:"8px solid transparent",borderBottom:`8px solid ${C.vio}`}} />
              <div style={{background:C.vio,color:"#fff",borderRadius:14,padding:"12px 16px",maxWidth:230,boxShadow:"0 8px 28px rgba(0,0,0,.22)",position:"relative"}}>
                <div style={{fontSize:18,marginBottom:6,textAlign:"center"}}>👋</div>
                <div style={{fontSize:13,fontWeight:800,marginBottom:4,lineHeight:1.3}}>
                  {lang==="fr" ? "Bienvenue sur Duvia !" : lang==="en" ? "Welcome to Duvia!" : lang==="de" ? "Willkommen bei Duvia!" : lang==="es" ? "¡Bienvenido a Duvia!" : "Bem-vindo ao Duvia!"}
                </div>
                <div style={{fontSize:12,opacity:.92,lineHeight:1.45}}>
                  {lang==="fr" ? <>Commencez par <strong>⚙️ Configuration</strong> pour paramétrer votre famille.</> : lang==="en" ? <>Start with <strong>⚙️ Settings</strong> to set up your family.</> : lang==="de" ? <>Beginne mit <strong>⚙️ Konfiguration</strong>.</> : lang==="es" ? <>Empieza por <strong>⚙️ Configuración</strong>.</> : <>Comece pela <strong>⚙️ Configuração</strong>.</>}
                </div>
                <div style={{fontSize:10,opacity:.7,marginTop:8,textAlign:"right"}}>
                  {lang==="fr"?"Appuyer pour fermer":"Tap to close"}
                </div>
              </div>
            </div>
          )}
          {showMenu && (
            <>
            <div onClick={()=>setShowMenu(false)} style={{position:"fixed",inset:0,zIndex:199}} />
            <div style={{position:"fixed",top:62,right:14,background:C.card,border:`1.5px solid ${C.bor}`,borderRadius:16,minWidth:260,maxWidth:"90vw",zIndex:300,boxShadow:"0 12px 40px rgba(0,0,0,.2)",overflow:"hidden"}}>
              {/* User header */}
              <div style={{padding:"14px 16px",borderBottom:`1px solid ${C.bor}`,display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:36,height:36,borderRadius:10,background:`linear-gradient(135deg,${isAdm?"#FFD700":isObs?C.ora:isChild?C.grn:C.vio},${isAdm?"#ff9f43":C.blu})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>
                  {isAdm ? "👑" : isObs ? "👁️" : isChild ? "🧒" : (user?.avatar || "👤")}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:800}}>{user.name}</div>
                  <div style={{fontSize:11,color:isAdm?"#FFD700":isObs?C.ora:isChild?C.grn:C.mut}}>{isAdm?(t.menuAdmin||"👑 Administrateur"):isObs?t.roleObs:isChild?(t.roleChild||"🧒 Enfant"):t.roleParent}</div>
                </div>
              </div>
              {/* Menu items */}
              {!isObs && !isChild && (
                <>
                  {isAdm && (
                    <button onClick={()=>{setMenuTab("admin");setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:menuTab==="admin"?`${"#FFD700"}18`:"#FFD70010",color:"#cc9900",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:700,borderRadius:0,cursor:"pointer"}}>
                      <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>👑</span><span style={{flex:1,textAlign:"left"}}>Administration</span>
                    </button>
                  )}
                  <button onClick={()=>{setMenuTab("config");setConfigStep(0);setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.txt,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>⚙️</span><span style={{flex:1,textAlign:"left"}}>{t.tabConfig}</span>
                  </button>
                  <button onClick={()=>{setMenuTab("notifs");setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.txt,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>🔔</span><span style={{flex:1,textAlign:"left"}}>{t.tabNotifs}</span>
                    {unread>0 && <span style={{background:C.red,color:"#fff",borderRadius:10,padding:"2px 8px",fontSize:10,fontWeight:800}}>{unread}</span>}
                  </button>
                  <button onClick={()=>{setMenuTab("hist");setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.txt,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>📋</span><span style={{flex:1,textAlign:"left"}}>{t.tabHist}</span>
                  </button>
                  <button onClick={()=>{setMenuTab("parrainage");setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:`${C.pin}08`,color:C.pin,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>🎁</span><span style={{flex:1,textAlign:"left"}}>{t.parrainage||"Parrainage"}</span>
                    {(sub.refMonths||0)>0 && <span style={{background:`${C.grn}22`,color:C.grn,borderRadius:10,padding:"2px 7px",fontSize:10,fontWeight:800}}>+{sub.refMonths} mois</span>}
                  </button>
                  <button onClick={()=>{setMenuTab("rating");setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:`${C.yel}08`,color:C.yel,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>⭐</span><span style={{flex:1,textAlign:"left"}}>{t.rateAppMenu||"Donner mon avis"}</span>
                  </button>
                </>
              )}
              {/* ── Lots gagnés déplacés dans le bouton 🏆 de la barre ───── */}
              {isChild && !isAdm && (
                <button onClick={()=>{setMenuTab("notifs");setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.txt,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                  <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>🔔</span><span style={{flex:1,textAlign:"left"}}>{t.tabNotifs}</span>
                  {unread>0 && <span style={{background:C.red,color:"#fff",borderRadius:10,padding:"2px 8px",fontSize:10,fontWeight:800}}>{unread}</span>}
                </button>
              )}

              <button onClick={()=>{setShowBugModal(true);setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.txt,display:"flex",alignItems:"center",gap:10,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>🐛</span><span style={{flex:1,textAlign:"left"}}>{t.bugReportMenu}</span>
              </button>
              <button onClick={()=>{setShowInstallModal(true);setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.txt,display:"flex",alignItems:"center",gap:10,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>📱</span><span style={{flex:1,textAlign:"left"}}>{t.installAppMenu}</span>
              </button>
              <button onClick={()=>{handleSetUser(null);setTab(0);setShowMenu(false);}} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.red,display:"flex",alignItems:"center",gap:10,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>🚪</span><span style={{flex:1,textAlign:"left"}}>{t.logout}</span>
              </button>
              <div style={{padding:"10px 16px",borderTop:`1px solid ${C.bor}`,textAlign:"center",fontSize:10,color:C.mut,lineHeight:1.5}}>
                DUVIA — Licence Propriétaire<br/>
                © 2026 Alberto Ramos — Tous droits réservés<br/>
                <button onClick={()=>setShowLicenseModal(true)} style={{background:"none",border:"none",color:C.vio,textDecoration:"underline",fontSize:10,cursor:"pointer",padding:0,fontFamily:"inherit"}}>{t.viewLicense}</button>
              </div>
            </div>
            </>
          )}
        </div>
        </div>{/* end right controls */}
      </div>

      {/* Modale "Installer l'application" */}
      {showInstallModal && <InstallAppModal C={C} t={t} onClose={()=>setShowInstallModal(false)} />}

      {/* Modale "Signaler un problème" (diagnostic) */}
      <BugReportModal C={C} t={t} open={showBugModal} onClose={()=>setShowBugModal(false)}
        getContext={()=>({
          userId: myUid || null,
          familyId: familySync?.familyId || null,
          screen: menuTab,
          appState: {
            role: user?.role || null,
            parentIdx: user?.parentIdx,
            lang,
            plan: sub?.plan || null,
            nbParents: cfg?.parents?.length,
            nbChildren: cfg?.children?.length,
            syncStatus: familySync?.syncStatus,
          },
        })} />

      {/* Modale "Licence" */}
      {showLicenseModal && (
        <div onClick={()=>setShowLicenseModal(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:16,padding:20,maxWidth:480,width:"100%",maxHeight:"80vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexShrink:0}}>
              <div style={{fontSize:16,fontWeight:900,color:C.txt}}>📄 Licence</div>
              <button onClick={()=>setShowLicenseModal(false)} style={{width:30,height:30,background:C.sur,border:`1px solid ${C.bor}`,borderRadius:8,color:C.mut,fontSize:14,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:12,color:C.mut,lineHeight:1.6,whiteSpace:"pre-wrap",overflowY:"auto",flex:1,paddingRight:4}}>
{`DUVIA - Licence Propriétaire

Copyright (c) 2026 Alberto Ramos

Tous droits réservés.

Le logiciel DUVIA, y compris son code source, son architecture, son interface utilisateur, son design, sa documentation, ses bases de données, ses contenus et tous les éléments associés, est la propriété exclusive d'Alberto Ramos.

AUTORISATIONS

L'utilisation de DUVIA est autorisée uniquement dans le cadre prévu par son auteur et conformément aux conditions d'utilisation applicables.

RESTRICTIONS

Sauf autorisation écrite préalable d'Alberto Ramos, il est strictement interdit de :

- Copier ou reproduire tout ou partie du logiciel ;
- Modifier, adapter ou créer des œuvres dérivées du logiciel ;
- Distribuer, publier, vendre, louer ou concéder sous licence le logiciel ;
- Décompiler, désassembler ou tenter d'extraire le code source ;
- Utiliser tout ou partie du logiciel à des fins commerciales ;
- Reproduire ou exploiter les fonctionnalités, l'architecture ou les contenus du logiciel dans un produit concurrent.

PROPRIÉTÉ INTELLECTUELLE

Aucun droit de propriété intellectuelle n'est transféré à l'utilisateur. Tous les droits, titres et intérêts relatifs à DUVIA demeurent la propriété exclusive d'Alberto Ramos.

ABSENCE DE GARANTIE

DUVIA est fourni « en l'état » (« as is »), sans aucune garantie expresse ou implicite, notamment concernant sa disponibilité, sa fiabilité ou son adéquation à un usage particulier.

LIMITATION DE RESPONSABILITÉ

Dans les limites autorisées par la loi, Alberto Ramos ne pourra être tenu responsable des dommages directs, indirects, accessoires ou consécutifs résultant de l'utilisation ou de l'impossibilité d'utiliser DUVIA.

VIOLATION DE LA LICENCE

Toute utilisation non autorisée du logiciel constitue une violation des droits de propriété intellectuelle et pourra donner lieu à des poursuites civiles et/ou pénales conformément aux lois applicables.

CONTACT

Pour toute demande d'autorisation ou de licence :

Alberto Ramos
Email : DUVIA.services@gmx.com

Date d'entrée en vigueur : 14 juin 2026

© 2026 Alberto Ramos. Tous droits réservés.`}
            </div>
          </div>
        </div>
      )}
      {/* Trial / Premium / Earned bubble — second row */}
      {!isObs && !isChild && st==="trial_premium" && (
        <div style={{padding:"0 14px 8px",display:"flex",justifyContent:"flex-end"}}>
          <div onClick={()=>{setMenuTab("premium");setShowMenu(false);}} style={{background:`${C.vio}18`,border:`1.5px solid ${C.vio}66`,borderRadius:20,padding:"4px 12px",fontSize:11,color:C.vio,fontWeight:800,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:6,transition:"all .15s"}}>
            {isBeta()
              ? <>🧪 Bêta · <span style={{opacity:.85}}>{(t.daysLeftSuffix||"{n}j restants").replace("{n}",BETA_DAYS_LEFT())}</span></>
              : <>⭐ {t.trialBanner} · <span style={{opacity:.85}}>{days}j restant{days>1?"s":""}</span></>
            }
          </div>
        </div>
      )}
      {!isObs && !isChild && st==="earned_premium" && (
        <div style={{padding:"0 14px 8px",display:"flex",justifyContent:"flex-end"}}>
          <div onClick={()=>{setMenuTab("parrainage");setShowMenu(false);}} style={{background:days<=5?`${C.red}18`:`${C.grn}18`,border:`1.5px solid ${days<=5?C.red+"66":C.grn+"66"}`,borderRadius:20,padding:"4px 12px",fontSize:11,color:days<=5?C.red:C.grn,fontWeight:800,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:6,transition:"all .15s",animation:"pulseFade 2s ease-in-out infinite"}}>
            🎁 Premium – {days}j restant{days>1?"s":""}
          </div>
        </div>
      )}
      {!isObs && !isChild && st==="freemium" && (
        <div style={{padding:"0 14px 8px",display:"flex",justifyContent:"flex-end"}}>
          <div onClick={()=>{setMenuTab("premium");setShowMenu(false);}} style={{background:`${C.red}18`,border:`1.5px solid ${C.red}66`,borderRadius:20,padding:"4px 12px",fontSize:11,color:C.red,fontWeight:800,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:6}}>
            ⚠️ {t.trialExpired}
          </div>
        </div>
      )}
      {!isObs && !isChild && st==="premium" && (
        <div style={{padding:"0 14px 8px",display:"flex",justifyContent:"flex-end"}}>
          <div onClick={()=>{setMenuTab("premium");setShowMenu(false);}} style={{background:`${C.grn}18`,border:`1.5px solid ${C.grn}66`,borderRadius:20,padding:"4px 12px",fontSize:11,color:C.grn,fontWeight:800,display:"inline-flex",alignItems:"center",gap:6,cursor:"pointer"}}>⭐ Premium</div>
        </div>
      )}
      </div>

      {bell && <BellPanel onClose={()=>setBell(false)} />}

      {/* BARRE FAMILLE — visible uniquement si plusieurs familles */}
      {familySync.families.length > 1 && (
        <div style={{
          flexShrink:0,
          background:headerBG,
          borderBottom:`1.5px solid ${C.bor}`,
          padding:"6px 14px",
          display:"flex",alignItems:"center",gap:8,
        }}>
          <span style={{fontSize:16,flexShrink:0}}>👨‍👩‍👧</span>
          <select
            value={familySync.familyId || ""}
            onChange={e => familySync.switchFamily(e.target.value)}
            style={{
              flex:1,height:34,fontSize:13,fontWeight:800,
              color:C.vio,background:`${C.vio}12`,
              border:`2px solid ${C.vio}`,borderRadius:12,
              cursor:"pointer",padding:"0 10px",
            }}
          >
            {familySync.families.map(f => (
              <option key={f.id} value={f.id} style={{color:C.txt}}>{f.label}</option>
            ))}
          </select>
          <InfoBubble C={C} tipKey={`duvia_famtip_${user?.id||"x"}`} title={t.multiFamilyTitle||"Plusieurs familles"}>
            {t.multiFamilyInfo||"Vous appartenez à plusieurs familles. Utilisez ce menu pour basculer de l'une à l'autre."}
          </InfoBubble>
        </div>
      )}

      {/* NAV — en haut. En config : remplacée par les étapes au même endroit */}
      {menuTab==="config" ? (
        (() => {
          const STEPS=[{i:"👤",l:t.stepId},{i:"👥",l:t.stepAccess},{i:"🗓️",l:t.stepDates},{i:"📆",l:t.stepGarde},{i:"🌐",l:t.stepLang||"Langue"}];
          return (
            <div style={{flexShrink:0,background:C.card,borderBottom:`1.5px solid ${C.bor}`,boxShadow:"0 1px 6px rgba(0,0,0,.05)"}}>
              {/* Barre retour + titre */}
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px 6px"}}>
                <button onClick={()=>{setMenuTab(null);setConfigStep(0);}} style={{width:34,height:34,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:18,borderRadius:8,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>🔙</button>
                <div style={{fontSize:14,fontWeight:900,flex:1}}>⚙️ {t.tabConfig}</div>
                {configStep===0 && <StepIdInfoButton C={C} t={t} />}
                {configStep===1 && <StepAccessInfoButton C={C} t={t} />}
                {configStep===2 && <StepDatesInfoButton C={C} t={t} />}
                {configStep===3 && <StepGardeInfoButton C={C} t={t} />}
              </div>
              {/* Onglets étapes */}
              <div style={{display:"flex"}}>
              {STEPS.map((s,i)=>(
                <button key={i} onClick={()=>setConfigStep(i)}
                  style={{flex:1,padding:"8px 4px 7px",background:configStep===i?C.sur:"transparent",color:configStep===i?C.vio:C.mut,borderBottom:configStep===i?`2.5px solid ${C.vio}`:"2.5px solid transparent",borderRadius:0,fontSize:16,height:"auto",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,transition:"all .15s",cursor:"pointer"}}>
                  <span style={{lineHeight:1,position:"relative"}}>
                    {s.i}
                    {s.badge>0&&<span style={{position:"absolute",top:-4,right:-6,width:14,height:14,borderRadius:"50%",background:C.red,color:"#fff",fontSize:8,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center"}}>{s.badge}</span>}
                  </span>
                  <span style={{fontSize:9,fontWeight:800,letterSpacing:".03em",textTransform:"uppercase"}}>{s.l}</span>
                </button>
              ))}
              </div>
            </div>
          );
        })()
      ) : (
        <div style={{flexShrink:0,background:headerBG,borderBottom:`1.5px solid ${C.bor}`,display:"flex",boxShadow:"0 1px 6px rgba(0,0,0,.05)"}}>
          {TABS.map((tb,i) => (
            <button key={i} onClick={()=>{ setTab(i); setShowMenu(false); setMenuTab(null); }} style={{flex:1,padding:"10px 2px",background:tab===i&&!menuTab?C.sur:"transparent",color:tab===i&&!menuTab?C.vio:C.mut,borderBottom:tab===i&&!menuTab?`2.5px solid ${C.vio}`:"2.5px solid transparent",borderRadius:0,fontSize:tab===i&&!menuTab?22:20,height:"auto",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",transition:"all .15s"}}>
              <span style={{lineHeight:1}}>{tb.icon}</span>
              {tb.badge>0 && <span style={{position:"absolute",top:5,right:"10%",background:C.red,borderRadius:"50%",width:8,height:8,border:`2px solid ${C.card}`}}/>}
            </button>
          ))}
        </div>
      )}

      {/* BANNIÈRE BÊTA */}
      {isBeta() && user && !sub._admin && (
        <div style={{
          background:C.sur,
          borderBottom:`1px solid ${C.bor}`,
          padding:"6px 16px",
          display:"flex",alignItems:"center",justifyContent:"center",
          flexShrink:0,
        }}>
          <div style={{fontSize:11,color:C.vio,fontWeight:700}}>
            {t.betaBanner||"🎉 Bêta gratuite — Trial Premium jusqu'au 30 septembre 2026"}
          </div>
        </div>
      )}

      {/* CONTENT */}
      <div id="duvia-scroll" style={{flex:1,overflowY:"auto",padding:16,background:C.bg}}>
        {(isObs && !isAdm) ? (
          <div>
            {tab===0 && <CalTab readOnly updateCal={()=>{}} />}
            {tab===1 && <ContactsTab readOnly />}
            {tab===2 && <MessagingTab />}
            {tab===3 && <GameTab />}
          </div>
        ) : (isChild && !isAdm) ? (
          <div>
            {tab===0 && <CalTab readOnly updateCal={()=>{}} />}
            {tab===1 && <ScheduleTab childReadOnly />}
            {tab===2 && <ContactsTab addOnly />}
            {tab===3 && <MessagingTab />}
            {tab===4 && <GameTab />}
          </div>
        ) : (
          <div>
            {menuTab==="config" && (
              <div>
                {configStep===0&&![...cfg.parents,...cfg.children].every(x=>x.name.trim())&&(
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,padding:"8px 12px",background:`${C.yel}18`,border:`1px solid ${C.yel}55`,borderRadius:10}}>
                    <span style={{fontSize:15}}>⚠️</span>
                    <span style={{fontSize:12,fontWeight:700,color:C.yel}}>{t.configIncomplete||"Incomplet"}</span>
                    <span style={{fontSize:11,color:C.mut}}>{t.configIncompleteDesc||"— Renseignez tous les noms pour continuer."}</span>
                  </div>
                )}
                <ConfigTab />
              </div>
            )}
            {menuTab==="notifs" && (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,paddingBottom:14,borderBottom:`1.5px solid ${C.bor}`}}>
                  <div style={{fontSize:15,fontWeight:900}}>🔔 {t.tabNotifs}</div>
                </div>
                <NotifTab />
              </div>
            )}
            {menuTab==="premium" && (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,paddingBottom:14,borderBottom:`1.5px solid ${C.bor}`}}>
                  <div style={{fontSize:15,fontWeight:900}}>⭐ {t.tabPremium}</div>
                </div>
                <PremiumTab />
              </div>
            )}
            {menuTab==="hist" && (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,paddingBottom:14,borderBottom:`1.5px solid ${C.bor}`}}>
                  <div style={{fontSize:15,fontWeight:900}}>📋 {t.tabHist}</div>
                </div>
                <HistTab />
              </div>
            )}
            {menuTab==="parrainage" && (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,paddingBottom:14,borderBottom:`1.5px solid ${C.bor}`}}>
                  <button onClick={()=>setMenuTab(null)} style={{padding:"0 14px",height:36,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>← Retour</button>
                  <div style={{fontSize:15,fontWeight:900}}>🎁 {t.parrainage||"Parrainage"}</div>
                </div>
                <ParrainageSection />
              </div>
            )}
            {menuTab==="rating" && (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,paddingBottom:14,borderBottom:`1.5px solid ${C.bor}`}}>
                  <button onClick={()=>setMenuTab(null)} style={{padding:"0 14px",height:36,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>← Retour</button>
                  <div style={{fontSize:15,fontWeight:900}}>⭐ {t.rateAppMenu||"Donner mon avis"}</div>
                </div>
                <RatingTab />
              </div>
            )}
            {menuTab==="admin" && isAdm && (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,paddingBottom:14,borderBottom:`1.5px solid ${C.bor}`}}>
                  <button onClick={()=>setMenuTab(null)} style={{padding:"0 14px",height:36,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>← Retour</button>
                  <div style={{fontSize:15,fontWeight:900}}>👑 Administration</div>
                </div>
                <AdminTab />
              </div>
            )}
            {!menuTab && tab===0 && <CalTab readOnly={false} canEdit={!isFreemiumPlan(sub)} />}
            {!menuTab && tab===1 && <ScheduleTab />}
            {!menuTab && tab===2 && <ExpTab />}
            {!menuTab && tab===3 && <ContactsTab />}
            {!menuTab && tab===4 && <VaultTab />}
            {!menuTab && tab===5 && <MessagingTab />}
            {!menuTab && tab===6 && <GameTab />}
          </div>
        )}
      </div>


      {/* ── Modale suppression de mon compte ──────────────────────────────── */}
      {confirmDeleteAccount && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:20,padding:28,maxWidth:340,width:"100%",border:`1.5px solid ${C.bor}`,textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:10}}>⚠️</div>
            <div style={{fontSize:16,fontWeight:900,color:C.txt,marginBottom:8}}>Supprimer mon compte ?</div>
            <div style={{fontSize:12,color:C.mut,lineHeight:1.6,marginBottom:8}}>
              Cette action est <strong style={{color:C.red}}>définitive</strong>. Vous serez déconnecté(e) et ne pourrez plus accéder à votre compte.
            </div>
            <div style={{background:`${C.red}10`,border:`1px solid ${C.red}33`,borderRadius:10,padding:"10px 12px",margin:"12px 0 20px",textAlign:"left"}}>
              <div style={{fontSize:11,fontWeight:800,color:C.red,marginBottom:6}}>Ce qui se passera :</div>
              {["👤 Votre compte sera supprimé","🗓️ Le planning de garde sera réinitialisé si nécessaire","💰 Les dépenses partagées seront remises à zéro","📞 Vous serez retiré(e) des contacts de la famille","💬 Vos messages resteront visibles (marqués « compte supprimé »)"].map((l,i)=>(
                <div key={i} style={{fontSize:11,color:C.mut,marginBottom:3}}>{l}</div>
              ))}
            </div>
            {deleteAccountError && (
              <div style={{background:`${C.red}10`,border:`1px solid ${C.red}44`,borderRadius:10,padding:"10px 12px",marginBottom:16,fontSize:12,color:C.red,textAlign:"left"}}>
                {deleteAccountError}
              </div>
            )}
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{ setConfirmDeleteAccount(false); setDeleteAccountError(""); }}
                disabled={deletingAccount}
                style={{flex:1,height:44,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13,cursor:deletingAccount?"not-allowed":"pointer",opacity:deletingAccount?.5:1}}>
                Annuler
              </button>
              <button onClick={deleteMyAccount} disabled={deletingAccount}
                style={{flex:1,height:44,background:C.red,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:13,cursor:deletingAccount?"not-allowed":"pointer",opacity:deletingAccount?.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                {deletingAccount
                  ? <><span style={{width:16,height:16,border:"2px solid #fff4",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>Suppression…</>
                  : "🗑️ Supprimer"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Modale reset ───────────────────────────────────────────────────── */}
      {showResetConfirm && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:20,padding:28,maxWidth:320,width:"100%",border:`1.5px solid ${C.bor}`,textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:10}}>🔄</div>
            <div style={{fontSize:16,fontWeight:900,color:C.txt,marginBottom:8}}>Réinitialiser l'app ?</div>
            <div style={{fontSize:12,color:C.mut,lineHeight:1.6,marginBottom:20}}>
              Toutes les données seront effacées :<br/>
              comptes, calendrier, dépenses, messages…<br/>
              <strong style={{color:C.ora}}>Retour à la première connexion.</strong>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setShowResetConfirm(false)}
                style={{flex:1,height:44,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13,cursor:"pointer"}}>
                Annuler
              </button>
              <button onClick={()=>{ try{window.localStorage.clear();}catch{} duviaReload(); }}
                style={{flex:1,height:44,background:C.ora,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:13,cursor:"pointer"}}>
                🔄 Réinitialiser
              </button>
            </div>
          </div>
        </div>
      )}
      {showRefPrompt && !sub.refCode && (
        <div style={{position:"fixed",bottom:72,left:"50%",transform:"translateX(-50%)",width:"calc(100% - 32px)",maxWidth:440,background:C.card,border:`1.5px solid ${C.pin}`,borderRadius:14,padding:"14px 16px",boxShadow:"0 4px 20px rgba(0,0,0,.15)",zIndex:200,display:"flex",gap:12,alignItems:"center"}}>
          <div style={{fontSize:26}}>🎁</div>
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:800,color:C.pin,marginBottom:2}}>Invitez l'autre parent</div>
            <div style={{fontSize:11,color:C.mut}}>Parrainez un proche — 15 jours offerts à chacun</div>
          </div>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            <button onClick={()=>{setShowRefPrompt(false);setMenuTab("parrainage");setShowMenu(true);}} style={{padding:"7px 12px",background:`linear-gradient(135deg,${C.vio},${C.pin})`,color:"#fff",fontSize:12,fontWeight:700,borderRadius:8}}>Inviter</button>
            <button onClick={()=>setShowRefPrompt(false)} style={{padding:"7px 10px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,fontSize:12,borderRadius:8}}>✕</button>
          </div>
        </div>
      )}
    </div>
    </AppContext.Provider>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
// ── Écran RGPD de PREMIÈRE UTILISATION ───────────────────────────────────────
// Distinct de la charte d'engagement (ConsentScreen). Affiché une seule fois
// par appareil (redemandé si RGPD_NOTICE_VERSION change). Informe sur les
// données + renvoie à la politique de confidentialité / CGU, et enregistre
// l'acceptation (version + date) via onAccept.
function RgpdConsentScreen({C,t,onAccept}) {
  const [checked,setChecked] = useState(false);
  const link = {color:C.vio,fontWeight:800,textDecoration:"underline"};
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C._brand?`linear-gradient(rgba(255,255,255,.6),rgba(255,255,255,.6)),linear-gradient(145deg,#7BA8F5 0%,#9D8FF0 26%,#F8F2FF 52%,#FF9FD2 76%,#FF6BB5 100%)`:C.bg}}>
      <div style={{width:"100%",maxWidth:460}} className="fi">
        <div style={{background:C.card,borderRadius:20,padding:"26px 24px",boxShadow:"0 10px 40px rgba(0,0,0,.12)"}}>
          <div style={{fontSize:20,fontWeight:900,color:C.txt,marginBottom:6}}>
            {t.rgpdTitle||"🔒 Vos données et votre vie privée"}
          </div>
          <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:16}}>
            {t.rgpdIntro||"Duvia traite des données personnelles (identité, plannings de garde, dépenses, documents, messages) pour vous aider à organiser la vie de vos enfants. Vos données sont conservées de façon sécurisée et ne sont jamais vendues."}
          </div>

          <div style={{background:`${C.vio}0e`,border:`1px solid ${C.bor}`,borderRadius:12,padding:"12px 14px",marginBottom:16,fontSize:12.5,color:C.txt,lineHeight:1.6}}>
            {t.rgpdRights||"Vous disposez d'un droit d'accès, de rectification, de suppression et de portabilité de vos données, ainsi que du droit de saisir la CNIL. Vous pouvez supprimer votre compte et vos données à tout moment depuis les réglages."}
          </div>

          <div style={{fontSize:12.5,color:C.mut,marginBottom:18}}>
            {t.rgpdSeeMore||"Pour en savoir plus :"}{" "}
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={link}>{t.rgpdPrivacy||"Politique de confidentialité"}</a>
            {" · "}
            <a href={CGU_URL} target="_blank" rel="noopener noreferrer" style={link}>{t.rgpdCgu||"Conditions d'utilisation"}</a>
          </div>

          <label style={{display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer",marginBottom:18}}>
            <input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} style={{width:20,height:20,marginTop:2,flexShrink:0,accentColor:C.vio,cursor:"pointer"}} />
            <span style={{fontSize:13,color:C.txt,fontWeight:600,lineHeight:1.5}}>
              {t.rgpdAcceptLabel||"J'ai lu et j'accepte la politique de confidentialité et les conditions d'utilisation de Duvia."}
            </span>
          </label>

          <button onClick={onAccept} disabled={!checked} style={{
            width:"100%",padding:"13px",background:checked?`linear-gradient(135deg,${C.vio},${C.blu})`:C.bor,
            color:checked?"#fff":C.mut,fontSize:15,fontWeight:800,borderRadius:12,
            cursor:checked?"pointer":"not-allowed",opacity:checked?1:.7,transition:"all .2s"}}>
            {t.rgpdAcceptBtn||"✓ Continuer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConsentScreen({C,t,user,onAccept,onDecline}) {
  const [checked1,setChecked1] = useState(false);
  const [checked2,setChecked2] = useState(false);
  const [checked3,setChecked3] = useState(false);
  const canAccept = checked1 && checked2 && checked3;
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C._brand?`linear-gradient(145deg,#7BA8F5 0%,#9D8FF0 26%,#F8F2FF 52%,#FF9FD2 76%,#FF6BB5 100%)`:`radial-gradient(ellipse at 30% 20%,rgba(124,111,205,.15) 0%,transparent 60%),${C.bg}`}}>
      <div style={{width:"100%",maxWidth:420}} className="fi">
        <div style={{textAlign:"center",marginBottom:22,paddingLeft:180}}>
          <div style={{fontSize:36,marginBottom:8}}>👨‍👩‍👧</div>
          <div style={{fontSize:20,fontWeight:900,color:C.txt,marginBottom:6}}>{t.consentWelcome||"Bienvenue"}, {user.name?.split(" ")[0]} !</div>
          <div style={{fontSize:13,color:C.mut,fontStyle:"italic",lineHeight:1.5}}>{t.consentIntro||"Avant de commencer, merci de confirmer votre engagement."}</div>
        </div>
        <div className="card" style={{marginBottom:14}}>
          <div style={{fontSize:14,fontWeight:800,color:C.txt,marginBottom:14,lineHeight:1.5}}>
            {t.consentTitle||"Vous utilisez cette application pour organiser la vie d'un ou plusieurs enfants."}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <label style={{display:"flex",alignItems:"flex-start",gap:12,cursor:"pointer",padding:"12px 14px",background:checked1?`${C.vio}11`:C.sur,border:`2px solid ${checked1?C.vio:C.bor}`,borderRadius:12,transition:"all .2s"}}>
              <input type="checkbox" checked={checked1} onChange={e=>setChecked1(e.target.checked)} style={{marginTop:2,flexShrink:0}} />
              <div>
                <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:3}}>{t.consentCheck1Title||"Je suis parent ou titulaire de l'autorité parentale"}</div>
                <div style={{fontSize:11,color:C.mut,lineHeight:1.4}}>{t.consentCheck1Desc||"Je déclare avoir les droits parentaux sur le ou les enfants concernés par cette application."}</div>
              </div>
            </label>
            <label style={{display:"flex",alignItems:"flex-start",gap:12,cursor:"pointer",padding:"12px 14px",background:checked2?`${C.grn}11`:C.sur,border:`2px solid ${checked2?C.grn:C.bor}`,borderRadius:12,transition:"all .2s"}}>
              <input type="checkbox" checked={checked2} onChange={e=>setChecked2(e.target.checked)} style={{marginTop:2,flexShrink:0}} />
              <div>
                <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:3}}>{t.consentCheck2Title||"J'utilise cette application dans l'intérêt du ou des enfants"}</div>
                <div style={{fontSize:11,color:C.mut,lineHeight:1.4}}>{t.consentCheck2Desc||"Je m'engage à utiliser Duvia uniquement pour le bien-être et l'organisation de vie des enfants."}</div>
              </div>
            </label>
            <label style={{display:"flex",alignItems:"flex-start",gap:12,cursor:"pointer",padding:"12px 14px",background:checked3?`${C.ora}11`:C.sur,border:`2px solid ${checked3?C.ora:C.bor}`,borderRadius:12,transition:"all .2s"}}>
              <input type="checkbox" checked={checked3} onChange={e=>setChecked3(e.target.checked)} style={{marginTop:2,flexShrink:0}} />
              <div>
                <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:3}}>{t.consentCheck3Title||"J'ai compris que Duvia n'a aucune valeur juridique"}</div>
                <div style={{fontSize:11,color:C.mut,lineHeight:1.4}}>{t.consentCheck3Desc||"Duvia est un outil d'aide à l'organisation familiale. Il ne remplace pas un accord légal, une décision judiciaire ou l'avis d'un professionnel du droit."}</div>
              </div>
            </label>
          </div>
          <button
            onClick={onAccept}
            disabled={!canAccept}
            style={{width:"100%",padding:"13px",marginTop:18,background:canAccept?`linear-gradient(135deg,${C.vio},${C.blu})`:`${C.bor}`,color:canAccept?"#fff":C.mut,fontSize:15,fontWeight:800,borderRadius:12,cursor:canAccept?"pointer":"not-allowed",transition:"all .2s",opacity:canAccept?1:.7}}>
            {t.consentAccept||"✓ J'accepte et j'accède à l'application"}
          </button>
          <button onClick={onDecline} style={{width:"100%",padding:"9px",marginTop:8,background:"transparent",color:C.mut,fontSize:12,textDecoration:"underline"}}>
            {t.consentDecline||"← Retour à la connexion"}
          </button>
        </div>
        <div style={{fontSize:10,color:C.mut,textAlign:"center",lineHeight:1.5,padding:"0 10px"}}>
          {t.consentFooter||"Ces engagements sont demandés à chaque nouvelle connexion pour garantir une utilisation bienveillante de l'application."}
        </div>
      </div>
    </div>
  );
}

function LoginScreen({C,t,lang,setLang,themeMode,cycleTheme,users,setUsers,onLogin,onObsJoin,familySync,cfg,setCfg}) {
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState(()=>{ try{return window.localStorage.getItem("duvia_last_email")||"";}catch{return "";} }); const [pw,setPw]=useState("");
  const [name,setName]=useState(""); const [role,setRole]=useState("parent");
  const [showInstallModal,setShowInstallModal]=useState(false);
  const [err,setErr]=useState(""); const [ok,setOk]=useState("");
  const [showPw,setShowPw]=useState(false);
  // « Rester connecté » — opt-in PROPRE à chaque affichage de l'écran de
  // connexion : on remet le drapeau à zéro au montage (évite qu'une valeur
  // « 1 » d'une session précédente garde l'utilisateur connecté par erreur).
  const [remember,setRemember]=useState(false);
  useEffect(()=>{ try{ window.localStorage.removeItem("duvia_remember"); window.localStorage.removeItem("duvia_remember_until"); }catch{} },[]);
  // Compte à rebours sur l'écran d'attente : le bouton Retour est bloqué 15 s.
  const [waitLeft,setWaitLeft]=useState(15);
  useEffect(()=>{
    if(mode!=="obs_waiting") return;
    setWaitLeft(15);
    const id=setInterval(()=> setWaitLeft(s=> s<=1 ? 0 : s-1), 1000);
    return ()=>clearInterval(id);
  },[mode]);

  const [shakeName,setShakeName]=useState(false);
  function _triggerShakeName(){ setShakeName(true); setTimeout(()=>setShakeName(false),600); }
  const [showLangMenu,setShowLangMenu]=useState(false);
  const foundLang=LANGS[lang]||LANGS["fr"];
  async function doLogin(){
    if(!email||!pw){ setErr(t.wrongPw); return; }
    try{ window.localStorage.setItem("duvia_last_email", email.trim()); }catch{}
    // 🔧 Si on arrive par un lien d'invitation, se connecter doit AUSSI rattacher
    // à la famille. La connexion simple ne le fait pas → on délègue au flux qui
    // rejoint réellement la famille (sinon l'invité finit dans sa propre famille).
    if(isAnyInvite && obsInviteCode?.code){ return doLoginAndJoin(); }
    const cleanEmail = identifierToAuthEmail(email);

    // Supabase Auth est la source de vérité pour TOUS les comptes, admin compris.
    setErr(""); setOk(t.syncConnecting||"Connexion…");
    const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(error){
      setOk(""); setErr(t.wrongPw); return;
    }

    // Admin vérifié côté serveur (table app_admins) — personne ne peut se
    // donner ce rôle soi-même, et il n'y a plus de mot de passe admin dans le code.
    const { data: adminRow } = await supabase
      .from("app_admins")
      .select("user_id")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (adminRow) {
      setOk("");
      onLogin({ id: data.user.id, email: cleanEmail, name: "Administrateur", role: "admin" });
      return;
    }

    // Connexion Supabase OK → profil local depuis métadonnées Supabase
    const meta = data.user?.user_metadata || {};
    const existing = users.find(u => u.email===cleanEmail);
    const profile = existing
      ? { ...existing }
      : {
          id: Date.now(), email: cleanEmail,
          name: meta.name || cleanEmail.split("@")[0],
          role: meta.role || "parent",
          parentIdx: meta.parentIdx ?? 0,
          phone: isLikelyPhoneIdentifier(email) ? email.trim() : (meta.phone||undefined),
          refCode: makeRefCode(Date.now(), cleanEmail),
          refUsed:null, refCount:0, validatedRefCount:0, refMonths:0,
          trialExtension:0, pendingSpins:0, monthlyRefMonth:null, monthlyRefCount:0,
          accountCreatedAt: new Date().toISOString(),
        };
    if(!existing) setUsers(u => [...u, profile]);
    setOk("");
    onLogin(profile);
  }
  const [refInput,setRefInput] = useState("");
  // Detect invite from URL — supports encoded (?inv=base64) and legacy plain params
  const [obsInviteCode] = useState(()=>{
    try{
      const p = new URLSearchParams(window.location.search);
      const inv = p.get("inv");
      if(inv){
        try{
          const d = JSON.parse(atob(inv));
          // Vérifier expiration (24h)
          if(d.expiresAt && new Date(d.expiresAt) < new Date()) return {expired:true};
          return {code:d.code, family:d.family, role:d.role, email:d.email||"", expiresAt:d.expiresAt||null};
        }catch{
          // 🔧 Nouveau format (table family_invitations) : token brut, pas du JSON encodé.
          // On le traite comme une invitation parent à valider côté serveur (RPC).
          return {code:inv, family:"__token__", role:"parent", email:"", newStyle:true};
        }
      }
      // legacy fallback (anciens liens non encodés)
      return {code:p.get("code"), family:p.get("family"), role:p.get("role"), email:""};
    }catch{return {};}
  });
  const isExpiredInvite = obsInviteCode?.expired === true;
  const isObsInvite    = obsInviteCode?.role==="observer" && obsInviteCode?.family;
  const isChildInvite  = obsInviteCode?.role==="child"    && obsInviteCode?.family;
  const isParentInvite = obsInviteCode?.role==="parent"   && obsInviteCode?.family;
  const isAnyInvite    = isObsInvite || isChildInvite || isParentInvite;

  // Arrivée via lien d'invitation → pré-remplir l'email et choisir le bon écran
  useEffect(()=>{
    if(!isAnyInvite) return;
    let cancelled = false;
    (async () => {
      const invEmail = obsInviteCode?.email || "";
      if(invEmail){
        // Ancien format : l'email est dans le lien.
        setEmail(invEmail);
        setMode("login");
        return;
      }
      // Nouveau format (jeton) : l'email est côté serveur. On le récupère pour
      // pré-remplir le champ ET savoir si le compte existe déjà → on ouvre
      // « Connexion » si oui, « Créer un compte » sinon.
      if(obsInviteCode?.newStyle && obsInviteCode?.code){
        try{
          const { data, error } = await supabase.rpc("peek_invitation", { p_token: obsInviteCode.code });
          const row = Array.isArray(data) ? data[0] : data;
          if(!cancelled && row && row.email){
            setEmail(row.email);
            if(row.has_account){
              // Compte déjà existant → écran « se connecter et rejoindre »
              // (le seul chemin qui rattache vraiment à la famille).
              setShowExistingAccount(true);
            } else {
              // Pas de compte → création, email pré-rempli.
              setMode("register");
            }
            return;
          }
        }catch(e){ console.warn("[Duvia] peek_invitation:", e); }
      }
      // Repli : par défaut, écran de connexion (basculable manuellement).
      if(!cancelled) setMode("login");
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const [showExistingAccount, setShowExistingAccount] = useState(false);

  const [childAge, setChildAge]           = useState("");
  const [parentConsent, setParentConsent] = useState(false);
  const [parentGender, setParentGender]   = useState("");
  const [parentPhone, setParentPhone]     = useState("");
  const [pwConfirm, setPwConfirm]         = useState("");

  // En attente d'approbation : on n'affiche QUE le message d'attente (pas le
  // formulaire ni le bouton « Envoyer le lien », qui n'ont rien à faire ici).
  // ⚠️ Placé APRÈS tous les hooks (sinon « Rendered fewer hooks » / React #300).
  if(mode==="obs_waiting") return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C.bg}}>
      <div style={{background:C.card,borderRadius:20,padding:"30px 24px",maxWidth:420,width:"100%",textAlign:"center",boxShadow:"0 10px 40px rgba(0,0,0,.12)"}}>
        <div style={{fontSize:44,marginBottom:12}}>⏳</div>
        <div style={{fontWeight:900,fontSize:18,marginBottom:8,color:C.txt}}>{t.obsJoinWaiting||"En attente d'approbation"}</div>
        <div style={{fontSize:13.5,color:C.mut,lineHeight:1.6,marginBottom:18}}>{t.obsJoinWaitingInfo||"Votre demande a été envoyée aux parents. Vous recevrez une notification dès qu'elle sera approuvée."}</div>
        {waitLeft>0 && (
          <div style={{fontSize:13,color:C.vio,fontWeight:700,marginBottom:10}}>
            ⏳ Veuillez patienter <b>{waitLeft}s</b>…
          </div>
        )}
        <button onClick={()=>{ try{ window.location.href = window.location.origin + "/"; }catch{ setMode("login"); } }} disabled={waitLeft>0}
          style={{height:42,padding:"0 22px",background:C.sur,color:waitLeft>0?C.bor:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13,borderRadius:10,opacity:waitLeft>0?0.55:1,cursor:waitLeft>0?"not-allowed":"pointer"}}>
          {t.backLogin||"Retour"}
        </button>
      </div>
    </div>
  );

  async function doReg(){
    // ── Validations ─────────────────────────────────────────────────
    const cleanName  = sanitize(name).slice(0, LIMITS.NAME_MAX);
    // Vérifier que le lien d'invitation observateur n'a pas déjà été utilisé
    if(isObsInvite && obsInviteCode?.code){
      const inv=(cfg.pendingInvites||[]).find(i=>i.code===obsInviteCode.code);
      if(inv && inv.used){ setErr(t.invErrUsedObs); return; }
    }
    const finalRolePreCheck = isObsInvite ? "observer" : isChildInvite ? "child" : role;
    // Observateurs et enfants peuvent s'identifier par email OU par téléphone.
    // Les parents restent en email obligatoire (utilisé ailleurs pour les invitations).
    const rawIdentifier = email.trim();
    const usingPhoneId = finalRolePreCheck !== "parent" && isLikelyPhoneIdentifier(rawIdentifier);
    const regPhoneId = usingPhoneId ? rawIdentifier : "";
    const cleanEmail = usingPhoneId
      ? identifierToAuthEmail(rawIdentifier)
      : rawIdentifier.toLowerCase().slice(0, LIMITS.EMAIL_MAX);
    if(!cleanName || !cleanEmail || !pw){ setErr(t.allRequired); return; }
    if(cleanName.length < 2){ setErr("Le nom doit contenir au moins 2 caractères."); return; }
    if(!isCleanText(cleanName)){ _triggerShakeName(); setErr("⚠️ Le nom contient des mots inappropriés."); return; }
    if(!usingPhoneId && !isValidEmail(cleanEmail)){ setErr(finalRolePreCheck==="parent" ? "Adresse email invalide." : "Adresse email ou numéro de téléphone invalide."); return; }
    const pwErr = validatePassword(pw);
    if(pwErr){ setErr(pwErr); return; }
    if(pw !== pwConfirm){ setErr(t.pwMismatch); return; }
    // Nettoyage du cache localStorage : on supprime toute entrée locale pour cet email
    // Le vrai doublon sera détecté par Supabase lors du signUp (linkAccount).
    setUsers(us => us.filter(u => u.email !== cleanEmail));
    const newId=Date.now();
    const newRefCode=makeRefCode(newId,cleanEmail);
    let refUsed=null; let trialExtension=0;
    if(refInput.trim()){
      const code=refInput.trim().toUpperCase();
      const referrer=users.find(u=>u.refCode===code);
      if(!referrer){setErr(t.refInvalid||"Code parrain invalide");return;}
      refUsed=code; // filleul → démarre en Trial Premium; bonus parrain déclenché à la validation (score ≥ 5)
      const newRefCount=(referrer.refCount||0)+1;
      setUsers(us=>us.map(u=>u.id===referrer.id?{...u,refCount:newRefCount}:u));
    }
    const finalRole = finalRolePreCheck;
    const parentIdx = isParentInvite ? 1 : (finalRole==="parent" ? 0 : undefined);
    if (isChildInvite) {
      const age = parseInt(childAge);
      if (!childAge || isNaN(age) || age < 5 || age > 99) {
        setErr("⚠️ Veuillez saisir un âge valide (5 à 99 ans).");
        return;
      }
      if (age < RGPD_CONSENT_AGE && !parentConsent) {
        setErr("⚠️ Le consentement parental est obligatoire pour les enfants de moins de 15 ans (RGPD).");
        return;
      }
    }
    const childAgeNum = isChildInvite ? parseInt(childAge) : undefined;
    const newUser = {id:newId,email:cleanEmail,name:cleanName,role:finalRole,parentIdx,
      gender: finalRole==="parent" ? (parentGender||"M") : undefined,
      phone:  finalRole==="parent" ? (parentPhone.trim()||"") : (regPhoneId||undefined),
      refCode:newRefCode,refUsed,refCount:0,validatedRefCount:0,refMonths:0,trialExtension:0,pendingSpins:0,monthlyRefMonth:null,monthlyRefCount:0,accountCreatedAt:new Date().toISOString(),startsAsPremiumTrial:!!refUsed,
      ...(isObsInvite  ? {obsStatus:"pending",obsFamilyCode:obsInviteCode.family,obsInviteCode:obsInviteCode.code} : {}),
      ...(isChildInvite ? {
        childAge: childAgeNum,
        childMessagingAllowed: true,
        obsFamilyCode: obsInviteCode.family,
        obsInviteCode: obsInviteCode.code,
        childParentConsentGiven: childAgeNum < RGPD_CONSENT_AGE ? true : undefined,
      } : {}),
    };
    setUsers(u=>[...u,newUser]);

    // ☁️ Créer le compte Supabase Auth pour TOUS les rôles (parent, observer, child)
    // Supabase Auth est la source de vérité — sans compte là-bas, on ne peut plus se connecter.
    // Exception : l'admin est local uniquement.
    if(finalRole !== "admin"){
      const linkRes = await familySync.linkAccount(cleanEmail, pw, {role:finalRole, parentIdx, name:cleanName, phone:regPhoneId||undefined});
      if(!linkRes.ok){
        if(linkRes.error === "already_registered"){
          // Email déjà dans Supabase → on annule la création locale et on bloque
          setUsers(us => us.filter(u => u.email !== cleanEmail));
          if(isAnyInvite){ setShowExistingAccount(true); setErr(""); return; }
          setErr(usingPhoneId ? "Ce numéro de téléphone est déjà utilisé." : t.emailUsed); return;
        }
        console.warn("[Duvia] Cloud account link failed:", linkRes.error);
      }
    }
    let parentInviteWaiting = false;
    if(finalRole==="parent"){
      if(isParentInvite && obsInviteCode.newStyle){
        // 🔗 Nouveau format : rejoindre en "pending" via le token — écran d'attente.
        const joinRes = await familySync.joinFamilyByToken(obsInviteCode.code, { name: cleanName, gender: parentGender||"M" });
        if(joinRes.ok){
          try{ window.localStorage.setItem("duvia_family_id", joinRes.familyId); }catch{}
          parentInviteWaiting = true;
        } else {
          setErr(
            joinRes.error==="expired" ? t.invErrExpired :
            joinRes.error==="used"    ? t.invErrUsed :
            t.invErrInvalid
          );
        }
      } else if(isParentInvite && obsInviteCode.family){

        // 🔗 Maintenant que le compte Auth existe, rejoindre la famille via le lien d'invitation
        const joinRes = await familySync.joinFamily(obsInviteCode.family);
        if(joinRes.ok){
          // ✅ Délai 100ms pour laisser le useEffect remettre skipNextSave à false
          // après le setCfg(famRow.data) dans joinFamily — sinon cette MAJ n'est pas
          // envoyée à Supabase et le Parent 1 ne voit pas que le Parent 2 a rejoint.
          await new Promise(r => setTimeout(r, 100));
          setCfg(c=>{
            const p=[...(c.parents||[])];
            while(p.length<2) p.push({});
            p[1] = {...p[1], name:cleanName, email:cleanEmail,
              gender:parentGender||p[1]?.gender||"M",
              phone:parentPhone.trim()||p[1]?.phone||"",
              inviteStatus:"accepted"};
            return {...c, parents:p};
          });
        } else {
          console.warn("[Duvia] Auto-join family failed:", joinRes.error);
        }
      }
    }

    if(parentInviteWaiting){
      setMode("obs_waiting"); setErr("");
    } else if(isParentInvite && obsInviteCode.newStyle){
      // ⚠️ Le rejoin par token a échoué — le message d'erreur est déjà affiché
      // plus haut (lien expiré/déjà utilisé/invalide). On ne touche à rien ici.
    } else if(isObsInvite){
      onObsJoin({id:newId,name:cleanName,email:cleanEmail,phone:regPhoneId||undefined,role:obsInviteCode.role||"observer",obsRole:parentGender||"grandparent",status:"pending",inviteCode:obsInviteCode.code});
      setMode("obs_waiting"); setErr("");
    } else if(isChildInvite){
      onObsJoin({id:newId,name:cleanName,email:cleanEmail,phone:regPhoneId||undefined,role:"child",status:"active",inviteCode:obsInviteCode.code,childAge:childAgeNum,childMessagingAllowed:true});
      setOk(`✅ Compte créé ! Bienvenue ${cleanName}.`);
      setMode("login"); setErr("");
    } else {
      // ✅ Inscription classique (sans invitation) → connexion directe, sans re-saisie.
      setErr(""); setOk("");
      onLogin(newUser);
    }
  }
  async function doForgot(){
    const id = email.trim();
    if(!id){setErr(t.allRequired);return;}
    if(isLikelyPhoneIdentifier(id)){ setErr("La réinitialisation du mot de passe par téléphone n'est pas disponible. Contactez le parent qui vous a invité."); return; }
    if(!isValidEmail(id)){ setErr("Adresse email invalide."); return; }
    setErr(""); setOk(t.syncConnecting||"Envoi…");
    // Vrai email de réinitialisation Supabase. On NE révèle PAS si le compte
    // existe (anti-énumération) : on affiche toujours le même message neutre,
    // que l'adresse soit connue ou non. La liste locale `users` n'est pas
    // consultée — elle est vide sur un nouvel appareil et n'est pas la source
    // de vérité (Supabase Auth l'est).
    try{
      await supabase.auth.resetPasswordForEmail(id.toLowerCase(), {
        redirectTo: `${APP_URL}/?reset=1`,
      });
    }catch(e){
      console.warn("[Duvia] resetPasswordForEmail:", e);
    }
    setOk(t.resetSent); setErr("");
  }

  async function doLoginAndJoin(){
    const cleanEmail = identifierToAuthEmail(email);

    // 🔧 Supabase Auth fait foi — pas seulement la liste locale de cet appareil,
    // qui est vide si l'invité ouvre le lien pour la première fois sur son
    // propre téléphone (le cas le plus fréquent en réalité).
    const { data, error: signErr } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(signErr){ setErr(t.wrongPw); return; }
    const meta = data.user?.user_metadata || {};
    const existing = users.find(u2 => u2.email===cleanEmail);
    const u = existing || {
      id: Date.now(), email: cleanEmail,
      name: meta.name || cleanEmail.split("@")[0],
      role: meta.role || "parent",
      parentIdx: meta.parentIdx ?? (isParentInvite ? 1 : 0),
      accountCreatedAt: new Date().toISOString(),
    };

    // Rattacher le compte existant à la famille via le lien d'invitation
    const childAgeNum = isChildInvite ? parseInt(childAge) : undefined;
    const updatedUser = {
      ...u,
      ...(isParentInvite ? {
        obsFamilyCode: obsInviteCode.family,
        obsInviteCode: obsInviteCode.code,
      } : {}),
      ...(isObsInvite ? {
        obsStatus: "pending",
        obsFamilyCode: obsInviteCode.family,
        obsInviteCode: obsInviteCode.code,
      } : {}),
      ...(isChildInvite ? {
        childAge: childAgeNum,
        childMessagingAllowed: true,
        obsFamilyCode: obsInviteCode.family,
        obsInviteCode: obsInviteCode.code,
        childParentConsentGiven: childAgeNum < RGPD_CONSENT_AGE ? true : undefined,
      } : {}),
    };
    if (existing) setUsers(us => us.map(u2 => u2.id===u.id ? updatedUser : u2));
    else setUsers(us => [...us, updatedUser]);

    if(isObsInvite){
      onObsJoin({...updatedUser, role:obsInviteCode.role||"grandparent", status:"pending", inviteCode:obsInviteCode.code});
      setMode("obs_waiting"); setErr("");
    } else if(isChildInvite){
      onObsJoin({...updatedUser, role:"child", status:"active", inviteCode:obsInviteCode.code, childAge:childAgeNum, childMessagingAllowed:true});
      setShowExistingAccount(false); setErr("");
      onLogin(updatedUser);
    } else if(isParentInvite){
      if(obsInviteCode.newStyle){
        // 🔗 Nouveau format : on rejoint la famille du lien (pending), écran
        // d'attente. Pas de court-circuit « j'ai déjà une famille active » : le
        // lien cible la famille de l'inviteur, pas une autre.
        const joinRes = await familySync.joinFamilyByToken(obsInviteCode.code, { name: u.name||updatedUser.name, gender: u.gender||meta.gender||"M" });
        if(joinRes.ok){
          // 🔧 Famille rejointe via le lien → on la note comme famille par
          // défaut. Sinon, avec une famille vierge laissée par un départ
          // précédent, l'app pouvait basculer sur la mauvaise après validation.
          try{ window.localStorage.setItem("duvia_family_id", joinRes.familyId); }catch{}
          setShowExistingAccount(false); setErr("");
          setMode("obs_waiting");
        } else {
          setErr(
            joinRes.error==="expired" ? t.invErrExpired :
            joinRes.error==="used"    ? t.invErrUsed :
            t.invErrInvalid
          );
        }
        return;
      }
      // Compte Parent 2 existant, ancien format → déjà connecté ci-dessus → rejoindre la famille
      const joinRes = await familySync.joinFamily(obsInviteCode.family);
      if(joinRes.ok){
        await new Promise(r => setTimeout(r, 100));
        setCfg(c=>{
          const p=[...(c.parents||[])];
          while(p.length<2) p.push({});
          p[1]={...p[1], name:updatedUser.name, email:cleanEmail, inviteStatus:"accepted"};
          return {...c, parents:p};
        });
      } else {
        console.warn("[Duvia] join (existing) failed:", joinRes.error);
      }
      setShowExistingAccount(false); setErr("");
      onLogin(updatedUser);
    }
  }
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C._brand?`linear-gradient(rgba(255,255,255,.6),rgba(255,255,255,.6)),linear-gradient(145deg,#7BA8F5 0%,#9D8FF0 26%,#F8F2FF 52%,#FF9FD2 76%,#FF6BB5 100%)`:`linear-gradient(rgba(255,255,255,.6),rgba(255,255,255,.6)),radial-gradient(ellipse at 30% 20%,rgba(124,111,205,.15) 0%,transparent 60%),${C.bg}`}}>
      <div style={{width:"100%",maxWidth:400}} className="fi">
        <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",alignItems:"center",gap:8,marginBottom:16}}>
          <div />{/* spacer pour centrer le logo */}
          <div style={{position:"relative"}}>
            <button onClick={()=>setShowLangMenu(v=>!v)} style={{height:36,padding:"0 12px",background:showLangMenu?`${C.vio}18`:C.card,border:`1.5px solid ${showLangMenu?C.vio:C.bor}`,color:showLangMenu?C.vio:C.txt,fontSize:13,fontWeight:700,borderRadius:8,display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
              <span>{foundLang.flag}</span>
              <span style={{fontSize:12}}>{foundLang.name}</span>
              <span style={{fontSize:9,opacity:.6}}>{showLangMenu?"▲":"▼"}</span>
            </button>
            {showLangMenu && (
              <div style={{position:"fixed",top:"auto",right:"auto",background:C.card,border:`1.5px solid ${C.bor}`,borderRadius:16,minWidth:180,zIndex:300,boxShadow:"0 12px 40px rgba(0,0,0,.2)",overflow:"hidden",marginTop:4}}>
                <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.bor}`,fontSize:9,fontWeight:800,color:C.mut,letterSpacing:".1em",textTransform:"uppercase"}}>
                  {t.langLabel||"🌐 Langue"}
                </div>
                {Object.entries(LANGS).map(([k,v])=>(
                  <button key={k} onClick={()=>{setLang(k);setShowLangMenu(false);}} style={{width:"100%",padding:"0 14px",height:44,background:lang===k?`${C.vio}12`:"transparent",color:lang===k?C.vio:C.txt,textAlign:"left",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:lang===k?800:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:20,flexShrink:0}}>{v.flag}</span>
                    <span style={{flex:1}}>{v.name}</span>
                    {lang===k && <span style={{color:C.vio,fontSize:14,fontWeight:900}}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={cycleTheme} title={themeMode==="palette"?"→ Clair":themeMode==="clair"?"→ Sombre":"→ Palette"} style={{height:36,padding:"0 12px",background:themeMode==="palette"?`${C.vio}18`:C.card,border:`1.5px solid ${themeMode==="palette"?C.vio:C.bor}`,color:themeMode==="palette"?C.vio:C.txt,fontSize:13,fontWeight:700,borderRadius:8}}>
            {themeMode==="sombre"?"🌙":themeMode==="clair"?"☀️":"🎨"}
          </button>
        </div>
        <div style={{textAlign:"center",marginBottom:22}}>
          <div style={{width:160,height:160,margin:"0 auto 2px",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <img src="/logo.png" alt="Duvia" style={{width:"100%",height:"100%",objectFit:"contain"}} />
          </div>
          <div style={{fontSize:13,color:C.mut,fontStyle:"italic"}}>{t.appSub}</div>
        </div>
        <div className="card" style={C._brand?{background:`linear-gradient(rgba(255,255,255,.5),rgba(255,255,255,.5)),linear-gradient(145deg,#7BA8F5 0%,#9D8FF0 26%,#F8F2FF 52%,#FF9FD2 76%,#FF6BB5 100%)`}:undefined}>
          {isExpiredInvite && (
            <div style={{background:`${C.red}12`,border:`1.5px solid ${C.red}44`,borderRadius:10,padding:"12px 14px",marginBottom:14,fontSize:13,color:C.red,fontWeight:700,textAlign:"center"}}>
              ⏰ {t.invErrExpiredWait}
            </div>
          )}
          {isAnyInvite && !isExpiredInvite && (
            <div style={{background:`${C.vio}10`,border:`1.5px solid ${C.vio}33`,borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.vio,fontWeight:700,textAlign:"center"}}>
              👨‍👩‍👧 {"Vous avez été invité(e) à rejoindre la famille sur Duvia"}
            </div>
          )}
          <div style={{display:"flex",gap:4,marginBottom:18,background:C.sur,borderRadius:11,padding:4}}>
            {[["login",t.login||"Connexion"],["register",t.register||"Créer un compte"]].map(([m,l])=>(
              <button key={m} onClick={()=>{setMode(m);setErr("");setOk("");}} style={{flex:1,height:38,background:mode===m?C.card:"transparent",color:mode===m?C.vio:C.mut,borderRadius:8,fontSize:13,fontWeight:mode===m?800:700,boxShadow:mode===m?"0 1px 4px rgba(0,0,0,.1)":"none",transition:"all .15s"}}>{l}</button>
            ))}
          </div>
          {err&&<div style={{background:`${C.red}12`,border:`1.5px solid ${C.red}44`,borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.red,fontWeight:700}}>{err}</div>}
          {ok&&<div style={{background:`${C.grn}12`,border:`1.5px solid ${C.grn}44`,borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.grn,fontWeight:700}}>{ok}</div>}
          {mode==="register" && (
            <div>
              {/* Compte existant détecté lors d'une invitation */}
              {showExistingAccount && (
                <div style={{background:`${C.yel}12`,border:`1.5px solid ${C.yel}55`,borderRadius:12,padding:"14px 16px",marginBottom:16}}>
                  <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:6}}>
                    {t.regExistingAccount||"👤 Un compte existe déjà avec cet email"}
                  </div>
                  <div style={{fontSize:12,color:C.mut,marginBottom:12,lineHeight:1.5}}>
                    {t.regExistingAccountDesc||"Tu peux te connecter avec ton mot de passe existant pour rejoindre la famille, ou utiliser un autre email."}
                  </div>
                  <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:5}}>{t.regPasswordLabel||"MOT DE PASSE"}</div>
                  <div style={{position:"relative",marginBottom:12}}>
                    <input
                      type={showPw?"text":"password"}
                      value={pw}
                      onChange={e=>setPw(e.target.value)}
                      onKeyDown={e=>e.key==="Enter"&&doLoginAndJoin()}
                      placeholder={t.regPasswordPlaceholder||"Ton mot de passe"}
                      autoFocus
                      style={{width:"100%",height:44,boxSizing:"border-box",fontSize:14,paddingRight:42}}
                    />
                    <button type="button" onClick={()=>setShowPw(v=>!v)} aria-label={showPw?"Masquer":"Afficher"} style={{position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",width:32,height:32,background:"transparent",border:"none",color:C.mut,fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>{showPw?"🙈":"👁️"}</button>
                  </div>
                  {err && <div style={{fontSize:12,color:C.red,marginBottom:10}}>{err}</div>}
                  <button onClick={doLoginAndJoin} style={{
                    width:"100%",height:44,background:`linear-gradient(135deg,${C.vio},${C.blu})`,
                    color:"#fff",fontSize:14,fontWeight:800,borderRadius:10,marginBottom:8,cursor:"pointer"
                  }}>
                    {t.regLoginJoin||"✅ Se connecter et rejoindre la famille"}
                  </button>
                  <button onClick={()=>{setShowExistingAccount(false);setEmail("");setPw("");setErr("");}} style={{
                    width:"100%",height:38,background:"transparent",color:C.mut,
                    border:`1px solid ${C.bor}`,fontSize:13,borderRadius:10,cursor:"pointer"
                  }}>
                    {t.regUseOtherEmail||"Utiliser un autre email"}
                  </button>
                </div>
              )}
              {!showExistingAccount && isChildInvite && <div style={{background:`${C.grn}12`,border:`1.5px solid ${C.grn}44`,borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.grn,fontWeight:700,textAlign:"center"}}>{t.regChildInviteMsg||"🧒 Rejoindre la famille en tant qu'enfant"}</div>}
              {!showExistingAccount && isObsInvite && <div style={{background:`${C.blu}12`,border:`1.5px solid ${C.blu}44`,borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.blu,fontWeight:700,textAlign:"center"}}>👀 {t.obsJoinInfo||"Vous avez été invité(e) à rejoindre Duvia en tant qu'observateur."}</div>}
              {!showExistingAccount && <><div className="field"><label className="lbl">{t.fullName}</label><input value={name} onChange={e=>setName(e.target.value)} className={shakeName?"duvia-shake":""} /></div>
              {!isAnyInvite&&<div className="field"><label className="lbl">{t.roleLabel||"Rôle"}</label><select value={role} onChange={e=>setRole(e.target.value)}><option value="parent">{t.roleParent}</option><option value="observer">{t.roleObs}</option></select></div>}

              {/* Vous êtes — pour les observateurs invités */}
              {isObsInvite && (
                <div className="field">
                  <label className="lbl">{"👤 Vous êtes"}</label>
                  <select value={role==="observer"?parentGender||"grandparent":parentGender} onChange={e=>setParentGender(e.target.value)} style={{width:"100%"}}>
                    <option value="grandparent">{t.grandparent||"Grands-parents"}</option>
                    <option value="uncle-aunt">{t.uncleAunt||"Oncle / Tante"}</option>
                    <option value="sibling">{t.sibling||"Frère / Sœur"}</option>
                    <option value="childcare">{t.childcareRole||"Assistante maternelle / Nourrice"}</option>
                    <option value="other">{t.otherFamily||"Autre proche"}</option>
                  </select>
                </div>
              )}

              {/* Père / Mère / Autre — pour les parents uniquement */}
              {(role==="parent"||isParentInvite) && (
                <div className="field">
                  <label className="lbl">{t.regYouAre||"Vous êtes"}</label>
                  <div style={{display:"flex",gap:8}}>
                    {[{v:"M",l:t.regGenderFather||"👨 Père"},{v:"F",l:t.regGenderMother||"👩 Mère"},{v:"O",l:t.regGenderOther||"🧑 Autre"}].map(({v,l})=>(
                      <button key={v} type="button" onClick={()=>setParentGender(v)} style={{
                        flex:1,padding:"8px 0",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer",
                        background:parentGender===v?C.vio:C.sur,
                        color:parentGender===v?"#fff":C.mut,
                        border:`1.5px solid ${parentGender===v?C.vio:C.bor}`,
                        transition:"all .15s",
                      }}>{l}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Téléphone — pour les parents */}
              {(role==="parent"||isParentInvite) && (
                <div className="field">
                  <label className="lbl">{t.regPhone||"📞 Téléphone"} <span style={{color:C.mut,fontWeight:400}}>{t.regOptional||"(optionnel)"}</span></label>
                  <input type="tel" value={parentPhone} onChange={e=>setParentPhone(e.target.value)} placeholder={t.regPhonePlaceholder||"06 12 34 56 78"} />
                </div>
              )}
              </>}

              {/* Champ âge — uniquement pour invitation enfant */}
              {isChildInvite && (
                <div className="field">
                  <label className="lbl">{t.regAge||"🎂 Âge"} <span style={{color:C.red}}>*</span></label>
                  <input
                    type="number" min="5" max="99"
                    value={childAge}
                    onChange={e=>setChildAge(e.target.value)}
                    placeholder={t.regAgePlaceholder||"ex : 14"}
                    style={{width:"100px"}}
                  />
                </div>
              )}

              {/* Consentement parental — moins de 15 ans */}
              {isChildInvite && parseInt(childAge) > 0 && parseInt(childAge) < RGPD_CONSENT_AGE && (
                <div style={{
                  background:`${C.ora}10`,border:`1.5px solid ${C.ora}44`,
                  borderRadius:10,padding:"12px 14px",marginBottom:12
                }}>
                  <label style={{display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer"}}>
                    <input
                      type="checkbox"
                      checked={parentConsent}
                      onChange={e=>setParentConsent(e.target.checked)}
                      style={{marginTop:3,flexShrink:0,width:16,height:16,cursor:"pointer"}}
                    />
                    <span style={{fontSize:12,color:C.txt,lineHeight:1.6}}>
                      {t.regConsentText||"En tant que parent ou tuteur légal, je consens au traitement des données personnelles de cet enfant de moins de 15 ans sur Duvia, conformément au RGPD (Art. 8) et à la loi française."}{" "}
                      <span style={{color:C.mut}}>
                        {t.regConsentNote||"Duvia ne saurait être tenu responsable de l'utilisation de l'application par des mineurs ni des échanges effectués via la messagerie."}
                      </span>
                    </span>
                  </label>
                  <div style={{marginTop:8,fontSize:11,color:C.mut,display:"flex",alignItems:"center",gap:6}}>
                    <span style={{color:C.ora}}>ℹ️</span>
                    {t.regMessagingWithConsent}
                  </div>
                </div>
              )}

              {/* Info messagerie — 15 ans et plus (accès libre) */}
              {isChildInvite && parseInt(childAge) >= RGPD_CONSENT_AGE && (
                <div style={{background:`${C.grn}10`,border:`1px solid ${C.grn}33`,borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:12,color:C.grn}}>
                  ✅ {parseInt(childAge)} {t.regAgeFreeAccess}
                </div>
              )}

              {/* Champ « Code parrain » retiré : le parrainage se fait via le menu Premium (invitation). */}
            </div>
          )}
          {(() => {
            const allowPhoneId = mode!=="register" || isObsInvite || isChildInvite || (!isAnyInvite && role!=="parent");
            const lockedEmail = isParentInvite && !!obsInviteCode?.email;
            return (
              <div className="field">
                <label className="lbl">{allowPhoneId ? (t.emailOrPhone||"Email ou téléphone") : t.email}</label>
                <input
                  type={allowPhoneId ? "text" : "email"}
                  value={email}
                  onChange={e=>setEmail(e.target.value)}
                  placeholder={allowPhoneId ? (t.emailOrPhonePlaceholder||"email@exemple.fr ou 06 12 34 56 78") : undefined}
                  readOnly={lockedEmail}
                  style={lockedEmail ? {background:C.sur,color:C.mut,cursor:"default"} : undefined}
                />
                {allowPhoneId && mode==="register" && <div style={{fontSize:11,color:C.mut,marginTop:4}}>{t.emailOrPhoneHint||"💡 Pas d'email ? Utilisez un numéro de téléphone."}</div>}
              </div>
            );
          })()}
          {mode!=="forgot"&&<div className="field"><label className="lbl">{t.password}</label>
            <div style={{position:"relative"}}>
              <input type={showPw?"text":"password"} value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&mode==="login"&&doLogin()} style={{width:"100%",boxSizing:"border-box",paddingRight:42}} />
              <button type="button" onClick={()=>setShowPw(v=>!v)} aria-label={showPw?"Masquer":"Afficher"} style={{position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",width:32,height:32,background:"transparent",border:"none",color:C.mut,fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>{showPw?"🙈":"👁️"}</button>
            </div>
          </div>}
          {mode==="register"&&<div className="field"><label className="lbl">{t.confirmPw}</label>
            <div style={{position:"relative"}}>
              <input type={showPw?"text":"password"} value={pwConfirm} onChange={e=>setPwConfirm(e.target.value)} placeholder={t.confirmPwPlaceholder} style={{width:"100%",boxSizing:"border-box",paddingRight:42,borderColor:pwConfirm&&pwConfirm!==pw?C.red:undefined}} />
              {pwConfirm && <span style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:16}}>{pwConfirm===pw?"✅":"❌"}</span>}
            </div>
          </div>}
          {(mode==="login"||mode==="register")&&(
            <label style={{display:"flex",alignItems:"center",gap:8,margin:"2px 0 12px",cursor:"pointer",fontSize:12.5,color:C.mut}}>
              <input type="checkbox" checked={remember}
                onChange={e=>{ const v=e.target.checked; setRemember(v); try{ if(v){ window.localStorage.setItem("duvia_remember","1"); window.localStorage.setItem("duvia_remember_until", String(Date.now()+24*60*60*1000)); } else { window.localStorage.removeItem("duvia_remember"); window.localStorage.removeItem("duvia_remember_until"); } }catch{} }}
                style={{width:17,height:17,accentColor:C.vio,cursor:"pointer"}} />
              {t.rememberMe||"Rester connecté 24h sur cet appareil"}
            </label>
          )}
          <button onClick={mode==="login"?doLogin:mode==="register"?doReg:doForgot} style={{width:"100%",height:48,background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:15,fontWeight:800,marginBottom:10,borderRadius:12,boxShadow:`0 4px 14px ${C.vio}44`}}>
            {mode==="login"?t.connect:mode==="register"?t.createAcc:t.sendLink}
          </button>
          {mode==="login"&&<button onClick={()=>{setMode("forgot");setErr("");setOk("");}} style={{width:"100%",height:36,background:"transparent",color:C.mut,fontSize:12,textDecoration:"underline"}}>{t.forgotPw}</button>}
          {mode==="forgot"&&<button onClick={()=>setMode("login")} style={{width:"100%",height:36,background:"transparent",color:C.mut,fontSize:12}}>{t.backLogin}</button>}
          {(mode==="login"||mode==="register")&&(
            <button onClick={()=>setShowInstallModal(true)} style={{display:"block",width:"100%",textAlign:"center",marginTop:6,background:"none",border:"none",color:C.mut,fontSize:12,textDecoration:"underline",cursor:"pointer",fontFamily:"inherit"}}>
              {t.installAppMenu}
            </button>
          )}
          {(mode==="login"||mode==="register")&&(
            <a href="https://duvia.fr" style={{display:"block",width:"100%",textAlign:"center",marginTop:6,color:C.mut,fontSize:12,textDecoration:"underline",fontFamily:"inherit"}}>
              {t.backToSite}
            </a>
          )}
          {mode==="obs_waiting"&&(
            <div style={{textAlign:"center",padding:"8px 0 4px"}}>
              <div style={{fontSize:36,marginBottom:8}}>⏳</div>
              <div style={{fontWeight:900,fontSize:16,marginBottom:6}}>{t.obsJoinWaiting||"⏳ En attente d'approbation"}</div>
              <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:14}}>{t.obsJoinWaitingInfo||"Votre demande a été envoyée aux parents."}</div>
              <button onClick={()=>setMode("login")} style={{height:40,padding:"0 20px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13}}>← {t.backLogin}</button>
            </div>
          )}
        </div>
      </div>
      {showInstallModal && <InstallAppModal C={C} t={t} onClose={()=>setShowInstallModal(false)} />}
    </div>
  );
}

// ─── BELL PANEL ───────────────────────────────────────────────────────────────
function BellPanel({onClose}) {
  const {C,t,cfg,setCfg} = useApp();
  const notifs=cfg.notifs||[];
  function markAll(){setCfg(c=>({...c,notifs:c.notifs.map(n=>({...n,read:true}))}));}
  return (
    <div style={{position:"relative",zIndex:200}}>
      <div style={{position:"fixed",inset:0,zIndex:199}} onClick={onClose} />
      <div className="fi" style={{position:"absolute",right:12,top:0,width:300,maxHeight:360,background:C.card,border:`1.5px solid ${C.bor}`,borderRadius:14,zIndex:200,overflow:"hidden",boxShadow:"0 12px 40px rgba(0,0,0,.4)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",borderBottom:`1.5px solid ${C.bor}`}}>
          <span style={{fontWeight:800,fontSize:13}}>🔔 {t.notifsTitle}</span>
          <div style={{display:"flex",gap:6}}>
            <button onClick={markAll} style={{padding:"3px 8px",background:"transparent",color:C.mut,border:`1px solid ${C.bor}`,fontSize:10}}>{t.markRead}</button>
            <button onClick={onClose} style={{padding:"3px 8px",background:"transparent",color:C.mut,fontSize:15}}>×</button>
          </div>
        </div>
        <div style={{overflowY:"auto",maxHeight:300}}>
          {notifs.length===0?<div style={{padding:20,textAlign:"center",color:C.mut,fontSize:13}}>{t.noNotifs}</div>:
            notifs.slice(0,15).map(n=>(
              <div key={n.id} style={{padding:"9px 14px",borderBottom:`1px solid ${C.bor}`,background:n.read?"transparent":`${C.vio}11`,display:"flex",gap:8}}>
                <span style={{fontSize:14,flexShrink:0}}>{n.type==="cal"?"📅":n.type==="exp"?"💰":"👋"}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,color:n.read?C.mut:C.txt}}>{n.msg}</div>
                  <div style={{fontSize:10,color:C.mut,marginTop:2,fontFamily:"JetBrains Mono"}}>{new Date(n.date).toLocaleString([],{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</div>
                </div>
                {!n.read&&<div style={{width:6,height:6,borderRadius:"50%",background:C.vio,flexShrink:0,marginTop:4}} />}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function NotifTab({prem: premProp}) {
  const {C,t,cfg,setCfg,prem: ctxPrem,onUpgrade,setActivity,user,setTab,setMenuTab,isObs,isChild} = useApp();
  const prem = premProp !== undefined ? premProp : ctxPrem;
  const notifs=cfg.notifs||[];
  function markAll(){setCfg(c=>({...c,notifs:c.notifs.map(n=>({...n,read:true}))}));}

  // Map notif type → tab index (parent layout: 0=Cal, 1=Schedule, 2=Exp, 3=Contacts, 4=Vault, 5=Msg)
  function getTabIndex(type) {
    if(isObs||isChild) {
      // Observer: 0=Cal, 1=Contacts, 2=Msg / Child: 0=Cal, 1=Schedule, 2=Contacts, 3=Msg
      if(type==="cal") return 0;
      if(type==="schedule") return isChild ? 1 : null;
      if(type==="msg") return isChild ? 3 : 2;
      return null;
    }
    if(type==="cal") return 0;
    if(type==="schedule") return 1;
    if(type==="exp") return 2;
    if(type==="msg") return 5;
    return null;
  }

  function handleNotifClick(n) {
    // mark as read
    setCfg(c=>({...c,notifs:c.notifs.map(x=>x.id===n.id?{...x,read:true}:x)}));
    const idx = getTabIndex(n.type);
    if(idx !== null) {
      setMenuTab(null);
      setTab(idx);
    }
  }

  if(!prem) return (
    <div style={{textAlign:"center",padding:"48px 20px"}}>
      <div style={{fontSize:40,marginBottom:12}}>🔔</div>
      <div style={{fontWeight:900,fontSize:17,marginBottom:8,color:C.txt}}>{t.tabNotifs}</div>
      <div style={{fontWeight:700,fontSize:14,color:C.ora,marginBottom:8}}>🔒 {t.lockSection}</div>
      <div style={{fontSize:13,color:C.mut,marginBottom:20,lineHeight:1.6}}>{t.lockDesc}</div>
      <button onClick={onUpgrade} style={{height:44,padding:"0 26px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",borderRadius:12,fontSize:15,fontWeight:800}}>{t.upgradeCTA}</button>
    </div>
  );
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div className="sec" style={{margin:0}}>{t.notifsTitle} ({notifs.filter(n=>!n.read).length} {t.unread})</div>
        <button onClick={markAll} style={{height:36,padding:"0 14px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>{t.markRead}</button>
      </div>
      {notifs.length===0?<div style={{textAlign:"center",padding:60,color:C.mut}}><div style={{fontSize:48,marginBottom:12}}>🔔</div>{t.noNotifs}</div>:
        notifs.map(n=>{
          const idx = getTabIndex(n.type);
          const isClickable = idx !== null;
          return (
            <div key={n.id} onClick={()=>handleNotifClick(n)}
              className="card"
              style={{marginBottom:10,border:`1.5px solid ${n.read?C.bor:C.vio}`,display:"flex",gap:12,cursor:isClickable?"pointer":"default",transition:"opacity .15s"}}
            >
              <span style={{fontSize:18,flexShrink:0}}>{n.type==="cal"?"📅":n.type==="schedule"?"🏫":n.type==="exp"?"💰":n.type==="msg"?"💬":n.type==="obs"?"👥":"👋"}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:14,color:n.read?C.mut:C.txt,fontWeight:n.read?400:700}}>{n.msg}</div>
                <div style={{fontSize:11,color:C.mut,marginTop:4,fontFamily:"JetBrains Mono"}}>{new Date(n.date).toLocaleString()}</div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>
                {!n.read&&<span className="badge" style={{background:`${C.vio}22`,color:C.vio}}>{t.newBadge}</span>}
                {isClickable&&<span style={{fontSize:10,color:C.mut}}>→</span>}
              </div>
            </div>
          );
        })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG TAB
// ═══════════════════════════════════════════════════════════════════════════════

// ─── AVATARS ──────────────────────────────────────────────────────────────────
const PARENT_AVATARS = ["👩","👨","👩‍🦱","👨‍🦱","👩‍🦰","👨‍🦰","👩‍🦳","👨‍🦳","👩‍🦲","👨‍🦲","🧔","👱‍♀️","👱","🧑","👮‍♀️","👮","👩‍⚕️","👨‍⚕️","👩‍🏫","👨‍🏫","🧕","🧑‍🦱","🧑‍🦰","🧑‍🦳"];
const CHILD_AVATARS  = ["🧒","👧","👦","🧒‍♀️","🧒‍♂️","👧‍🦱","👦‍🦱","👧‍🦰","👦‍🦰","👧‍🦳","👦‍🦳","🧑‍🎨","🧑‍🎤","🧑‍🚀","🧑‍💻","👼","🧸","🦄","🐣","⭐"];
const OBS_AVATARS    = ["👴","👵","🧓","👩‍👦","👨‍👦","👩‍👧","👨‍👧","🧑‍🤝‍🧑","👫","👬","👭","🤶","🎅","🧙‍♀️","🧙","🧝‍♀️","🦸‍♀️","🦸","🤴","👸"];

function Avatar({emoji, color, size=40, onClick, selected=false}) {
  return (
    <div onClick={onClick} style={{
      width:size, height:size, borderRadius:"50%",
      background:color?`${color}22`:"#f0f1f6",
      border:`2.5px solid ${selected?color||"#7c6fcd":"transparent"}`,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:size*0.5, cursor:onClick?"pointer":"default",
      boxShadow:selected?`0 0 0 3px ${color||"#7c6fcd"}44`:"none",
      transition:"all .15s", flexShrink:0,
      userSelect:"none",
    }}>{emoji}</div>
  );
}

function AvatarPicker({current, onSelect, pool, color}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{position:"relative",zIndex:open?500:1}}>
      <Avatar emoji={current||pool[0]} color={color} size={44} onClick={()=>setOpen(o=>!o)} selected={!!current} />
      {open && (
        <>
          <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:498}} />
          <div style={{position:"absolute",top:50,left:0,zIndex:499,background:"white",border:"1.5px solid #e5e7eb",borderRadius:14,padding:8,boxShadow:"0 8px 24px rgba(0,0,0,.25)",display:"grid",gridTemplateColumns:"repeat(5,44px)",gap:4,width:"auto"}}>
            {pool.map((em,i)=>(
              <div key={i} onClick={()=>{onSelect(em);setOpen(false);}} style={{
                width:40,height:40,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:24,cursor:"pointer",background:current===em?`${color||"#7c6fcd"}22`:"transparent",
                border:`1.5px solid ${current===em?color||"#7c6fcd":"transparent"}`,
                transition:"all .1s",flexShrink:0,
              }}>{em}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── STEP LANGUE ──────────────────────────────────────────────────────────────
function StepLang({lang,setLang}) {
  const {C,t} = useApp();
  return (
    <div>
      <div className="sec" style={{marginBottom:14}}>{t.langAppTitle}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {Object.entries(LANGS).map(([k,v])=>(
          <button key={k} onClick={()=>setLang(k)} style={{
            padding:"14px 12px",
            background:lang===k?`${C.vio}18`:C.sur,
            border:`2px solid ${lang===k?C.vio:C.bor}`,
            borderRadius:12,
            display:"flex",alignItems:"center",justifyContent:"center",gap:8,
            cursor:"pointer",transition:"all .15s"
          }}>
            <span style={{fontSize:15,fontWeight:700,color:lang===k?C.vio:C.txt}}>{v.name}</span>
            {lang===k&&<span style={{color:C.vio,fontSize:16,fontWeight:900}}>✓</span>}
          </button>
        ))}
      </div>
      <div style={{marginTop:16,padding:"12px 14px",background:`${C.vio}08`,borderRadius:12,border:`1px solid ${C.vio}22`,fontSize:12,color:C.mut,lineHeight:1.5}}>
        {t.langAppDesc}
      </div>
    </div>
  );
}

function ConfigTab() {
  const {C,t,cfg,setCfg,addHist,pushNotif,prem,perms,onUpgrade,apiData,apiLoading,sub,setSub,lang,setLang,msgs,setMsgs,setUsers,user,familySync,configStep:step,setConfigStep:setStep} = useApp();
  const STEPS=[{i:"👤",l:t.stepId},{i:"👥",l:t.stepAccess},{i:"🗓️",l:t.stepDates},{i:"📆",l:t.stepGarde},{i:"🌐",l:t.stepLang||"Langue"}];

  // ── Invite modal state ─────────────────────────────────────────────────────
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteErr, setInviteErr] = useState("");
  const [sendingInvite, setSendingInvite] = useState(false);
  const [inviteResult, setInviteResult] = useState(null); // {url,email,phone} une fois le lien généré

  // ── Delete modals state ────────────────────────────────────────────────────
  const [confirmDelIdx, setConfirmDelIdx] = useState(null);  // 1er modal: confirmation
  const [emailSimIdx, setEmailSimIdx]     = useState(null);  // 2e modal: simulation email

  function setParent(i,f,v){setCfg(c=>{const p=[...c.parents];p[i]={...p[i],[f]:v};return{...c,parents:p};});}
  function setChild(i,f,v){setCfg(c=>{const ch=[...c.children];ch[i]={...ch[i],[f]:v};return{...c,children:ch};});}

  function addParent(){
    if(cfg.parents.length >= 2) return; // limite absolue de 2 parents
    setInviteEmail(""); setInvitePhone(""); setInviteErr(""); setInviteResult(null);
    setShowInviteModal(true);
  }

  async function confirmInvite(){
    const em  = inviteEmail.trim();
    const tel = invitePhone.trim();
    if(!em && !tel){ setInviteErr("Saisis au moins un email ou un numéro de téléphone."); return; }
    if(em && !em.includes("@")){ setInviteErr("Email invalide."); return; }
    if(cfg.parents.some(p=>p.inviteEmail && p.inviteEmail===em)){ setInviteErr("Cet email a déjà été invité."); return; }
    if(!familySync?.familyId){ setInviteErr("Famille introuvable, réessaie."); return; }
    setSendingInvite(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      // 🔧 Ré-invitation : supprimer une éventuelle ancienne invitation pour ce
      // même email dans cette famille (sinon conflit d'unicité → « Erreur lors
      // de la génération du lien » quand on réinvite après un départ).
      if (em) {
        try {
          // Récupère l'uid de l'ancien invité (via l'invitation déjà utilisée)
          // pour nettoyer aussi son adhésion résiduelle ('removed'), sinon sa
          // ré-inscription pourrait buter dessus.
          const { data: oldInv } = await supabase.from("family_invitations")
            .select("used_by").eq("family_id", familySync.familyId).eq("email", em)
            .not("used_by", "is", null).maybeSingle();
          if (oldInv?.used_by) {
            await supabase.from("family_members")
              .delete().eq("family_id", familySync.familyId).eq("user_id", oldInv.used_by);
          }
          await supabase.from("family_invitations")
            .delete().eq("family_id", familySync.familyId).eq("email", em);
        } catch (e) { console.warn("[Duvia] confirmInvite: nettoyage ancienne invitation:", e); }
      }
      const { data: inv, error } = await supabase
        .from("family_invitations")
        .insert({
          family_id: familySync.familyId,
          created_by: userData?.user?.id,
          role: "parent",
          email: em || null,
          expires_at: new Date(Date.now() + 24*60*60*1000).toISOString(), // 24h
        })
        .select("token")
        .single();
      if (error || !inv?.token) throw error || new Error("no-token");
      const inviteUrl = `${APP_URL}/?inv=${inv.token}`;
      // 🔧 L'invité va toujours à l'index 1 (jamais 0) — le créateur de la
      // famille reste toujours en position 1 (le haut de la liste).
      setCfg(c=>({...c,parents:[...c.parents,{
        id:Date.now(), name:"", gender:"M", birthDay:"", birthMonth:"",
        color:PCOLS[c.parents.length%PCOLS.length],
        inviteStatus:"pending", inviteEmail:em||null,
        invitePhone: tel||null,
        inviteCode: inv.token, inviteUrl,
      }]}));
      setInviteResult({ url: inviteUrl, email: em||null, phone: tel||null });
    } catch (e) {
      console.error("[Duvia] confirmInvite error:", e);
      setInviteErr("Erreur lors de la génération du lien. Réessaie.");
    } finally {
      setSendingInvite(false);
    }
  }

  // Demander suppression → ouvre la confirmation, puis simulation email
  function removeParent(i){
    const p = cfg.parents[i];
    if(!p) return;
    // Bloqué si parent souscripteur premium
    if(sub?.subscriberParentIdx === i){
      alert("Ce parent est le souscripteur Premium. Il ne peut pas être supprimé."); return;
    }
    setConfirmDelIdx(i);
  }

  // « Quitter la famille » — pour le parent connecté (créateur OU invité).
  async function quitterFamille(){
    if(!window.confirm("Quitter cette famille ?\n\nVous repartirez sur une famille personnelle vierge. Une synthèse de vos données est conservée pour export.")) return;
    const res = await familySync?.leaveFamily?.();
    if(res?.ok){ duviaReload(); }
    else { alert("⚠️ Impossible de quitter la famille.\n\nDétail : "+(res?.error||"inconnu")+"\n\n(Si l'erreur mentionne « leave_family », la migration SQL 0018 n'est pas encore exécutée sur Supabase.)"); }
  }

  // « Retirer l'invité » — réservé au créateur (parents[0]).
  async function retirerInvite(i){
    const p = cfg.parents[i];
    if(!p?.userId){ alert("Cet invité n'a pas encore rejoint — utilisez « Retirer » sur l'invitation."); return; }
    if(!window.confirm(`Retirer ${p.name||"l'invité"} de la famille ?\n\nIl repartira sur une famille personnelle vierge. Vous conservez la famille et son code.`)) return;
    const res = await familySync?.removeFamilyMember?.(p.userId);
    if(res?.ok){
      setCfg(c=>({...c, parents:c.parents.filter((_,j)=>j!==i)}));
    } else {
      alert("⚠️ Impossible de retirer l'invité.\n\nDétail : "+(res?.error||"inconnu")+"\n\n(Si l'erreur mentionne « remove_family_member », la migration SQL 0017 n'est pas encore exécutée sur Supabase.)");
    }
  }

  // Après confirmation → crée la demande + ouvre simulation email
  function requestDeletion(i){
    setCfg(c=>({...c, pendingDeletion:{ parentIdx:i, parentId:c.parents[i]?.id, parentName:c.parents[i]?.name, requestedAt:new Date().toISOString() }}));
    setConfirmDelIdx(null);
    setEmailSimIdx(i);
  }

  // Parent refuse → annuler
  function cancelDeletion(){
    setCfg(c=>({...c, pendingDeletion:null}));
    setEmailSimIdx(null);
  }

  // Parent accepte → exécuter toutes les conséquences
  function executeDeletion(i){
    const parent = cfg.parents[i];
    if(!parent) return;
    const parentName = parent.name || `Parent ${i+1}`;
    const parentEmail = parent.email || parent.inviteEmail || "";

    // 0. 🔧 Retrait RÉEL côté serveur : on détache l'invité de la famille
    //    (son adhésion passe à 'removed'). Sans ça, il restait membre actif et
    //    continuait de voir l'inviteur. Nécessite son identifiant de compte
    //    (userId), enregistré sur le créneau au moment de la validation.
    if(parent.userId){
      familySync?.removeFamilyMember?.(parent.userId).then(res=>{
        if(res && !res.ok) console.warn("[Duvia] removeFamilyMember:", res.error);
      });
    } else {
      console.warn("[Duvia] executeDeletion: pas de userId sur le parent — retrait serveur impossible.");
    }

    // 2. Désactiver le compte utilisateur lié
    if(parentEmail){
      setUsers(us => (us||[]).map(u =>
        u.email === parentEmail ? {...u, disabled:true, familyRemoved:true} : u
      ));
    }

    // 3. Modifier cfg en une seule opération
    setCfg(c => {
      // Planning garde : réinitialiser si ce parent était impliqué
      const impacted = (c.custody?.pattern||[]).some(d => d.parentIdx === i);
      // Dépenses : remise à zéro
      // Contacts : auto-générés depuis cfg.parents → disparaissent automatiquement
      // Historique : conservé
      // Coffre-fort : géré via cfg.deletedParents dans VaultTab
      return {
        ...c,
        parents: c.parents.filter((_,j) => j !== i),
        expenses: [],
        custody: impacted ? {
          ...c.custody,
          pattern: [],
          confirmed: false,
        } : c.custody,
        deletedParents: [...(c.deletedParents||[]), {
          id: parent.id, name: parentName, email: parentEmail,
          deletedAt: new Date().toISOString(),
        }],
        pendingDeletion: null,
      };
    });

    setEmailSimIdx(null);
    pushNotif(`🗑️ ${parentName} a été supprimé de la famille.`);
  }
  function addChild(){if(cfg.children.length>=(perms?.maxChildren??1))return onUpgrade();setCfg(c=>({...c,children:[...c.children,{id:Date.now(),name:"",birthDay:"",birthMonth:""}]}));}
  function removeChild(i){setCfg(c=>{const children=c.children.filter((_,j)=>j!==i);return{...c,children,sameGuardAll:children.length<=1?true:c.sameGuardAll};});}
  return (
    <div>
      {/* ── Modal 1 : Confirmation de suppression ─────────────────────────── */}
      {confirmDelIdx !== null && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:20,padding:28,maxWidth:340,width:"100%",border:`1.5px solid ${C.bor}`}}>
            <div style={{fontSize:32,textAlign:"center",marginBottom:8}}>⚠️</div>
            <div style={{fontSize:15,fontWeight:900,color:C.txt,textAlign:"center",marginBottom:6}}>Supprimer ce parent ?</div>
            <div style={{fontSize:12,color:C.mut,textAlign:"center",marginBottom:6,lineHeight:1.6}}>
              <strong style={{color:C.txt}}>{cfg.parents[confirmDelIdx]?.name||`Parent ${confirmDelIdx+1}`}</strong> recevra un email de confirmation.
            </div>
            <div style={{background:`${C.red}10`,border:`1px solid ${C.red}33`,borderRadius:10,padding:"10px 12px",marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:800,color:C.red,marginBottom:6}}>Conséquences si accepté :</div>
              {["🗓️ Planning de garde remis à zéro si impacté","💰 Dépenses remises à zéro","📞 Supprimé des contacts","💬 Conversations conservées (marqué supprimé)","🗄️ Documents coffre conservés (marqué supprimé)","📋 Historique des modifications conservé"].map((l,i)=>(
                <div key={i} style={{fontSize:11,color:C.mut,marginBottom:3}}>{l}</div>
              ))}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmDelIdx(null)} style={{flex:1,height:44,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13}}>Annuler</button>
              <button onClick={()=>requestDeletion(confirmDelIdx)} style={{flex:2,height:44,background:C.red,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:13}}>
                📨 Envoyer la demande
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal 2 : Simulation email de confirmation ───────────────────────── */}
      {emailSimIdx !== null && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:20,padding:0,maxWidth:360,width:"100%",border:`1.5px solid ${C.bor}`,overflow:"hidden"}}>
            {/* Header email simulé */}
            <div style={{background:C.dark,padding:"14px 18px",display:"flex",gap:10,alignItems:"center"}}>
              <span style={{fontSize:20}}>✉️</span>
              <div>
                <div style={{fontSize:11,fontWeight:800,color:"#94a3b8",marginBottom:1}}>Simulation — Email envoyé à</div>
                <div style={{fontSize:12,color:"#e2e8f0",fontWeight:700}}>{cfg.parents[emailSimIdx]?.email||cfg.parents[emailSimIdx]?.inviteEmail||"parent@exemple.com"}</div>
              </div>
            </div>
            {/* Corps email */}
            <div style={{padding:"18px 20px"}}>
              <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:8}}>Demande de suppression de compte</div>
              <div style={{fontSize:12,color:C.mut,lineHeight:1.7,marginBottom:16}}>
                Bonjour <strong>{cfg.parents[emailSimIdx]?.name||"Parent"}</strong>,<br/>
                Vous avez reçu une demande de suppression de votre accès à la famille sur Duvia.<br/>
                Souhaitez-vous confirmer cette suppression ?
              </div>
              <div style={{background:`${C.yel}15`,border:`1px solid ${C.yel}44`,borderRadius:8,padding:"8px 12px",marginBottom:16,fontSize:11,color:C.txt}}>
                🎭 <strong>Mode prototype</strong> — Choisissez la réponse du parent 2
              </div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={cancelDeletion} style={{flex:1,height:44,background:`${C.grn}18`,color:C.grn,border:`1.5px solid ${C.grn}44`,borderRadius:12,fontWeight:800,fontSize:12}}>
                  ✋ Refuser
                </button>
                <button onClick={()=>executeDeletion(emailSimIdx)} style={{flex:1,height:44,background:C.red,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:12}}>
                  ✅ Accepter
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal invitation parent 2 ──────────────────────────────────────── */}
      {showInviteModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:20,padding:28,maxWidth:340,width:"100%",border:`1.5px solid ${C.bor}`}}>
            {!inviteResult ? (
              <>
                <div style={{fontSize:28,textAlign:"center",marginBottom:6}}>👋</div>
                <div style={{fontSize:16,fontWeight:900,color:C.txt,textAlign:"center",marginBottom:4}}>{t.inviteOtherParent}</div>
                <div style={{fontSize:12,color:C.mut,textAlign:"center",marginBottom:20,lineHeight:1.5}}>
                  {t.inviteFillField}<br/>{t.inviteLink24h}
                </div>

                <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:5,textTransform:"uppercase",letterSpacing:".06em"}}>
                  ✉️ Email
                </div>
                <input
                  value={inviteEmail}
                  onChange={e=>{setInviteEmail(e.target.value);setInviteErr("");}}
                  onKeyDown={e=>e.key==="Enter"&&confirmInvite()}
                  placeholder="jean.dupont@email.com"
                  type="email"
                  autoFocus
                  style={{width:"100%",height:44,boxSizing:"border-box",fontSize:14,marginBottom:14,borderColor:inviteErr?C.red:undefined}}
                />

                <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:5,textTransform:"uppercase",letterSpacing:".06em"}}>
                  📞 Téléphone
                </div>
                <input
                  value={invitePhone}
                  onChange={e=>setInvitePhone(e.target.value)}
                  placeholder="06 12 34 56 78"
                  type="tel"
                  style={{width:"100%",height:44,boxSizing:"border-box",fontSize:14,marginBottom:inviteErr?6:18}}
                />
                {inviteErr && <div style={{fontSize:12,color:C.red,marginBottom:12}}>{inviteErr}</div>}
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <button disabled={sendingInvite} onClick={confirmInvite} style={{width:"100%",minHeight:44,padding:"10px 12px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:13,whiteSpace:"normal",lineHeight:1.3,opacity:sendingInvite?0.6:1,cursor:sendingInvite?"not-allowed":"pointer"}}>
                    {sendingInvite ? t.inviteGenerating : t.inviteGenerate}
                  </button>
                  <button onClick={()=>setShowInviteModal(false)} style={{width:"100%",height:40,background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13}}>{t.cancel}</button>
                </div>
              </>
            ) : (
              <>
                <div style={{fontSize:28,textAlign:"center",marginBottom:6}}>✅</div>
                <div style={{fontSize:16,fontWeight:900,color:C.txt,textAlign:"center",marginBottom:4}}>{t.linkReady}</div>
                <div style={{fontSize:12,color:C.mut,textAlign:"center",marginBottom:16,lineHeight:1.5}}>
                  {t.chooseHowSend}
                </div>
                <ParentInviteShareBtns C={C} parent={{inviteUrl:inviteResult.url, inviteEmail:inviteResult.email, invitePhone:inviteResult.phone}} familyName={cfg.parents[0]?.name || "Votre famille"} />
                <button onClick={()=>{
                  navigator.clipboard.writeText(inviteResult.url);
                  pushNotif("Lien copié !","info");
                }} style={{width:"100%",height:40,background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`,borderRadius:10,fontWeight:700,fontSize:13,marginBottom:10}}>
                  {t.copyInviteLink}
                </button>
                <button onClick={()=>{setShowInviteModal(false);setInviteResult(null);setInvitePhone("");setInviteEmail("");}} style={{width:"100%",height:44,background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:13}}>
                  {t.doneBtn}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {/* Step tabs — now rendered in the bottom nav bar */}
      <div className="fi">
        {step===0 && <StepId setParent={setParent} setChild={setChild} addParent={addParent} removeParent={removeParent} addChild={addChild} removeChild={removeChild} onShowEmailSim={setEmailSimIdx} quitterFamille={quitterFamille} retirerInvite={retirerInvite} />}
        {step===1 && <StepAccess />}
        {step===2 && <StepDates />}
        {step===3 && <StepGarde />}
        {step===4 && <StepLang lang={lang} setLang={setLang} />}
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:18,gap:10,paddingTop:14}}>
        {step>0&&<button onClick={()=>setStep(s=>s-1)} style={{height:44,padding:"0 20px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`,borderRadius:10,fontWeight:700}}>{t.prev}</button>}
        {step<4&&(()=>{
          const namesOk=step!==0||([...cfg.parents,...cfg.children].every(x=>x.name.trim()));
          return <button onClick={()=>namesOk&&setStep(s=>s+1)} style={{height:44,padding:"0 20px",background:namesOk?C.vio:`${C.vio}55`,color:"#fff",cursor:namesOk?"pointer":"not-allowed",opacity:namesOk?1:0.6,borderRadius:10}} title={!namesOk?(t.nameRequired||"Le nom est obligatoire."):undefined}>{t.next}</button>;
        })()}

      </div>
    </div>
  );
}

function CountryBadge({country}) {
  const {C} = useApp();
  const found = COUNTRIES.find(c => c.code === country);
  if (!found) return null;
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:C.sur,borderRadius:10,marginTop:8}}>
      <span style={{fontSize:22}}>{found.flag}</span>
      <div>
        <div style={{fontWeight:800,fontSize:14,color:C.txt}}>{found.name}</div>
        <div style={{fontSize:11,color:C.mut}}>
          {hasMultipleZones(country) ? `${(OH_SUBS_CATALOG[country]||[]).length} régions disponibles — OpenHolidays API` : "Vacances et fériés — OpenHolidays API"}
        </div>
      </div>
    </div>
  );
}

// ─── STEP 1: IDENTITIES ───────────────────────────────────────────────────────
// ── Carte de synchronisation famille (cloud) ─────────────────────────────────
function FamilySyncCard() {
  const {C,t,cfg,familySync} = useApp();
  const {syncStatus,joinFamily} = familySync;
  const [joinCode,setJoinCode] = useState("");
  const [joinMsg,setJoinMsg] = useState("");
  const [joining,setJoining] = useState(false);
  const [expanded,setExpanded] = useState(false);

  async function handleJoin(){
    if(!joinCode.trim()) return;
    setJoining(true); setJoinMsg("");
    const res = await joinFamily(joinCode);
    setJoining(false);
    if(res.ok){ setJoinMsg("ok"); setJoinCode(""); }
    else setJoinMsg(res.error==="notfound" ? "notfound" : "error");
  }

  const SI = {
    connecting:{icon:"⏳",color:C.yel,label:t.syncConnecting},
    synced:{icon:"☁️",color:C.grn,label:t.syncSynced},
    offline:{icon:"📴",color:C.mut,label:t.syncOffline},
    error:{icon:"⚠️",color:C.red,label:t.syncError},
  }[syncStatus] || {icon:"❔",color:C.mut,label:""};

  const isSynced = syncStatus==="synced";
  const showDetails = !isSynced || expanded;

  return (
    <div className="card" style={{marginBottom:16,borderColor:`${C.vio}55`}}>
      <div onClick={()=>isSynced && setExpanded(v=>!v)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,cursor:isSynced?"pointer":"default",marginBottom:showDetails?8:0}}>
        <div className="sec" style={{marginBottom:0}}>☁️ {t.familySyncTitle}</div>
        <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 10px",background:`${SI.color}15`,border:`1px solid ${SI.color}44`,borderRadius:10,fontSize:11,fontWeight:700,color:SI.color,flexShrink:0}}>
          <span>{SI.icon}</span><span>{SI.label}</span>
          {isSynced && <span style={{marginLeft:2,opacity:.6,fontSize:9}}>{expanded?"▲":"▼"}</span>}
        </div>
      </div>

      {showDetails && (
        <>
          <div style={{fontSize:12,color:C.mut,marginBottom:12,lineHeight:1.5}}>{t.familySyncDesc}</div>

          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
            <span style={{fontSize:11,color:C.mut,fontWeight:700}}>{t.familyCode} :</span>
            <span style={{fontFamily:"JetBrains Mono",fontSize:15,fontWeight:800,letterSpacing:2,color:C.vio}}>{cfg.shareCode}</span>
          </div>

          {/* Bloc « Rejoindre une famille existante » masqué : l'ajout d'un 2e
              parent se fait via le lien d'invitation (carte Invité). On garde
              uniquement l'affichage du code famille à partager ci-dessus. */}
        </>
      )}
    </div>
  );
}


function StepId({setParent,setChild,addParent,removeParent,addChild,removeChild,onShowEmailSim,quitterFamille,retirerInvite}) {
  const {C,t,cfg,setCfg,prem,perms,onUpgrade,user,sub,familySync} = useApp();
  const [touched,setTouched] = useState({});
  const [pidActing,setPidActing] = useState(null); // userId en cours de validation/refus

  // Rafraîchir les demandes en attente à l'ouverture de la config (pour pouvoir
  // valider l'invité directement depuis la carte Parent ci-dessous).
  useEffect(()=>{ familySync?.refreshPendingMembers?.(); /* eslint-disable-next-line */ },[]);

  // Auto-sync email du parent connecté dans son slot
  useEffect(()=>{
    if(!user||user.parentIdx===undefined) return;
    const idx = user.parentIdx;
    if(cfg.parents[idx] && cfg.parents[idx].email !== user.email){
      setCfg(c=>{const p=[...c.parents];p[idx]={...p[idx],email:user.email};return{...c,parents:p};});
    }
  },[user]);
  const markTouched = (key) => setTouched(v=>({...v,[key]:true}));

  // Shared field styles for consistent height/alignment
  const IH = 44;
  const fieldBox = {display:"flex",flexDirection:"column",gap:0};
  const lbl = {fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4,minHeight:16};
  const inp = {height:IH,boxSizing:"border-box",width:"100%"};

  // Bulle d'aide — visible jusqu'à fermeture manuelle
  const [showTip, setShowTip] = useState(true);
  function dismissTip() { setShowTip(false); }

  return (
    <div>
      <FamilySyncCard />

      <div className="sec">{t.parents}</div>
      {cfg.parents.map((p,i)=>{
        const pKey=`p${i}`; const pErr=touched[pKey]&&!p.name.trim();
        // 🔒 Email = identifiant de connexion (« lié au compte »). Il n'est
        // éditable QUE sur un créneau non encore réclamé par un compte (ex. le
        // créateur saisit l'email du parent 2 à la main avant l'invitation).
        // Verrouillé sinon : mon propre email, un parent qui a rejoint, OU le
        // créateur (index 0, toujours un vrai compte) — ce qui empêche l'invité
        // de modifier l'email de l'autre parent.
        const emailLocked = isParentEmailLocked(p, i, user?.parentIdx);
        const isMine = (i === user?.parentIdx)
          || (!!p.email && !!user?.email && p.email.toLowerCase() === user.email.toLowerCase()); // je n'édite/vois en détail que MA fiche
        const lockStyle = isMine ? undefined : { pointerEvents: "none", opacity: 0.75 };

        // ── Carte "En attente" ─────────────────────────────────────────────
        if(p.inviteStatus==="pending") return (
          <div key={i} className="card" style={{marginBottom:12,borderColor:p.color,borderStyle:"dashed"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{fontSize:11,fontWeight:800,color:p.color,textTransform:"uppercase",letterSpacing:".06em"}}>{i===0?t.creatorLabel:t.guestLabel}</span>
              <button onClick={()=>setCfg(c=>({...c,parents:c.parents.filter((_,j)=>j!==i)}))} style={{padding:"3px 10px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:12,borderRadius:6}}>{t.remove}</button>
            </div>
            <div style={{display:"flex",gap:12,alignItems:"center",padding:"8px 0 14px"}}>
              <div style={{width:44,height:44,borderRadius:"50%",background:`${p.color}22`,border:`2px dashed ${p.color}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>⏳</div>
              <div>
                <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:3}}>{t.waitingSignup}</div>
                <div style={{fontSize:12,color:C.mut}}>
                  {p.inviteEmail && <span>✉️ {p.inviteEmail}</span>}
                  {p.inviteEmail && p.invitePhone && <span style={{margin:"0 6px",opacity:.4}}>·</span>}
                  {p.invitePhone && <span>📞 {p.invitePhone}</span>}
                </div>
              </div>
            </div>

            {/* Boutons d'envoi du lien */}
            {p.inviteUrl && (
              <ParentInviteShareBtns C={C} parent={p} familyName={cfg.parents[0]?.name||"la famille"} />
            )}

            {/* ✅ Validation directe : si l'invité a déjà rejoint (en attente),
                on peut le valider ICI, sans aller dans l'onglet Accès. */}
            {(() => {
              const pend = (familySync?.pendingMembers||[]).filter(mm => (mm.role||"parent")==="parent");
              const m = pend.find(mm => mm.email && p.inviteEmail && mm.email.toLowerCase()===p.inviteEmail.toLowerCase()) || pend[0];
              if(!m) return null;
              const who = m.displayName || m.email || "Cette personne";
              return (
                <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${C.bor}`}}>
                  <div style={{fontSize:12.5,fontWeight:800,color:C.grn,marginBottom:9}}>
                    🙋 {who} a rejoint — à valider
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button disabled={pidActing===m.userId} onClick={async()=>{
                      setPidActing(m.userId);
                      const res=await familySync.validateMember(m);
                      setPidActing(null);
                      if(!res.ok) alert("⚠️ Erreur lors de la validation.");
                    }} style={{flex:1,height:40,background:C.grn,color:"#fff",borderRadius:9,fontSize:13,fontWeight:800,opacity:pidActing===m.userId?0.6:1}}>
                      {pidActing===m.userId?"⏳…":"✅ Valider"}
                    </button>
                    <button disabled={pidActing===m.userId} onClick={async()=>{
                      if(!window.confirm("Refuser cette demande ?")) return;
                      setPidActing(m.userId);
                      const res=await familySync.rejectMember(m.userId);
                      setPidActing(null);
                      if(!res.ok) alert("⚠️ Erreur lors du refus.");
                    }} style={{height:40,padding:"0 14px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:9,fontSize:13,fontWeight:700,opacity:pidActing===m.userId?0.6:1}}>
                      ❌
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        );

        return (
        <div key={i} className="card" style={{marginBottom:12,borderColor:pErr?C.red:p.color}}>
          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:11,fontWeight:800,color:p.color,textTransform:"uppercase",letterSpacing:".06em"}}>{i===0?t.creatorLabel:t.guestLabel}</span>
              {sub?.subscriberParentIdx===i && (
                <span style={{fontSize:9,fontWeight:900,background:`linear-gradient(135deg,${C.yel},${C.ora})`,color:"#fff",padding:"2px 7px",borderRadius:8,letterSpacing:".04em"}}>
                  👑 Souscripteur Premium
                </span>
              )}
              {cfg.pendingDeletion?.parentIdx===i && (
                <span style={{fontSize:9,fontWeight:900,background:`${C.red}22`,color:C.red,border:`1px solid ${C.red}44`,padding:"2px 7px",borderRadius:8}}>
                  ⏳ Suppression en attente
                </span>
              )}
            </div>
            {i===user?.parentIdx ? (
              cfg.parents.length>1 ? (
                <button onClick={quitterFamille} style={{padding:"3px 10px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:12,borderRadius:6}}>{t.leaveFamily}</button>
              ) : null
            ) : (user?.parentIdx===0 && i===1) ? (
              sub?.subscriberParentIdx===i
                ? <span style={{fontSize:11,color:C.mut,fontStyle:"italic"}}>🔒 Protégé</span>
                : <button onClick={()=>retirerInvite(i)} style={{padding:"3px 10px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:12,borderRadius:6}}>Retirer l'invité</button>
            ) : null}
          </div>

          {/* Row 1 : Avatar | Nom | Genre | Couleur */}
          <div style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:12}}>
            {/* Avatar */}
            <div style={{...fieldBox,flexShrink:0}}>
              <span style={lbl}>Avatar</span>
              <div style={{height:IH,display:"flex",alignItems:"center"}}>
                <AvatarPicker current={p.avatar} color={p.color} pool={PARENT_AVATARS} onSelect={em=>setParent(i,"avatar",em)} />
              </div>
            </div>
            {/* Nom */}
            <div style={{...fieldBox,flex:2}}>
              <span style={{...lbl,color:pErr?C.red:undefined}}>{t.name} <span style={{color:C.red}}>*</span></span>
              <input value={p.name} onChange={e=>setParent(i,"name",e.target.value)} onBlur={()=>markTouched(pKey)} readOnly={!isMine}
                style={{...inp,borderColor:pErr?C.red:undefined,outline:pErr?`1px solid ${C.red}`:undefined,...(isMine?{}:{background:C.sur,color:C.mut,cursor:"default"})}} />
            </div>
            {/* Genre */}
            <div style={{...fieldBox,flex:1,...lockStyle}}>
              <span style={lbl}>{t.gender}</span>
              <CustomSelect value={p.gender} onChange={v=>setParent(i,"gender",v)} options={[
                {value:"F",label:t.female||"Mère",icon:"🌸"},
                {value:"M",label:t.male||"Père",icon:"🎩"},
                {value:"O",label:t.other||"Autre",icon:"🧑"},
              ]} />
            </div>
            {/* Couleur */}
            <div style={{...fieldBox,flexShrink:0,...lockStyle}}>
              <span style={lbl}>{t.color}</span>
              <input type="color" value={p.color} onChange={e=>setParent(i,"color",e.target.value)}
                style={{...inp,width:IH,padding:2,cursor:"pointer"}} />
            </div>
          </div>

          {/* Lignes privées (naissance, téléphone, email) — visibles UNIQUEMENT
              sur MA propre fiche. Un parent ne voit pas la fiche identité de
              l'autre (vie privée des co-parents séparés). */}
          {isMine && <>
          {/* Row 2 : Jour naissance | Mois naissance */}
          <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:12}}>
            <div style={{...fieldBox,flex:1}}>
              <span style={lbl}>{t.birthDay}</span>
              <input type="number" min="1" max="31" value={p.birthDay} onChange={e=>setParent(i,"birthDay",e.target.value)} placeholder={t.dayPlaceholder||"JJ"} style={inp} />
            </div>
            <div style={{...fieldBox,flex:2}}>
              <span style={lbl}>{t.birthMonth}</span>
              <CustomSelect value={p.birthMonth} onChange={v=>setParent(i,"birthMonth",v)} options={[
                {value:"",label:"--"},
                ...(t.months||[]).map((m,j)=>({value:pad(j+1),label:m}))
              ]} />
            </div>
          </div>

          {/* Row 3 : Téléphone + Email */}
          <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:0}}>
            <div style={{...fieldBox,flex:1}}>
              <span style={lbl}>📞 {t.contactsPhone||"Téléphone"}</span>
              <input type="tel" value={p.phone||""} onChange={e=>setParent(i,"phone",e.target.value)} placeholder={t.regPhonePlaceholder||"ex: 06 12 34 56 78"} style={inp} />
            </div>
            <div style={{...fieldBox,flex:2}}>
              <span style={lbl}>
                ✉️ Email
                {emailLocked &&
                  <span style={{marginLeft:5,fontSize:9,background:`${C.grn}22`,color:C.grn,border:`1px solid ${C.grn}44`,padding:"1px 6px",borderRadius:6,fontWeight:800,verticalAlign:"middle"}}>
                    {t.linkedAccount||"🔗 Lié au compte"}
                  </span>
                }
              </span>
              <input
                type="email"
                value={p.email||(p.inviteStatus==="accepted"?p.inviteEmail:"")}
                onChange={e=>setParent(i,"email",e.target.value)}
                readOnly={emailLocked}
                placeholder="email@exemple.com"
                style={{...inp,
                  background:emailLocked?C.sur:undefined,
                  color:emailLocked?C.mut:undefined,
                  cursor:emailLocked?"default":undefined,
                }}
              />
            </div>
          </div>
          </>}
        </div>
      );})}
      {cfg.parents.length >= 2
        ? <div style={{fontSize:12,color:C.mut,textAlign:"center",padding:"10px 0 14px",fontStyle:"italic"}}>
            👥 Maximum 2 parents atteint
          </div>
        : <button onClick={addParent} style={{width:"100%",height:44,padding:"0 16px",background:"transparent",color:C.ora,border:`1.5px dashed ${C.ora}`,marginBottom:14}}>{t.addParent}</button>}

      <div className="sec">{t.children}</div>
      {cfg.children.map((ch,i)=>{
        const cKey=`c${i}`; const cErr=touched[cKey]&&!ch.name.trim();
        const isLocked = i >= (perms?.maxChildren ?? 1); // enfant hors limite du plan
        return (
        <div key={i} style={{position:"relative",marginBottom:12}}>
          <div className="card" style={{borderColor:cErr?C.red:`${C.vio}55`, filter: isLocked ? "blur(3px)" : "none", pointerEvents: isLocked ? "none" : "auto", userSelect: isLocked ? "none" : "auto", opacity: isLocked ? 0.7 : 1, transition:"filter .2s,opacity .2s"}}>
          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <span style={{fontSize:11,fontWeight:800,color:C.vio,textTransform:"uppercase",letterSpacing:".06em"}}>{t.childN} {i+1}</span>
            {i>0&&<button onClick={()=>removeChild(i)} style={{padding:"3px 10px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:12}}>{t.remove}</button>}
          </div>

          {/* Row 1 : Avatar | Nom */}
          <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:12}}>
            <div style={{...fieldBox,flexShrink:0}}>
              <span style={lbl}>Avatar</span>
              <div style={{height:IH,display:"flex",alignItems:"center"}}>
                <AvatarPicker current={ch.avatar} color={C.vio} pool={CHILD_AVATARS} onSelect={em=>setChild(i,"avatar",em)} />
              </div>
            </div>
            <div style={{...fieldBox,flex:1}}>
              <span style={{...lbl,color:cErr?C.red:undefined}}>{t.name} <span style={{color:C.red}}>*</span></span>
              <input value={ch.name} onChange={e=>setChild(i,"name",e.target.value)} onBlur={()=>markTouched(cKey)}
                style={{...inp,borderColor:cErr?C.red:undefined,outline:cErr?`1px solid ${C.red}`:undefined}} />
              {cErr&&<div style={{fontSize:11,color:C.red,marginTop:3}}>{t.nameRequired||"Le nom est obligatoire."}</div>}
            </div>
          </div>

          {/* Row 2 : Jour naissance | Mois naissance */}
          <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:12}}>
            <div style={{...fieldBox,flex:1}}>
              <span style={lbl}>{t.birthDay}</span>
              <input type="number" min="1" max="31" value={ch.birthDay} onChange={e=>setChild(i,"birthDay",e.target.value)} placeholder={t.dayPlaceholder||"JJ"} style={inp} />
            </div>
            <div style={{...fieldBox,flex:2}}>
              <span style={lbl}>{t.birthMonth}</span>
              <CustomSelect value={ch.birthMonth} onChange={v=>setChild(i,"birthMonth",v)} options={[
                {value:"",label:"--"},
                ...(t.months||[]).map((m,j)=>({value:pad(j+1),label:m}))
              ]} />
            </div>
          </div>

          {/* Row 3 : Téléphone */}
          <div style={fieldBox}>
            <span style={lbl}>📞 {t.contactsPhone||"Téléphone"}</span>
            <input type="tel" value={ch.phone||""} onChange={e=>setChild(i,"phone",e.target.value)} placeholder={t.regPhonePlaceholder||"ex: 06 12 34 56 78"} style={inp} />
          </div>

          {/* Row 4 : Lien d'invitation enfant */}
          {ch.name.trim() && (
            <ChildInviteBtn childIdx={i} childName={ch.name} childPhone={ch.phone} />
          )}
        </div>
          {/* Overlay lock pour enfants hors limite */}
          {isLocked && (
            <div onClick={onUpgrade} style={{position:"absolute",inset:0,borderRadius:12,background:"rgba(0,0,0,.18)",backdropFilter:"blur(0px)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6,zIndex:10,cursor:"pointer"}}>
              <div style={{background:C.card,border:`1.5px solid ${C.vio}`,borderRadius:12,padding:"12px 20px",textAlign:"center",boxShadow:"0 4px 16px rgba(0,0,0,.18)"}}>
                <div style={{fontSize:22,marginBottom:4}}>🔒</div>
                <div style={{fontSize:12,fontWeight:900,color:C.vio,marginBottom:2}}>Enfant {i+1} — Plan supérieur requis</div>
                <div style={{fontSize:11,color:C.mut,marginBottom:8}}>{i===1?"Trial Premium : jusqu'à 2 enfants":"Premium : enfants illimités"}</div>
                <div style={{padding:"5px 14px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",borderRadius:8,fontSize:11,fontWeight:800}}>⭐ Passer au Premium</div>
              </div>
            </div>
          )}
        </div>
      );})}
      {(cfg.children.length>=(perms?.maxChildren??1))
        ? <button onClick={onUpgrade} style={{width:"100%",height:44,padding:"0 16px",background:`${C.vio}11`,color:C.vio,border:`1.5px dashed ${C.vio}`,marginBottom:12}}>{t.lockChildren}</button>
        : <button onClick={addChild} style={{width:"100%",height:44,padding:"0 16px",background:"transparent",color:C.vio,border:`1.5px dashed ${C.vio}`,marginBottom:12}}>{t.addChild}</button>}
    </div>
  );
}

// ─── PARENT INVITE SHARE BUTTONS ─────────────────────────────────────────────
function ParentInviteShareBtns({ C, parent, familyName }) {
  const { t } = useApp();
  function cleanPhoneWA(phone) {
    if (!phone) return null;
    let p = phone.replace(/[\s.\-()+]/g, "");
    if (p.startsWith("00")) p = p.slice(2);
    else if (p.startsWith("0")) p = "33" + p.slice(1);
    return p || null;
  }

  const msg = `Bonjour 👋\n${familyName} t'invite à rejoindre la famille sur Duvia.\nCrée ton compte ici :\n${parent.inviteUrl}`;

  function handleSMS() {
    const phone = parent.invitePhone ? parent.invitePhone.replace(/[\s.\-()+]/g,"") : "";
    window.open(`sms:${phone}?&body=${encodeURIComponent(msg)}`, "_blank");
  }

  function handleWhatsApp() {
    const phone = cleanPhoneWA(parent.invitePhone);
    window.open(`https://wa.me/${phone||""}?text=${encodeURIComponent(msg)}`, "_blank");
  }

  function handleEmail() {
    const subject = encodeURIComponent(`Rejoins notre famille sur Duvia 👨‍👩‍👧`);
    const href = `mailto:${parent.inviteEmail||""}?subject=${subject}&body=${encodeURIComponent(msg)}`;
    const a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.bor}`}}>
      <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>
        {t.sendInviteLink}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button onClick={handleSMS} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:"#25D36618",color:"#128C7E",border:"1.5px solid #25D36644",
        }}>💬 SMS</button>
        <button onClick={handleWhatsApp} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:"#25D36618",color:"#25D366",border:"1.5px solid #25D36644",
        }}>📱 WhatsApp</button>
        <button onClick={handleEmail} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`,
        }}>✉️ Email</button>
      </div>
      {!parent.invitePhone && (
        <div style={{fontSize:10,color:C.mut,marginTop:5}}>
          {t.reinviteNumberTip}
        </div>
      )}
    </div>
  );
}

// ─── CHILD INVITE BUTTON ─────────────────────────────────────────────────────
function ChildInviteBtn({ childIdx, childName, childPhone }) {
  const { C, t, cfg, setCfg } = useApp();
  const [inviteUrl, setInviteUrl] = useState("");

  // Nettoie le numéro pour WhatsApp (supprime espaces/tirets, gère le 0 → 33)
  function cleanPhoneWA(phone) {
    if (!phone) return null;
    let p = phone.replace(/[\s.\-()+]/g, "");
    if (p.startsWith("00")) p = p.slice(2);
    else if (p.startsWith("0")) p = "33" + p.slice(1);
    return p || null;
  }

  function getOrGenUrl() {
    if (inviteUrl) return inviteUrl;
    const code = `CHILD-${cfg.shareCode||"DUVIA"}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    const url  = `https://app.duvia.fr/?code=${code}&role=child&family=${cfg.shareCode||"DUVIA"}&idx=${childIdx}`;
    setCfg(c => ({
      ...c,
      pendingChildInvites: [
        ...(c.pendingChildInvites||[]).filter(inv => inv.childIdx !== childIdx),
        { code, childIdx, childName, used: false, createdAt: new Date().toISOString() }
      ]
    }));
    setInviteUrl(url);
    return url;
  }

  const msgText = (url) =>
    `Bonjour ${childName} 👋\nRejoins notre famille sur Duvia !\nClique ici pour créer ton compte :\n${url}`;

  function handleEmail() {
    const url     = getOrGenUrl();
    const subject = encodeURIComponent(`Rejoins notre famille sur Duvia 👨‍👩‍👧`);
    const body    = encodeURIComponent(msgText(url));
    window.open(`mailto:?subject=${subject}&body=${body}`, "_blank");
  }

  function handleSMS() {
    const url = getOrGenUrl();
    const body = encodeURIComponent(msgText(url));
    const phone = childPhone ? childPhone.replace(/[\s.\-()+]/g,"") : "";
    window.open(`sms:${phone}?&body=${body}`, "_blank");
  }

  function handleWhatsApp() {
    const url  = getOrGenUrl();
    const body = encodeURIComponent(msgText(url));
    const phone = cleanPhoneWA(childPhone);
    // wa.me sans numéro = ouvre WhatsApp avec le texte (l'utilisateur choisit le contact)
    window.open(`https://wa.me/${phone||""}?text=${body}`, "_blank");
  }

  return (
    <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${C.bor}`}}>
      <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>
        📨 Inviter {childName} à rejoindre l'app
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>

        {/* SMS */}
        <button onClick={handleSMS} style={{
          display:"flex",alignItems:"center",gap:6,
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:"#25D36618",color:"#128C7E",border:"1.5px solid #25D36644",
        }}>
          💬 SMS
        </button>

        {/* WhatsApp */}
        <button onClick={handleWhatsApp} style={{
          display:"flex",alignItems:"center",gap:6,
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:"#25D36618",color:"#25D366",border:"1.5px solid #25D36644",
        }}>
          <span style={{fontSize:14}}>📱</span> WhatsApp
        </button>

        {/* Email */}
        <button onClick={handleEmail} style={{
          display:"flex",alignItems:"center",gap:6,
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`,
        }}>
          ✉️ Email
        </button>
      </div>
      {!childPhone && (
        <div style={{fontSize:10,color:C.mut,marginTop:5}}>
          💡 Ajoute un numéro de téléphone pour pré-remplir l'envoi.
        </div>
      )}
      <div style={{fontSize:10,color:C.mut,marginTop:4}}>
        {t.regInviteAgeInfo}
      </div>
    </div>
  );
}

// ─── NATIONAL HOLIDAYS PICKER ────────────────────────────────────────────────
function NatHolPicker() {
  const {C,t,cfg,setCfg} = useApp();
  const fixed = NAT_HOLS_FIXED[cfg.country] || [];
  const easterHols = NAT_HOLS_EASTER[cfg.country] || [];
  const y = +cfg.custody.startYear || new Date().getFullYear();
  const e = easterDate(y);
  const addD = (dt, n) => { const r = new Date(dt); r.setDate(r.getDate() + n); return r; };

  const allHols = [
    ...fixed.map(h => ({
      key: `${h.m}-${h.d}`,
      name: h.n,
      date: `${pad(h.d)}/${pad(h.m)}`,
    })),
    ...easterHols.map(([offset, name]) => {
      const hd = addD(e, offset);
      return {
        key: `easter+${offset}`,
        name,
        date: `${pad(hd.getDate())}/${pad(hd.getMonth() + 1)}`,
      };
    }),
  ];

  const active = cfg.activeNatHols || allHols.map(h => h.key);

  function toggle(key) {
    const next = active.includes(key)
      ? active.filter(k => k !== key)
      : [...active, key];
    setCfg(c => ({ ...c, activeNatHols: next }));
  }

  function toggleAll() {
    const next = active.length === allHols.length ? [] : allHols.map(h => h.key);
    setCfg(c => ({ ...c, activeNatHols: next }));
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.txt }}>📅 {t.natHols}</span>
        <button onClick={toggleAll}
          style={{ padding: "4px 10px", background: "transparent", color: C.vio, border: `1px solid ${C.vio}`, fontSize: 11, borderRadius: 8 }}>
          {active.length === allHols.length ? t.applyNone : t.applyAll}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))", gap: 6 }}>
        {allHols.map(h => {
          const on = active.includes(h.key);
          return (
            <label key={h.key}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: on ? `${C.red}11` : C.bg, borderRadius: 8, border: `1.5px solid ${on ? C.red : C.bor}`, cursor: "pointer", transition: "all .15s" }}>
              <input type="checkbox" checked={on} onChange={() => toggle(h.key)} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.txt }}>{h.name}</div>
                <div style={{ fontSize: 10, color: C.mut, fontFamily: "JetBrains Mono" }}>{h.date}</div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ─── ZONE DROPDOWN ────────────────────────────────────────────────────────────
function ZoneDropdown({chCountry, chCurSub, chSubs, chSetZone, noZoneLabel, locked=false}) {
  const {C, onUpgrade} = useApp();
  const [open, setOpen] = useState(false);
  const isFR = chCountry === "FR";
  const frZoneOptions = isFR ? ["A","B","C"].map(zl => ({
    zl,
    code: chSubs.filter(s=>s.label.includes(`Zone ${zl}`))[0]?.code || "",
    regions: chSubs.filter(s=>s.label.includes(`Zone ${zl}`)).map(s=>s.label.replace(/^Zone [ABC] — /,"")).join(", ")
  })) : [];
  const options = isFR
    ? [{value:"", label: noZoneLabel}, ...frZoneOptions.map(o=>({value:o.zl, label:`Zone ${o.zl}`, sub:o.regions, code:o.code}))]
    : [{value:"", label: noZoneLabel}, ...[...chSubs].sort((a,b)=>a.label.localeCompare(b.label,"fr",{sensitivity:"base"})).map(s=>({value:s.code, label:s.label, code:s.code}))];
  const curValue = isFR
    ? (chSubs.find(s=>s.code===chCurSub)?.label.match(/Zone ([ABC])/)?.[1] || "")
    : chCurSub || "";
  const curLabel = options.find(o=>o.value===curValue)?.label || noZoneLabel;

  function select(opt) {
    if(!opt.value) { chSetZone("",""); }
    else if(isFR) { const fo=frZoneOptions.find(o=>o.zl===opt.value); if(fo) chSetZone(fo.code,""); }
    else { chSetZone(opt.value,""); }
    setOpen(false);
  }

  if(locked) return (
    <button onClick={onUpgrade} style={{width:"100%",height:36,padding:"0 14px",background:`${C.ora}10`,border:`1.5px dashed ${C.ora}66`,borderRadius:10,display:"inline-flex",alignItems:"center",gap:8,fontSize:12,fontWeight:800,color:C.ora,cursor:"pointer",boxSizing:"border-box"}}>
      <span>🔒</span><span>Réservé Premium</span>
    </button>
  );
  return (
    <div style={{position:"relative"}}>
      {open && <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:199}} />}
      <button onClick={()=>setOpen(v=>!v)}
        style={{width:"100%",height:44,padding:"0 16px",background:C.card,border:`1.5px solid ${open?C.vio:C.bor}`,borderRadius:12,display:"flex",alignItems:"center",gap:10,fontSize:13,fontWeight:600,color:C.txt,cursor:"pointer",boxSizing:"border-box"}}>
        <span style={{flex:1,textAlign:"left",color:curValue?C.txt:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{curLabel}</span>
        <span style={{fontSize:10,color:C.mut,transition:"transform .2s",display:"inline-block",transform:open?"rotate(180deg)":"rotate(0deg)",flexShrink:0}}>▼</span>
      </button>
      {open && (
        <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,right:0,background:C.card,border:`1.5px solid ${C.bor}`,borderRadius:16,zIndex:300,boxShadow:"0 12px 40px rgba(0,0,0,.2)",overflow:"hidden",maxHeight:260,overflowY:"auto"}}>
          {options.map((opt,i)=>{
            const isActive = opt.value === curValue;
            return (
              <button key={i} onClick={()=>select(opt)}
                style={{width:"100%",padding:"0 16px",minHeight:opt.sub?52:44,background:isActive?`${C.vio}10`:"transparent",color:isActive?C.vio:C.txt,display:"flex",alignItems:"center",gap:10,borderBottom:i<options.length-1?`1px solid ${C.bor}`:"none",fontSize:13,fontWeight:isActive?700:600,borderRadius:0,cursor:"pointer",textAlign:"left",boxSizing:"border-box"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{opt.label}</div>
                  {opt.sub && <div style={{fontSize:10,color:C.mut,fontWeight:400,marginTop:1,whiteSpace:"normal",lineHeight:1.3}}>{opt.sub}</div>}
                </div>
                {isActive && <span style={{fontSize:14,color:C.vio,flexShrink:0}}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Toggle({checked, onChange}) {
  const {C} = useApp();
  return (
    <div onClick={()=>onChange(!checked)} style={{width:44,height:24,borderRadius:12,background:checked?C.vio:`${C.mut}44`,cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
      <div style={{position:"absolute",top:3,left:checked?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",boxShadow:"0 1px 4px rgba(0,0,0,.25)",transition:"left .2s"}} />
    </div>
  );
}

function CustomSelect({value, onChange, options, style}) {
  const {C} = useApp();
  const [open, setOpen] = useState(false);
  const cur = options.find(o=>String(o.value)===String(value)) || options[0];

  return (
    <div style={{position:"relative",...style}}>
      {open && <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:199}} />}
      <button onClick={()=>setOpen(v=>!v)}
        style={{width:"100%",height:44,padding:"0 16px",background:C.card,border:`1.5px solid ${open?C.vio:C.bor}`,borderRadius:12,display:"flex",alignItems:"center",gap:10,fontSize:13,fontWeight:600,color:C.txt,cursor:"pointer",boxSizing:"border-box"}}>
        {cur?.icon && <span style={{fontSize:18,flexShrink:0}}>{cur.icon}</span>}
        <span style={{flex:1,textAlign:"left",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cur?.label||""}</span>
        <span style={{fontSize:10,color:C.mut,transition:"transform .2s",display:"inline-block",transform:open?"rotate(180deg)":"rotate(0deg)",flexShrink:0}}>▼</span>
      </button>
      {open && (
        <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,right:0,background:C.card,border:`1.5px solid ${C.bor}`,borderRadius:16,zIndex:300,boxShadow:"0 12px 40px rgba(0,0,0,.2)",overflow:"hidden",maxHeight:Math.min(280,options.length*44+2),overflowY:"auto"}}>
          {options.map((o,i)=>{
            const isActive = String(o.value)===String(value);
            return (
              <button key={o.value} onClick={()=>{onChange(o.value);setOpen(false);}}
                style={{width:"100%",padding:"0 16px",height:44,background:isActive?`${C.vio}10`:"transparent",color:isActive?C.vio:C.txt,display:"flex",alignItems:"center",gap:10,borderBottom:i<options.length-1?`1px solid ${C.bor}`:"none",fontSize:13,fontWeight:isActive?700:600,borderRadius:0,cursor:"pointer",boxSizing:"border-box"}}>
                {o.icon && <span style={{fontSize:18,flexShrink:0}}>{o.icon}</span>}
                <span style={{flex:1,textAlign:"left"}}>{o.label}</span>
                {isActive && <span style={{fontSize:14,color:C.vio,flexShrink:0}}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CountryDropdown({value, onChange}) {
  const {C} = useApp();
  const [open, setOpen] = useState(false);
  const sorted = [...COUNTRIES].sort((a,b)=>a.name.localeCompare(b.name,"fr",{sensitivity:"base"}));
  const cur = COUNTRIES.find(c=>c.code===value) || COUNTRIES[0];
  return (
    <div style={{position:"relative"}}>
      {open && <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:199}} />}
      <button onClick={()=>setOpen(v=>!v)}
        style={{width:"100%",height:44,padding:"0 16px",background:C.card,border:`1.5px solid ${open?C.vio:C.bor}`,borderRadius:12,display:"flex",alignItems:"center",gap:10,fontSize:13,fontWeight:600,color:C.txt,cursor:"pointer",boxSizing:"border-box"}}>
        <span style={{fontSize:18,flexShrink:0}}>{cur.flag}</span>
        <span style={{flex:1,textAlign:"left",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cur.name}</span>
        <span style={{fontSize:10,color:C.mut,transition:"transform .2s",display:"inline-block",transform:open?"rotate(180deg)":"rotate(0deg)",flexShrink:0}}>▼</span>
      </button>
      {open && (
        <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,right:0,background:C.card,border:`1.5px solid ${C.bor}`,borderRadius:16,zIndex:300,boxShadow:"0 12px 40px rgba(0,0,0,.2)",overflow:"hidden",maxHeight:280,overflowY:"auto"}}>
          {sorted.map((c,i)=>{
            const isActive = c.code===value;
            return (
              <button key={c.code} onClick={()=>{onChange(c.code);setOpen(false);}}
                style={{width:"100%",padding:"0 16px",height:44,background:isActive?`${C.vio}10`:"transparent",color:isActive?C.vio:C.txt,display:"flex",alignItems:"center",gap:10,borderBottom:i<sorted.length-1?`1px solid ${C.bor}`:"none",fontSize:13,fontWeight:isActive?700:600,borderRadius:0,cursor:"pointer",boxSizing:"border-box"}}>
                <span style={{fontSize:18,flexShrink:0}}>{c.flag}</span>
                <span style={{flex:1,textAlign:"left",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</span>
                {isActive && <span style={{fontSize:14,color:C.vio,flexShrink:0}}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── STEP 2: SPECIAL DATES ────────────────────────────────────────────────────
function StepDates() {
  const {C,t,cfg,setCfg,prem,perms,onUpgrade,apiData,apiLoading} = useApp();
  const sd=cfg.specialDates;
  const [openHol,setOpenHol]=useState(null);

  // ── Mode multi-enfant ──────────────────────────────────────────────────────
  const children = cfg.children || [];
  const multiChild = !cfg.sameGuardAll && children.length > 1;

  function updSD(f,v){setCfg(c=>({...c,specialDates:{...c.specialDates,[f]:v}}));}
  function tSD(f,k,v){setCfg(c=>({...c,specialDates:{...c.specialDates,[f]:{...c.specialDates[f],[k]:v}}}));}
  function setPB(i,f,v){setCfg(c=>{const a=[...(c.specialDates.parentBirths||[])];a[i]={...(a[i]||{}),[f]:v};return{...c,specialDates:{...c.specialDates,parentBirths:a}};});}
  function setPCB(i,f,v){setCfg(c=>{const a=[...(c.specialDates.childBirths||[])];a[i]={...(a[i]||{}),[f]:v};return{...c,specialDates:{...c.specialDates,childBirths:a}};});}
  // ── Per-child special dates helpers ──────────────────────────────────────
  function getChildSD(childId) {
    return cfg.specialDates?.perChild?.[childId] || {};
  }
  function setChildSD(childId, field, value) {
    setCfg(c => ({...c, specialDates:{...c.specialDates,
      perChild:{...(c.specialDates.perChild||{}),
        [childId]:{...(c.specialDates.perChild?.[childId]||{}), [field]:value}
      }
    }}));
  }
  function setChildPB(childId, i, field, value) {
    setCfg(c => {
      const perChildEntry = c.specialDates?.perChild?.[childId] || {};
      const pbs = [...(perChildEntry.parentBirths || [])];
      pbs[i] = {...(pbs[i]||{}), [field]:value};
      return {...c, specialDates:{...c.specialDates,
        perChild:{...(c.specialDates.perChild||{}),
          [childId]:{...perChildEntry, parentBirths:pbs}
        }
      }};
    });
  }
  function setChildCB(childId, field, value) {
    setCfg(c => ({...c, specialDates:{...c.specialDates,
      perChild:{...(c.specialDates.perChild||{}),
        [childId]:{...(c.specialDates.perChild?.[childId]||{}), [field]:value}
      }
    }}));
  }
  function getChildCountry(childId) {
    return cfg.childrenCountry?.[childId] || cfg.country || "FR";
  }
  function setChildCountry(childId, country) {
    setCfg(c => ({...c, childrenCountry:{...(c.childrenCountry||{}), [childId]:country}}));
  }
  function setHD(hn,ds,pi){
    const det={...getHolDetails()};
    if(pi===undefined){const copy={...(det[hn]||{})};delete copy[ds];det[hn]=copy;}
    else{det[hn]={...(det[hn]||{}),[ds]:pi};}
    setHolDetails(det);
  }
  const syr=schoolYearStart();
  // Shared field styles — same as StepId
  const IH = 36;
  const fld = {display:"flex",flexDirection:"column"};
  const lbl = {fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4,minHeight:16};
  const inp = {height:IH,boxSizing:"border-box",width:"100%"};

  return (
    <div>
      {/* ── Même garde pour tous les enfants — caché si 1 seul enfant ──────── */}
      {cfg.children.length > 1 && (
      <div className="card" style={{marginBottom:16,borderColor:cfg.sameGuardAll?C.bor:C.vio,borderWidth:"1.5px"}}>
        <label style={{display:"flex",alignItems:"center",gap:12,cursor:prem?"pointer":"not-allowed",opacity:prem?1:0.6}} onClick={!prem?onUpgrade:undefined}>
          <div style={{
            width:44,height:26,borderRadius:13,flexShrink:0,position:"relative",transition:"background .2s",
            background:prem&&cfg.sameGuardAll?C.vio:C.bor,
          }}>
            <div style={{
              position:"absolute",top:3,left:prem&&cfg.sameGuardAll?20:3,
              width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s",
              boxShadow:"0 1px 3px rgba(0,0,0,.2)"
            }}/>
            <input type="checkbox" checked={prem?cfg.sameGuardAll:false} disabled={!prem}
              onChange={e=>prem&&setCfg(c=>({...c,sameGuardAll:e.target.checked}))}
              style={{position:"absolute",opacity:0,width:"100%",height:"100%",cursor:"pointer",margin:0}} />
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:800,color:C.txt,display:"flex",alignItems:"center",gap:6}}>
              {t.sameGuard}
              {!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`}}>🔒 Réservé Premium</span>}
            </div>
            <div style={{fontSize:11,color:C.mut,marginTop:2,lineHeight:1.4}}>
              {prem&&cfg.sameGuardAll
                ? "✅ Planning identique pour tous les enfants"
                : prem
                  ? "⚙️ Chaque enfant a sa propre zone scolaire et ses propres vacances"
                  : "Passez en Premium pour personnaliser par enfant"}
            </div>
          </div>
        </label>
      </div>
      )}

      {/* Start date */}
      <div className="sec">{t.startDate}</div>
      <div className="card" style={{marginBottom:16}}>
        <div style={{display:"flex",gap:10,alignItems:"flex-end"}}>
          <div style={{...fld,flex:1}}>
            <span style={lbl}>{t.month}</span>
            <select value={cfg.custody.startMonth} onChange={e=>setCfg(c=>({...c,custody:{...c.custody,startMonth:e.target.value}}))} style={inp}>
              {t.months.map((m,i)=><option key={i} value={pad(i+1)}>{m}</option>)}
            </select>
          </div>
          <div style={{...fld,flex:1}}>
            <span style={lbl}>{t.year}</span>
            <input type="number" value={cfg.custody.startYear} onChange={e=>setCfg(c=>({...c,custody:{...c.custody,startYear:e.target.value}}))} style={inp} />
          </div>
        </div>
      </div>

      {/* ── Bloc pays / zone : simplifié si garde identique pour tous ───────── */}
      {!multiChild ? (
        (() => {
          const ch0 = children[0] || {id:"global"};
          const chId = ch0.id;
          const chCountry = getChildCountry(chId);
          const chZone = { subdivisionCode: cfg.subdivisionCode||"", zone: cfg.zone||"" };
          const chSubs = OH_SUBS_CATALOG[chCountry] || [];
          const chCurSub = chZone.subdivisionCode || "";
          const chHols = getHolsFromData(chCountry, apiData, chCurSub||chZone.zone);
          const chOpen = openHol && !openHol.includes("::") ? openHol : null;
          const setChOpen = (hn) => setOpenHol(hn || null);
          const chGetHolDetails=()=> { return sd.schoolHolDetails || {}; };
          const chSetHolDetails=(newDet)=> { setCfg(c=>({...c, specialDates:{...c.specialDates, schoolHolDetails:newDet}})); };
          const chSetHD=(hn,ds,pi)=> { const det={...chGetHolDetails()}; if(pi===undefined){const copy={...(det[hn]||{})};delete copy[ds];det[hn]=copy;}else{det[hn]={...(det[hn]||{}),[ds]:pi};} chSetHolDetails(det); };
          const chSetZone=(subdivisionCode, zone)=> { setCfg(c=>({...c, subdivisionCode, zone})); };
          const chMD = sd.motherDay || {enabled:false};
          const chFD = sd.fatherDay || {enabled:false};
          const chPB = sd.parentBirths || [];
          const chEvenIdx = sd.evenParentIdx ?? 0;
          const chOddIdx = sd.oddParentIdx ?? 1;

          return (
            <div style={{marginBottom:16,border:`1.5px solid ${C.bor}`,borderRadius:14,overflow:"hidden"}}>
              <div style={{padding:"14px 14px 4px"}}>

                {/* Pays */}
                <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.country}</div>
                <div style={{marginBottom:12}}>
                  <CountryDropdown value={chCountry} onChange={v=>{
                    setCfg(c=>({...c,country:v,activeNatHols:null,zone:"",subdivisionCode:""}));
                    if(children[0]) setChildCountry(children[0].id, v);
                  }} />
                </div>

                {/* Zone scolaire */}
                <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.zone} — {t.schoolYear} {syr}/{syr+1}</div>
                <div style={{marginBottom:12}}>
                  {chSubs.length > 0 ? (
                    <ZoneDropdown chCountry={chCountry} chCurSub={chCurSub} chSubs={chSubs} chSetZone={chSetZone} noZoneLabel={t.noZone} locked={!perms?.zoneChoice} />
                  ) : (
                    <div style={{fontSize:12,color:C.mut,fontStyle:"italic"}}>{t.noZone} — {chCountry}</div>
                  )}
                </div>

                {/* Vacances scolaires */}
                {chHols.length > 0 && (
                  <div style={{marginBottom:12}}>
                    <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.schoolHols}</div>
                    {chHols.map((hol,hi)=>{
                      const isOpen = chOpen === hol.n;
                      const det = chGetHolDetails()[hol.n]||{};
                      const days = daysRange(hol.s,hol.e);
                      const assignedCount = Object.keys(det).length;
                      return (
                        <div key={hi} style={{marginBottom:6,border:`1.5px solid ${C.bor}`,borderRadius:10,overflow:"hidden"}}>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 11px",background:C.sur,cursor:"pointer"}} onClick={e=>{const s=nearestScroller(e.currentTarget);const restore=lockScroll(s);setChOpen(isOpen?null:hol.n);requestAnimationFrame(restore);}}>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <span style={{fontWeight:700,fontSize:12,color:C.grn}}>🌿 {hol.n}</span>
                              <span style={{fontSize:10,color:C.mut,fontFamily:"JetBrains Mono"}}>{hol.s.slice(8)}/{hol.s.slice(5,7)} → {hol.e.slice(8)}/{hol.e.slice(5,7)}</span>
                            </div>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              {assignedCount>0 && <span style={{fontSize:10,background:`${C.grn}22`,color:C.grn,padding:"2px 6px",borderRadius:6,fontWeight:700}}>{assignedCount}/{days.length}j</span>}
                              <span style={{color:C.vio,fontSize:10}}>{isOpen?"▲":"▼"}</span>
                            </div>
                          </div>
                          {isOpen && (
                            <div style={{padding:"10px 11px"}}>
                              {/* Boutons tout assigner */}
                              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                                {cfg.parents.map((p,pi)=>(
                                  <button key={pi} onClick={()=>{const base=chGetHolDetails();const newDet={...base,[hol.n]:{...(base[hol.n]||{})}};days.forEach(d2=>{newDet[hol.n][d2]=pi;});chSetHolDetails(newDet);}} style={{padding:"4px 10px",background:`${p.color}22`,color:p.color,border:`1.5px solid ${p.color}`,borderRadius:20,fontSize:11,fontWeight:700}}>Tout → {p.name||`P${pi+1}`}</button>
                                ))}
                                <button onClick={()=>{const base=chGetHolDetails();chSetHolDetails({...base,[hol.n]:{}});}} style={{padding:"4px 8px",background:"transparent",color:C.mut,border:`1px solid ${C.bor}`,borderRadius:20,fontSize:11}}>Effacer</button>
                              </div>
                              {/* Vue par semaines */}
                              {(()=>{
                                // Découper les jours en semaines (lun→dim)
                                const weeks=[];
                                let week=[];
                                days.forEach(ds2=>{
                                  const d2=new Date(ds2+"T12:00:00");
                                  const dw2=dow(d2.getFullYear(),d2.getMonth(),d2.getDate());
                                  week.push({ds:ds2,dw:dw2});
                                  if(dw2===6||ds2===days[days.length-1]){weeks.push(week);week=[];}
                                });
                                return weeks.map((wk,wi)=>{
                                  // Résumé de la semaine
                                  const wkPiCounts={};
                                  wk.forEach(({ds})=>{const pi=det[ds];if(pi!==undefined)wkPiCounts[pi]=(wkPiCounts[pi]||0)+1;});
                                  const totalAssigned=Object.values(wkPiCounts).reduce((a,b)=>a+b,0);
                                  const dominantPi=Object.keys(wkPiCounts).length===1?Number(Object.keys(wkPiCounts)[0]):undefined;
                                  const wkLabel=`${wk[0].ds.slice(8)}/${wk[0].ds.slice(5,7)} → ${wk[wk.length-1].ds.slice(8)}/${wk[wk.length-1].ds.slice(5,7)}`;
                                  const wkColor=dominantPi!==undefined?cfg.parents[dominantPi]?.color:C.bor;
                                  return (
                                    <WeekRow key={wi} wk={wk} wkPiCounts={wkPiCounts} dominantPi={dominantPi} wkColor={wkColor} wkLabel={wkLabel}
                                      hol={hol} det={det} chGetHolDetails={chGetHolDetails} chSetHolDetails={chSetHolDetails} chSetHD={chSetHD}
                                      cfg={cfg} C={C} t={t} />
                                  );
                                });
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Fêtes mères/pères */}
                <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.stepDates}</div>
                <div style={{marginBottom:12,border:`1px solid ${C.bor}`,borderRadius:10,overflow:"hidden"}}>
                  {[{k:"motherDay",l:t.motherDay,d:t.motherDayInfo,val:chMD},{k:"fatherDay",l:t.fatherDay,d:t.fatherDayInfo,val:chFD}].map(({k,l,d,val},ki)=>(
                    <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderBottom:ki===0?`1px solid ${C.bor}`:"none",background:C.card}}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>{l}{!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`}}>🔒 Réservé Premium</span>}</div>
                        <div style={{fontSize:11,color:C.mut}}>{d}</div>
                      </div>
                      {prem ? (
                        <Toggle checked={!!val?.enabled} onChange={v=>updSD(k,{enabled:v})} />
                      ) : (
                        <button onClick={onUpgrade} style={{padding:"5px 10px",background:`${C.ora}10`,color:C.ora,border:`1.5px dashed ${C.ora}66`,borderRadius:8,fontSize:11,fontWeight:800}}>🔒 Réservé Premium</button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Anniversaires des parents */}
                <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.parentBirthdays}</div>
                <div style={{marginBottom:12,border:`1px solid ${C.bor}`,borderRadius:10,overflow:"hidden"}}>
                  {cfg.parents.map((p,pi)=>{
                    const pb = chPB[pi] || {enabled:false,parentIdx:pi};
                    return (
                      <div key={pi} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderBottom:pi<cfg.parents.length-1?`1px solid ${C.bor}`:"none",background:C.card}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                            <span style={{width:8,height:8,borderRadius:"50%",background:p.color,flexShrink:0}}/>
                            🎂 {p.name||`${t.parentN} ${pi+1}`}
                            {p.birthDay&&p.birthMonth&&<span style={{fontSize:11,color:C.mut,fontFamily:"JetBrains Mono"}}>{p.birthDay}/{p.birthMonth}</span>}
                            {!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`}}>🔒 Réservé Premium</span>}
                          </div>
                          <div style={{fontSize:11,color:C.mut}}>{t.forced||"Garde forcée"}</div>
                        </div>
                        {prem ? (
                          <Toggle checked={!!pb.enabled} onChange={v=>setPB(pi,"enabled",v)} />
                        ) : (
                          <button onClick={onUpgrade} style={{padding:"5px 10px",background:`${C.ora}10`,color:C.ora,border:`1.5px dashed ${C.ora}66`,borderRadius:8,fontSize:11,fontWeight:800}}>🔒 Réservé Premium</button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Anniversaire de l'enfant */}
                {children.length > 0 && (<>
                  <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.childBirthdays}</div>
                  <div style={{marginBottom:14,padding:"10px 12px",background:C.card,border:`1px solid ${C.bor}`,borderRadius:10}}>
                    <div style={{fontSize:12,color:C.mut,marginBottom:10,lineHeight:1.5}}>{t.childBirthdaysInfo}</div>
                    <div style={{display:"flex",gap:10,alignItems:"flex-end"}}>
                      <div style={{...fld,flex:1}}><span style={lbl}>{t.evenYears}</span>
                        <CustomSelect value={chEvenIdx} onChange={v=>updSD("evenParentIdx",+v)} options={[
                          {value:-1,label:t.allParents},
                          ...cfg.parents.map((p,pi)=>({value:pi,label:p.name||`P${pi+1}`}))
                        ]} />
                      </div>
                      <div style={{...fld,flex:1}}><span style={lbl}>{t.oddYears}</span>
                        <CustomSelect value={chOddIdx} onChange={v=>updSD("oddParentIdx",+v)} options={[
                          {value:-1,label:t.allParents},
                          ...cfg.parents.map((p,pi)=>({value:pi,label:p.name||`P${pi+1}`}))
                        ]} />
                      </div>
                    </div>
                  </div>
                </>)}

              </div>
            </div>
          );
        })()
      ) : (
      children.map((ch, chi) => {
        const chId = ch.id;
        const chSD = getChildSD(chId);
        const chCountry = getChildCountry(chId);
        // Zone effective
        const chZone = multiChild && cfg.childrenZones?.[chId]
          ? cfg.childrenZones[chId]
          : { subdivisionCode: cfg.subdivisionCode||"", zone: cfg.zone||"" };
        const chSubs = OH_SUBS_CATALOG[chCountry] || [];
        const chCurSub = chZone.subdivisionCode || "";
        // School hols for this child
        const chHols = getHolsFromData(chCountry, apiData, chCurSub||chZone.zone);
        // Open state per child
        const [chOpen, setChOpen] = [
          openHol && openHol.startsWith(chId+"::") ? openHol.slice((chId+"::").length) : null,
          (hn) => setOpenHol(hn ? chId+"::"+hn : null)
        ];
        const chGetHolDetails=()=> {
          if(multiChild) return (sd.schoolHolDetailsPerChild?.[chId]) || {};
          return sd.schoolHolDetails || {};
        };
        const chSetHolDetails=(newDet)=> {
          if(multiChild) {
            setCfg(c=>({...c, specialDates:{...c.specialDates,
              schoolHolDetailsPerChild:{...(c.specialDates.schoolHolDetailsPerChild||{}), [chId]:newDet}
            }}));
          } else {
            setCfg(c=>({...c, specialDates:{...c.specialDates, schoolHolDetails:newDet}}));
          }
        };
        const chSetHD=(hn,ds,pi)=> {
          const det={...chGetHolDetails()};
          if(pi===undefined){const copy={...(det[hn]||{})};delete copy[ds];det[hn]=copy;}
          else{det[hn]={...(det[hn]||{}),[ds]:pi};}
          chSetHolDetails(det);
        };
        const chSetZone=(subdivisionCode, zone)=> {
          if(multiChild) {
            setCfg(c=>({...c, childrenZones:{...c.childrenZones, [chId]:{subdivisionCode,zone}}}));
          } else {
            setCfg(c=>({...c, subdivisionCode, zone}));
          }
        };
        // Per-child special dates
        const chMD = chSD.motherDay || {enabled:false};
        const chFD = chSD.fatherDay || {enabled:false};
        const chPB = chSD.parentBirths || [];
        const chEvenIdx = chSD.evenParentIdx ?? 0;
        const chOddIdx = chSD.oddParentIdx ?? 1;

        return (
          <div key={chId} style={{marginBottom:16,border:`2px solid ${C.bor}`,borderRadius:16,overflow:"hidden"}}>
            {/* Enfant header */}
            <div style={{padding:"10px 14px",background:C.sur,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`}}>
              <span style={{fontSize:18}}>{ch.avatar||"🧒"}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:14,fontWeight:900,color:C.txt}}>{ch.name||`${t.childN} ${chi+1}`}</div>
                {ch.birthDay&&ch.birthMonth&&<div style={{fontSize:11,color:C.mut,fontFamily:"JetBrains Mono"}}>{ch.birthDay}/{ch.birthMonth}</div>}
              </div>
              {chCurSub && <span style={{fontSize:10,background:`${C.vio}22`,color:C.vio,padding:"2px 8px",borderRadius:6,fontWeight:700}}>📍 {chCountry==="FR" ? (chSubs.find(s=>s.code===chCurSub)?.label.match(/Zone [ABC]/)?.[0]||chCurSub) : chSubs.find(s=>s.code===chCurSub)?.label||chCurSub}</span>}
            </div>
            <div style={{padding:"14px 14px 4px"}}>

              {/* Pays */}
              <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.country}</div>
              <div style={{marginBottom:12}}>
                <CountryDropdown value={chCountry} onChange={v=>{
                  if(multiChild) setChildCountry(chId, v);
                  else setCfg(c=>({...c,country:v,activeNatHols:null,zone:"",subdivisionCode:""}));
                }} />
              </div>

              {/* Zone scolaire */}
              <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.zone} — {t.schoolYear} {syr}/{syr+1}</div>
              <div style={{marginBottom:12}}>
                {chSubs.length > 0 ? (
                  <ZoneDropdown
                    chCountry={chCountry}
                    chCurSub={chCurSub}
                    chSubs={chSubs}
                    chSetZone={chSetZone}
                    noZoneLabel={t.noZone}
                    locked={!perms?.zoneChoice}
                  />
                ) : (
                  <div style={{fontSize:12,color:C.mut,fontStyle:"italic"}}>{t.noZone} — {chCountry}</div>
                )}
              </div>

              {/* Vacances scolaires */}
              {chHols.length > 0 && (
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.schoolHols}</div>
                  {chHols.map((hol,hi)=>{
                    const isOpen = chOpen === hol.n;
                    const det = chGetHolDetails()[hol.n]||{};
                    const days = daysRange(hol.s,hol.e);
                    const assignedCount = Object.keys(det).length;
                    return (
                      <div key={hi} style={{marginBottom:6,border:`1.5px solid ${C.bor}`,borderRadius:10,overflow:"hidden"}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 11px",background:C.sur,cursor:"pointer"}} onClick={e=>{const s=nearestScroller(e.currentTarget);const restore=lockScroll(s);setChOpen(isOpen?null:hol.n);requestAnimationFrame(restore);}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontWeight:700,fontSize:12,color:C.grn}}>🌿 {hol.n}</span>
                            <span style={{fontSize:10,color:C.mut,fontFamily:"JetBrains Mono"}}>{hol.s.slice(8)}/{hol.s.slice(5,7)} → {hol.e.slice(8)}/{hol.e.slice(5,7)}</span>
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            {assignedCount>0 && <span style={{fontSize:10,background:`${C.grn}22`,color:C.grn,padding:"2px 6px",borderRadius:6,fontWeight:700}}>{assignedCount}/{days.length}j</span>}
                            <span style={{color:C.vio,fontSize:10}}>{isOpen?"▲":"▼"}</span>
                          </div>
                        </div>
                        {isOpen && (
                          <div style={{padding:"10px 11px"}}>
                            <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                              {cfg.parents.map((p,pi)=>(
                                <button key={pi} onClick={()=>{const base=chGetHolDetails();const newDet={...base,[hol.n]:{...(base[hol.n]||{})}};days.forEach(d2=>{newDet[hol.n][d2]=pi;});chSetHolDetails(newDet);}} style={{padding:"4px 10px",background:`${p.color}22`,color:p.color,border:`1.5px solid ${p.color}`,borderRadius:20,fontSize:11,fontWeight:700}}>Tout → {p.name||`P${pi+1}`}</button>
                              ))}
                              <button onClick={()=>{const base=chGetHolDetails();chSetHolDetails({...base,[hol.n]:{}});}} style={{padding:"4px 8px",background:"transparent",color:C.mut,border:`1px solid ${C.bor}`,borderRadius:20,fontSize:11}}>Effacer</button>
                            </div>
                            {(()=>{
                              const weeks=[];let week=[];
                              days.forEach(ds2=>{
                                const d2=new Date(ds2+"T12:00:00");
                                const dw2=dow(d2.getFullYear(),d2.getMonth(),d2.getDate());
                                week.push({ds:ds2,dw:dw2});
                                if(dw2===6||ds2===days[days.length-1]){weeks.push(week);week=[];}
                              });
                              return weeks.map((wk,wi)=>{
                                const wkPiCounts={};
                                wk.forEach(({ds})=>{const pi=det[ds];if(pi!==undefined)wkPiCounts[pi]=(wkPiCounts[pi]||0)+1;});
                                const totalAssigned=Object.values(wkPiCounts).reduce((a,b)=>a+b,0);
                                const dominantPi=Object.keys(wkPiCounts).length===1?Number(Object.keys(wkPiCounts)[0]):undefined;
                                const wkLabel=`${wk[0].ds.slice(8)}/${wk[0].ds.slice(5,7)} → ${wk[wk.length-1].ds.slice(8)}/${wk[wk.length-1].ds.slice(5,7)}`;
                                const wkColor=dominantPi!==undefined?cfg.parents[dominantPi]?.color:C.bor;
                                return (
                                  <WeekRow key={wi} wk={wk} wkPiCounts={wkPiCounts} dominantPi={dominantPi} wkColor={wkColor} wkLabel={wkLabel}
                                    hol={hol} det={det} chGetHolDetails={chGetHolDetails} chSetHolDetails={chSetHolDetails} chSetHD={chSetHD}
                                    cfg={cfg} C={C} t={t} />
                                );
                              });
                            })()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Fêtes mères/pères */}
              <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.stepDates}</div>
              <div style={{marginBottom:12,border:`1px solid ${C.bor}`,borderRadius:10,overflow:"hidden"}}>
                {[{k:"motherDay",l:t.motherDay,d:t.motherDayInfo,val:chMD},{k:"fatherDay",l:t.fatherDay,d:t.fatherDayInfo,val:chFD}].map(({k,l,d,val},ki)=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderBottom:ki===0?`1px solid ${C.bor}`:"none",background:C.card}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                        {l}{!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`}}>🔒 Réservé Premium</span>}
                      </div>
                      <div style={{fontSize:11,color:C.mut}}>{d}</div>
                    </div>
                    {prem ? (
                      <Toggle checked={!!val?.enabled} onChange={v=>setChildSD(chId,k,{enabled:v})} />
                    ) : (
                      <button onClick={onUpgrade} style={{padding:"5px 10px",background:`${C.ora}10`,color:C.ora,border:`1.5px dashed ${C.ora}66`,borderRadius:8,fontSize:11,fontWeight:800}}>🔒 Réservé Premium</button>
                    )}
                  </div>
                ))}
              </div>

              {/* Anniversaires des parents */}
              <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.parentBirthdays}</div>
              <div style={{marginBottom:12,border:`1px solid ${C.bor}`,borderRadius:10,overflow:"hidden"}}>
                {cfg.parents.map((p,pi)=>{
                  const pb = chPB[pi] || {enabled:false,parentIdx:pi};
                  return (
                    <div key={pi} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderBottom:pi<cfg.parents.length-1?`1px solid ${C.bor}`:"none",background:C.card}}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                          <span style={{width:8,height:8,borderRadius:"50%",background:p.color,flexShrink:0}}/>
                          🎂 {p.name||`${t.parentN} ${pi+1}`}
                          {p.birthDay&&p.birthMonth&&<span style={{fontSize:11,color:C.mut,fontFamily:"JetBrains Mono"}}>{p.birthDay}/{p.birthMonth}</span>}
                          {!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`}}>🔒 Réservé Premium</span>}
                        </div>
                        <div style={{fontSize:11,color:C.mut}}>{t.forced||"Garde forcée"}</div>
                      </div>
                      {prem ? (
                        <Toggle checked={!!pb.enabled} onChange={v=>setChildPB(chId,pi,"enabled",v)} />
                      ) : (
                        <button onClick={onUpgrade} style={{padding:"5px 10px",background:`${C.ora}10`,color:C.ora,border:`1.5px dashed ${C.ora}66`,borderRadius:8,fontSize:11,fontWeight:800}}>🔒 Réservé Premium</button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Anniversaire de cet enfant */}
              <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{t.childBirthdays}</div>
              <div style={{marginBottom:14,padding:"10px 12px",background:C.card,border:`1px solid ${C.bor}`,borderRadius:10}}>
                <div style={{fontSize:12,color:C.mut,marginBottom:10,lineHeight:1.5}}>{t.childBirthdaysInfo}</div>
                <div style={{display:"flex",gap:10,alignItems:"flex-end"}}>
                  <div style={{...fld,flex:1}}>
                    <span style={lbl}>{t.evenYears}</span>
                    <CustomSelect value={chEvenIdx} onChange={v=>setChildCB(chId,"evenParentIdx",+v)} options={[
                      {value:-1,label:t.allParents},
                      ...cfg.parents.map((p,pi)=>({value:pi,label:p.name||`P${pi+1}`}))
                    ]} />
                  </div>
                  <div style={{...fld,flex:1}}>
                    <span style={lbl}>{t.oddYears}</span>
                    <CustomSelect value={chOddIdx} onChange={v=>setChildCB(chId,"oddParentIdx",+v)} options={[
                      {value:-1,label:t.allParents},
                      ...cfg.parents.map((p,pi)=>({value:pi,label:p.name||`P${pi+1}`}))
                    ]} />
                  </div>
                </div>
              </div>

            </div>
          </div>
        );
      }))}

      {/* Custom dates — locked */}
      <div className="card" style={{position:"relative"}}>
        <div className="sec">{t.customDates} {!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`,marginLeft:4}}>🔒 Réservé Premium</span>}</div>
        {!prem&&(
          <div style={{borderRadius:10,background:`${C.bg}cc`,backdropFilter:"blur(3px)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,zIndex:2,cursor:"pointer",padding:"24px 16px"}} onClick={onUpgrade}>
            <div style={{fontSize:24}}>🔒</div>
            <div style={{fontWeight:800,fontSize:14,color:C.txt}}>{t.lockSection}</div>
            <div style={{fontSize:12,color:C.mut,textAlign:"center",padding:"0 20px"}}>{t.lockDesc}</div>
            <button style={{height:44,padding:"0 20px",background:C.ora,color:"#fff",borderRadius:10,fontSize:13}}>{t.seeOffers}</button>
          </div>
        )}
        {(cfg.specialDates?.custom||[]).map((cd,i)=>{
          const updCd=(field,val)=>{
            setCfg(prev=>{
              const arr=[...(prev.specialDates?.custom||[])];
              arr[i]={...arr[i],[field]:val};
              return {...prev,specialDates:{...prev.specialDates,custom:arr}};
            });
          };
          const children = cfg.children.length > 0 ? cfg.children : [];
          const parents = cfg.parents.length > 0 ? cfg.parents : [];
          return (
            <div key={i} style={{marginBottom:12,padding:"12px",background:C.sur,borderRadius:10,border:`1.5px solid ${C.bor}`}}>
              {/* Header */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:12,fontWeight:800,color:C.vio}}>📌 Date {i+1}</div>
                <button onClick={()=>{if(!prem)return;setCfg(prev=>{const arr=[...(prev.specialDates?.custom||[])];arr.splice(i,1);return {...prev,specialDates:{...prev.specialDates,custom:arr}};});}} style={{padding:"3px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:11}}>✕</button>
              </div>
              {/* Label */}
              <div style={{...fld,marginBottom:10}}>
                <span style={lbl}>Nom de l'événement</span>
                <input value={cd.label||""} onChange={e=>updCd("label",e.target.value)} placeholder="Ex: Vacances ski, Mariage..." disabled={!prem} style={inp} />
              </div>
              {/* Date row */}
              <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:10}}>
                <div style={{...fld,flex:1}}>
                  <span style={lbl}>Jour</span>
                  <input type="number" min="1" max="31" value={cd.day||""} onChange={e=>updCd("day",e.target.value)} placeholder={t.dayPlaceholder||"JJ"} disabled={!prem} style={inp} />
                </div>
                <div style={{...fld,flex:2}}>
                  <span style={lbl}>Mois</span>
                  <select value={cd.month||""} onChange={e=>updCd("month",e.target.value)} disabled={!prem} style={inp}>
                    <option value="">--</option>
                    {t.months.map((m,j)=><option key={j} value={pad(j+1)}>{m}</option>)}
                  </select>
                </div>
                <div style={{...fld,flex:1}}>
                  <span style={lbl}>Année</span>
                  <input type="number" min="2020" max="2099" value={cd.year||""} onChange={e=>updCd("year",e.target.value)} placeholder={cd.yearly?"—":new Date().getFullYear()} disabled={!prem||cd.yearly} style={{...inp,opacity:cd.yearly?0.4:1}} />
                </div>
              </div>
              {/* Who has custody */}
              <div className="field">
                <label className="lbl">🧒 Concerne</label>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  <button onClick={()=>updCd("childId","all")} style={{padding:"6px 14px",background:(!cd.childId||cd.childId==="all")?C.vio:C.sur,color:(!cd.childId||cd.childId==="all")?"#fff":C.mut,border:`1.5px solid ${(!cd.childId||cd.childId==="all")?C.vio:C.bor}`,borderRadius:20,fontSize:12,fontWeight:700}}>
                    Tous
                  </button>
                  {children.map(ch=>(
                    <button key={ch.id} onClick={()=>updCd("childId",String(ch.id))} style={{padding:"6px 14px",background:cd.childId===String(ch.id)?C.vio:C.sur,color:cd.childId===String(ch.id)?"#fff":C.mut,border:`1.5px solid ${cd.childId===String(ch.id)?C.vio:C.bor}`,borderRadius:20,fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:4}}>
                      {ch.avatar&&<span>{ch.avatar}</span>}{ch.name||`Enfant ${ch.id}`}
                    </button>
                  ))}
                </div>
              </div>
              {/* Which parent */}
              <div className="field">
                <label className="lbl">👤 Garde chez</label>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {parents.map(p=>(
                    <button key={p.id} onClick={()=>updCd("parentId",String(p.id))} style={{flex:1,minWidth:80,padding:"9px",background:cd.parentId===String(p.id)?p.color:C.sur,color:cd.parentId===String(p.id)?"#fff":C.mut,border:`2px solid ${cd.parentId===String(p.id)?p.color:C.bor}`,borderRadius:10,fontSize:13,fontWeight:800,display:"flex",alignItems:"center",gap:6,justifyContent:"center"}}>
                      {p.avatar&&<span style={{fontSize:18}}>{p.avatar}</span>}{p.name||`Parent ${p.id}`}
                    </button>
                  ))}
                </div>
              </div>
              {/* Yearly recurrence */}
              <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13}}>
                <input type="checkbox" checked={!!cd.yearly} onChange={e=>updCd("yearly",e.target.checked)} />
                <span>🔁 Reconduire tous les ans</span>
              </label>
            </div>
          );
        })}
        <button onClick={()=>prem?setCfg(c=>({...c,specialDates:{...c.specialDates,custom:[...(c.specialDates.custom||[]),{label:"",day:"",month:"",year:"",parentIdx:0,childIdx:"all",yearly:false}]}})):onUpgrade()} style={{width:"100%",height:44,padding:"0 16px",background:"transparent",color:prem?C.vio:C.mut,border:`1.5px dashed ${prem?C.vio:C.bor}`,fontSize:13}}>
          {prem?t.addDate:`🔒 ${t.addDate} — Premium`}
        </button>
      </div>
    </div>
  );
}

// ─── STEP 3: CUSTODY ─────────────────────────────────────────────────────────
function StepGarde() {
  const {C,t,cfg,setCfg,addHist,pushNotif} = useApp();
  const {parents} = cfg;
  const children = cfg.children || [];

  // ── Sélecteur d'enfant (actif seulement si sameGuardAll=false) ─────────────
  const multiChild = !cfg.sameGuardAll && children.length > 1;
  const [selChildId, setSelChildId] = useState(children[0]?.id || null);

  // Charger le bon planning selon le mode
  function loadCustody(childId) {
    if(!cfg.sameGuardAll && childId && cfg.custodyPerChild?.[childId]) {
      return cfg.custodyPerChild[childId];
    }
    return cfg.custody;
  }

  const activeCustody = loadCustody(multiChild ? selChildId : null);

  const D14=Array.from({length:14},(_,i)=>({label:t.dayShort[i%7],name:t.dayNames[i%7],num:i+1,we:i>=5&&i<=6||i>=12}));
  const [type,setType]=useState(activeCustody.type||"weekAlt");
  const [wA,setWA]=useState(activeCustody.weekAlt||{evenIdx:0});
  const [ex,setEx]=useState(activeCustody.exclusive||{mainIdx:0,weIdx:1,parity:"even"});
  const [pat,setPat]=useState(()=>activeCustody.pattern.length?[...activeCustody.pattern]:D14.map(()=>({parentIdx:undefined,timeType:"full",startTime:"",endTime:"",location:""})));
  const [confirmed,setConfirmed]=useState(activeCustody.confirmed);

  // ── Re-synchronisation automatique depuis cfg (ex: MAJ Supabase depuis l'autre parent) ──
  const prevCustodyRef = useRef(activeCustody);
  useEffect(() => {
    const fresh = loadCustody(multiChild ? selChildId : null);
    const prev = prevCustodyRef.current;
    // On ne ré-injecte que si cfg a vraiment changé (comparaison par JSON pour éviter les boucles)
    if (JSON.stringify(fresh) !== JSON.stringify(prev)) {
      prevCustodyRef.current = fresh;
      setType(fresh.type||"weekAlt");
      setWA(fresh.weekAlt||{evenIdx:0});
      setEx(fresh.exclusive||{mainIdx:0,weIdx:1,parity:"even"});
      setPat(fresh.pattern?.length?[...fresh.pattern]:D14.map(()=>({parentIdx:undefined,timeType:"full",startTime:"",endTime:"",location:""})));
      setConfirmed(fresh.confirmed||false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, selChildId]);

  // Rechargement quand on change d'enfant
  function switchChild(childId) {
    // Sauvegarder l'enfant courant avant de switcher
    if(selChildId && selChildId !== childId) {
      const draft = { type, weekAlt:wA, exclusive:ex, pattern:pat, confirmed, startMonth:cfg.custody.startMonth, startYear:cfg.custody.startYear };
      setCfg(c=>({...c, custodyPerChild:{...c.custodyPerChild, [selChildId]:draft}}));
    }
    // Charger l'enfant suivant
    setSelChildId(childId);
    const c = loadCustody(childId);
    setType(c.type||"weekAlt");
    setWA(c.weekAlt||{evenIdx:0});
    setEx(c.exclusive||{mainIdx:0,weIdx:1,parity:"even"});
    setPat(c.pattern?.length?[...c.pattern]:D14.map(()=>({parentIdx:undefined,timeType:"full",startTime:"",endTime:"",location:""})));
    setConfirmed(c.confirmed||false);
  }

  function setDay(idx,pi){
    setPat(prev=>{
      const next=[...prev];next[idx]={...next[idx],parentIdx:pi};
      const last=prev.reduce((acc,d,i)=>(d?.parentIdx===pi&&i<idx?i:acc),-1);
      if(last>=0) for(let j=last+1;j<idx;j++) if(next[j]?.parentIdx===undefined) next[j]={...next[j],parentIdx:pi};
      return next;
    });
  }

  function confirm(){
    const newCustody = {
      ...(multiChild ? (cfg.custodyPerChild?.[selChildId]||cfg.custody) : cfg.custody),
      type, weekAlt:wA, exclusive:ex, pattern:pat, confirmed:true
    };
    if(multiChild && selChildId) {
      setCfg(c=>({...c, custodyPerChild:{...c.custodyPerChild,[selChildId]:newCustody}}));
      const childName = children.find(ch=>ch.id===selChildId)?.name||"Enfant";
      addHist(t.stepGarde, childName, "cal");
      pushNotif(`📆 Planning de ${childName} confirmé`);
    } else {
      setCfg(c=>({...c, custody:newCustody}));
      addHist(t.stepGarde,"","cal"); pushNotif("📆 "+t.confirmed);
    }
    setConfirmed(true);
  }
  return (
    <div>
      {/* ── Sélecteur d'enfant (mode garde individuelle) ──────────────────── */}
      {multiChild && (
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:8}}>
            Planning de garde pour :
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {children.map(ch=>{
              const hasCustody = cfg.custodyPerChild?.[ch.id]?.confirmed;
              return (
                <button key={ch.id} onClick={()=>switchChild(ch.id)}
                  style={{padding:"7px 14px",background:selChildId===ch.id?C.vio:C.sur,
                    color:selChildId===ch.id?"#fff":C.mut,
                    border:`1.5px solid ${selChildId===ch.id?C.vio:C.bor}`,
                    borderRadius:10,fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                  {ch.name||`Enfant`}
                  {hasCustody
                    ? <span style={{fontSize:10,background:"#fff3",borderRadius:4,padding:"1px 5px"}}>✅</span>
                    : <span style={{fontSize:10,opacity:.6}}>⏳</span>
                  }
                </button>
              );
            })}
          </div>
          {cfg.custodyPerChild && Object.keys(cfg.custodyPerChild).length > 0 && (
            <div style={{marginTop:8,fontSize:11,color:C.mut,fontStyle:"italic"}}>
              {Object.keys(cfg.custodyPerChild).length}/{children.length} enfant(s) configuré(s)
            </div>
          )}
        </div>
      )}

      {!cfg.sameGuardAll && !multiChild && children.length === 1 && (
        <div style={{marginBottom:12,padding:"8px 12px",background:`${C.vio}10`,border:`1px solid ${C.vio}22`,borderRadius:10,fontSize:12,color:C.mut}}>
          📋 Planning individuel activé pour <strong style={{color:C.txt}}>{children[0]?.name||"l'enfant"}</strong>
        </div>
      )}

      <div className="sec">{t.patternTitle}</div>
      <div className="card" style={{marginBottom:14}}>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
          <div style={{display:"flex",gap:8}}>
            {[["weekAlt",t.patWeekAlt],["exclusive",t.patExclusive]].map(([tp,lb])=>(
              <button key={tp} onClick={()=>{setType(tp);setConfirmed(false);}} style={{flex:1,padding:"12px 10px",background:type===tp?C.vio:C.sur,color:type===tp?"#fff":C.mut,border:`1.5px solid ${type===tp?C.vio:C.bor}`,borderRadius:10,fontSize:12,fontWeight:700,textAlign:"center"}}>{lb}</button>
            ))}
          </div>
          <button onClick={()=>{setType("custom");setConfirmed(false);}} style={{width:"100%",padding:"12px 14px",background:type==="custom"?C.vio:C.sur,color:type==="custom"?"#fff":C.mut,border:`1.5px solid ${type==="custom"?C.vio:C.bor}`,borderRadius:10,fontSize:13,fontWeight:700,textAlign:"left"}}>{t.patCustom}</button>
        </div>

        {type==="weekAlt"&&(
          <div className="fi" style={{background:C.bg,borderRadius:10,padding:14,marginBottom:14}}>
            <div style={{fontSize:12,color:C.mut,marginBottom:10,fontWeight:700}}>{t.patWeekAltQ}</div>
            <div style={{display:"flex",gap:8}}>
              {parents.map((p,pi)=>(
                <button key={pi} onClick={()=>setWA({evenIdx:pi})} style={{flex:1,padding:"9px",background:wA.evenIdx===pi?p.color:C.sur,color:wA.evenIdx===pi?"#fff":C.mut,border:`2px solid ${wA.evenIdx===pi?p.color:C.bor}`,borderRadius:10,fontWeight:700}}>
                  {p.name||`P${pi+1}`}
                </button>
              ))}
            </div>
            <div style={{marginTop:10,fontSize:12,color:C.mut,padding:"8px 12px",background:`${C.vio}11`,borderRadius:8}}>
              <strong style={{color:C.vio}}>{parents[wA.evenIdx]?.name||`P${wA.evenIdx+1}`}</strong> → {t.evenWeek} | <strong style={{color:parents[1-wA.evenIdx]?.color}}>{parents[1-wA.evenIdx]?.name||`P${2-wA.evenIdx}`}</strong> → {t.oddWeek}
            </div>
          </div>
        )}

        {type==="exclusive"&&(
          <div className="fi" style={{background:C.bg,borderRadius:10,padding:14,marginBottom:14}}>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:12,color:C.mut,marginBottom:8,fontWeight:700}}>{t.patExcMainQ}</div>
              <div style={{display:"flex",gap:8}}>{parents.map((p,pi)=>(
                <button key={pi} onClick={()=>setEx(e=>({...e,mainIdx:pi}))} style={{flex:1,padding:"9px",background:ex.mainIdx===pi?p.color:C.sur,color:ex.mainIdx===pi?"#fff":C.mut,border:`2px solid ${ex.mainIdx===pi?p.color:C.bor}`,borderRadius:10,fontWeight:700}}>{p.name||`P${pi+1}`}</button>
              ))}</div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:12,color:C.mut,marginBottom:8,fontWeight:700}}>{t.patExcWEQ}</div>
              <div style={{display:"flex",gap:8}}>{parents.map((p,pi)=>(
                <button key={pi} onClick={()=>setEx(e=>({...e,weIdx:pi}))} style={{flex:1,padding:"9px",background:ex.weIdx===pi?p.color:C.sur,color:ex.weIdx===pi?"#fff":C.mut,border:`2px solid ${ex.weIdx===pi?p.color:C.bor}`,borderRadius:10,fontWeight:700}}>{p.name||`P${pi+1}`}</button>
              ))}</div>
            </div>
            <div>
              <div style={{fontSize:12,color:C.mut,marginBottom:8,fontWeight:700}}>{t.patExcParityQ}</div>
              <div style={{display:"flex",gap:8}}>
                {[["even",t.evenWeek],["odd",t.oddWeek]].map(([v,lb])=>(
                  <button key={v} onClick={()=>setEx(e=>({...e,parity:v}))} style={{flex:1,padding:"9px",background:ex.parity===v?C.vio:C.sur,color:ex.parity===v?"#fff":C.mut,border:`1.5px solid ${ex.parity===v?C.vio:C.bor}`,borderRadius:10,fontWeight:700,fontSize:13}}>{lb}</button>
                ))}
              </div>
            </div>
            <div style={{marginTop:12,fontSize:12,color:C.mut,padding:"8px 12px",background:`${C.vio}11`,borderRadius:8,lineHeight:1.7}}>
              📋 <strong style={{color:C.vio}}>{parents[ex.mainIdx]?.name||`P${ex.mainIdx+1}`}</strong> — semaine<br/>
              🏠 <strong style={{color:parents[ex.weIdx]?.color}}>{parents[ex.weIdx]?.name||`P${ex.weIdx+1}`}</strong> — WE {ex.parity==="even"?t.evenWeek:t.oddWeek}
            </div>
          </div>
        )}

        {type==="custom"&&(
          <div className="fi">
            <div style={{overflowX:"auto"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(14,1fr)",gap:3,minWidth:520,marginBottom:4}}>
                <div style={{gridColumn:"1 / span 7",textAlign:"center",fontSize:9,fontWeight:800,color:C.vio,background:`${C.vio}12`,borderRadius:6,padding:"3px 0",textTransform:"uppercase",letterSpacing:".05em"}}>{t.evenWeek}</div>
                <div style={{gridColumn:"8 / span 7",textAlign:"center",fontSize:9,fontWeight:800,color:C.blu,background:`${C.blu}12`,borderRadius:6,padding:"3px 0",textTransform:"uppercase",letterSpacing:".05em"}}>{t.oddWeek}</div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(14,1fr)",gap:3,minWidth:520}}>
                {D14.map((d,i)=>(
                  <div key={i} style={{textAlign:"center"}}>
                    <div style={{fontSize:9,color:d.we?C.yel:C.mut,marginBottom:3,fontFamily:"JetBrains Mono",fontWeight:700,lineHeight:1.2}}>{d.label}<br/><span style={{fontSize:8}}>{d.num}</span></div>
                    {parents.map((p,pi)=>(
                      <button key={pi} onClick={()=>setDay(i,pi)} style={{width:"100%",padding:"4px 1px",marginBottom:2,background:pat[i]?.parentIdx===pi?p.color:C.sur,color:pat[i]?.parentIdx===pi?"#fff":C.mut,border:`1.5px solid ${pat[i]?.parentIdx===pi?p.color:C.bor}`,borderRadius:6,fontSize:8,fontWeight:800}}>
                        {p.name?p.name.split(" ")[0].slice(0,4):`P${pi+1}`}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            {D14.map((d,i)=>pat[i]?.parentIdx!==undefined&&(
              <div key={i} style={{display:"flex",gap:6,alignItems:"center",marginBottom:6,padding:"6px",background:C.bg,borderRadius:8,marginTop:i===0?12:0}}>
                <span style={{fontFamily:"JetBrains Mono",fontSize:10,color:C.mut,minWidth:30}}>{d.label}{d.num}</span>
                <span style={{width:8,height:8,borderRadius:"50%",background:parents[pat[i].parentIdx]?.color,flexShrink:0}} />
                <select value={pat[i]?.timeType||"full"} onChange={e=>{const p=[...pat];p[i]={...p[i],timeType:e.target.value};setPat(p);}} style={{flex:1,fontSize:11}}>
                  <option value="full">{t.wholeDay}</option><option value="start">{t.pickup}</option><option value="end">{t.dropoff}</option><option value="split">{t.both}</option>
                </select>
                {(pat[i]?.timeType==="start"||pat[i]?.timeType==="split")&&<input type="time" value={pat[i]?.startTime||""} onChange={e=>{const p=[...pat];p[i]={...p[i],startTime:e.target.value};setPat(p);}} style={{flex:1,fontSize:11}} />}
                {(pat[i]?.timeType==="end"||pat[i]?.timeType==="split")&&<input type="time" value={pat[i]?.endTime||""} onChange={e=>{const p=[...pat];p[i]={...p[i],endTime:e.target.value};setPat(p);}} style={{flex:1,fontSize:11}} />}
                {pat[i]?.timeType!=="full"&&<input value={pat[i]?.location||""} onChange={e=>{const p=[...pat];p[i]={...p[i],location:e.target.value};setPat(p);}} placeholder={t.place} style={{flex:2,fontSize:11}} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {!confirmed?(
        <div className="card" style={{borderColor:C.yel}}>
          <div style={{fontSize:13,color:C.yel,marginBottom:12}}>⚠️ {t.confirmQ}</div>
          <button onClick={confirm} style={{height:44,padding:"0 24px",background:C.grn,color:"#fff",borderRadius:10}}>{t.confirmBtn}</button>
        </div>
      ):(
        <div className="card" style={{borderColor:C.grn,display:"flex",alignItems:"center",gap:10}}>
          <span style={{color:C.grn,fontSize:20}}>✓</span>
          <span style={{color:C.grn,fontWeight:700}}>{t.confirmed}</span>
          <button onClick={()=>setConfirmed(false)} style={{marginLeft:"auto",height:36,padding:"0 14px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>{t.editModel}</button>
        </div>
      )}
    </div>
  );
}

// ─── WEEK ROW (school holidays) ───────────────────────────────────────────────
function WeekRow({wk, wkPiCounts, dominantPi, wkColor, wkLabel, hol, det, chGetHolDetails, chSetHolDetails, chSetHD, cfg, C, t}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{marginBottom:6,border:`1.5px solid ${wkColor}`,borderRadius:10,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 10px",background:dominantPi!==undefined?`${wkColor}15`:C.sur}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,fontWeight:800,color:C.txt,fontFamily:"JetBrains Mono"}}>{wkLabel}</span>
          <span style={{fontSize:10,color:C.mut}}>{wk.length}j</span>
        </div>
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          {cfg.parents.map((p,pi)=>(
            <button key={pi}
              onClick={()=>{const base=chGetHolDetails();const nd={...base,[hol.n]:{...(base[hol.n]||{})}};wk.forEach(({ds})=>{nd[hol.n][ds]=pi;});chSetHolDetails(nd);setOpen(false);}}
              style={{padding:"3px 9px",background:wkPiCounts[pi]===wk.length?p.color:`${p.color}22`,color:wkPiCounts[pi]===wk.length?"#fff":p.color,border:`1.5px solid ${p.color}`,borderRadius:20,fontSize:11,fontWeight:800}}>
              {p.name?p.name.split(" ")[0].slice(0,6):`P${pi+1}`}
            </button>
          ))}
          <button onClick={()=>setOpen(o=>!o)}
            style={{padding:"3px 8px",background:open?`${C.vio}18`:"transparent",color:open?C.vio:C.mut,border:`1.5px solid ${open?C.vio:C.bor}`,borderRadius:20,fontSize:10,fontWeight:700}}>
            {open?"▲":"✏️"}
          </button>
        </div>
      </div>
      {open && (
        <div style={{display:"flex",gap:0,background:C.bg,borderTop:`1px solid ${C.bor}`}}>
          {wk.map(({ds,dw},di)=>{
            const aPi=det[ds];
            const aP=aPi!==undefined?cfg.parents[aPi]:null;
            const isWE=dw>=5;
            const cycleDay=()=>{
              const next=aPi===undefined?0:aPi<cfg.parents.length-1?aPi+1:undefined;
              chSetHD(hol.n,ds,next);
            };
            return (
              <div key={ds} onClick={cycleDay}
                style={{flex:1,padding:"8px 4px",textAlign:"center",cursor:"pointer",background:aP?`${aP.color}22`:"transparent",borderRight:di<wk.length-1?`1px solid ${C.bor}`:"none",transition:"background .12s"}}>
                <div style={{fontSize:9,fontWeight:800,color:isWE?C.yel:C.mut,marginBottom:2}}>{t.dayShort[dw]}</div>
                <div style={{fontSize:9,color:C.mut,fontFamily:"JetBrains Mono",marginBottom:4}}>{ds.slice(8)}</div>
                <div style={{width:22,height:22,borderRadius:"50%",margin:"0 auto",background:aP?aP.color:C.bor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800,color:aP?"#fff":C.sur}}>
                  {aP?(aP.name?aP.name[0].toUpperCase():"P"):"?"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── STEP 4: ACCESS ───────────────────────────────────────────────────────────
function StepAccess() {
  const {C,t,cfg,setCfg,pushNotif,prem,perms,onUpgrade,user,familySync,isObs,isChild} = useApp();
  const [creatingFamily,setCreatingFamily] = useState(false);
  const [pendingActionId,setPendingActionId] = useState(null);
  useEffect(()=>{ familySync.refreshPendingMembers(); },[familySync.familyId]);
  const [email,setEmail]=useState("");
  const [phone,setPhone]=useState("");
  const [role,setRole]=useState("grandparent");
  const [sent,setSent]=useState(false);
  const [canGuard,setCanGuard]=useState(false);
  const [copied,setCopied]=useState(false);
  const [lastCode,setLastCode]=useState(null);
  const obs=cfg.observers||[];
  const pending=obs.filter(o=>o.status==="pending");
  const active=obs.filter(o=>!o.status||o.status==="active");
  const rl={grandparent:t.grandparent,"uncle-aunt":t.uncleAunt,sibling:t.sibling,childcare:t.childcareRole,other:t.otherFamily};

  // Nettoie le numéro pour WhatsApp (supprime espaces/tirets, gère le 0 → 33)
  function cleanPhoneWA(p) {
    if (!p) return null;
    let c = p.replace(/[\s.\-()+]/g, "");
    if (c.startsWith("00")) c = c.slice(2);
    else if (c.startsWith("0")) c = "33" + c.slice(1);
    return c || null;
  }

  // Generate a single-use invite code tied to this family
  function makeInviteCode(){ return `OBS-${Math.random().toString(36).slice(2,8).toUpperCase()}`; }

  function sendInvite(){
    if(!email && !phone) return;
    const code=makeInviteCode();
    const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString(); // 24h expiry
    // Encode payload in base64 — family code not visible in the URL
    const payload=btoa(JSON.stringify({code,role:"observer",family:cfg.shareCode,email:email||"",expiresAt}));
    const inviteUrl=`https://app.duvia.fr/?inv=${payload}`;
    // Store pending invite code so we can validate it on registration
    setCfg(c=>({...c,pendingInvites:[...(c.pendingInvites||[]),{code,email,phone,role,canGuard,createdAt:new Date().toISOString(),expiresAt,used:false}]}));
    setSent(inviteUrl);
    setLastCode(code);
  }

  const inviteMsg = (url) =>
    `Bonjour 👋\n${(cfg.parents?.[0]?.name)||""} t'invite à rejoindre la famille sur Duvia en tant qu'observateur.\nCrée ton compte ici :\n${url}`;

  function handleSendEmail(){
    if(!sent) return;
    const subject = encodeURIComponent("Rejoins notre famille sur Duvia 👨‍👩‍👧");
    const body    = encodeURIComponent(inviteMsg(sent));
    const a = document.createElement("a");
    a.href = `mailto:${email||""}?subject=${subject}&body=${body}`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function handleSendSMS(){
    if(!sent) return;
    const p = phone ? phone.replace(/[\s.\-()+]/g,"") : "";
    window.open(`sms:${p}?&body=${encodeURIComponent(inviteMsg(sent))}`, "_blank");
  }

  function handleSendWhatsApp(){
    if(!sent) return;
    const p = cleanPhoneWA(phone);
    window.open(`https://wa.me/${p||""}?text=${encodeURIComponent(inviteMsg(sent))}`, "_blank");
  }

  // DEMO ONLY — simulate the invited person opening the link and registering,
  // so the "pending approval" flow can be tested end-to-end without a backend.
  function simulateObsJoin(){
    if(!lastCode) return;
    setCfg(c=>{
      const invite=(c.pendingInvites||[]).find(inv=>inv.code===lastCode && !inv.used);
      if(!invite) return c;
      const newId=`obs_${Date.now()}`;
      return {
        ...c,
        observers:[...(c.observers||[]),{id:newId,name:invite.email?invite.email.split("@")[0]:(invite.phone||""),email:invite.email||"",phone:invite.phone||"",role:invite.role||"grandparent",status:"pending",inviteCode:lastCode,canGuard:invite.canGuard||false}],
        pendingInvites:c.pendingInvites.map(inv=>inv.code===lastCode?{...inv,used:true}:inv),
      };
    });
    pushNotif(t.obsDemoSimulate,"obs");
    setSent(false);
    setCopied(false);
    setLastCode(null);
  }

  function copyInvite(){
    navigator.clipboard.writeText(sent).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
  }

  function approveObs(id){
    setCfg(c=>({...c,observers:c.observers.map(o=>o.id===id?{...o,status:"active"}:o)}));
    const obs=cfg.observers.find(o=>o.id===id);
    pushNotif(`${t.obsApproved} — ${obs?.name||obs?.email}`,"obs");
  }

  function rejectObs(id){
    const obs=cfg.observers.find(o=>o.id===id);
    setCfg(c=>({...c,observers:c.observers.filter(o=>o.id!==id)}));
    pushNotif(`${obs?.name||obs?.email} — ${t.obsRejected}`,"info");
  }

  return (
    <div>
      {/* ── Mes familles (multi-familles) — parents uniquement ── */}
      {!isObs && !isChild && (
      <>
      <div className="sec">🏠 Mes familles</div>
      <div className="card" style={{marginBottom:16}}>
        {familySync.families.length > 0 && (
          <div style={{marginBottom:10}}>
            {familySync.families.map(f => (
              <div key={f.id} style={{fontSize:13,fontWeight:f.id===familySync.familyId?800:600,color:f.id===familySync.familyId?C.vio:C.txt,padding:"4px 0"}}>
                {f.id===familySync.familyId ? "📍 " : "・"}{f.label}
              </div>
            ))}
          </div>
        )}
        <button
          disabled={creatingFamily}
          onClick={async ()=>{
            if(!window.confirm("Créer une nouvelle famille distincte ? Tu pourras basculer entre tes familles depuis le menu en haut de l'app.")) return;
            setCreatingFamily(true);
            const myProfile = (typeof user?.parentIdx === "number" ? cfg.parents[user.parentIdx] : null) || {};
            const prefillParent = {
              name: myProfile.name || "",
              gender: myProfile.gender || "F",
              birthDay: myProfile.birthDay || "",
              birthMonth: myProfile.birthMonth || "",
              phone: myProfile.phone || "",
              email: user?.email || myProfile.email || "", // verrouillé : lié au compte
            };
            const res = await familySync.createNewFamily(prefillParent);
            setCreatingFamily(false);
            if(!res.ok) alert("⚠️ Erreur lors de la création de la famille.");
          }}
          style={{width:"100%",height:44,background:C.sur,color:C.vio,border:`1.5px solid ${C.vio}`,borderRadius:10,fontWeight:800,fontSize:13,cursor:creatingFamily?"not-allowed":"pointer",opacity:creatingFamily?0.6:1}}>
          {creatingFamily ? "⏳ Création…" : "➕ Créer une nouvelle famille"}
        </button>
      </div>

      <div className="sec" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span>👋 Demandes en attente</span>
        <button onClick={()=>familySync.refreshPendingMembers()} style={{background:"transparent",color:C.vio,fontSize:11,fontWeight:700,padding:"2px 8px"}}>🔄 Actualiser</button>
      </div>
      <div className="card" style={{marginBottom:16}}>
        {familySync.pendingMembers.length===0 ? (
          <div style={{fontSize:13,color:C.mut,textAlign:"center",padding:"6px 0"}}>Aucune demande en attente.</div>
        ) : familySync.pendingMembers.map(m => (
          <div key={m.userId} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${C.bor}`}}>
            <div style={{width:36,height:36,borderRadius:"50%",background:`${C.yel}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>⏳</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:800,fontSize:13}}>{m.displayName || m.email || "Parent invité"}</div>
              {m.displayName && m.email && <div style={{fontSize:10,color:C.mut}}>{m.email}</div>}
              <div style={{fontSize:11,color:C.mut}}>Souhaite rejoindre cette famille</div>
            </div>
            <button disabled={pendingActionId===m.userId} onClick={async ()=>{
              setPendingActionId(m.userId);
              const res = await familySync.validateMember(m);
              setPendingActionId(null);
              if(!res.ok) alert("⚠️ Erreur lors de la validation.");
            }} style={{padding:"7px 12px",background:C.grn,color:"#fff",borderRadius:8,fontSize:12,fontWeight:800,opacity:pendingActionId===m.userId?0.6:1}}>✅ Valider</button>
            <button disabled={pendingActionId===m.userId} onClick={async ()=>{
              if(!window.confirm("Refuser cette demande ?")) return;
              setPendingActionId(m.userId);
              const res = await familySync.rejectMember(m.userId);
              setPendingActionId(null);
              if(!res.ok) alert("⚠️ Erreur lors du refus.");
            }} style={{padding:"7px 12px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:8,fontSize:12,fontWeight:700,opacity:pendingActionId===m.userId?0.6:1}}>❌</button>
          </div>
        ))}
      </div>
      </>
      )}

      {/* ── Pending approvals ── */}
      {pending.length>0&&(
        <div style={{marginBottom:16}}>
          <div className="sec">🔔 {t.obsPendingTitle} ({pending.length})</div>
          {pending.map(o=>(
            <div key={o.id} className="card" style={{marginBottom:10,borderColor:`${C.yel}88`,background:`${C.yel}08`}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                <div style={{width:38,height:38,borderRadius:"50%",background:`linear-gradient(135deg,${C.yel},${C.ora})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>⏳</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14}}>{o.name||o.email}</div>
                  <div style={{fontSize:12,color:C.mut}}>{o.email}</div>
                  <span className="badge" style={{background:`${C.yel}22`,color:C.yel,marginTop:4,display:"inline-block"}}>{rl[o.role]||o.role} · {t.obsStatusPending}</span>
                </div>
              </div>
              <div style={{fontSize:13,color:C.mut,marginBottom:12}}>{o.name||o.email} {t.obsPendingInfo}</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>approveObs(o.id)} style={{flex:1,background:C.grn,color:"#fff",height:40,fontSize:13,fontWeight:800}}>{t.obsApprove}</button>
                <button onClick={()=>rejectObs(o.id)} style={{flex:1,background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,height:40,fontSize:13,fontWeight:700}}>{t.obsReject}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Invite form ── */}
      <div className="sec">📨 {t.obsInviteTitle}</div>
      <div className="card" style={{marginBottom:16,position:"relative"}}>
        {!prem&&<div style={{position:"absolute",inset:0,background:`${C.bg}cc`,backdropFilter:"blur(3px)",borderRadius:13,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,zIndex:5,cursor:"pointer"}} onClick={onUpgrade}><div style={{fontSize:24}}>📨</div><div style={{fontWeight:800,color:C.ora}}>🔒 {t.lockSection}</div><div style={{fontSize:11,color:C.mut}}>{t.lockDesc}</div></div>}
        {!sent?(
          <>
            <div className="field"><label className="lbl">{t.obsInviteEmail} <span style={{color:C.mut,fontWeight:400}}>({t.optional||"optionnel"})</span></label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="mamie@exemple.fr" /></div>
            <div className="field"><label className="lbl">📞 {t.obsInvitePhone||"Téléphone"} <span style={{color:C.mut,fontWeight:400}}>({t.optional||"optionnel"})</span></label><input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder={t.regPhonePlaceholder||"ex: 06 12 34 56 78"} /></div>
            <div style={{fontSize:11,color:C.mut,marginTop:-6,marginBottom:10}}>{t.obsInviteContactHint||"Renseignez au moins un moyen de contact (email ou téléphone)."}</div>
            <div className="field"><label className="lbl">{t.obsInviteType}</label>
              <CustomSelect value={role} onChange={v=>setRole(v)} options={[
                {value:"grandparent",label:t.grandparent,icon:"👴"},
                {value:"uncle-aunt",label:t.uncleAunt,icon:"👨‍👩‍👦"},
                {value:"sibling",label:t.sibling,icon:"🧑‍🤝‍🧑"},
                {value:"childcare",label:t.childcareRole,icon:"🍼"},
                {value:"other",label:t.otherFamily,icon:"🧑"},
              ]} />
            </div>
            <div onClick={()=>setCanGuard(v=>!v)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginBottom:10,background:canGuard?`#f59e0b18`:`${C.sur}`,border:`1.5px solid ${canGuard?"#f59e0b":C.bor}`,borderRadius:10,cursor:"pointer",transition:"all .15s"}}>
              <div style={{width:20,height:20,borderRadius:6,border:`2px solid ${canGuard?"#f59e0b":C.bor}`,background:canGuard?"#f59e0b":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
                {canGuard&&<span style={{color:"#fff",fontSize:13,fontWeight:900}}>✓</span>}
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:canGuard?"#f59e0b":C.txt}}>🏠 Peut être gardien</div>
                <div style={{fontSize:11,color:C.mut}}>Apparaît dans le calendrier comme option de garde</div>
              </div>
            </div>
            <button onClick={sendInvite} disabled={!email&&!phone} style={{width:"100%",height:44,background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:14,fontWeight:800,borderRadius:12,opacity:(email||phone)?1:.5}}>{t.obsInviteSend}</button>
          </>
        ):(
          <div>
            <div style={{textAlign:"center",marginBottom:14}}>
              <div style={{fontSize:28,marginBottom:6}}>✅</div>
              <div style={{fontWeight:800,fontSize:15,color:C.grn,marginBottom:4}}>{t.obsInviteSent}</div>
              <div style={{fontSize:12,color:C.mut,marginBottom:12}}>{t.obsInviteExpiry}</div>
            </div>
            <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>{t.sendInviteLink}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
              <button onClick={handleSendSMS} disabled={!phone} style={{padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:phone?"pointer":"not-allowed",opacity:phone?1:.4,background:"#25D36618",color:"#128C7E",border:"1.5px solid #25D36644"}}>💬 SMS</button>
              <button onClick={handleSendWhatsApp} disabled={!phone} style={{padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:phone?"pointer":"not-allowed",opacity:phone?1:.4,background:"#25D36618",color:"#25D366",border:"1.5px solid #25D36644"}}>📱 WhatsApp</button>
              <button onClick={handleSendEmail} disabled={!email} style={{padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:email?"pointer":"not-allowed",opacity:email?1:.4,background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`}}>✉️ Email</button>
            </div>
            <div style={{background:C.bg,borderRadius:10,padding:"10px 12px",marginBottom:10,border:`1.5px solid ${C.bor}`,display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontFamily:"JetBrains Mono",fontSize:11,color:C.vio,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sent}</span>
              <button onClick={copyInvite} style={{padding:"5px 10px",background:copied?C.grn:C.vio,color:"#fff",fontSize:11,flexShrink:0,height:32}}>{copied?t.obsInviteCopied:t.obsInviteOrCopy}</button>
            </div>
            <button onClick={()=>{setSent(false);setCopied(false);setLastCode(null);setEmail("");setPhone("");}} style={{width:"100%",height:38,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13}}>{t.addObsBtn} →</button>
            <button onClick={simulateObsJoin} style={{width:"100%",height:38,marginTop:8,background:"transparent",color:C.vio,border:`1.5px dashed ${C.vio}66`,fontSize:12,fontWeight:700,borderRadius:10}}>{t.obsDemoSimulate}</button>
          </div>
        )}
      </div>

      {/* ── Active observers list ── */}
      <div className="sec">{t.observersTitle} ({active.length})</div>
      {active.length===0?<div style={{textAlign:"center",padding:28,color:C.mut}}><div style={{fontSize:32,marginBottom:8}}>👥</div>{t.noObs}</div>:active.map(o=>(
        <div key={o.id} className="card" style={{marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:38,height:38,borderRadius:"50%",background:`linear-gradient(135deg,${C.ora},${C.pin})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>{o.role==="grandparent"?"👴":"👥"}</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:14}}>{o.name}</div>
            <div style={{fontSize:12,color:C.mut}}>{o.email}</div>
            {o.phone&&<a href={`tel:${o.phone.replace(/\s/g,"")}`} style={{fontSize:12,color:C.blu,fontWeight:700,textDecoration:"none",display:"flex",alignItems:"center",gap:4,marginTop:2}}>📞 {o.phone}</a>}
            <span className="badge" style={{background:`${C.grn}22`,color:C.grn,marginTop:4,display:"inline-block"}}>{rl[o.role]||o.role} · {t.obsStatusActive}</span>
          </div>
          <div style={{display:"flex",gap:5,flexShrink:0}}>
            {o.phone&&<a href={`tel:${o.phone.replace(/\s/g,"")}`} style={{display:"flex",alignItems:"center",justifyContent:"center",width:32,height:32,borderRadius:10,background:`${C.grn}22`,border:`1.5px solid ${C.grn}44`,textDecoration:"none",fontSize:14}}>📞</a>}
            <button onClick={()=>setCfg(c=>({...c,observers:c.observers.filter(x=>x.id!==o.id)}))} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:12}}>{t.remove}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Helper: Nth weekday of a month (weekday 0=Sun...6=Sat, n=1,2,3,-1=last)
function nthWeekday(y, month, weekday, n) {
  if (n > 0) {
    let d = new Date(y, month, 1), count = 0;
    while (count < n) { if (d.getDay() === weekday) count++; if (count < n) d.setDate(d.getDate() + 1); }
    return d;
  } else { // last
    let d = new Date(y, month + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }
}

// ─── FÊTES FAMILIALES PAR PAYS ────────────────────────────────────────────────
// Format: [month(0-based), weekday(0=Sun), nth] | {fixed:[month,day]} | null

const MOTHERS_DAY = {
  FR:  [4, 0, -1],       // dernier dimanche de mai
  BE:  [4, 0, -1],       // dernier dimanche de mai
  LU:  [4, 0, -1],       // dernier dimanche de mai
  CH:  [4, 0,  2],       // 2e dimanche de mai
  AT:  [4, 0,  2],       // 2e dimanche de mai
  DE:  [4, 0,  2],       // 2e dimanche de mai
  NL:  [4, 0,  2],       // 2e dimanche de mai
  IT:  [4, 0,  2],       // 2e dimanche de mai
  ES:  [4, 0,  1],       // 1er dimanche de mai
  PT:  [4, 0,  1],       // 1er dimanche de mai
  GB:  [2, 0,  4],       // 4e dimanche de mars (Mothering Sunday)
  IE:  [2, 0,  4],       // 4e dimanche de mars
  CA:  [4, 0,  2],       // 2e dimanche de mai
  PL:  {fixed:[4, 26]},  // 26 mai
  CZ:  [4, 0,  2],       // 2e dimanche de mai
  SK:  [4, 0,  2],       // 2e dimanche de mai
  HR:  {fixed:[4, 22]},  // 22 mai
};

const FATHERS_DAY = {
  FR:  [5, 0,  3],       // 3e dimanche de juin
  BE:  [5, 0,  2],       // 2e dimanche de juin
  LU:  [5, 0,  3],       // 3e dimanche de juin
  CH:  [5, 0,  3],       // 3e dimanche de juin
  AT:  [5, 0,  2],       // 2e dimanche de juin
  DE:  null,             // Ascension (Himmelfahrt) — calculé séparément
  NL:  [5, 0,  3],       // 3e dimanche de juin
  IT:  {fixed:[2, 19]},  // 19 mars (Saint-Joseph)
  ES:  {fixed:[2, 19]},  // 19 mars (Saint-Joseph)
  PT:  {fixed:[2, 19]},  // 19 mars
  GB:  [5, 0,  3],       // 3e dimanche de juin
  IE:  [5, 0,  3],       // 3e dimanche de juin
  CA:  [5, 0,  3],       // 3e dimanche de juin
  PL:  {fixed:[5, 23]},  // 23 juin
  CZ:  [5, 0,  3],       // 3e dimanche de juin
  SK:  [5, 0,  3],       // 3e dimanche de juin
  HR:  [5, 0,  3],       // 3e dimanche de juin
};

// Fête des grands-parents par pays
const GRANDPARENTS_DAY = {
  FR:  [2, 0,  1],       // 1er dimanche de mars
  BE:  [2, 0,  1],       // 1er dimanche de mars
  LU:  [2, 0,  1],       // 1er dimanche de mars
  IT:  {fixed:[9,  2]},  // 2 octobre
  ES:  {fixed:[7, 26]},  // 26 juillet (Saint-Joachim et Sainte-Anne)
  PT:  {fixed:[7, 26]},  // 26 juillet
  DE:  {fixed:[9,  9]},  // World Grandparents Day (ONU)
  CH:  {fixed:[9,  9]},
  AT:  {fixed:[9,  9]},
  NL:  {fixed:[9,  9]},
  GB:  [9, 0,  1],       // 1er dimanche d'octobre
  IE:  [9, 0,  1],
  CA:  [9, 0,  1],       // 1er dimanche d'octobre (après la fête du travail)
  PL:  {fixed:[0, 21]},  // 21 janvier (Dzień Babci) — grand-mère
  CZ:  {fixed:[9,  9]},
  SK:  {fixed:[9,  9]},
  HR:  {fixed:[9,  9]},
};

// Fête des grand-mères spécifique (Pologne, Russia-influenced)
const GRANDMOTHER_DAY = {
  PL: {fixed:[0, 21]},   // 21 janvier — Dzień Babci
};
const GRANDFATHER_DAY = {
  PL: {fixed:[0, 22]},   // 22 janvier — Dzień Dziadka
};

function getEventDate(y, rule) {
  if (!rule) return null;
  if (rule.fixed) return new Date(y, rule.fixed[0], rule.fixed[1]);
  const [month, weekday, nth] = rule;
  return nthWeekday(y, month, weekday, nth);
}

function getMothersDayDate(y, country) {
  const base = getEventDate(y, MOTHERS_DAY[country] || MOTHERS_DAY["FR"]);
  // 🇫🇷 Règle légale française (art. D215-1 CASF) : dernier dimanche de mai,
  // SAUF si ce dimanche coïncide avec la Pentecôte (Pâques + 49 j), auquel cas
  // la Fête des Mères est reportée au 1er dimanche de juin.
  if (country === "FR" && base) {
    const easter = easterDate(y);
    const pentecost = new Date(easter); pentecost.setDate(easter.getDate() + 49);
    if (sameDay(base, pentecost)) return nthWeekday(y, 5, 0, 1); // 1er dimanche de juin
  }
  return base;
}
function getFathersDayDate(y, country) {
  if (country === "DE") {
    // Himmelfahrt = Ascension = Pâques + 39 jours
    const easter = easterDate(y);
    const asc = new Date(easter); asc.setDate(easter.getDate() + 39);
    return asc;
  }
  return getEventDate(y, FATHERS_DAY[country]);
}
function getGrandparentsDayDate(y, country) {
  return getEventDate(y, GRANDPARENTS_DAY[country]);
}
function getGrandmotherDayDate(y, country) {
  return getEventDate(y, GRANDMOTHER_DAY[country]);
}
function getGrandfatherDayDate(y, country) {
  return getEventDate(y, GRANDFATHER_DAY[country]);
}

function sameDay(d1, d2ref) {
  return d1 && d2ref && d1.getFullYear()===d2ref.getFullYear() && d1.getMonth()===d2ref.getMonth() && d1.getDate()===d2ref.getDate();
}

// Retourne les événements spéciaux d'une date (anniversaires, fêtes)
function getSpecialEvents(date, cfg) {
  const events = [];
  const m = date.getMonth() + 1, d2 = date.getDate(), y = date.getFullYear();
  const country = cfg.country || "FR";

  // Parents birthdays
  cfg.parents.forEach((p, i) => {
    if (p.birthDay && p.birthMonth && +p.birthDay === d2 && +p.birthMonth === m) {
      events.push({ label: `🎂 ${p.name||"Parent "+(i+1)}`, color: p.color });
    }
  });
  // Children birthdays
  cfg.children.forEach((ch, i) => {
    if (ch.birthDay && ch.birthMonth && +ch.birthDay === d2 && +ch.birthMonth === m) {
      events.push({ label: `🎁 ${ch.name||"Enfant "+(i+1)}`, color: "#bc8cff" });
    }
  });

  // ── Fêtes familiales — toujours affichées dans le calendrier ──────────────
  const md = getMothersDayDate(y, country);
  if (sameDay(md, date)) {
    const label = country==="GB"||country==="IE" ? "🌸 Mothering Sunday"
                : country==="DE" ? "🌸 Muttertag"
                : country==="ES" ? "🌸 Día de la Madre"
                : country==="PT" ? "🌸 Dia da Mãe"
                : country==="IT" ? "🌸 Festa della Mamma"
                : country==="NL" ? "🌸 Moederdag"
                : country==="PL" ? "🌸 Dzień Matki"
                : "🌸 Fête des Mères";
    events.push({ label, color: "#ff6bb5" });
  }

  const fd = getFathersDayDate(y, country);
  if (sameDay(fd, date)) {
    const label = country==="GB"||country==="IE" ? "🎩 Father's Day"
                : country==="DE" ? "🎩 Vatertag (Himmelfahrt)"
                : country==="ES"||country==="PT"||country==="IT" ? "🎩 Día del Padre / San Giuseppe"
                : country==="NL" ? "🎩 Vaderdag"
                : country==="PL" ? "🎩 Dzień Ojca"
                : "🎩 Fête des Pères";
    events.push({ label, color: "#4a9eff" });
  }

  // Fête des grands-parents (générique)
  const gpd = getGrandparentsDayDate(y, country);
  if (sameDay(gpd, date)) {
    const label = country==="IT" ? "👴 Festa dei Nonni"
                : country==="ES"||country==="PT" ? "👴 Día de los Abuelos"
                : country==="DE"||country==="CH"||country==="AT" ? "👴 Großelterntag"
                : country==="GB"||country==="IE"||country==="CA" ? "👴 Grandparents Day"
                : country==="NL" ? "👴 Grootoudersdag"
                : "👴 Fête des Grands-Parents";
    events.push({ label, color: "#f5a623" });
  }

  // Grand-mère spécifique (Pologne)
  const gmd = getGrandmotherDayDate(y, country);
  if (sameDay(gmd, date)) events.push({ label: "👵 Dzień Babci", color: "#f5a623" });

  // Grand-père spécifique (Pologne)
  const gfd = getGrandfatherDayDate(y, country);
  if (sameDay(gfd, date)) events.push({ label: "👴 Dzień Dziadka", color: "#f5a623" });

  // Custom dates
  (cfg.specialDates?.custom||[]).forEach(cd => {
    if (!cd.label || !cd.day || !cd.month) return;
    const dayMatch = +cd.day === d2;
    const monthMatch = +cd.month === m;
    const yearMatch = cd.yearly || !cd.year || +cd.year === y;
    if (dayMatch && monthMatch && yearMatch) {
      const p = cfg.parents.find(p=>String(p.id)===String(cd.parentId)) || cfg.parents[0];
      events.push({ label: `📌 ${cd.label}${p?.name?" → "+p.name.split(" ")[0]:""}`, color: p?.color||"#f5c842" });
    }
  });
  return events;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALENDAR TAB
// ═══════════════════════════════════════════════════════════════════════════════
function CalTab({readOnly=false,canEdit=true,updateCal:updateCalProp}) {
  const {C,t,cfg,updateCal: ctxUpdateCal,apiData,setMenuTab,setConfigStep,prem,perms,onUpgrade,isObs,isChild,user,sub} = useApp();
  const premFull = isPremFull(sub); // PDF calendrier réservé full premium uniquement
  const editBlocked = !canEdit;
  const updateCal = updateCalProp !== undefined ? updateCalProp : ctxUpdateCal;
  // Persiste la position du calendrier dans localStorage pour survivre aux changements d'onglet et rechargements JSX
  const [_calMs, _setCalMs] = useLocalStorage("duvia_cal_pos", ()=>{ const t=new Date(); return new Date(t.getFullYear(),t.getMonth(),1).getTime(); });
  const [cur,setCurRaw]=useState(()=>{ const saved=_calMs; const d=new Date(saved); const now=new Date(); return (d.getFullYear()===now.getFullYear()&&Math.abs(d.getMonth()-now.getMonth())<=24)?new Date(d.getFullYear(),d.getMonth(),1):new Date(now.getFullYear(),now.getMonth(),1); });
  const setCur=useCallback((v)=>{ setCurRaw(prev=>{ const next=typeof v==="function"?v(prev):v; _setCalMs(next.getTime()); return next; }); },[_setCalMs]);
  const [inlineDs,setInlineDs]=useState(null);
  const [fullDs,setFullDs]=useState(null);
  const [showLegend,setShowLegend]=useState(false);
  const [calView,setCalView]=useLocalStorage("duvia_cal_view","list");
  const editRef=useRef(null);
  const y=cur.getFullYear(),m=cur.getMonth();
  const dc=dInMonth(y,m);
  const multiChild = !cfg.sameGuardAll && cfg.children?.length > 1;
  const [selChildId,setSelChildId]=useState(()=>cfg.children?.[0]?.id||null);
  const activeChildId = multiChild ? selChildId : (cfg.children?.[0]?.id||null);

  // ── Export calendrier PDF ─────────────────────────────────────────────────
  const [calExportHtml, setCalExportHtml] = useState(null);
  const calIframeRef = useRef(null);

  function generateCalendarPDF() {
    if(!premFull){ onUpgrade(); return; }
    const p0 = cfg.parents[0]||{}, p1 = cfg.parents[1]||{};
    const col0 = p0.color||"#f97316", col1 = p1.color||"#06b6d4";
    const cols = [col0, col1];
    const DAY_LTR = ["D","L","M","M","J","V","S"];
    const MONTHS  = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
    const pubHols = new Set((apiData?.publicHols||[]).map(h=>h.date));
    // Zone scolaire active (même logique que l'affichage du calendrier)
    const activeCountry = (multiChild && activeChildId && cfg.childrenCountry?.[activeChildId]) || cfg.country || "FR";
    const activeZoneData = (multiChild && activeChildId && cfg.childrenZones?.[activeChildId]) || {subdivisionCode:cfg.subdivisionCode||"",zone:cfg.zone||""};
    const scoZone = activeZoneData.subdivisionCode || activeZoneData.zone;
    const schoolHolPeriods = getHolsFromData(activeCountry, apiData, scoZone);

    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth(), 1);

    function buildMonth(mi){
      const md = new Date(startDate.getFullYear(), startDate.getMonth()+mi, 1);
      const yr = md.getFullYear(), mo = md.getMonth();
      const nDays = dInMonth(yr,mo);
      let rows="", lastWk=-1;

      for(let d=1;d<=nDays;d++){
        const date = new Date(yr,mo,d);
        const ds   = toStr(date); // 🔧 Fix : toISOString() décale d'1 jour pour les fuseaux UTC+1/+2 (France) — toStr() garde la date locale.
        const dow  = date.getDay();
        const wk   = wkNum(date);
        const isWE = dow===0||dow===6;
        const isFH = pubHols.has(ds);
        const isSH = schoolHolPeriods.some(h=>ds>=h.s&&ds<=h.e);
        const guard= resolveGuard(ds,cfg,activeChildId);
        const pIdx = guard?.parentIdx;
        const isFullDay = !guard?.timeType || guard?.timeType === "full";

        // Couleur de garde
        let custBg;
        if(isFH)       custBg = "#ef444488";
        else if(pIdx===0) custBg = col0+"99";
        else if(pIdx===1) custBg = col1+"99";
        else            custBg = "#f0f0f0";

        // Couleur vacances scolaires (vert)
        const vacBg = isSH ? "#22c55ecc" : "transparent";

        // Jour férié → 1ère et 2ème colonnes (lettre + numéro du jour) en rouge
        const dlClass = `dl${isFH?" fer":""}`;
        const dnClass = `dn${isFH?" fer":""}`;

        const wkCell = wk!==lastWk
          ? `<td class="wk">${wk}</td>`
          : `<td class="wk"></td>`;
        lastWk=wk;

        if(isFullDay || !guard){
          // Journée entière → 1 seule ligne
          rows+=`<tr class="${isWE?"we":""}">
            ${wkCell}
            <td class="${dlClass}">${DAY_LTR[dow]}</td>
            <td class="${dnClass}">${d}</td>
            <td class="vac" style="background:${vacBg}"></td>
            <td class="cu" colspan="2" style="background:${custBg}"></td>
          </tr>`;
        } else {
          // Journée partagée → couleur variable selon le parent qui prend/rend la garde
          const refIdx = (pIdx===0||pIdx===1) ? pIdx : 0;
          const otherIdx = refIdx===0 ? 1 : 0;
          let changeTime, firstColor, secondColor;
          if(guard.timeType==="end"){
            // ce parent garde l'enfant jusqu'à l'heure indiquée, puis passage à l'autre
            changeTime  = guard.endTime || "12:00";
            firstColor  = cols[refIdx];
            secondColor = cols[otherIdx];
          } else {
            // "start" ou "split" : prise de garde par ce parent à l'heure indiquée
            changeTime  = guard.startTime || guard.endTime || "12:00";
            firstColor  = cols[otherIdx];
            secondColor = cols[refIdx];
          }
          rows+=`<tr class="${isWE?"we":""}">
            ${wkCell}
            <td class="${dlClass}">${DAY_LTR[dow]}</td>
            <td class="${dnClass}">${d}</td>
            <td class="vac" style="background:${vacBg}"></td>
            <td class="cu" style="background:${firstColor+"99"}">→${changeTime}</td>
            <td class="cu" style="background:${secondColor+"99"}"></td>
          </tr>`;
        }
      }

      return `<div class="mo">
        <div class="mhdr">${MONTHS[mo].toUpperCase()} ${yr}</div>
        <table><tbody>${rows}</tbody></table>
      </div>`;
    }

    let page1Months="", page2Months="";
    for(let mi=0;mi<6;mi++)  page1Months += buildMonth(mi);
    for(let mi=6;mi<12;mi++) page2Months += buildMonth(mi);

    // Bornes des deux périodes (pour les sous-titres et le certificat)
    const m1Start = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const m1End   = new Date(startDate.getFullYear(), startDate.getMonth()+5, 1);
    const m2Start = new Date(startDate.getFullYear(), startDate.getMonth()+6, 1);
    const m2End   = new Date(startDate.getFullYear(), startDate.getMonth()+11, 1);
    const periodLabel = (a,b) => `${MONTHS[a.getMonth()]} ${a.getFullYear()} – ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;

    const legendHTML = `<div class="leg">
      <span><i class="lc" style="background:${col0}aa"></i>${p0.name||"Parent 1"}</span>
      <span><i class="lc" style="background:${col1}aa"></i>${p1.name||"Parent 2"}</span>
      <span><i class="lc fer-lc"></i>Jour férié</span>
      <span><i class="lc" style="background:#22c55ecc"></i>Vacances scolaires</span>
    </div>`;

    const childrenNames = (cfg.children||[]).map(c=>c.name).filter(Boolean).join(", ") || "—";
    const todayLabel = new Date().toLocaleDateString("fr-FR",{day:"2-digit",month:"long",year:"numeric"});

    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Planning de garde — Duvia</title>
<style>
@page{size:A4 landscape;margin:0}
@page certpage{size:A4 portrait;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#999}
body{font-family:Arial,sans-serif;font-size:8px;-webkit-print-color-adjust:exact;print-color-adjust:exact;display:flex;flex-direction:column;align-items:center;gap:8mm;padding:8mm 0}
.page{width:297mm;height:210mm;padding:5mm;background:#fff;box-shadow:0 0 6px rgba(0,0,0,.35);page-break-after:always;overflow:hidden;display:flex;flex-direction:column}
.page:last-child{page-break-after:auto}
.page.cert{width:210mm;height:297mm;page:certpage}
@media print{
  html,body{background:#fff;padding:0;gap:0}
  .page{box-shadow:none;width:auto;height:auto}
  .page.cert{width:auto;height:auto}
}
h1{text-align:center;font-size:12px;font-weight:900;margin-bottom:2px}
.sub{text-align:center;font-size:7.5px;color:#666;margin-bottom:3px}
.leg{display:flex;gap:14px;justify-content:center;margin-bottom:4px;flex-wrap:wrap}
.leg span{display:flex;align-items:center;gap:4px;font-size:7.5px;font-weight:700}
.lc{width:13px;height:8px;border-radius:2px;display:inline-block;border:1px solid rgba(0,0,0,.15)}
.fer-lc{background:#ef444488}
.cal{flex:1;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(2,1fr);gap:4px;min-height:0}
.mo{border:1px solid #e0e0e0;border-radius:3px;overflow:hidden;display:flex;flex-direction:column}
.mhdr{flex:none;font-weight:900;font-size:8px;text-align:center;padding:2px 2px;background:#fef3c7;color:#92400e;border-bottom:1px solid #e0e0e0;letter-spacing:.02em}
table{flex:1;width:100%;border-collapse:collapse;table-layout:fixed}
tr{height:10px}
td{padding:0 1px;font-size:6.5px;line-height:10px;overflow:hidden;white-space:nowrap;border-bottom:1px solid rgba(0,0,0,.04)}
.wk{font-size:5px;color:#bbb;background:#fafafa;width:10px;text-align:center;border-right:1px solid #eee;font-weight:600}
.dl{width:9px;text-align:center;font-weight:800;color:#333;font-size:7px}
.dn{width:13px;text-align:right;padding-right:1px;font-weight:600;font-size:6.5px}
.dl.fer,.dn.fer{background:#ef444433;color:#7f1d1d}
.vac{width:6px;border-right:1px solid rgba(0,0,0,.07)}
.cu{font-size:6px;color:#222;padding:0 2px}
.we .dl{color:#888;font-style:italic}
.we .dn{color:#888}
.we{background:rgba(0,0,0,.018)}
.cert{display:flex;align-items:center;justify-content:center;height:100%;min-height:185mm}
.certbox{width:100%;max-width:680px;border:2px solid #c2745a;border-radius:10px;padding:34px 46px;text-align:center}
.certbox h1{font-size:22px;margin-bottom:6px}
.cert-sub{font-size:11px;color:#666;margin-bottom:24px}
.cert-body{font-size:12.5px;line-height:1.8;text-align:left;color:#333}
.cert-parents{display:flex;justify-content:center;gap:36px;margin:16px 0;font-weight:800;font-size:13px}
.cert-parents .dot{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}
.cert-note{font-size:10px;color:#666;font-style:italic;margin-top:14px}
.cert-sign{display:flex;justify-content:space-around;margin-top:46px}
.cert-sign-block{width:42%;font-size:11px;text-align:center}
.cert-sign-line{border-bottom:1px solid #999;height:54px;margin-bottom:6px}
.cert-footer{margin-top:34px;font-size:9px;color:#999}
</style></head><body>

<div class="page">
  <h1>&#128197; Planning de garde &mdash; ${p0.name||"Parent 1"} &amp; ${p1.name||"Parent 2"}</h1>
  <div class="sub">Page 1/2 &middot; ${periodLabel(m1Start,m1End)} &middot; Généré par Duvia le ${todayLabel}</div>
  ${legendHTML}
  <div class="cal">${page1Months}</div>
</div>

<div class="page">
  <h1>&#128197; Planning de garde &mdash; ${p0.name||"Parent 1"} &amp; ${p1.name||"Parent 2"}</h1>
  <div class="sub">Page 2/2 &middot; ${periodLabel(m2Start,m2End)} &middot; Généré par Duvia le ${todayLabel}</div>
  ${legendHTML}
  <div class="cal">${page2Months}</div>
</div>

<div class="page cert">
  <div class="certbox">
    <h1>&#128196; Certificat de planning de garde</h1>
    <div class="cert-sub">Document généré automatiquement par l'application Duvia</div>
    <div class="cert-body">
      <p>Le présent document atteste du planning de garde alternée établi entre :</p>
      <div class="cert-parents">
        <div><span class="dot" style="background:${col0}"></span>${p0.name||"Parent 1"}</div>
        <div><span class="dot" style="background:${col1}"></span>${p1.name||"Parent 2"}</div>
      </div>
      <p>Pour l'enfant / les enfants : <strong>${childrenNames}</strong></p>
      <p>Période couverte par ce document : <strong>${periodLabel(m1Start,m2End)}</strong></p>
      <p class="cert-note">Ce planning reflète l'organisation de la garde convenue entre les parents au moment de son édition. Toute modification ultérieure doit faire l'objet d'un accord mutuel entre les deux parents.</p>
    </div>
    <div class="cert-sign">
      <div class="cert-sign-block"><div class="cert-sign-line"></div><div>${p0.name||"Parent 1"}<br/>Date et signature</div></div>
      <div class="cert-sign-block"><div class="cert-sign-line"></div><div>${p1.name||"Parent 2"}<br/>Date et signature</div></div>
    </div>
    <div class="cert-footer">Document généré le ${todayLabel} via Duvia</div>
  </div>
</div>

<script>window.addEventListener('message',e=>{if(e.data==='DUVIA_PRINT')window.print();});</script>
</body></html>`;

    setCalExportHtml(html);
  }

  return (
    <div>
      {/* ── Prévisualisation PDF calendrier ── */}
      {calExportHtml && (
        <div style={{position:"fixed",inset:0,zIndex:700,display:"flex",flexDirection:"column",background:"#111"}}>
          <div style={{display:"flex",gap:8,padding:"10px 14px",background:"#1a1a2e",alignItems:"center",flexShrink:0}}>
            <div style={{flex:1,fontSize:13,fontWeight:700,color:"#ede9fe"}}>📅 Planning de garde annuel — Duvia</div>
            <button
              onClick={()=>calIframeRef.current?.contentWindow?.postMessage("DUVIA_PRINT","*")}
              style={{padding:"7px 16px",background:"#7B7CF5",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              🖨️ Imprimer → PDF
            </button>
            <button
              onClick={()=>setCalExportHtml(null)}
              style={{padding:"7px 12px",background:"rgba(255,255,255,.15)",color:"#fff",border:"none",borderRadius:8,fontSize:13,cursor:"pointer",fontWeight:700}}>
              ✕
            </button>
          </div>
          <iframe ref={calIframeRef} srcDoc={calExportHtml}
            style={{flex:1,border:"none",background:"white"}}
            title="Planning PDF Duvia"
            sandbox="allow-same-origin allow-scripts allow-modals allow-popups" />
        </div>
      )}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontSize:16,fontWeight:900}}>📅 {t.tabCal||"Calendrier"}</div>
          <div style={{fontSize:11,color:C.mut}}>{t.calSub||"Planning de garde mensuel"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          {!isObs && !isChild && (
            <button onClick={()=>{ if(!premFull){ onUpgrade(); return; } generateCalendarPDF(); }}
              title={premFull ? "Exporter le planning annuel en PDF" : "Réservé aux membres Premium abonnés"}
              style={{display:"flex",alignItems:"center",gap:3,padding:"3px 7px",background:premFull?`${C.vio}15`:`${C.mut}15`,border:`1px solid ${premFull?C.vio:C.mut}44`,borderRadius:6,cursor:"pointer",transition:"all .15s",opacity:premFull?1:.6}}>
              <span style={{fontSize:10}}>{premFull?"📄":"🔒"}</span>
              <span style={{fontSize:9,color:premFull?C.vio:C.mut,fontWeight:800}}>PDF</span>
            </button>
          )}
          <InfoBubble C={C} tipKey={`duvia_caltip_${user?.id||"x"}`} title={t.tabCal||"Calendrier"} autoOpen={false}>
            {t.calTipBody||"Visualisez et gérez le planning de garde mensuel. Il est visible par tous les membres de la famille."}
            <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid rgba(255,255,255,.25)"}}>
              {t.calTipGuardians||"🏠 Gardiens : un proche invité avec l'option « Peut être gardien » (Configuration → Accès) apparaît ici en orange. Vous pouvez alors lui attribuer une journée de garde — par exemple quand les grands-parents gardent les enfants à la place d'un parent."}
            </div>
          </InfoBubble>
        </div>
      </div>
      {/* Sélecteur d'enfant */}
      {multiChild && (
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
          {cfg.children.map(ch=>{
            const isActive = selChildId===ch.id;
            const confirmed = cfg.custodyPerChild?.[ch.id]?.confirmed;
            return (
              <button key={ch.id} onClick={()=>setSelChildId(ch.id)}
                style={{padding:"7px 14px",background:isActive?C.vio:C.sur,color:isActive?"#fff":C.mut,
                  border:`1.5px solid ${isActive?C.vio:C.bor}`,borderRadius:10,fontSize:13,fontWeight:700,
                  display:"flex",alignItems:"center",gap:6}}>
                {ch.avatar||"🧒"} {ch.name||`Enfant`}
                {confirmed
                  ? <span style={{fontSize:10,opacity:.8}}>✅</span>
                  : <span style={{fontSize:10,opacity:.5}}>⏳</span>}
              </button>
            );
          })}
        </div>
      )}
      {/* Bulle d'info : modèle de garde non validé */}
      {(() => {
        const hasUnconfirmed = multiChild
          ? cfg.children?.some(ch => !cfg.custodyPerChild?.[ch.id]?.confirmed)
          : !cfg.custody?.confirmed;
        if (!hasUnconfirmed) return null;
        return (
          <button onClick={()=>{ setMenuTab("config"); setConfigStep(3); }}
            style={{
              width:"100%",display:"flex",alignItems:"center",gap:10,
              background:`${C.yel}18`,border:`1.5px solid ${C.yel}88`,
              borderRadius:12,padding:"10px 14px",marginBottom:14,
              cursor:"pointer",textAlign:"left",
            }}>
            <span style={{fontSize:20,flexShrink:0}}>⏳</span>
            <span style={{flex:1,fontSize:13,fontWeight:700,color:C.yel,lineHeight:1.4}}>
              {t.calValidateGuardModel || "Veuillez valider le modèle de garde"}
            </span>
            <span style={{fontSize:16,color:C.yel,opacity:.8,flexShrink:0}}>→</span>
          </button>
        );
      })()}

      {/* Bannière freemium lock */}
      {editBlocked && !isObs && !isChild && (
        <div onClick={onUpgrade} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",marginBottom:14,background:`${C.vio}10`,border:`1.5px dashed ${C.vio}55`,borderRadius:14,cursor:"pointer"}}>
          <span style={{fontSize:20,flexShrink:0}}>🔒</span>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:800,color:C.vio}}>Édition détaillée — Premium</div>
            <div style={{fontSize:11,color:C.mut,marginTop:1}}>Horaires, lieu, notes : disponibles avec Premium.</div>
          </div>
          <div style={{flexShrink:0,padding:"5px 10px",background:`${C.vio}22`,color:C.vio,borderRadius:8,fontSize:11,fontWeight:800}}>⭐ Premium</div>
        </div>
      )}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <button onClick={()=>setCur(d=>new Date(d.getFullYear(),d.getMonth()-1,1))} style={{padding:"7px 13px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`}}>{t.prev}</button>
        <div style={{textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
          <div style={{fontSize:19,fontWeight:900}}>{t.months[m]} {y}</div>
          {(() => {
            const now = new Date();
            const isCurrentMonth = now.getFullYear()===y && now.getMonth()===m;
            return !isCurrentMonth ? (
              <button onClick={()=>setCur(new Date(now.getFullYear(),now.getMonth(),1))}
                style={{padding:"3px 12px",background:C.vio,color:"#fff",fontSize:11,fontWeight:800,borderRadius:20,border:"none"}}>
                📍 {t.calToday||"Aujourd'hui"}
              </button>
            ) : (
              <div style={{fontSize:10,color:C.vio,fontWeight:700}}>📍 {t.calCurrentMonth||"Mois actuel"}</div>
            );
          })()}
          {readOnly&&<div style={{fontSize:10,color:C.ora,fontWeight:700}}>{t.readOnly}</div>}
        </div>
        <button onClick={()=>setCur(d=>new Date(d.getFullYear(),d.getMonth()+1,1))} style={{padding:"7px 13px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`}}>→</button>
      </div>
      <div style={{marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
        <div>
          <button onClick={()=>setShowLegend(v=>!v)} style={{padding:"1px 10px",height:24,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:20,fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:5}}>
            <span>🏷️ {t.calLegend||"Légende"}</span>
            <span style={{fontSize:9,transition:"transform .2s",display:"inline-block",transform:showLegend?"rotate(180deg)":"rotate(0deg)"}}>▼</span>
          </button>
          {showLegend&&(
            <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap",padding:"8px 12px",background:C.sur,borderRadius:8,border:`1.5px solid ${C.bor}`}}>
              <span className="chip" style={{fontSize:11}}><span style={{fontSize:11,fontWeight:900,color:C.red,marginRight:4}}>14</span>{t.holiday}</span>
              <span className="chip" style={{fontSize:11}}><span style={{width:14,height:14,borderRadius:4,border:`2px solid ${C.grn}`,display:"inline-block",marginRight:4,verticalAlign:"middle"}} />{t.vacation}</span>
              <span className="chip" style={{fontSize:11}}>🌸 {t.motherDay?.replace(/^🌸\s*/,"")||"Fête des Mères"}</span>
              <span className="chip" style={{fontSize:11}}>🎩 {t.fatherDay?.replace(/^🎩\s*/,"")||"Fête des Pères"}</span>
              <span className="chip" style={{fontSize:11}}>👴 {t.calGrandparents||"Grands-Parents"}</span>
              {cfg.parents.map((p,i)=>p.name&&<span key={i} className="chip" style={{fontSize:11,borderColor:p.color,background:`${p.color}20`,color:p.color,fontWeight:700}}><span style={{width:8,height:8,borderRadius:"50%",background:p.color,display:"inline-block",marginRight:4,flexShrink:0}} />{p.name}</span>)}
              {(cfg.observers||[]).filter(o=>o.status==="active"&&o.canGuard).map(o=><span key={o.id} className="chip" style={{fontSize:11,borderColor:"#f59e0b"}}><span style={{width:8,height:8,borderRadius:"50%",background:"#f59e0b",display:"inline-block",marginRight:4}} />🏠 {o.name||(o.email||"").split("@")[0]}</span>)}
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:2,background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:20,padding:2,flexShrink:0}}>
          <button onClick={()=>setCalView("list")}
            style={{padding:"0 12px",height:26,background:calView==="list"?C.vio:"transparent",color:calView==="list"?"#fff":C.mut,border:"none",borderRadius:18,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",gap:5,transition:"all .15s"}}>
            ☰ {t.calViewList||"Détaillée"}
          </button>
          <button onClick={()=>setCalView("grid")}
            style={{padding:"0 12px",height:26,background:calView==="grid"?C.vio:"transparent",color:calView==="grid"?"#fff":C.mut,border:"none",borderRadius:18,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",gap:5,transition:"all .15s"}}>
            ▦ {t.calViewGrid||"Mois"}
          </button>
        </div>
      </div>
      {calView==="grid" && (
        <MonthGridCalendar
          y={y} m={m} dc={dc} cfg={cfg} t={t} C={C} apiData={apiData}
          multiChild={multiChild} activeChildId={activeChildId}
          readOnly={readOnly} editBlocked={editBlocked}
          inlineDs={inlineDs} setInlineDs={setInlineDs}
          setFullDs={setFullDs}
        />
      )}
      {calView==="list" && (
      <div className="card" style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"32px 96px 1fr 1fr",background:C.sur,padding:"8px 12px",fontSize:10,color:C.mut,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",borderBottom:`1.5px solid ${C.bor}`}}>
          <span>{t.wk}</span><span>{t.day}</span><span>{t.info}</span>
          <span>{t.guard} {!readOnly&&<span style={{color:C.vio,fontSize:9,fontWeight:400,textTransform:"none"}}>{t.tapToEdit}</span>}</span>
        </div>
        {Array.from({length:dc},(_,i)=>{
          const day=i+1,date=new Date(y,m,day),dw=dow(y,m,day),isWE=dw>=5;
          const activeCountry = (multiChild && activeChildId && cfg.childrenCountry?.[activeChildId]) || cfg.country || "FR";
          const activeZoneData = (multiChild && activeChildId && cfg.childrenZones?.[activeChildId]) || {subdivisionCode:cfg.subdivisionCode||"",zone:cfg.zone||""};
          const ds=toStr(date),ferName=getPublicHolName(ds,activeCountry,apiData),fer=!!ferName,scoZone=activeZoneData.subdivisionCode||activeZoneData.zone,scoName=getHolName(ds,scoZone,activeCountry,apiData),sco=!!scoName,specials=getSpecialEvents(date,cfg);
          const guard=resolveGuard(ds,cfg,activeChildId),wk=wkNum(date),isInl=inlineDs===ds;
          const todayStr=toStr(new Date()),isToday=ds===todayStr;
          return (
            <div key={i}>
              <div style={{display:"grid",gridTemplateColumns:"32px 96px 1fr 1fr",padding:"8px 12px",borderBottom:`1px solid ${C.bor}`,background:isInl?C.sur:isToday?`${C.vio}18`:isWE?`${C.yel}11`:"transparent",transition:"background .15s",borderLeft:isToday?`3px solid ${C.vio}`:"3px solid transparent"}}>
                <span style={{fontFamily:"JetBrains Mono",fontSize:10,color:C.mut,alignSelf:"center"}}>{dw===0?wk:""}</span>
                <div style={{alignSelf:"center"}}>
                  <div style={{fontFamily:"JetBrains Mono",fontSize:13,fontWeight:700,color:isToday?C.vio:isWE?C.yel:C.txt,display:"flex",alignItems:"center",gap:5}}>
                    {pad(day)}
                    {isToday&&<span style={{fontSize:9,background:C.vio,color:"#fff",padding:"1px 5px",borderRadius:6,fontWeight:800,fontFamily:"Nunito"}}>{t.calTodayBadge||"Auj."}</span>}
                  </div>
                  <div style={{fontSize:11,color:isToday?C.vio:isWE?C.yel:C.mut,fontWeight:600}}>{t.dayNames[dw]}</div>
                </div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                  {fer&&<span className="badge" style={{background:`${C.red}22`,color:C.red,maxWidth:90,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={ferName||t.holiday}>{ferName||t.holiday}</span>}
                  {sco&&<span className="badge" style={{background:`${C.grn}22`,color:C.grn,maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={scoName}>{scoName}</span>}
                  {specials.map((ev,ei)=>(
                    <span key={ei} className="badge" style={{background:`${ev.color}22`,color:ev.color,maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={ev.label}>{ev.label}</span>
                  ))}
                </div>
                <GuardCell guard={guard} readOnly={readOnly} isOpen={isInl}
                  onClick={()=>{if(!readOnly){setInlineDs(isInl?null:ds);setFullDs(null);}}}
                  onFull={()=>{if(!editBlocked){setFullDs(ds);setInlineDs(null);}}} />
              </div>
              {isInl&&!readOnly&&<InlinePicker ds={ds} guard={guard} onClose={()=>setInlineDs(null)} onFull={!editBlocked?()=>{setFullDs(ds);setInlineDs(null);}:null} />}
            </div>
          );
        })}
      </div>
      )}
      {fullDs&&!readOnly&&!editBlocked&&(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setFullDs(null)}><div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:480,maxHeight:"90vh",overflowY:"auto",borderRadius:18}}><EditDay ds={fullDs} onClose={()=>setFullDs(null)} editRef={editRef} /></div></div>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUE GRILLE MENSUELLE (calendrier "façon papier" — cases colorées par parent)
// ═══════════════════════════════════════════════════════════════════════════════
function MonthGridCalendar({y,m,dc,cfg,t,C,apiData,multiChild,activeChildId,readOnly,editBlocked,inlineDs,setInlineDs,setFullDs}) {
  const activeCountry = (multiChild && activeChildId && cfg.childrenCountry?.[activeChildId]) || cfg.country || "FR";
  const activeZoneData = (multiChild && activeChildId && cfg.childrenZones?.[activeChildId]) || {subdivisionCode:cfg.subdivisionCode||"",zone:cfg.zone||""};
  const scoZone = activeZoneData.subdivisionCode || activeZoneData.zone;
  const todayStr = toStr(new Date());

  // Lundi=0 ... Dimanche=6 — nombre de cases vides avant le 1er du mois
  const firstDow = dow(y,m,1);

  // Pré-calcule la garde + infos de chaque jour du mois
  const days = Array.from({length:dc},(_,i)=>{
    const day=i+1, date=new Date(y,m,day), ds=toStr(date), dw=dow(y,m,day);
    const ferName=getPublicHolName(ds,activeCountry,apiData), fer=!!ferName;
    const scoName=getHolName(ds,scoZone,activeCountry,apiData), sco=!!scoName;
    const specials=getSpecialEvents(date,cfg);
    const isBirthday=specials.some(ev=>ev.label?.includes("🎂")||ev.label?.includes("🎁"));
    const guard=resolveGuard(ds,cfg,activeChildId);
    return {day,ds,dw,fer,ferName,sco,scoName,specials,isBirthday,guard,isToday:ds===todayStr,isWE:dw>=5};
  });

  // Le badge rond résume "qui garde cette semaine" : on l'affiche le dimanche (fin de semaine,
  // comme dans le calendrier papier de référence), ou sur le dernier jour du mois si celui-ci
  // tombe avant un dimanche. On l'affiche aussi sur tout jour où la garde change réellement par
  // rapport à la veille (utile pour les alternances non hebdomadaires : garde alternée par jour, etc.).
  function parentKey(g){ if(!g) return null; if(g.allParents) return "all"; if(g.obsId) return `obs:${g.obsId}`; if(g.parentIdx>=0) return `p:${g.parentIdx}`; return null; }
  days.forEach((d,i)=>{
    const prevKey = i>0 ? parentKey(days[i-1].guard) : null;
    const isRealChange = parentKey(d.guard) !== prevKey;
    const isWeekEnd = d.dw===6 || i===days.length-1;
    d.isChangeDay = isWeekEnd || isRealChange;
    d.isRealChange = isRealChange; // changement effectif de gardien (pas juste dimanche)
  });

  function cellBg(g){
    if(!g) return C.sur;
    if(g.allParents) return "#a855f722";
    if(g.obsId) return "#f59e0b22";
    if(g.parentIdx>=0){ const p=cfg.parents[g.parentIdx]; return p?.color ? p.color+"22" : C.sur; }
    return C.sur;
  }
  function badgeColor(g){
    if(!g) return C.mut;
    if(g.allParents) return "#a855f7";
    if(g.obsId) return "#f59e0b";
    if(g.parentIdx>=0){ const p=cfg.parents[g.parentIdx]; return p?.color || C.vio; }
    return C.mut;
  }
  // Convertit "HH:MM" en pourcentage de la journée (00:00=0%, 12:00=50%, 24:00=100%)
  function timeToPercent(hm){
    if(!hm) return 50;
    const [h,mi]=hm.split(":").map(Number);
    if(Number.isNaN(h)) return 50;
    return Math.max(0,Math.min(100,((h*60+(mi||0))/1440)*100));
  }
  // Jours avec prise/fin de garde à heure précise : dégradé vertical au prorata de l'heure
  // (ex: prise à 07:55 → la couleur du matin occupe ~33% du haut de la case, le reste en bas).
  days.forEach((d,i)=>{
    d.splitBefore=null; d.splitAfter=null; d.splitPercent=null;
    const g=d.guard;
    let before=null, after=null, pct=null;
    if(g && g.timeType==="start" && g.startTime){
      before = badgeColor(i>0 ? days[i-1].guard : null);
      after  = badgeColor(g);
      pct    = timeToPercent(g.startTime);
    } else if(g && g.timeType==="end" && g.endTime){
      before = badgeColor(g);
      after  = badgeColor(i<days.length-1 ? days[i+1].guard : null);
      pct    = timeToPercent(g.endTime);
    }
    if(before && after && before!==after){
      d.splitBefore=before; d.splitAfter=after; d.splitPercent=pct;
    }
  });
  function badgeLabel(g){
    if(!g) return "";
    if(g.allParents) return "★";
    if(g.obsId){ return "🏠"; }
    if(g.parentIdx>=0){
      const p=cfg.parents[g.parentIdx];
      if(p?.name?.trim()) return p.name.trim().charAt(0).toUpperCase();
      return String.fromCharCode(65+g.parentIdx); // A, B, C... si pas de prénom renseigné
    }
    return "";
  }

  const dayLetters = (t.dayNames||["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"])
    .map(n=>(n.slice(0,3)+".").toUpperCase());

  function openDay(ds){
    if(readOnly) return;
    setInlineDs(inlineDs===ds?null:ds);
  }

  return (
    <div className="card" style={{padding:14,overflow:"hidden",width:"100%",boxSizing:"border-box"}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:5,marginBottom:6,width:"100%",boxSizing:"border-box"}}>
        {dayLetters.map((lbl,i)=>(
          <div key={i} style={{textAlign:"center",fontSize:10,fontWeight:800,letterSpacing:".04em",color:C.mut,padding:"2px 0",minWidth:0,overflow:"hidden"}}>{lbl}</div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:5,width:"100%",boxSizing:"border-box"}}>
        {Array.from({length:firstDow}).map((_,i)=>(
          <div key={`pad-${i}`} style={{aspectRatio:"1",borderRadius:10,background:`${C.sur}66`,minWidth:0,boxSizing:"border-box"}} />
        ))}
        {days.map(d=>{
          const hasSplit = d.splitBefore && d.splitAfter;
          const bg = hasSplit
            ? `linear-gradient(180deg, ${d.splitBefore}40 0%, ${d.splitBefore}40 ${d.splitPercent}%, ${d.splitAfter}40 ${d.splitPercent}%, ${d.splitAfter}40 100%)`
            : (d.isToday ? `${C.vio}22` : cellBg(d.guard));
          const hasBadge = d.isRealChange && d.guard && !d.isBirthday;
          // Priorité couleur du numéro : férié (rouge gras) > week-end (gris foncé gras) > normal
          const numColor = d.fer ? C.red : d.isWE ? "#52525b" : (d.isToday ? C.vio : C.txt);
          const numWeight = (d.fer || d.isWE || d.isToday) ? 900 : 700;
          // Détection icône spéciale (fête des mères, pères, grands-parents)
          const specialIcon = !d.isBirthday && !d.fer && !d.sco
            ? d.specials.find(ev => ev.label?.includes("🌸") || ev.label?.includes("🎩") || ev.label?.includes("👴") || ev.label?.includes("👵"))
            : null;
          const specialIconChar = specialIcon
            ? (specialIcon.label?.match(/🌸|🎩|👴|👵/)?.[0] || null)
            : null;
          // Point coloré uniquement si ni vacances, ni jour férié, ni icône spéciale, ni anniversaire
          const dotColor = !d.isBirthday && !d.fer && !d.sco && !specialIconChar
            ? d.specials[0]?.color
            : null;
          // Encadrement vert si vacances scolaires (priorité sur bordure today/inline)
          const scoBorder = d.sco ? `2px solid ${C.grn}` : null;
          const activeBorder = d.isToday ? `1.5px solid ${C.vio}` : inlineDs===d.ds ? `1.5px solid ${C.vio}` : "1.5px solid transparent";
          // Heure + lieu du rendez-vous de garde (ex: "12:00 → 14:00" / "📍 MANTES")
          const g = d.guard;
          let cellTime = "";
          if(g && g.timeType && g.timeType!=="full"){
            const st=g.startTime, et=g.endTime;
            if(g.timeType==="start"&&st) cellTime=`▶ ${st}`;
            else if(g.timeType==="end"&&et) cellTime=`⏹ ${et}`;
            else if(g.timeType==="split"&&st&&et) cellTime=`${st} → ${et}`;
            else if(g.timeType==="split"&&st) cellTime=`▶ ${st}`;
            else if(g.timeType==="split"&&et) cellTime=`⏹ ${et}`;
          }
          const cellLocation = g?.location || "";
          return (
            <div key={d.ds} onClick={()=>openDay(d.ds)}
              title={d.ferName||d.scoName||d.specials[0]?.label||undefined}
              style={{
                aspectRatio:"1",borderRadius:10,background:bg,padding:"6px 6px",
                display:"flex",flexDirection:"column",justifyContent:"space-between",
                cursor:readOnly?"default":"pointer",position:"relative",
                border:scoBorder || activeBorder,
                transition:"transform .12s, box-shadow .12s",
                minWidth:0,boxSizing:"border-box",overflow:"hidden",
              }}>
              <span style={{display:"flex",alignItems:"center",gap:3}}>
                <span style={{fontSize:13,fontWeight:numWeight,color:numColor}}>{d.day}</span>
                {d.isBirthday && <span style={{fontSize:11,lineHeight:1}}>🎂</span>}
              </span>
              {(cellTime || cellLocation) && (
                <span style={{textAlign:"center",minWidth:0,overflow:"hidden"}}>
                  {cellTime && <span style={{display:"block",fontSize:9,fontWeight:800,color:C.vio,fontFamily:"JetBrains Mono",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{cellTime}</span>}
                  {cellLocation && <span style={{display:"block",fontSize:8,fontWeight:700,color:C.pin,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>📍 {cellLocation}</span>}
                </span>
              )}
              {specialIconChar && (
                <span style={{position:"absolute",top:5,right:5,fontSize:12,lineHeight:1}}>{specialIconChar}</span>
              )}
              {dotColor && (
                <span style={{position:"absolute",top:7,right:7,width:6,height:6,borderRadius:"50%",background:dotColor}} />
              )}
              {hasBadge && (
                <span style={{
                  position:"absolute",bottom:5,right:5,
                  fontSize:11,lineHeight:1,opacity:0.75,
                }}>🔄</span>
              )}
            </div>
          );
        })}
      </div>
      {inlineDs && !readOnly && (() => {
        const d = days.find(d=>d.ds===inlineDs);
        if(!d) return null;
        const dayInfo = [];
        if(d.fer) dayInfo.push({icon:"📍",label:d.ferName||t.holiday||"Férié",color:C.red});
        if(d.sco) dayInfo.push({icon:"🌿",label:d.scoName||t.vacation||"Vacances",color:C.grn});
        d.specials.forEach(ev=>dayInfo.push({icon:"",label:ev.label,color:ev.color}));
        return (
          <div style={{marginTop:10}}>
            <InlinePicker ds={inlineDs} guard={d.guard} onClose={()=>setInlineDs(null)} dayInfo={dayInfo}
              onFull={!editBlocked?()=>{setFullDs(inlineDs);setInlineDs(null);}:null} />
          </div>
        );
      })()}
    </div>
  );
}

function GuardCell({guard,readOnly,isOpen,onClick,onFull}) {
  const {C,t,cfg} = useApp();
  const parents = cfg.parents;
  const gP=guard?.allParents ? null : (guard?.parentIdx!==undefined && guard.parentIdx>=0 ? parents[guard.parentIdx] : null);
  const gObs=guard?.obsId ? (cfg.observers||[]).find(o=>String(o.id)===String(guard.obsId)) : null;
  const isAllParents = guard?.allParents === true;
  const borderColor = gObs?"#f59e0b":gP?.color||"#a855f7";
  return (
    <div onClick={readOnly?undefined:onClick} style={{display:"flex",alignItems:"center",gap:7,cursor:readOnly?"default":"pointer",padding:"4px 7px",borderRadius:8,border:`1.5px solid ${isOpen&&(gP||isAllParents||gObs)?borderColor:isOpen?C.vio:"transparent"}`,background:isOpen?`${borderColor}11`:"transparent",transition:"all .15s"}}>
      {isAllParents?(
        <div style={{display:"flex",alignItems:"center",gap:7,width:"100%"}}>
          <div style={{display:"flex",gap:2,flexShrink:0}}>
            {parents.map((p,i)=><span key={i} style={{width:8,height:8,borderRadius:"50%",background:p.color}} />)}
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:700,color:C.txt}}>{parents.map(p=>p.name).filter(Boolean).join(" & ")||"Tous"}</div>
            <div style={{fontSize:9,color:"#bc8cff",fontWeight:700}}>🎁 Ensemble</div>
          </div>
          {!readOnly&&<span style={{fontSize:10,color:C.vio}}>✎</span>}
        </div>
      ) : gObs?(
        <div style={{display:"flex",alignItems:"center",gap:7,width:"100%"}}>
          <span style={{width:10,height:10,borderRadius:"50%",background:"#f59e0b",flexShrink:0}} />
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:700,color:C.txt}}>{gObs.name||guard.obsName||"Gardien"}</div>
            <div style={{fontSize:9,color:"#f59e0b",fontWeight:700}}>🏠 Gardien</div>
          </div>
          {!readOnly&&<span style={{fontSize:10,color:C.vio}}>✎</span>}
        </div>
      ) : gP?(
        <div style={{display:"flex",alignItems:"center",gap:7,width:"100%"}}>
          <span style={{width:10,height:10,borderRadius:"50%",background:gP.color,flexShrink:0}} />
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:700,color:C.txt}}>{gP.name||`P${guard.parentIdx+1}`}</div>
            {guard.source==="schoolHol"&&<div style={{fontSize:9,color:C.grn,fontWeight:700}}>🌿 {t.calSchoolHol||"Vacances"}</div>}
            {guard.source==="parentBirthday"&&<div style={{fontSize:9,color:"#f97316",fontWeight:700}}>🎂</div>}
            {guard.source==="childBirthday"&&<div style={{fontSize:9,color:"#bc8cff",fontWeight:700}}>🎁</div>}
            {guard.timeType&&guard.timeType!=="full"&&(()=>{
              const st=guard.startTime; const et=guard.endTime;
              let timeStr="";
              if(guard.timeType==="start"&&st) timeStr=`▶ ${st}`;
              else if(guard.timeType==="end"&&et) timeStr=`⏹ ${et}`;
              else if(guard.timeType==="split"&&st&&et) timeStr=`${st} → ${et}`;
              else if(guard.timeType==="split"&&st) timeStr=`▶ ${st}`;
              else if(guard.timeType==="split"&&et) timeStr=`⏹ ${et}`;
              return timeStr?(
                <div style={{fontSize:10,color:C.vio,fontWeight:700}}>
                  {timeStr}{guard.location&&<span style={{color:C.mut,fontWeight:400}}> 📍{guard.location}</span>}
                </div>
              ):null;
            })()}
          </div>
          {!readOnly&&<span style={{fontSize:10,color:C.vio}}>✎</span>}
        </div>
      ):(
        <span style={{fontSize:12,color:C.mut}}>{readOnly?"—":t.whichParent}</span>
      )}
    </div>
  );
}

function InlinePicker({ds,guard,onClose,onFull,dayInfo}) {
  const {C,t,cfg,updateCal} = useApp();
  const guardianObs=(cfg.observers||[]).filter(o=>o.status==="active"&&o.canGuard);
  // Résumé heure/lieu du rendez-vous (même logique que GuardCell), affiché dans le panneau rapide
  const timeStr = (()=>{
    if(!guard || !guard.timeType || guard.timeType==="full") return "";
    const st=guard.startTime, et=guard.endTime;
    if(guard.timeType==="start"&&st) return `▶ ${st}`;
    if(guard.timeType==="end"&&et) return `⏹ ${et}`;
    if(guard.timeType==="split"&&st&&et) return `${st} → ${et}`;
    if(guard.timeType==="split"&&st) return `▶ ${st}`;
    if(guard.timeType==="split"&&et) return `⏹ ${et}`;
    return "";
  })();
  const hasRdv = !!(timeStr || guard?.location || guard?.note);
  return (
    <div className="fi" style={{background:C.sur,borderBottom:`1.5px solid ${C.bor}`,padding:"9px 12px 12px",display:"flex",flexDirection:"column",gap:8}}>
      {dayInfo && dayInfo.length>0 && (
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          {dayInfo.map((info,i)=>(
            <span key={i} style={{display:"flex",alignItems:"center",gap:4,padding:"3px 9px",borderRadius:14,background:`${info.color}1f`,color:info.color,fontSize:11,fontWeight:800}}>
              {info.icon} {info.label}
            </span>
          ))}
        </div>
      )}
      {hasRdv && (
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:12,background:`${C.vio}14`,border:`1.5px solid ${C.vio}33`,flexWrap:"wrap"}}>
          {timeStr && <span style={{fontSize:14,fontWeight:900,color:C.vio,fontFamily:"JetBrains Mono"}}>{timeStr}</span>}
          {guard?.location && (
            <span style={{fontSize:12,fontWeight:800,color:C.pin,display:"flex",alignItems:"center",gap:3}}>
              📍 {guard.location}
            </span>
          )}
          {guard?.note && (
            <span style={{fontSize:11,color:C.mut,fontStyle:"italic",width:"100%"}}>📝 {guard.note}</span>
          )}
        </div>
      )}
      <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
        {cfg.parents.map((p,pi)=>(
          <button key={pi} onClick={()=>{updateCal(ds,{parentIdx:pi,obsId:undefined,timeType:"full",startTime:"",endTime:"",location:"",note:""});onClose();}}
            style={{padding:"5px 12px",background:guard?.parentIdx===pi&&!guard?.obsId?p.color:`${p.color}22`,color:guard?.parentIdx===pi&&!guard?.obsId?"#fff":p.color,border:`2px solid ${p.color}`,borderRadius:20,fontSize:13,fontWeight:700}}>
            {p.name||`P${pi+1}`}
          </button>
        ))}
        {guardianObs.map(o=>(
          <button key={o.id} onClick={()=>{updateCal(ds,{parentIdx:undefined,obsId:o.id,obsName:o.name,timeType:"full",startTime:"",endTime:"",location:"",note:""});onClose();}}
            style={{padding:"5px 12px",background:guard?.obsId===o.id?"#f59e0b":"#f59e0b18",color:guard?.obsId===o.id?"#fff":"#f59e0b",border:"2px solid #f59e0b",borderRadius:20,fontSize:13,fontWeight:700}}>
            🏠 {o.name||(o.email||"").split("@")[0]}
          </button>
        ))}
        <button onClick={()=>{updateCal(ds,{parentIdx:undefined,obsId:undefined});onClose();}} style={{padding:"5px 10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:20,fontSize:12}}>✕</button>
        {onFull
          ? <button onClick={onFull} style={{padding:"5px 10px",background:"transparent",color:C.vio,border:`1.5px solid ${C.vio}`,borderRadius:20,fontSize:12,marginLeft:"auto"}}>{t.fullEdit}</button>
          : <button disabled style={{padding:"5px 10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:20,fontSize:12,marginLeft:"auto",opacity:.6,cursor:"not-allowed",display:"flex",alignItems:"center",gap:5}}>🔒 {t.fullEdit}</button>
        }
      </div>
    </div>
  );
}

function EditDay({ds,onClose,editRef}) {
  const {C,t,cfg,updateCal} = useApp();
  const ex=cfg.overrides[ds]||{};
  const [pi,setPi]=useState(ex.obsId?`obs:${ex.obsId}`:(ex.parentIdx!==undefined?String(ex.parentIdx):""));
  const [tt,setTt]=useState(ex.timeType||"full");
  const [st,setSt]=useState(ex.startTime||"");
  const [et,setEt]=useState(ex.endTime||"");
  const [loc,setLoc]=useState(ex.location||"");
  const [note,setNote]=useState(ex.note||"");
  const guardianObs=(cfg.observers||[]).filter(o=>o.status==="active"&&o.canGuard);
  function save(){
    if(pi.startsWith("obs:")){
      const obsId=pi.slice(4);
      const obs=guardianObs.find(o=>String(o.id)===obsId);
      updateCal(ds,{parentIdx:undefined,obsId,obsName:obs?.name||"",timeType:tt,startTime:st,endTime:et,location:loc,note});
    } else {
      updateCal(ds,{parentIdx:pi===""?undefined:+pi,obsId:undefined,obsName:undefined,timeType:tt,startTime:st,endTime:et,location:loc,note});
    }
    onClose();
  }
  return (
    <div ref={editRef} className="card fi" style={{marginTop:12,borderColor:C.vio,scrollMarginTop:12}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
        <span style={{fontWeight:800}}>✏️ {t.editDay} — {ds.split("-").reverse().join("/")}</span>
        <button onClick={onClose} style={{background:"transparent",color:C.mut,fontSize:18}}>×</button>
      </div>
      <div className="row">
        <div className="field" style={{flex:1}}><label className="lbl">{t.guardParent}</label>
          <select value={pi} onChange={e=>setPi(e.target.value)}>
            <option value="">--</option>
            {cfg.parents.map((p,i)=><option key={i} value={String(i)}>{p.name||`${t.parentN} ${i+1}`}</option>)}
            {guardianObs.length>0&&<optgroup label="🏠 Gardiens">
              {guardianObs.map(o=><option key={o.id} value={`obs:${o.id}`}>🏠 {o.name||(o.email||"").split("@")[0]}</option>)}
            </optgroup>}
          </select>
        </div>
        <div className="field" style={{flex:1}}><label className="lbl">{t.schedule}</label><select value={tt} onChange={e=>setTt(e.target.value)}><option value="full">{t.wholeDay}</option><option value="start">{t.pickup}</option><option value="end">{t.dropoff}</option><option value="split">{t.both}</option></select></div>
      </div>
      {(tt==="start"||tt==="split")&&<div className="field"><label className="lbl">{t.pickupTime}</label><input type="time" value={st} onChange={e=>setSt(e.target.value)} /></div>}
      {(tt==="end"||tt==="split")&&<div className="field"><label className="lbl">{t.dropoffTime}</label><input type="time" value={et} onChange={e=>setEt(e.target.value)} /></div>}
      {tt!=="full"&&<div className="field"><label className="lbl">{t.place}</label><input value={loc} onChange={e=>setLoc(e.target.value)} /></div>}
      <div className="field"><label className="lbl">{t.note}</label><input value={note} onChange={e=>setNote(e.target.value)} /></div>
      <button onClick={save} style={{width:"100%",padding:"10px",background:C.vio,color:"#fff"}}>{t.saveDay}</button>
    </div>
  );
}

// ─── RATING ──────────────────────────────────────────────────────────────────
function RatingTab() {
  const {C,t} = useApp();
  const [hovered, setHovered] = useState(0);
  const [selected, setSelected] = useState(0);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const EMOJIS  = ['', '😔', '😐', '🙂', '😊', '😍'];
  const PLACEHOLDERS = t.ratingPlaceholders || ['', 'Qu\'est-ce qui vous a déçu ?', 'Qu\'est-ce qui pourrait être amélioré ?', 'Qu\'avez-vous apprécié ?', 'Qu\'est-ce que vous aimez le plus ?', 'Qu\'est-ce que vous aimez le plus ?'];
  const emoji   = selected ? EMOJIS[selected] : '🌟';
  const message = selected >= 4 ? (t.ratingMsgHigh||'Merci beaucoup ! 😍') : (t.ratingMsgLow||'Merci 🙏 Dites-nous comment améliorer');
  const canSend = selected > 0;

  if (submitted) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 20px",gap:14,animation:"ratingAppear .45s cubic-bezier(.34,1.56,.64,1) both"}}>
      <style>{`@keyframes ratingAppear{from{opacity:0;transform:scale(.88) translateY(12px)}to{opacity:1;transform:none}}`}</style>
      <span style={{fontSize:54}}>🎉</span>
      <div style={{fontSize:18,fontWeight:800,color:C.txt}}>{t.ratingThanks||"Merci pour votre retour !"}</div>
      <div style={{fontSize:13,color:C.mut}}>{"★".repeat(selected)}{"☆".repeat(5-selected)} ({selected}/5)</div>
      {comment && <div style={{marginTop:8,fontSize:13,color:C.mut,fontStyle:"italic",textAlign:"center",maxWidth:260,lineHeight:1.5}}>"{comment}"</div>}
    </div>
  );

  return (
    <div style={{padding:"8px 0"}}>
      <style>{`
        @keyframes ratingAppear{from{opacity:0;transform:scale(.88) translateY(12px)}to{opacity:1;transform:none}}
        .duvia-star{font-size:40px;cursor:pointer;color:#dde1ec;transition:color .15s,transform .15s cubic-bezier(.34,1.56,.64,1),filter .15s;user-select:none;line-height:1}
        .duvia-star.active{color:#FFB800;filter:drop-shadow(0 2px 6px rgba(255,184,0,.45))}
        .duvia-star.picked{transform:scale(1.18)}
        .duvia-textarea:focus{outline:none;border-color:#FFB800 !important;box-shadow:0 0 0 3px rgba(255,184,0,.15)}
      `}</style>

      <div style={{background:C.card,borderRadius:20,padding:"32px 24px 28px",textAlign:"center",boxShadow:`0 4px 24px rgba(0,0,0,.07)`,animation:"ratingAppear .45s cubic-bezier(.34,1.56,.64,1) both"}}>

        {/* Emoji */}
        <div style={{fontSize:44,marginBottom:12,lineHeight:1,transition:"all .2s"}}>{emoji}</div>
        <div style={{fontSize:17,fontWeight:800,color:C.txt,marginBottom:4,letterSpacing:"-.2px"}}>{t.ratingHeading||"Votre avis compte"}</div>
        <div style={{fontSize:13,color:C.mut,marginBottom:26}}>{t.ratingSubheading||"Comment évaluez-vous votre expérience ?"}</div>

        {/* Stars */}
        <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:22}}>
          {[1,2,3,4,5].map(v => (
            <span
              key={v}
              className={`duvia-star${(hovered||selected)>=v?" active":""}${selected===v?" picked":""}`}
              onMouseEnter={()=>setHovered(v)}
              onMouseLeave={()=>setHovered(0)}
              onClick={()=>setSelected(v)}
            >★</span>
          ))}
        </div>

        {/* Feedback message */}
        <div style={{fontSize:14,fontWeight:600,color:C.txt,opacity:selected?1:0,transform:selected?"translateY(0)":"translateY(6px)",transition:"opacity .25s,transform .25s",marginBottom:selected?18:0,minHeight:selected?20:0}}>
          {selected ? message : ""}
        </div>

        {/* Comment textarea — appears after star selection */}
        {selected > 0 && (
          <div style={{textAlign:"left",marginBottom:20,animation:"ratingAppear .3s cubic-bezier(.34,1.56,.64,1) both"}}>
            <label style={{fontSize:12,fontWeight:700,color:C.mut,display:"block",marginBottom:8,textTransform:"uppercase",letterSpacing:".5px"}}>{t.ratingCommentLabel||"Votre commentaire"} <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}>{t.ratingOptional||"(optionnel)"}</span></label>
            <textarea
              className="duvia-textarea"
              value={comment}
              onChange={e=>setComment(e.target.value)}
              placeholder={PLACEHOLDERS[selected]}
              rows={3}
              style={{width:"100%",padding:"12px 14px",borderRadius:12,border:`1.5px solid ${C.bor}`,background:C.sur,color:C.txt,fontSize:14,lineHeight:1.5,resize:"none",fontFamily:"inherit",transition:"border-color .2s,box-shadow .2s"}}
            />
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={()=>{ if(canSend) setSubmitted(true); }}
          style={{width:"100%",padding:"14px",border:"none",borderRadius:14,background:canSend?"linear-gradient(135deg,#FFB800,#FF8C00)":C.sur,color:canSend?"#fff":C.mut,fontSize:15,fontWeight:700,cursor:canSend?"pointer":"default",opacity:canSend?1:.5,transition:"all .25s",letterSpacing:".2px"}}
        >
          {t.ratingSubmit||"Envoyer mon avis"}
        </button>
      </div>
    </div>
  );
}
// ─── RATING END ───────────────────────────────────────────────────────────────

// ─── HISTORY ─────────────────────────────────────────────────────────────────
function HistTab() {
  const {C,t,cfg,setTab,setMenuTab} = useApp();
  const history = cfg.history || [];

  const TYPE_MAP = {"cal":0,"schedule":1,"exp":2,"contacts":3,"vault":4,"msg":5};
  const TYPE_ICON = {"cal":"📅","schedule":"🏫","exp":"💰","contacts":"📞","vault":"🗄️","msg":"💬"};

  function handleClick(h) {
    const idx = TYPE_MAP[h.type];
    if(idx === undefined) return;
    setMenuTab(null);
    setTab(idx);
  }

  if(!history.length) return <div style={{textAlign:"center",padding:60,color:C.mut}}><div style={{fontSize:48,marginBottom:12}}>📋</div>{t.noHistory}</div>;
  return (
    <div>
      <div style={{marginBottom:16,display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:36,height:36,borderRadius:12,background:`linear-gradient(135deg,${C.vio},${C.pin})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>📋</div>
        <div style={{flex:1}}>
          <div style={{fontSize:16,fontWeight:900}}>{t.historyTitle||"Historique"}</div>
          <div style={{fontSize:11,color:C.mut}}>{t.histSub||"Journal des modifications"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4,padding:"5px 9px",background:`${C.ora}15`,border:`1px solid ${C.ora}44`,borderRadius:8,flexShrink:0}}>
          <span style={{fontSize:11}}>👁️</span>
          <span style={{fontSize:10,color:C.ora,fontWeight:700}}>{t.vaultShared||"Visible QUE par les parents"}</span>
        </div>
      </div>
      <div className="sec">{t.historyTitle} ({history.length})</div>
      {history.map((h,i)=>{
        const d=new Date(h.date);
        const isClickable = h.type && TYPE_MAP[h.type] !== undefined;
        return (
          <div key={i} onClick={isClickable?()=>handleClick(h):undefined}
            className="card"
            style={{marginBottom:10,display:"flex",gap:12,cursor:isClickable?"pointer":"default",border:`1.5px solid ${C.bor}`,transition:"opacity .15s"}}>
            <div style={{background:C.sur,borderRadius:"50%",width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>
              {TYPE_ICON[h.type]||"📝"}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14}}>{h.action}</div>
              <div style={{color:C.mut,fontSize:13,marginTop:2}}>{h.detail}</div>
              <div style={{color:C.mut,fontSize:11,marginTop:3,fontFamily:"JetBrains Mono"}}>{h.who} · {d.toLocaleDateString()} {d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
            </div>
            {isClickable && <span style={{fontSize:12,color:C.mut,alignSelf:"center",flexShrink:0}}>→</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── EXPENSES ─────────────────────────────────────────────────────────────────
function ExpTab() {
  const {C,t,cfg,setCfg,addHist,pushNotif,user,prem,perms,onUpgrade,isAdm,setActivity,sub,simDate,setExpSubmittedPopup,addRefAction} = useApp();
  const premFull = isPremFull(sub); // PDF réservé full premium uniquement
  const now = simDate ? new Date(simDate) : new Date();
  const todayStr = toStr(now);
  const [showAdd,setShowAdd]=useState(false);
  const [editId,setEditId]=useState(null);
  const [catF,setCatF]=useState("all");
  const [viewer,setViewer]=useState(null);
  const [formErr,setFormErr]=useState("");
  const [shakeLabel,setShakeLabel]=useState(false);
  function _triggerShakeLabel(){ setShakeLabel(true); setTimeout(()=>setShakeLabel(false),600); }
  const [attErr,setAttErr]=useState("");
  const [attLoading,setAttLoading]=useState(false);
  const [dragOver,setDragOver]=useState(false);
  const fileRef=useRef(null);
  const formRef=useRef(null);
  const reimFormRef=useRef(null);
  const [showReim,setShowReim]=useState(false);
  const myIdx = user?.role==="parent" && user?.parentIdx!==undefined ? user.parentIdx : 0;
  const otherIdx = cfg.parents.length>1 ? (myIdx===0?1:0) : 0;
  const emptyReim={from:myIdx,to:otherIdx,amount:"",date:toStr(new Date()),note:""};
  const [reimForm,setReimForm]=useState(emptyReim);
  const [reimErr,setReimErr]=useState("");
  const [editReimId,setEditReimId]=useState(null);
  const [recurringEditModal,setRecurringEditModal]=useState(null);
  const [recurringDelModal,setRecurringDelModal]=useState(null);
  const [editScope,setEditScope]=useState(null);
  const [showExportModal,setShowExportModal]=useState(false);
  const [exportFrom,setExportFrom]=useState(()=>{const d=new Date();d.setMonth(d.getMonth()-3);return toStr(d);});
  const [exportTo,setExportTo]=useState(toStr(new Date()));
  const [exportGenerating,setExportGenerating]=useState(false);
  const [exportHtml,setExportHtml]=useState(null);
  const iframePdfRef=useRef(null);

  const emptyForm={label:"",amount:"",paidBy:myIdx,split:50,category:t.cats[0],date:toStr(new Date()),note:"",attachments:[],recurring:false,recurringFreq:"monthly",recurringEnd:""};
  const [form,setForm]=useState(emptyForm);
  const expenses=(cfg.expenses||[]).filter(e => !e.date || e.date <= todayStr);

  // ── Attachment helpers ────────────────────────────────────────────────────
  const MAX_MB=2; const MAX_BYTES=MAX_MB*1024*1024; const MAX_ATT=3;
  const ALLOWED_TYPES=['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'];
  const ALLOWED_EXT=['.jpg','.jpeg','.png','.webp','.heic','.heif','.pdf'];

  async function compressImage(file,maxW=1200,quality=0.82){
    return new Promise(resolve=>{
      const img=new Image();
      const url=URL.createObjectURL(file);
      img.onload=()=>{
        URL.revokeObjectURL(url);
        const ratio=Math.min(1,maxW/Math.max(img.width,1));
        const canvas=document.createElement('canvas');
        canvas.width=Math.round(img.width*ratio);
        canvas.height=Math.round(img.height*ratio);
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg',quality));
      };
      img.onerror=()=>{URL.revokeObjectURL(url);resolve(null);};
      img.src=url;
    });
  }

  async function toBase64(file){
    return new Promise(resolve=>{
      const r=new FileReader();
      r.onload=()=>resolve(r.result);
      r.readAsDataURL(file);
    });
  }

  function fmtSize(bytes){
    if(bytes<1024)return `${bytes} o`;
    if(bytes<1024*1024)return `${(bytes/1024).toFixed(0)} Ko`;
    return `${(bytes/1024/1024).toFixed(1)} Mo`;
  }

  // ── Admin: inject a fake test attachment ──────────────────────────────────
  function simulatePhoto(){
    const SAMPLES=[
      {label:"Facture médicale",color:"#4a9eff",emoji:"🏥"},
      {label:"Reçu pharmacie",color:"#3ecf8e",emoji:"💊"},
      {label:"Note de frais école",color:"#f5c842",emoji:"🏫"},
      {label:"Ticket restaurant",color:"#ff9f43",emoji:"🍽️"},
    ];
    const s=SAMPLES[Math.floor(Math.random()*SAMPLES.length)];
    const canvas=document.createElement('canvas');
    canvas.width=320; canvas.height=240;
    const ctx=canvas.getContext('2d');
    // Background
    ctx.fillStyle=s.color+'33'; ctx.fillRect(0,0,320,240);
    ctx.strokeStyle=s.color; ctx.lineWidth=3; ctx.strokeRect(4,4,312,232);
    // Emoji
    ctx.font='64px serif'; ctx.textAlign='center';
    ctx.fillText(s.emoji,160,110);
    // Label
    ctx.font='bold 16px sans-serif'; ctx.fillStyle=s.color;
    ctx.fillText(s.label,160,150);
    // Admin badge
    ctx.font='12px sans-serif'; ctx.fillStyle='#888';
    ctx.fillText('👑 Simulation Admin · '+new Date().toLocaleDateString(),160,180);
    const data=canvas.toDataURL('image/jpeg',0.85);
    const thumb=canvas.toDataURL('image/jpeg',0.5);
    const att={id:Date.now()+Math.random(),name:`${s.label.replace(/ /g,'_')}_sim.jpg`,type:'image/jpeg',data,thumb,originalSize:8192,compressedSize:Math.round(data.length*0.75)};
    setForm(f=>({...f,attachments:[...(f.attachments||[]),att].slice(0,MAX_ATT)}));
    setAttErr("");
  }

  async function handleFiles(rawFiles){
    setAttErr(""); setAttLoading(true);
    const current=form.attachments||[];
    if(current.length>=MAX_ATT){
      setAttErr(`Max ${MAX_ATT} ${t.expAttErrMax||"pièces jointes par dépense."}`);
      setAttLoading(false); return;
    }
    const newAtts=[...current];
    for(const file of Array.from(rawFiles)){
      if(newAtts.length>=MAX_ATT){setAttErr(`Max ${MAX_ATT} ${t.expAttErrMaxShort||"pièces jointes."}`);break;}
      const isImage=file.type.startsWith('image/');
      const isPdf=file.type==='application/pdf';
      const extOk=ALLOWED_EXT.some(e=>file.name.toLowerCase().endsWith(e));
      if(!ALLOWED_TYPES.includes(file.type)&&!extOk){
        setAttErr(`${t.expAttErrFormat||"Format non supporté"} : ${file.name}. ${t.expAttErrAccepted||"Acceptés : JPG, PNG, WEBP, HEIC, PDF."}`);
        continue;
      }
      if(file.size>MAX_BYTES){
        setAttErr(`${file.name} ${t.expAttErrSize||"dépasse"} ${MAX_MB} Mo (${fmtSize(file.size)}).`);
        continue;
      }
      let data=null, thumb=null;
      if(isPdf){
        data=await toBase64(file);
      } else if(isImage&&(file.type==='image/heic'||file.type==='image/heif'||file.name.toLowerCase().endsWith('.heic')||file.name.toLowerCase().endsWith('.heif'))){
        // HEIC — store as-is, no thumbnail
        data=await toBase64(file);
      } else if(isImage){
        data=await compressImage(file,1200,0.82);
        thumb=await compressImage(file,96,0.65);
      }
      if(data){
        const compressed=Math.round(data.length*0.75);
        newAtts.push({id:Date.now()+Math.random(),name:file.name,type:file.type||'application/octet-stream',data,thumb,originalSize:file.size,compressedSize:compressed});
      }
    }
    setForm(f=>({...f,attachments:newAtts}));
    setAttLoading(false);
  }

  function removeAtt(id){setForm(f=>({...f,attachments:(f.attachments||[]).filter(a=>a.id!==id)}));}

  function openViewer(att){setViewer(att);}

  function downloadAtt(att){
    const a=document.createElement('a');
    a.href=att.data; a.download=att.name; a.click();
  }

  // ── Expense CRUD ──────────────────────────────────────────────────────────

  // Génère les dates d'occurrences entre start et end selon la fréquence
  function getOccurrences(startDate, endDate, freq) {
    const dates = [];
    let cur = new Date(startDate + "T12:00:00");
    const end = new Date(endDate + "T12:00:00");
    while (cur <= end && dates.length < 120) {
      dates.push(toStr(cur));
      if (freq === "weekly")       cur = new Date(cur.getTime() + 7*24*3600*1000);
      else if (freq === "monthly") { cur = new Date(cur); cur.setMonth(cur.getMonth()+1); }
      else if (freq === "yearly")  { cur = new Date(cur); cur.setFullYear(cur.getFullYear()+1); }
      else break;
    }
    return dates;
  }

  function add(){
    if(!form.label){setFormErr(t.expErrDesc||"⚠️ La description est obligatoire.");return;}
    if(!form.amount||isNaN(parseFloat(form.amount))){setFormErr(t.expErrAmount||"⚠️ Le montant est obligatoire.");return;}
    // ── Validations sécurité ────────────────────────────────────────
    const amt = parseFloat(form.amount);
    if(amt < LIMITS.AMOUNT_MIN){ setFormErr(`⚠️ Montant minimum : ${LIMITS.AMOUNT_MIN}€`); return; }
    if(amt > LIMITS.AMOUNT_MAX){ setFormErr(`⚠️ Montant maximum : ${LIMITS.AMOUNT_MAX}€`); return; }
    const cleanLabel = sanitize(form.label).slice(0, LIMITS.LABEL_MAX);
    if(!cleanLabel){ setFormErr("⚠️ La description contient des caractères invalides."); return; }
    if(!isCleanText(cleanLabel)){ _triggerShakeLabel(); setFormErr("⚠️ La description contient des mots inappropriés."); return; }
    if(form.recurring && !form.recurringEnd){setFormErr("⚠️ La date de fin est obligatoire pour une dépense récurrente.");return;}
    if(form.recurring && form.recurringEnd < form.date){setFormErr("⚠️ La date de fin doit être après la date de début.");return;}
    setFormErr("");
    if(!prem&&!editId&&expenses.length>=1){} // no limit
    const payload={...form,label:cleanLabel,amount:amt,split:form.split||50,attachments:form.attachments||[]};

    if(editId){
      if(editScope==="series"){
        // Modifier toute la série : recalculer les occurrences et remplacer
        const existing=(cfg.expenses||[]).find(x=>x.id===editId);
        const rid=existing?.recurringId;
        if(rid && form.recurring && form.recurringEnd){
          const occurrences=getOccurrences(form.date,form.recurringEnd,form.recurringFreq);
          const newExpenses=occurrences.map((d,i)=>({
            ...payload,id:rid+i+(Date.now()%10000),date:d,
            recurringId:rid,recurringFreq:form.recurringFreq,
            recurringStart:form.date,recurringEnd:form.recurringEnd,
            status:"pending", createdBy: user?.parentIdx??0,
          }));
          setCfg(c=>({...c,expenses:[...newExpenses,...(c.expenses||[]).filter(x=>x.recurringId!==rid)]}));
          addHist(t.expModified||"Dépense modifiée",`🔄 ${form.label} — série (${occurrences.length} occ.)`,"exp");
          pushNotif(`✏️ ${form.label} — série modifiée, revalidation requise`,"exp");
        } else {
          // Fallback: single
          setCfg(c=>({...c,expenses:c.expenses.map(e=>e.id===editId?{...payload,id:editId,status:"pending",createdBy:user?.parentIdx??0}:e)}));
          addHist(t.expModified||"Dépense modifiée",`${form.label} — ${form.amount}€`,"exp");
          pushNotif(`✏️ ${form.label} (${form.amount}€) modifiée — revalidation requise`,"exp");
        }
      } else {
        setCfg(c=>({...c,expenses:c.expenses.map(e=>e.id===editId?{...payload,id:editId,status:"pending",createdBy:user?.parentIdx??0}:e)}));
        addHist(t.expModified||"Dépense modifiée",`${form.label} — ${form.amount}€`,"exp");
        pushNotif(`✏️ ${form.label} (${form.amount}€) modifiée — revalidation requise`,"exp");
      }
    } else if(form.recurring) {
      const occurrences = getOccurrences(form.date, form.recurringEnd, form.recurringFreq);
      const recurringId = Date.now();
      const newExpenses = occurrences.map((d, i) => ({
        ...payload, id: recurringId + i, date: d,
        recurringId, recurringFreq: form.recurringFreq,
        recurringStart: form.date, recurringEnd: form.recurringEnd,
        status:"pending", createdBy: user?.parentIdx??0,
      }));
      setCfg(c=>({...c,expenses:[...newExpenses,...(c.expenses||[])]}));
      addHist(t.newExpense,`🔄 ${form.label} — ${occurrences.length} occurrences`,"exp");
      pushNotif(`🔄 ${form.label} — ${occurrences.length} occurrence${occurrences.length>1?"s":""}` ,"exp");
      setActivity(a=>({...a,expenses:{ts:new Date().toISOString(),by:String(user?.id||"")}}));
      setExpSubmittedPopup(true);
    } else {
      const e={...payload,id:Date.now(),status:"pending",createdBy:user?.parentIdx??0};
      setCfg(c=>({...c,expenses:[e,...(c.expenses||[])]}));
      addHist(t.newExpense,`${form.label} — ${form.amount}€`,"exp");
      pushNotif(`💰 ${form.label} (${form.amount}€)`,"exp");
      setActivity(a=>({...a,expenses:{ts:new Date().toISOString(),by:String(user?.id||"")}}));
      addRefAction("ADD_EXPENSE");
      if((expenses||[]).length===0 && !sub?.refUsed) setTimeout(()=>{ try{ window.__setShowRefPrompt && window.__setShowRefPrompt(true); }catch(e){} },1200);
      setExpSubmittedPopup(true);
    }
    setShowAdd(false); setEditId(null); setEditScope(null); setForm(emptyForm); setAttErr(""); setFormErr("");
    setTimeout(()=>{ try{ document.getElementById("duvia-scroll")?.scrollTo({top:0,behavior:"smooth"}); }catch(e){} }, 60);
    return true;
  }

  function startEdit(e){
    if(e.recurringId){ setRecurringEditModal(e); return; }
    openEditForm(e,"single");
  }

  function openEditForm(e, scope){
    setEditScope(scope);
    if(scope==="series"){
      const seriesItems=(cfg.expenses||[]).filter(x=>x.recurringId===e.recurringId);
      const first=seriesItems.reduce((a,b)=>a.date<=b.date?a:b,seriesItems[0]);
      const last=seriesItems.reduce((a,b)=>a.date>=b.date?a:b,seriesItems[0]);
      setForm({label:e.label,amount:String(e.amount),paidBy:e.paidBy,split:e.split||50,category:e.category,
        date:first.date,note:e.note||"",attachments:e.attachments||[],
        recurring:true,recurringFreq:e.recurringFreq||"monthly",recurringEnd:last.date});
    } else {
      setForm({label:e.label,amount:String(e.amount),paidBy:e.paidBy,split:e.split||50,category:e.category,
        date:e.date||toStr(new Date()),note:e.note||"",attachments:e.attachments||[],
        recurring:false,recurringFreq:"monthly",recurringEnd:""});
    }
    setEditId(e.id); setShowAdd(true); setAttErr(""); setRecurringEditModal(null);
    setTimeout(()=>formRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),60);
  }

  function cancelForm(){setShowAdd(false);setEditId(null);setEditScope(null);setForm(emptyForm);setAttErr("");}

  function del(id){
    const e=(cfg.expenses||[]).find(x=>x.id===id);
    if(e?.recurringId){ setRecurringDelModal(e); return; }
    doDelete(id,"single");
  }

  function doDelete(id, scope){
    const e=(cfg.expenses||[]).find(x=>x.id===id);
    if(scope==="series" && e?.recurringId){
      setCfg(c=>({...c,expenses:c.expenses.filter(x=>x.recurringId!==e.recurringId)}));
      pushNotif("\uD83D\uDD04 Série supprimée","exp");
    } else {
      setCfg(c=>({...c,expenses:c.expenses.filter(x=>x.id!==id)}));
      pushNotif(t.expDeleted||"💰 Dépense supprimée","exp");
    }
    setRecurringDelModal(null);
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const reimbursements=cfg.reimbursements||[];
  // Backward compat: expenses without status are treated as confirmed
  const confirmedExpenses=expenses.filter(e=>!e.status||e.status==="confirmed");
  const total=confirmedExpenses.reduce((s,e)=>s+e.amount,0);
  const totals=cfg.parents.map((_,i)=>confirmedExpenses.filter(e=>e.paidBy===i).reduce((s,e)=>s+e.amount,0));
  const owed=cfg.parents.map((_,i)=>confirmedExpenses.reduce((s,e)=>{
    const sp=e.split||50;
    return s+e.amount*(i===e.paidBy?(100-sp)/100:sp/100);
  },0));
  // Reimbursements adjust the net balance: only confirmed ones are counted
  const confirmedReims=reimbursements.filter(r=>r.status==="confirmed");
  const reimSent=cfg.parents.map((_,i)=>confirmedReims.filter(r=>r.from===i).reduce((s,r)=>s+r.amount,0));
  const reimReceived=cfg.parents.map((_,i)=>confirmedReims.filter(r=>r.to===i).reduce((s,r)=>s+r.amount,0));
  const balance=cfg.parents.map((_,i)=>(totals[i]||0)-(owed[i]||0)+(reimSent[i]||0)-(reimReceived[i]||0));

  // ── Reimbursement CRUD ────────────────────────────────────────────────────
  function addReim(){
    if(!reimForm.amount||isNaN(parseFloat(reimForm.amount))||parseFloat(reimForm.amount)<=0){
      setReimErr(t.expErrReimAmount||"⚠️ Montant invalide.");return;
    }
    if(reimForm.from===reimForm.to){setReimErr(t.expErrReimSame||"⚠️ Les deux parents doivent être différents.");return;}
    setReimErr("");
    const fromName=cfg.parents[reimForm.from]?.name||`P${reimForm.from+1}`;
    const toName=cfg.parents[reimForm.to]?.name||`P${reimForm.to+1}`;
    if(editReimId){
      setCfg(c=>({...c,reimbursements:(c.reimbursements||[]).map(r=>r.id===editReimId?{...r,...reimForm,amount:parseFloat(reimForm.amount),status:"pending"}:r)}));
      addHist(t.expReimTitle||"Remboursement",`Modifié · ${fromName} → ${toName} · ${reimForm.amount}€`,"exp");
      pushNotif(`✏️ Remboursement de ${fromName} modifié (${reimForm.amount}€) — revalidation requise`,"exp");
      setEditReimId(null);
    } else {
      const r={...reimForm,id:Date.now(),amount:parseFloat(reimForm.amount),_type:"reim",status:"pending"};
      setCfg(c=>({...c,reimbursements:[r,...(c.reimbursements||[])]}));
      addHist(t.expReimTitle||"Remboursement",`${fromName} → ${toName} · ${reimForm.amount}€`,"exp");
      pushNotif(`💸 ${fromName} ${t.expReimAdded||"a remboursé"} ${toName} (${reimForm.amount}€)`,"exp");
    }
    setShowReim(false);
    setReimForm(emptyReim);
  }
  function delReim(id){setCfg(c=>({...c,reimbursements:(c.reimbursements||[]).filter(r=>r.id!==id)}));}
  function confirmReim(id){
    setCfg(c=>({...c,reimbursements:(c.reimbursements||[]).map(r=>r.id===id?{...r,status:"confirmed"}:r)}));
    const r=(cfg.reimbursements||[]).find(x=>x.id===id);
    if(r){ const fromName=cfg.parents[r.from]?.name||`P${r.from+1}`; pushNotif(`✅ Remboursement de ${fromName} (${r.amount}€) confirmé`,"exp"); addHist("Remboursement confirmé",`${fromName} → ${r.amount}€`,"exp"); }
  }
  function rejectReim(id){
    setCfg(c=>({...c,reimbursements:(c.reimbursements||[]).map(r=>r.id===id?{...r,status:"rejected"}:r)}));
    const r=(cfg.reimbursements||[]).find(x=>x.id===id);
    if(r){ const fromName=cfg.parents[r.from]?.name||`P${r.from+1}`; pushNotif(`❌ Remboursement de ${fromName} (${r.amount}€) refusé`,"exp"); }
  }

  function confirmExp(id){
    setCfg(c=>({...c,expenses:(c.expenses||[]).map(e=>e.id===id?{...e,status:"confirmed"}:e)}));
    const e=(cfg.expenses||[]).find(x=>x.id===id);
    if(e){ const pName=cfg.parents[e.createdBy]?.name||`P${(e.createdBy||0)+1}`; pushNotif(`${t.expConfirmedNotif||"✅ Dépense confirmée"} : ${e.label} (${e.amount}€)`,"exp"); addHist(t.expConfirmedNotif||"Dépense confirmée",`${e.label} · ${e.amount}€`,"exp"); }
  }
  function rejectExp(id){
    setCfg(c=>({...c,expenses:(c.expenses||[]).map(e=>e.id===id?{...e,status:"rejected"}:e)}));
    const e=(cfg.expenses||[]).find(x=>x.id===id);
    if(e){ pushNotif(`${t.expRejectedNotif||"❌ Dépense refusée"} : ${e.label}`,"exp"); addHist(t.expRejectedNotif||"Dépense refusée",`${e.label} · ${e.amount}€`,"exp"); }
  }

  const filtered=catF==="all"?expenses:expenses.filter(e=>e.category===catF);
  // Unified list: expenses + reimbursements sorted by date desc
  const allItems=[
    ...filtered.map(e=>({...e,_type:"expense"})),
    ...(catF==="all"?reimbursements.map(r=>({...r,_type:"reim"})):[])
  ].sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));

  // ── PDF Export ───────────────────────────────────────────────────────────
  function generateLegalPDF(){
    if(!premFull){ onUpgrade(); return; } // Réservé aux membres Premium abonnés
    setExportGenerating(true);
    try{
      const from=exportFrom; const to=exportTo;
      const filteredExpenses=(cfg.expenses||[]).filter(e=>{const d=e.date||"";return(!from||d>=from)&&(!to||d<=to);});
      const filteredReims=(cfg.reimbursements||[]).filter(r=>{const d=r.date||"";return(!from||d>=from)&&(!to||d<=to);});
      const filteredHistory=(cfg.history||[]).filter(h=>{const d=(h.date||"").slice(0,10);return(!from||d>=from)&&(!to||d<=to);});
      const now2=new Date();
      const fmtDate=d=>d?new Date(d+"T12:00:00").toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric"}):"—";
      const fmtDateTime=d=>d?new Date(d).toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—";
      const confirmedExp=filteredExpenses.filter(e=>!e.status||e.status==="confirmed");
      const totalConfirmed=confirmedExp.reduce((s,e)=>s+e.amount,0);
      const pendingExp=filteredExpenses.filter(e=>e.status==="pending");
      const rejectedExp=filteredExpenses.filter(e=>e.status==="rejected");
      const confirmedReims=filteredReims.filter(r=>r.status==="confirmed");
      const totalReims=confirmedReims.reduce((s,r)=>s+r.amount,0);
      const totalsPerParent=cfg.parents.map((_,i)=>confirmedExp.filter(e=>e.paidBy===i).reduce((s,e)=>s+e.amount,0));
      const owedPerParent=cfg.parents.map((_,i)=>confirmedExp.reduce((s,e)=>{const sp=e.split||50;return s+e.amount*(i===e.paidBy?(100-sp)/100:sp/100);},0));
      const reimSent2=cfg.parents.map((_,i)=>confirmedReims.filter(r=>r.from===i).reduce((s,r)=>s+r.amount,0));
      const reimReceived2=cfg.parents.map((_,i)=>confirmedReims.filter(r=>r.to===i).reduce((s,r)=>s+r.amount,0));
      const balances=cfg.parents.map((_,i)=>(totalsPerParent[i]||0)-(owedPerParent[i]||0)+(reimSent2[i]||0)-(reimReceived2[i]||0));
      const exportDateStr=now2.toLocaleDateString("fr-FR",{day:"2-digit",month:"long",year:"numeric"});
      const exportTimeStr=now2.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
      const periodLabel=`${from?fmtDate(from):"Début"} au ${to?fmtDate(to):"Aujourd'hui"}`;
      const totalRecords=filteredExpenses.length+filteredReims.length;
      const statusBadge=s=>{
        if(!s||s==="confirmed") return '<span style="background:#dcfce7;color:#166534;padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;">✓ Confirmé</span>';
        if(s==="pending") return '<span style="background:#fef9c3;color:#854d0e;padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;">⏳ En attente</span>';
        if(s==="rejected") return '<span style="background:#fee2e2;color:#991b1b;padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;">✗ Refusé</span>';
        return s||"—";
      };
      // Attachments section
      let attachmentsHtml="";
      const expWithAtt=filteredExpenses.filter(e=>(e.attachments||[]).length>0);
      if(expWithAtt.length>0){
        attachmentsHtml=`<div class="page-break"></div><div class="doc-header"><div class="doc-header-left">Duvia — Rapport de dépenses partagées</div><div class="doc-header-right">Période : ${periodLabel} · Export : ${exportDateStr}</div></div><div class="section-title">4. Justificatifs (${expWithAtt.length} dépenses avec pièce jointe)</div><p style="color:#666;font-size:10px;margin-bottom:16px;">Pièces jointes aux dépenses enregistrées sur la période sélectionnée.</p>`;
        expWithAtt.forEach(e=>{
          const pName=cfg.parents[e.paidBy]?.name||`Parent ${e.paidBy+1}`;
          attachmentsHtml+=`<div style="margin-bottom:24px;page-break-inside:avoid;"><div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;padding:8px 14px;margin-bottom:8px;font-size:10px;"><strong>${e.label||"—"}</strong> — ${pName} — ${fmtDate(e.date)} — ${(e.amount||0).toFixed(2)} €</div><div style="display:flex;flex-wrap:wrap;gap:10px;">`;
          (e.attachments||[]).forEach(a=>{
            if(a.data&&a.type&&a.type.startsWith("image/")) attachmentsHtml+=`<img src="${a.data}" style="max-width:200px;max-height:160px;border:1px solid #dee2e6;border-radius:4px;object-fit:contain;" alt="${a.name||"pièce jointe"}">`;
            else if(a.data&&a.type==="application/pdf") attachmentsHtml+=`<div style="width:110px;height:80px;border:1px solid #dee2e6;border-radius:4px;display:flex;align-items:center;justify-content:center;background:#f8f9fa;font-size:10px;color:#666;text-align:center;padding:6px;">📄 PDF<br><span style="font-size:8px;">${(a.name||"").slice(0,18)}</span></div>`;
          });
          attachmentsHtml+=`</div></div>`;
        });
      }
      const expRows=filteredExpenses.slice().sort((a,b)=>new Date(a.date||0)-new Date(b.date||0)).map(e=>{
        const pName=cfg.parents[e.paidBy]?.name||`Parent ${e.paidBy+1}`;
        const creatorName=e.createdBy!==undefined?(cfg.parents[e.createdBy]?.name||`Parent ${e.createdBy+1}`):pName;
        const idTs=e.id?new Date(e.id):null;
        const dateSaisie=idTs&&!isNaN(idTs)?idTs.toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric"}):"—";
        const heureSaisie=idTs&&!isNaN(idTs)?idTs.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}):"—";
        const sp=e.split||50;
        const hasAtt=(e.attachments||[]).length>0;
        return `<tr><td>${fmtDate(e.date)}</td><td>${dateSaisie}<br><span style="font-size:8px;color:#888;">${heureSaisie}</span></td><td>${e.category||"—"}</td><td><strong>${(e.label||"—").replace(/</g,"&lt;")}</strong>${e.note?`<br><span style="font-size:8px;color:#888;">${e.note.replace(/</g,"&lt;")}</span>`:""}</td><td style="text-align:right;font-weight:700;">${(e.amount||0).toFixed(2)} €</td><td>${pName}</td><td style="text-align:center;font-size:9px;">${sp}%/${100-sp}%</td><td>${statusBadge(e.status)}</td><td style="font-size:9px;">${creatorName}${hasAtt?" 📎":""}</td></tr>`;
      }).join("");
      const reimRows=filteredReims.slice().sort((a,b)=>new Date(a.date||0)-new Date(b.date||0)).map(r=>{
        const fromName=cfg.parents[r.from]?.name||`Parent ${r.from+1}`;
        const toName=cfg.parents[r.to]?.name||`Parent ${r.to+1}`;
        const idTs=r.id?new Date(r.id):null;
        const dateSaisie=idTs&&!isNaN(idTs)?idTs.toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric"}):"—";
        const heureSaisie=idTs&&!isNaN(idTs)?idTs.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}):"—";
        return `<tr><td>${fmtDate(r.date)}</td><td>${dateSaisie}<br><span style="font-size:8px;color:#888;">${heureSaisie}</span></td><td>${fromName}</td><td>${toName}</td><td style="text-align:right;font-weight:700;">${(r.amount||0).toFixed(2)} €</td><td style="font-size:9px;">${(r.note||"—").replace(/</g,"&lt;")}</td><td>${statusBadge(r.status)}</td></tr>`;
      }).join("");
      const histRows=filteredHistory.slice().sort((a,b)=>new Date(b.date||0)-new Date(a.date||0)).map(h=>`<tr><td>${fmtDateTime(h.date)}</td><td>${(h.who||"Système").replace(/</g,"&lt;")}</td><td>${(h.action||"—").replace(/</g,"&lt;")}</td><td style="font-size:9px;">${(h.detail||"—").replace(/</g,"&lt;")}</td></tr>`).join("");
      const exportId=Date.now().toString(36).toUpperCase()+"-DUVIA";

      const html=`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Duvia — Rapport de dépenses partagées</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;color:#1a1a2e;background:white;}
@page{size:A4;margin:18mm 14mm 18mm 14mm;}
@media print{.no-print{display:none!important;}.page-break{page-break-before:always;}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
.cover{min-height:240mm;display:flex;flex-direction:column;justify-content:space-between;padding:10mm 0;}
.cover-logo{display:flex;align-items:center;gap:12px;margin-bottom:36px;}
.cover-logo img{width:56px;height:56px;border-radius:12px;object-fit:contain;background:white;border:1px solid #e5e7eb;}
.cover-appname{font-size:30px;font-weight:900;color:#7B7CF5;letter-spacing:-1px;}
.cover-appsub{font-size:11px;color:#9ca3af;margin-top:3px;}
.cover-badge{display:inline-flex;align-items:center;gap:6px;background:#1a1a2e;color:white;font-size:9px;font-weight:800;padding:4px 14px;border-radius:20px;margin-bottom:20px;letter-spacing:1px;text-transform:uppercase;}
.cover-title{font-size:30px;font-weight:900;color:#17103A;line-height:1.15;margin-bottom:8px;}
.cover-sub{font-size:13px;color:#7269A8;margin-bottom:32px;}
.cover-meta-box{background:#F2EDFF;border:1.5px solid #C6B8EE;border-radius:12px;padding:20px 24px;margin-bottom:24px;}
.cover-meta-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;font-size:11px;}
.cover-meta-row:last-child{margin-bottom:0;}
.cml{font-weight:700;color:#7269A8;min-width:130px;flex-shrink:0;}
.cmv{color:#17103A;font-weight:600;}
.cover-legal{font-size:8.5px;color:#9ca3af;line-height:1.7;border-top:1px solid #e5e7eb;padding-top:12px;}
.page-break{page-break-before:always;}
.doc-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:2px solid #7B7CF5;margin-bottom:18px;}
.doc-header-left{font-size:9px;font-weight:800;color:#7B7CF5;text-transform:uppercase;letter-spacing:.5px;}
.doc-header-right{font-size:8px;color:#9ca3af;}
.section-title{font-size:14px;font-weight:800;color:#17103A;border-bottom:2px solid #7B7CF5;padding-bottom:7px;margin-bottom:14px;}
.subsection-title{font-size:10px;font-weight:800;color:#7269A8;margin:14px 0 8px;text-transform:uppercase;letter-spacing:.5px;}
.summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px;}
.sc{background:#F2EDFF;border:1px solid #C6B8EE;border-radius:8px;padding:12px 14px;}
.sc .sl{font-size:8px;font-weight:700;color:#7269A8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
.sc .sv{font-size:17px;font-weight:900;color:#17103A;}
.sc .ss{font-size:8px;color:#9ca3af;margin-top:2px;}
.parties-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:14px;}
.party-card{border:1px solid #e5e7eb;border-radius:8px;padding:13px;background:#fafafa;}
.party-name{font-size:12px;font-weight:800;color:#17103A;margin-bottom:7px;}
.party-row{font-size:9.5px;color:#6b7280;margin-bottom:3px;}
.party-row span{font-weight:600;color:#374151;}
table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:9.5px;}
thead tr{background:#17103A;color:white;}
thead th{padding:6px 8px;text-align:left;font-size:8px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;}
tbody tr:nth-child(even){background:#f9fafb;}
tbody td{padding:5px 7px;border-bottom:1px solid #f0f0f0;vertical-align:top;line-height:1.4;}
tfoot td{padding:6px 8px;font-size:9.5px;}
.no-data{text-align:center;padding:24px;color:#9ca3af;font-style:italic;font-size:10px;}
.audit-table thead tr{background:#374151;}
.cert-page{min-height:200mm;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:20mm 15mm;}
.cert-seal{width:72px;height:72px;border-radius:50%;border:3px solid #7B7CF5;display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 18px;background:#F2EDFF;}
.cert-title{font-size:18px;font-weight:900;color:#17103A;margin-bottom:6px;}
.cert-sub{font-size:11px;color:#7269A8;margin-bottom:28px;}
.cert-box{background:#F2EDFF;border:1.5px solid #C6B8EE;border-radius:12px;padding:20px 28px;display:inline-block;min-width:280px;margin-bottom:20px;text-align:left;}
.cr{display:flex;justify-content:space-between;gap:20px;margin-bottom:9px;font-size:10px;}
.cr:last-child{margin-bottom:0;}
.cr .crl{color:#7269A8;font-weight:600;}
.cr .crv{font-weight:800;color:#17103A;}
.cert-hash{font-family:monospace;font-size:8px;color:#c4b5fd;background:#17103A;padding:5px 12px;border-radius:6px;margin-top:14px;letter-spacing:1px;}
.cert-warn{font-size:8.5px;color:#9ca3af;max-width:360px;line-height:1.7;margin-top:20px;}
.print-btn{position:fixed;bottom:20px;right:20px;background:linear-gradient(135deg,#7B7CF5,#FF6CB8);color:white;border:none;border-radius:12px;padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(123,124,245,.4);z-index:999;}
</style>
</head>
<body>
<button class="no-print" onclick="window.print()" style="position:fixed;bottom:20px;right:20px;background:linear-gradient(135deg,#7B7CF5,#FF6CB8);color:white;border:none;border-radius:12px;padding:12px 20px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(123,124,245,.4);z-index:999;">🖨️ Imprimer / PDF</button>

<!-- ═══════════════ COUVERTURE ═══════════════ -->
<div class="cover">
<div>
  <div class="cover-logo">
    <img src="${APP_LOGO_PNG}" alt="Duvia">
    <div><div class="cover-appname">Duvia</div><div class="cover-appsub">Two homes. One family.</div></div>
  </div>
  <div class="cover-badge">📊 Export Duvia</div>
  <div class="cover-title">Rapport de dépenses<br>partagées</div>
  <div class="cover-sub">Garde alternée — Export des données Duvia</div>
  <div class="cover-meta-box">
    <div class="cover-meta-row"><div class="cml">📅 Période couverte&nbsp;:</div><div class="cmv">${periodLabel}</div></div>
    <div class="cover-meta-row"><div class="cml">🗓️ Date d'export&nbsp;:</div><div class="cmv">${exportDateStr} à ${exportTimeStr}</div></div>
    <div class="cover-meta-row"><div class="cml">👨‍👩‍👧 Famille&nbsp;:</div><div class="cmv">${cfg.parents.map(p=>(p.name||"—").replace(/</g,"&lt;")).join(" / ")}</div></div>
    <div class="cover-meta-row"><div class="cml">📊 Dépenses&nbsp;:</div><div class="cmv">${filteredExpenses.length} entrée${filteredExpenses.length!==1?"s":""} · Total confirmé ${totalConfirmed.toFixed(2)} €</div></div>
    <div class="cover-meta-row"><div class="cml">💸 Remboursements&nbsp;:</div><div class="cmv">${filteredReims.length} entrée${filteredReims.length!==1?"s":""} · Total confirmé ${totalReims.toFixed(2)} €</div></div>
    <div class="cover-meta-row"><div class="cml">🔑 ID Export&nbsp;:</div><div class="cmv" style="font-family:monospace;font-size:9px;">${exportId}</div></div>
  </div>
</div>
<div class="cover-legal">Ce rapport a été généré automatiquement par l'application Duvia le ${exportDateStr} à ${exportTimeStr}. Il présente les dépenses partagées et remboursements saisis par les utilisateurs pour la période indiquée.\n⚠️ Duvia est un outil d'aide à l'organisation familiale. Les données et rapports générés par cette application n'ont aucune valeur juridique et ne constituent pas des pièces légales. Ils ne remplacent pas un accord homologué, une décision judiciaire ou l'avis d'un professionnel du droit.</div>
</div>

<!-- ═══════════════ RÉSUMÉ EXÉCUTIF ═══════════════ -->
<div class="page-break"></div>
<div class="doc-header"><div class="doc-header-left">Duvia — Rapport de dépenses partagées</div><div class="doc-header-right">Période : ${periodLabel} · Export : ${exportDateStr}</div></div>
<div class="section-title">1. Résumé exécutif</div>
<div class="summary-grid">
  <div class="sc"><div class="sl">Total confirmé</div><div class="sv">${totalConfirmed.toFixed(2)} €</div><div class="ss">${confirmedExp.length} dépense${confirmedExp.length!==1?"s":""}</div></div>
  <div class="sc"><div class="sl">Remboursements</div><div class="sv">${totalReims.toFixed(2)} €</div><div class="ss">${confirmedReims.length} confirmé${confirmedReims.length!==1?"s":""}</div></div>
  <div class="sc"><div class="sl">En attente</div><div class="sv">${pendingExp.length}</div><div class="ss">Non validées</div></div>
  <div class="sc"><div class="sl">Refusées</div><div class="sv">${rejectedExp.length}</div><div class="ss">Sur la période</div></div>
  <div class="sc"><div class="sl">Total enregistrements</div><div class="sv">${totalRecords}</div><div class="ss">Dépenses + remb.</div></div>
  <div class="sc"><div class="sl">Modifications</div><div class="sv">${filteredHistory.length}</div><div class="ss">Entrées historique</div></div>
</div>
<div class="subsection-title">Soldes par parent</div>
<table>
  <thead><tr><th>Parent</th><th style="text-align:right;">Total payé</th><th style="text-align:right;">Quote-part due</th><th style="text-align:right;">Remb. envoyés</th><th style="text-align:right;">Remb. reçus</th><th style="text-align:right;">Solde net</th></tr></thead>
  <tbody>${cfg.parents.map((p,i)=>`<tr><td style="font-weight:700;">${(p.name||`Parent ${i+1}`).replace(/</g,"&lt;")}</td><td style="text-align:right;">${(totalsPerParent[i]||0).toFixed(2)} €</td><td style="text-align:right;">${(owedPerParent[i]||0).toFixed(2)} €</td><td style="text-align:right;">${(reimSent2[i]||0).toFixed(2)} €</td><td style="text-align:right;">${(reimReceived2[i]||0).toFixed(2)} €</td><td style="text-align:right;font-weight:800;color:${balances[i]>0.01?"#166534":balances[i]<-0.01?"#991b1b":"#374151"};">${balances[i]>0?"+":" "}${(balances[i]||0).toFixed(2)} €</td></tr>`).join("")}</tbody>
</table>

<!-- ═══════════════ PARTIES ═══════════════ -->
<div class="page-break"></div>
<div class="doc-header"><div class="doc-header-left">Duvia — Rapport de dépenses partagées</div><div class="doc-header-right">Période : ${periodLabel} · Export : ${exportDateStr}</div></div>
<div class="section-title">2. Informations des parties</div>
<div class="subsection-title">Parents / Détenteurs de l'autorité parentale</div>
<div class="parties-grid">${cfg.parents.map((p,i)=>`<div class="party-card" style="border-left:4px solid ${p.color||"#7B7CF5"};"><div class="party-name">${(p.name||`Parent ${i+1}`).replace(/</g,"&lt;")}</div><div class="party-row">Rôle&nbsp;: <span>${p.gender==="female"?"Mère":p.gender==="male"?"Père":"Parent"}</span></div><div class="party-row">Téléphone&nbsp;: <span>${(p.phone||"Non renseigné").replace(/</g,"&lt;")}</span></div><div class="party-row">Email&nbsp;: <span>${(p.email||p.inviteEmail||"Non renseigné").replace(/</g,"&lt;")}</span></div></div>`).join("")}</div>
<div class="subsection-title">Enfants concernés</div>
${(cfg.children||[]).length===0?'<p style="color:#9ca3af;font-style:italic;font-size:10px;">Aucun enfant enregistré.</p>':`<div class="parties-grid">${(cfg.children||[]).map((c,i)=>`<div class="party-card"><div class="party-name">👶 ${(c.name||`Enfant ${i+1}`).replace(/</g,"&lt;")}</div>${c.birthDay&&c.birthMonth?`<div class="party-row">Naissance&nbsp;: <span>${String(c.birthDay).padStart(2,"0")}/${String(c.birthMonth).padStart(2,"0")}</span></div>`:""}</div>`).join("")}</div>`}

<!-- ═══════════════ DÉPENSES ═══════════════ -->
<div class="page-break"></div>
<div class="doc-header"><div class="doc-header-left">Duvia — Rapport de dépenses partagées</div><div class="doc-header-right">Période : ${periodLabel} · Export : ${exportDateStr}</div></div>
<div class="section-title">3. Détail des dépenses et remboursements</div>
<div class="subsection-title">3.1 Dépenses (${filteredExpenses.length})</div>
${filteredExpenses.length===0?'<div class="no-data">Aucune dépense sur cette période.</div>':`<table><thead><tr><th>Date</th><th>Saisie / Heure</th><th>Catégorie</th><th>Description</th><th style="text-align:right;">Montant</th><th>Payé par</th><th>Répart.</th><th>Statut</th><th>Créé par</th></tr></thead><tbody>${expRows}</tbody><tfoot><tr style="background:#17103A;color:white;"><td colspan="4" style="font-weight:800;padding:6px 8px;">TOTAL CONFIRMÉ</td><td style="text-align:right;font-weight:800;padding:6px 8px;">${totalConfirmed.toFixed(2)} €</td><td colspan="4"></td></tr></tfoot></table>`}
<div class="subsection-title" style="margin-top:20px;">3.2 Remboursements (${filteredReims.length})</div>
${filteredReims.length===0?'<div class="no-data">Aucun remboursement sur cette période.</div>':`<table><thead><tr><th>Date</th><th>Saisie / Heure</th><th>De (rembourseur)</th><th>À (bénéficiaire)</th><th style="text-align:right;">Montant</th><th>Note</th><th>Statut</th></tr></thead><tbody>${reimRows}</tbody><tfoot><tr style="background:#17103A;color:white;"><td colspan="4" style="font-weight:800;padding:6px 8px;">TOTAL CONFIRMÉ</td><td style="text-align:right;font-weight:800;padding:6px 8px;">${totalReims.toFixed(2)} €</td><td colspan="2"></td></tr></tfoot></table>`}

${attachmentsHtml}

<!-- ═══════════════ AUDIT ═══════════════ -->
<div class="page-break"></div>
<div class="doc-header"><div class="doc-header-left">Duvia — Rapport de dépenses partagées</div><div class="doc-header-right">Période : ${periodLabel} · Export : ${exportDateStr}</div></div>
<div class="section-title">5. Historique des modifications (${filteredHistory.length} entrées)</div>
<p style="color:#666;font-size:10px;margin-bottom:14px;">Retraçage complet des créations, modifications et validations de dépenses sur la période.</p>
${filteredHistory.length===0?'<div class="no-data">Aucune entrée d\'audit sur cette période.</div>':`<table class="audit-table"><thead><tr><th>Date / Heure</th><th>Utilisateur</th><th>Action</th><th>Détail</th></tr></thead><tbody>${histRows}</tbody></table>`}

<!-- ═══════════════ CERTIFICATION ═══════════════ -->
<div class="page-break"></div>
<div class="cert-page">
  <div class="cert-seal">🏛️</div>
  <div class="cert-title">Certification d'authenticité</div>
  <div class="cert-sub">Document généré par Duvia · Application de gestion de garde alternée</div>
  <div class="cert-box">
    <div class="cr"><span class="crl">Date de génération</span><span class="crv">${exportDateStr} à ${exportTimeStr}</span></div>
    <div class="cr"><span class="crl">Période couverte</span><span class="crv">${periodLabel}</span></div>
    <div class="cr"><span class="crl">Famille</span><span class="crv">${cfg.parents.map(p=>(p.name||"—").replace(/</g,"&lt;")).join(" / ")}</span></div>
    <div class="cr"><span class="crl">Dépenses exportées</span><span class="crv">${filteredExpenses.length}</span></div>
    <div class="cr"><span class="crl">Remboursements exportés</span><span class="crv">${filteredReims.length}</span></div>
    <div class="cr"><span class="crl">Total enregistrements</span><span class="crv">${totalRecords}</span></div>
    <div class="cr"><span class="crl">Entrées historique</span><span class="crv">${filteredHistory.length}</span></div>
    <div class="cr"><span class="crl">Généré par</span><span class="crv">${(user?.name||"Utilisateur").replace(/</g,"&lt;")}</span></div>
  </div>
  <div class="cert-hash">ID EXPORT : ${exportId}</div>
  <div class="cert-warn">Ce rapport reflète les données saisies par les utilisateurs dans l'application Duvia pour la période sélectionnée. ⚠️ Duvia est un outil d'aide à l'organisation familiale. Les rapports et données de cette application n'ont aucune valeur juridique. Ils ne remplacent pas un accord légal, une décision judiciaire ou l'avis d'un professionnel du droit.</div>
</div>
<script>
window.addEventListener('message',function(e){
  if(e.data==='DUVIA_PRINT'){window.print();}
});
</script>
</body></html>`;

      setExportHtml(html);
      setExportGenerating(false);
      setShowExportModal(false);
    }catch(err){
      console.error("PDF Export error:",err);
      setExportGenerating(false);
    }
  }

  // ── Attachment drop zone UI ───────────────────────────────────────────────
  function AttachZone(){
    const atts=form.attachments||[];
    return (
      <div className="field">
        <label className="lbl">{t.expAttLabel||"📎 Pièces jointes"} (max {MAX_ATT} · {MAX_MB} Mo · JPG PNG WEBP HEIC PDF)</label>
        {/* Drop zone */}
        <div
          onClick={()=>fileRef.current?.click()}
          onDragOver={e=>{e.preventDefault();setDragOver(true);}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files);}}
          style={{border:`2px dashed ${dragOver?C.vio:C.bor}`,borderRadius:12,padding:"14px 12px",textAlign:"center",cursor:"pointer",background:dragOver?`${C.vio}0a`:C.sur,transition:"all .15s",marginBottom:8}}
        >
          {attLoading
            ? <div style={{color:C.mut,fontSize:13}}>{t.expAttProcessing||"⏳ Traitement…"}</div>
            : <div>
                <div style={{fontSize:26,marginBottom:4}}>📂</div>
                <div style={{fontSize:12,color:C.mut}}>{t.expAttClick||"Cliquer ou glisser-déposer"}</div>
                <div style={{fontSize:10,color:C.mut,marginTop:2}}>{t.expAttFormats||"JPG · PNG · WEBP · HEIC · PDF · max"} {MAX_MB} Mo</div>
              </div>
          }
        </div>
        <input ref={fileRef} type="file" multiple accept={ALLOWED_EXT.join(',')} style={{display:"none"}}
          onChange={e=>{handleFiles(e.target.files);e.target.value="";}} />
        {isAdm&&(form.attachments||[]).length<MAX_ATT&&(
          <button onClick={simulatePhoto} style={{width:"100%",padding:"7px",background:"linear-gradient(135deg,#FFD70022,#ff9f4322)",border:"1.5px dashed #FFD700",borderRadius:8,color:"#b45309",fontSize:11,fontWeight:800,marginTop:4,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            {t.expAttSimulate||"👑 Simuler une pièce jointe"} <span style={{fontWeight:400,opacity:.7}}>{t.expAttSimulateNote||"(admin only)"}</span>
          </button>
        )}
        {attErr&&<div style={{fontSize:11,color:C.red,marginBottom:6,padding:"5px 8px",background:`${C.red}12`,borderRadius:6}}>⚠️ {attErr}</div>}
        {/* Preview list */}
        {atts.length>0&&(
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
            {atts.map(a=>(
              <div key={a.id} style={{position:"relative",width:72,height:72,borderRadius:10,overflow:"hidden",border:`1.5px solid ${C.bor}`,background:C.sur,cursor:"pointer",flexShrink:0}} onClick={()=>openViewer(a)}>
                {a.thumb
                  ? <img src={a.thumb} alt={a.name} style={{width:"100%",height:"100%",objectFit:"cover"}} />
                  : <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2}}>
                      <span style={{fontSize:26}}>{a.type==='application/pdf'?'📄':'🖼️'}</span>
                      <span style={{fontSize:8,color:C.mut,textAlign:"center",padding:"0 4px",wordBreak:"break-all",lineHeight:1.2}}>{a.name.slice(0,16)}</span>
                    </div>
                }
                <button onClick={ev=>{ev.stopPropagation();removeAtt(a.id);}}
                  style={{position:"absolute",top:2,right:2,width:18,height:18,borderRadius:"50%",background:"rgba(0,0,0,.6)",color:"#fff",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center",padding:0,lineHeight:1}}>✕</button>
                <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,.45)",color:"#fff",fontSize:8,textAlign:"center",padding:"2px 3px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  {fmtSize(a.compressedSize||a.originalSize)}
                </div>
              </div>
            ))}
            {atts.length<MAX_ATT&&(
              <div onClick={()=>fileRef.current?.click()} style={{width:72,height:72,borderRadius:10,border:`2px dashed ${C.bor}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:C.mut,fontSize:26,flexShrink:0}}>+</div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{position:"relative"}}>
      {/* ── Viewer modal ── */}
      {viewer&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.85)",zIndex:500,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setViewer(null)}>
          <div onClick={e=>e.stopPropagation()} style={{maxWidth:"min(94vw,680px)",maxHeight:"88vh",display:"flex",flexDirection:"column",gap:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
              <span style={{color:"#fff",fontSize:13,fontWeight:700,wordBreak:"break-all"}}>{viewer.name}</span>
              <div style={{display:"flex",gap:8,flexShrink:0}}>
                <button onClick={()=>downloadAtt(viewer)} style={{padding:"6px 14px",background:C.vio,color:"#fff",borderRadius:8,fontSize:12,fontWeight:700}}>{t.expDownload||"⬇ Télécharger"}</button>
                <button onClick={()=>setViewer(null)} style={{padding:"6px 12px",background:"rgba(255,255,255,.15)",color:"#fff",borderRadius:8,fontSize:12}}>✕</button>
              </div>
            </div>
            {viewer.type==='application/pdf'
              ? <div style={{background:C.card,borderRadius:12,padding:24,textAlign:"center"}}>
                  <div style={{fontSize:56,marginBottom:12}}>📄</div>
                  <div style={{fontSize:14,color:C.txt,marginBottom:6,fontWeight:700}}>{viewer.name}</div>
                  <div style={{fontSize:12,color:C.mut,marginBottom:14}}>{fmtSize(viewer.compressedSize||viewer.originalSize)}</div>
                  <button onClick={()=>downloadAtt(viewer)} style={{padding:"10px 24px",background:C.vio,color:"#fff",borderRadius:10,fontSize:14,fontWeight:800}}>{t.expDownloadPdf||"⬇ Télécharger le PDF"}</button>
                </div>
              : <img src={viewer.data} alt={viewer.name} style={{maxWidth:"100%",maxHeight:"75vh",borderRadius:12,objectFit:"contain"}} />
            }
          </div>
        </div>
      )}

      {/* ── Modal choix modification récurrente ── */}
      {recurringEditModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:20,padding:28,maxWidth:320,width:"100%",border:`1.5px solid ${C.vio}`,boxShadow:"0 12px 40px rgba(0,0,0,.25)"}}>
            <div style={{fontSize:32,textAlign:"center",marginBottom:10}}>🔄</div>
            <div style={{fontSize:15,fontWeight:800,marginBottom:6,textAlign:"center"}}>Modifier la dépense récurrente</div>
            <div style={{fontSize:13,color:C.mut,marginBottom:20,textAlign:"center",lineHeight:1.5}}>
              <strong style={{color:C.vio}}>{recurringEditModal.label}</strong><br/>
              Voulez-vous modifier uniquement cette occurrence ou toute la série ?
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <button onClick={()=>openEditForm(recurringEditModal,"single")}
                style={{padding:"13px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:14,textAlign:"left",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:20}}>📌</span>
                <div>
                  <div>Cette occurrence uniquement</div>
                  <div style={{fontSize:11,color:C.mut,fontWeight:400}}>Le {(recurringEditModal.date||"").split("-").reverse().join("/")}</div>
                </div>
              </button>
              <button onClick={()=>openEditForm(recurringEditModal,"series")}
                style={{padding:"13px",background:`${C.vio}10`,color:C.vio,border:`1.5px solid ${C.vio}`,borderRadius:12,fontWeight:700,fontSize:14,textAlign:"left",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:20}}>🔄</span>
                <div>
                  <div>Toute la série</div>
                  <div style={{fontSize:11,color:C.mut,fontWeight:400}}>Toutes les occurrences seront recalculées</div>
                </div>
              </button>
              <button onClick={()=>setRecurringEditModal(null)}
                style={{padding:"10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontWeight:700,fontSize:13}}>
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal choix suppression récurrente ── */}
      {recurringDelModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:20,padding:28,maxWidth:320,width:"100%",border:`1.5px solid ${C.red}`,boxShadow:"0 12px 40px rgba(0,0,0,.25)"}}>
            <div style={{fontSize:32,textAlign:"center",marginBottom:10}}>🗑️</div>
            <div style={{fontSize:15,fontWeight:800,marginBottom:6,textAlign:"center"}}>Supprimer la dépense récurrente</div>
            <div style={{fontSize:13,color:C.mut,marginBottom:20,textAlign:"center",lineHeight:1.5}}>
              <strong style={{color:C.red}}>{recurringDelModal.label}</strong><br/>
              Supprimer uniquement cette occurrence ou toute la série ?
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <button onClick={()=>doDelete(recurringDelModal.id,"single")}
                style={{padding:"13px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:14,textAlign:"left",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:20}}>📌</span>
                <div>
                  <div>Cette occurrence uniquement</div>
                  <div style={{fontSize:11,color:C.mut,fontWeight:400}}>Le {(recurringDelModal.date||"").split("-").reverse().join("/")}</div>
                </div>
              </button>
              <button onClick={()=>doDelete(recurringDelModal.id,"series")}
                style={{padding:"13px",background:`${C.red}10`,color:C.red,border:`1.5px solid ${C.red}`,borderRadius:12,fontWeight:700,fontSize:14,textAlign:"left",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:20}}>🔄</span>
                <div>
                  <div>Toute la série</div>
                  <div style={{fontSize:11,color:C.mut,fontWeight:400}}>Toutes les occurrences seront supprimées</div>
                </div>
              </button>
              <button onClick={()=>setRecurringDelModal(null)}
                style={{padding:"10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontWeight:700,fontSize:13}}>
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontSize:16,fontWeight:900}}>💰 {t.tabExp||"Dépenses"}</div>
          <div style={{fontSize:11,color:C.mut}}>{t.expSub||"Suivi des dépenses partagées"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <button
            onClick={()=>{ if(!premFull){ onUpgrade(); return; } setShowExportModal(true); }}
            title={premFull ? (t.exportPDF||"Exporter en PDF") : (t.premiumSubscribersOnly||"Réservé aux membres Premium abonnés")}
            style={{display:"flex",alignItems:"center",gap:3,padding:"3px 7px",background:premFull?`${C.vio}15`:`${C.mut}15`,border:`1px solid ${premFull?C.vio:C.mut}44`,borderRadius:6,cursor:"pointer",transition:"all .15s",opacity:premFull?1:.6}}
          >
            <span style={{fontSize:10}}>{premFull?"📄":"🔒"}</span>
            <span style={{fontSize:9,color:premFull?C.vio:C.mut,fontWeight:800}}>PDF</span>
          </button>
          <InfoBubble C={C} tipKey={`duvia_exptip_${user?.id||"x"}`} title={t.tabExp||"Dépenses"}>
            {t.expTipBody||"Suivez et partagez les dépenses de l'enfant. Cette section est visible uniquement par les parents."}
          </InfoBubble>
        </div>
      </div>

      {/* ── Freemium / Trial notice ── */}
      {!prem && (
        <div onClick={onUpgrade} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",marginBottom:14,background:`${C.vio}10`,border:`1.5px dashed ${C.vio}55`,borderRadius:14,cursor:"pointer"}}>
          <span style={{fontSize:20,flexShrink:0}}>🔒</span>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:800,color:C.vio}}>Soldes — Premium</div>
            <div style={{fontSize:11,color:C.mut,marginTop:1}}>Les montants des soldes sont floutés. Passez en Premium pour les voir en clair.</div>
          </div>
          <div style={{flexShrink:0,padding:"5px 10px",background:`${C.vio}22`,color:C.vio,borderRadius:8,fontSize:11,fontWeight:800}}>⭐ Premium</div>
        </div>
      )}

      {/* ── Totals cards ── */}
      <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(cfg.parents.length+1,4)},1fr)`,gap:8,marginBottom:14}}>
        {cfg.parents.map((p,i)=>(
          <div key={i} className="card" style={{borderColor:p.color,textAlign:"center",padding:12}}>
            <div style={{fontSize:10,color:C.mut,textTransform:"uppercase",marginBottom:4,fontWeight:800}}>{p.name||`P${i+1}`}</div>
            <div style={{fontSize:18,fontWeight:900,color:p.color}}>{(totals[i]||0).toFixed(2)}€</div>
            <div style={{fontSize:10,color:C.mut,marginTop:2}}>{t.expPaid||"payé"}: {(totals[i]||0).toFixed(2)}€</div>
            <div style={{fontSize:10,color:balance[i]>0.01?C.grn:balance[i]<-0.01?C.red:C.mut,fontWeight:700,filter:!perms?.balanceVisible?"blur(5px)":"none",userSelect:!perms?.balanceVisible?"none":"auto"}}>
              {balance[i]>0.01?`+${balance[i].toFixed(2)}€`:balance[i]<-0.01?`${balance[i].toFixed(2)}€`:t.even}
            </div>
          </div>
        ))}
        <div className="card" style={{textAlign:"center",padding:12}}>
          <div style={{fontSize:10,color:C.mut,textTransform:"uppercase",marginBottom:4,fontWeight:800}}>{t.total}</div>
          <div style={{fontSize:18,fontWeight:900,color:C.blu}}>{total.toFixed(2)}€</div>
          <div style={{fontSize:10,color:C.mut}}>{expenses.length} {expenses.length!==1?(t.expCountPlural||"dépenses"):(t.expCount||"dépense")}</div>
        </div>
      </div>

      {/* ── Who owes whom ── */}
      {(()=>{
        if(cfg.parents.length<2) return null;
        const creditor=balance.reduce((best,b,i)=>b>balance[best]?i:best,0);
        const debtor=balance.reduce((best,b,i)=>b<balance[best]?i:best,0);
        const diff=balance[creditor]-balance[debtor];
        const isBalanced=diff<0.01;
        const balBlur = !perms?.balanceVisible;
        return (
          <div style={{marginBottom:14,padding:"10px 14px",borderRadius:12,background:isBalanced?`${C.grn}12`:`${C.ora}12`,border:`1.5px solid ${isBalanced?C.grn:C.ora}`,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:20}}>{isBalanced?"✅":"💳"}</span>
            {isBalanced
              ? <span style={{fontSize:13,fontWeight:800,color:C.grn}}>{t.expBalanced||"Comptes équilibrés — aucun remboursement nécessaire"}</span>
              : <span style={{fontSize:13,fontWeight:700,color:C.txt,lineHeight:1.4,display:"flex",alignItems:"center",flexWrap:"wrap",gap:4}}>
                  <span style={{color:cfg.parents[debtor]?.color,fontWeight:900}}>{cfg.parents[debtor]?.name||`P${debtor+1}`}</span>
                  {" "}{t.expOwes||"doit"}{" "}
                  {balBlur
                    ? <span onClick={onUpgrade} style={{fontFamily:"JetBrains Mono",fontWeight:900,color:C.ora,filter:"blur(5px)",cursor:"pointer",userSelect:"none",background:`${C.ora}18`,borderRadius:6,padding:"1px 6px"}}>99,99€</span>
                    : <span style={{fontFamily:"JetBrains Mono",fontWeight:900,color:C.ora}}>{(diff/2).toFixed(2)}€</span>
                  }
                  {" "}{t.expTo||"à"}{" "}
                  <span style={{color:cfg.parents[creditor]?.color,fontWeight:900}}>{cfg.parents[creditor]?.name||`P${creditor+1}`}</span>
                  {balBlur && <span onClick={onUpgrade} style={{fontSize:10,color:C.ora,fontWeight:800,cursor:"pointer",marginLeft:4}}>🔒 Premium</span>}
                </span>
            }
          </div>
        );
      })()}
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={()=>{if(showAdd&&!editId){cancelForm();setShowReim(false);}else if(!showAdd){setShowAdd(true);setShowReim(false);}else{cancelForm();setShowReim(false);}}}
          style={{flex:2,height:44,background:showAdd?C.sur:C.vio,color:showAdd?C.mut:"#fff",border:showAdd?`1.5px solid ${C.bor}`:"none",borderRadius:10}}>
          {showAdd?(editId?(t.expEditCancel||"✕ Annuler"):t.cancelAdd):t.addExpense}
        </button>
        <button onClick={()=>{setShowReim(r=>!r);setShowAdd(false);cancelForm();setReimErr("");}}
          style={{flex:1,height:44,background:showReim?C.sur:`${C.grn}18`,color:showReim?C.mut:C.grn,border:`1.5px solid ${showReim?C.bor:C.grn+"66"}`,borderRadius:10,fontWeight:700,fontSize:13}}>
          {showReim?(t.expReimCancel||"✕ Annuler"):(t.expReimBtn||"💸 Remboursement")}
        </button>
      </div>

      {/* ── Reimbursement form ── */}
      {showReim&&(
        <div ref={reimFormRef} className="card fi" style={{marginBottom:12,borderColor:C.grn,scrollMarginTop:12}}>
          <div className="sec">{editReimId?"✏️ Modifier le remboursement":(t.expReimSectionTitle||"💸 Ajouter un remboursement")}</div>
          <div style={{fontSize:12,color:C.mut,marginBottom:12,lineHeight:1.5}}>
            {t.expReimDesc||"Un remboursement enregistre qu'un parent a rendu de l'argent à l'autre et ajuste automatiquement le solde."}
          </div>
          <div className="row">
            <div className="field" style={{flex:1}}>
              <label className="lbl">{t.expReimFrom||"De (qui rembourse)"}</label>
              <select value={reimForm.from} onChange={e=>{const v=+e.target.value;setReimForm(f=>({...f,from:v,to:f.to===v?(v===0?1:0):f.to}));}}>
                {cfg.parents.map((p,i)=><option key={i} value={i}>{p.name||`P${i+1}`}</option>)}
              </select>
            </div>
            <div style={{display:"flex",alignItems:"center",paddingBottom:14,fontSize:18}}>→</div>
            <div className="field" style={{flex:1}}>
              <label className="lbl">{t.expReimTo||"À (qui reçoit)"}</label>
              <select value={reimForm.to} onChange={e=>{const v=+e.target.value;setReimForm(f=>({...f,to:v,from:f.from===v?(v===0?1:0):f.from}));}}>
                {cfg.parents.map((p,i)=><option key={i} value={i}>{p.name||`P${i+1}`}</option>)}
              </select>
            </div>
          </div>
          <div className="row">
            <div className="field" style={{flex:1}}><label className="lbl">{t.amount}</label><input type="number" step="0.01" min="0.01" value={reimForm.amount} onChange={e=>setReimForm(f=>({...f,amount:e.target.value}))} placeholder="0.00" /></div>
            <div className="field" style={{flex:1}}><label className="lbl">{t.date}</label><input type="date" value={reimForm.date} onChange={e=>setReimForm(f=>({...f,date:e.target.value}))} /></div>
          </div>
          <div className="field"><label className="lbl">{t.note}</label><input value={reimForm.note} onChange={e=>setReimForm(f=>({...f,note:e.target.value}))} /></div>
          {reimErr&&<div style={{fontSize:12,color:C.red,padding:"7px 10px",background:`${C.red}12`,borderRadius:8,marginBottom:8}}>{reimErr}</div>}
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{setShowReim(false);setReimForm(emptyReim);setReimErr("");setEditReimId(null);}} style={{flex:1,padding:"11px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontWeight:700}}>{t.cancel||"Annuler"}</button>
            <button onClick={addReim} style={{flex:2,padding:"11px",background:C.grn,color:"#fff",fontWeight:800,fontSize:14}}>{t.expReimSave||"💸 Enregistrer le remboursement"}</button>
          </div>
        </div>
      )}

      {/* ── Form ── */}
      {showAdd&&(
        <div ref={formRef} className="card fi" style={{marginBottom:12,borderColor:editId?C.ora:C.vio,scrollMarginTop:12}}>
          <div className="sec">{editId?(editScope==="series"?"🔄 Modifier toute la série":(t.expEditTitle||"✏️ Modifier la dépense")):t.newExpense}</div>
          <div className="field"><label className="lbl">{t.description}</label><input value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))} className={shakeLabel?"duvia-shake":""} /></div>
          <div className="row">
            <div className="field" style={{flex:1}}><label className="lbl">{t.amount}</label><input type="number" step="0.01" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} /></div>
            <div className="field" style={{flex:1}}><label className="lbl">{t.paidBy}</label><select value={form.paidBy} onChange={e=>setForm(f=>({...f,paidBy:+e.target.value}))}>{cfg.parents.map((p,i)=><option key={i} value={i}>{p.name||`P${i+1}`}</option>)}</select></div>
          </div>
          <div className="row">
            <div className="field" style={{flex:1}}><label className="lbl">{t.category}</label><select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>{t.cats.map(c=><option key={c}>{c}</option>)}</select></div>
            {!form.recurring && (
              <div className="field" style={{flex:1}}>
                <label className="lbl">{t.date}</label>
                <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
              </div>
            )}
          </div>

          {/* ── Récurrence ─────────────────────────────────────────────────── */}
          {(!editId || editScope==="series") && (
            <div style={{marginBottom:10}}>
              {editScope!=="series" && (
              <button type="button" onClick={()=>setForm(f=>({...f,recurring:!f.recurring,recurringEnd:""}))}
                style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",width:"100%",
                  background:form.recurring?`${C.vio}18`:C.sur,
                  border:`1.5px solid ${form.recurring?C.vio:C.bor}`,
                  borderRadius:10,cursor:"pointer",transition:"all .15s"}}>
                <span style={{fontSize:16}}>🔄</span>
                <span style={{flex:1,fontSize:13,fontWeight:700,color:form.recurring?C.vio:C.mut,textAlign:"left"}}>
                  Dépense récurrente
                </span>
                <span style={{width:20,height:20,borderRadius:10,
                  background:form.recurring?C.vio:C.bor,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:11,color:"#fff",fontWeight:900,flexShrink:0}}>
                  {form.recurring?"✓":""}
                </span>
              </button>
              )}
              {form.recurring && (
                <div style={{background:`${C.vio}08`,border:`1px solid ${C.vio}22`,borderRadius:"0 0 10px 10px",padding:"12px 14px",display:"flex",flexDirection:"column",gap:10}}>
                  {/* Fréquence */}
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Fréquence</div>
                    <div style={{display:"flex",gap:8}}>
                      {[["weekly","Hebdo."],["monthly","Mensuelle"],["yearly","Annuelle"]].map(([k,l])=>(
                        <button key={k} type="button" onClick={()=>setForm(f=>({...f,recurringFreq:k}))}
                          style={{flex:1,padding:"7px 4px",fontSize:12,fontWeight:700,
                            background:form.recurringFreq===k?C.vio:C.sur,
                            color:form.recurringFreq===k?"#fff":C.mut,
                            border:`1.5px solid ${form.recurringFreq===k?C.vio:C.bor}`,
                            borderRadius:8,cursor:"pointer"}}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Date de début / Date de fin */}
                  <div style={{display:"flex",gap:10}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>🗓️ Date de début</div>
                      <input type="date" value={form.date}
                        onChange={e=>setForm(f=>({...f,date:e.target.value,recurringEnd:f.recurringEnd&&f.recurringEnd<e.target.value?"":f.recurringEnd}))}
                        style={{width:"100%",height:36,boxSizing:"border-box",fontSize:14}} />
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>📅 Date de fin</div>
                      <input type="date" value={form.recurringEnd} min={form.date}
                        onChange={e=>setForm(f=>({...f,recurringEnd:e.target.value}))}
                        style={{width:"100%",height:36,boxSizing:"border-box",fontSize:14}} />
                    </div>
                  </div>
                  {/* Aperçu occurrences */}
                  {form.recurringEnd && form.recurringEnd >= form.date && (()=>{
                    const n = getOccurrences(form.date, form.recurringEnd, form.recurringFreq).length;
                    const amt = parseFloat(form.amount)||0;
                    return (
                      <div style={{background:`${C.grn}12`,border:`1px solid ${C.grn}33`,borderRadius:8,padding:"8px 12px",display:"flex",gap:8,alignItems:"center"}}>
                        <span style={{fontSize:16}}>📊</span>
                        <div style={{fontSize:12,color:C.txt}}>
                          <strong>{n} occurrence{n>1?"s":""}</strong> générée{n>1?"s":""}
                          {amt>0 && <> · Total <strong style={{color:C.grn}}>{(n*amt).toFixed(2)} €</strong></>}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          <div className="field">
            <label className="lbl">{t.expShareLabel||"⚖️ Partage de la dépense"}</label>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
              <div style={{fontSize:12,fontWeight:800,color:cfg.parents[form.paidBy]?.color||C.vio,minWidth:80,textAlign:"center"}}>
                {cfg.parents[form.paidBy]?.name||"P1"}<br/><span style={{fontSize:16}}>{100-(form.split||50)}%</span>
              </div>
              <input type="range" min="0" max="100" step="5" value={form.split||50} onChange={e=>setForm(f=>({...f,split:+e.target.value}))} style={{flex:1,accentColor:C.vio}} />
              <div style={{fontSize:12,fontWeight:800,color:C.mut,minWidth:80,textAlign:"center"}}>
                {cfg.parents.find((_,i)=>i!==form.paidBy)?.name||"P2"}<br/><span style={{fontSize:16,color:C.txt}}>{form.split||50}%</span>
              </div>
            </div>
            {(()=>{
              const amt=parseFloat(form.amount)||0;
              const sp=form.split||50;
              const payerAmt=amt*(100-sp)/100;
              const otherAmt=amt*sp/100;
              const payerName=cfg.parents[form.paidBy]?.name||"P1";
              const otherName=cfg.parents.find((_,i)=>i!==form.paidBy)?.name||"P2";
              const payerColor=cfg.parents[form.paidBy]?.color||C.vio;
              return (
                <div style={{display:"flex",gap:8}}>
                  <div style={{flex:1,background:`${payerColor}14`,border:`1px solid ${payerColor}44`,borderRadius:8,padding:"6px 10px",textAlign:"center"}}>
                    <div style={{fontSize:10,color:payerColor,fontWeight:800,marginBottom:2}}>{payerName}</div>
                    <div style={{fontSize:15,fontWeight:900,color:payerColor,fontFamily:"JetBrains Mono"}}>
                      {amt>0?payerAmt.toFixed(2):"–"}€
                    </div>
                    <div style={{fontSize:9,color:C.mut}}>{100-sp}% · {t.expSharePayer||"part payeur"}</div>
                  </div>
                  <div style={{flex:1,background:`${C.bor}55`,border:`1px solid ${C.bor}`,borderRadius:8,padding:"6px 10px",textAlign:"center"}}>
                    <div style={{fontSize:10,color:C.mut,fontWeight:800,marginBottom:2}}>{otherName}</div>
                    <div style={{fontSize:15,fontWeight:900,color:C.txt,fontFamily:"JetBrains Mono"}}>
                      {amt>0?otherAmt.toFixed(2):"–"}€
                    </div>
                    <div style={{fontSize:9,color:C.mut}}>{sp}% · {t.expShareDue||"part due"}</div>
                  </div>
                </div>
              );
            })()}
          </div>
          <div className="field"><label className="lbl">{t.note}</label><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} /></div>
          <AttachZone />
          {formErr&&<div style={{fontSize:12,color:C.red,padding:"7px 10px",background:`${C.red}12`,borderRadius:8,marginBottom:6}}>{formErr}</div>}
          <div style={{display:"flex",gap:8,alignItems:"flex-start",background:`${C.vio}0c`,border:`1px solid ${C.vio}33`,borderRadius:8,padding:"8px 10px",marginBottom:10}}>
            <span style={{fontSize:14,flexShrink:0}}>ℹ️</span>
            <div style={{fontSize:11,color:C.mut,lineHeight:1.4}}>
              {t.expInfoPart1} <strong style={{color:C.mut}}>{t.expInfoPending}</strong>{t.expInfoPart2} <strong style={{color:C.grn}}>{t.expInfoConfirmed}</strong>{t.expInfoPart3} <strong style={{color:C.red}}>{t.expInfoRejected}</strong>{t.expInfoPart4}
            </div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:4}}>
            {editId && (
              <button onClick={cancelForm} style={{flex:1,padding:"10px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontWeight:700}}>{t.cancel||"Annuler"}</button>
            )}
            <button onClick={()=>{ add(); }} style={{flex:2,padding:"10px",background:editId?C.ora:C.grn,color:"#fff",fontWeight:700,borderRadius:10}}>{editId?(t.expEditSave||"💾 Enregistrer les modifications"):(t.saveDay||"Enregistrer")}</button>
          </div>
        </div>
      )}

      {/* ── Category filter ── */}
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
        {[{k:"all",l:t.all},...t.cats.map(c=>({k:c,l:c}))].map(({k,l})=>(
          <button key={k} onClick={()=>setCatF(k)} style={{padding:"4px 10px",background:catF===k?C.vio:C.sur,color:catF===k?"#fff":C.mut,border:`1.5px solid ${catF===k?C.vio:C.bor}`,borderRadius:20,fontSize:11,fontWeight:700}}>{l}</button>
        ))}
      </div>

      {/* ── Expense list ── */}
      {allItems.length===0
        ? <div style={{textAlign:"center",padding:40,color:C.mut}}><div style={{fontSize:40,marginBottom:12}}>💰</div>{t.noExpenses}</div>
        : allItems.map(item=>{
            if(item._type==="reim"){
              const fromP=cfg.parents[item.from]; const toP=cfg.parents[item.to];
              const st=item.status||"confirmed"; // backward compat: old items without status = confirmed
              const iAmReceiver = user?.role==="parent" && user?.parentIdx===item.to;
              const iAmSender   = user?.role==="parent" && user?.parentIdx===item.from;
              const borderCol = st==="confirmed"?`${C.grn}66`:st==="rejected"?`${C.red}66`:`${C.yel}66`;
              const statusLabel = st==="confirmed"?"✅ Accepté":st==="rejected"?"❌ Refusé":"⏳ En attente";
              const statusColor = st==="confirmed"?C.grn:st==="rejected"?C.red:C.yel;
              return (
                <div key={item.id} className="card" style={{marginBottom:10,borderColor:borderCol}}>
                  <div style={{display:"flex",alignItems:"center",gap:11}}>
                    <div style={{background:st==="rejected"?`${C.red}18`:`${C.grn}18`,borderRadius:10,padding:"7px 9px",textAlign:"center",minWidth:58,flexShrink:0}}>
                      <div style={{fontFamily:"JetBrains Mono",fontSize:14,fontWeight:700,color:st==="rejected"?C.red:C.grn}}>{item.amount.toFixed(2)}</div>
                      <div style={{fontSize:9,color:C.mut}}>EUR</div>
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:14,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span style={{fontSize:16}}>💸</span>
                        <span style={{color:fromP?.color||C.grn}}>{fromP?.name||`P${item.from+1}`}</span>
                        <span style={{color:C.mut,fontWeight:400}}>→</span>
                        <span style={{color:toP?.color||C.txt}}>{toP?.name||`P${item.to+1}`}</span>
                      </div>
                      <div style={{fontSize:11,color:C.mut,marginTop:2}}>{(item.date||"").split("-").reverse().join("/")} · {t.expReimBadge||"Remboursement"}</div>
                      {item.note&&<div style={{fontSize:11,color:C.mut,marginTop:2}}>{item.note}</div>}
                      <div style={{marginTop:5,display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",background:`${statusColor}15`,border:`1px solid ${statusColor}44`,borderRadius:20}}>
                        <span style={{fontSize:11,fontWeight:700,color:statusColor}}>{statusLabel}</span>
                      </div>
                    </div>
                    {(iAmSender||isAdm) && st==="pending" && (
                      <div style={{display:"flex",gap:5,flexShrink:0}}>
                        <button onClick={()=>{setEditReimId(item.id);setReimForm({from:item.from,to:item.to,amount:String(item.amount),date:item.date,note:item.note||""});setShowReim(true);setTimeout(()=>reimFormRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),60);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                        <button onClick={()=>delReim(item.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                      </div>
                    )}
                    {(iAmSender||isAdm) && st!=="pending" && (
                      <button onClick={()=>delReim(item.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12,flexShrink:0}}>✕</button>
                    )}
                  </div>
                  {/* Receiver action buttons */}
                  {iAmReceiver && st==="pending" && (
                    <div style={{marginTop:12,padding:"12px 14px",background:`${C.yel}0d`,border:`1px solid ${C.yel}44`,borderRadius:10}}>
                      <div style={{fontSize:13,color:C.txt,marginBottom:10,lineHeight:1.5}}>
                        <strong style={{color:fromP?.color||C.grn}}>{fromP?.name||`P${item.from+1}`}</strong> vous a envoyé un remboursement de <strong>{item.amount.toFixed(2)} €</strong> le {(item.date||"").split("-").reverse().join("/")}.<br/>
                        Pouvez-vous confirmer la réception ?
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>confirmReim(item.id)}
                          style={{flex:1,padding:"10px",background:C.grn,color:"#fff",borderRadius:10,fontWeight:800,fontSize:13}}>
                          ✅ Valider
                        </button>
                        <button onClick={()=>rejectReim(item.id)}
                          style={{flex:1,padding:"10px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:10,fontWeight:700,fontSize:13}}>
                          ❌ Refuser
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            }
            const e=item; const atts=e.attachments||[];
            const expSt=e.status||"confirmed"; // backward compat: old items = confirmed
            const iAmExpSender  = user?.role==="parent" && e.createdBy!==undefined && user?.parentIdx===e.createdBy;
            const iAmExpReceiver= user?.role==="parent" && e.createdBy!==undefined && user?.parentIdx!==e.createdBy;
            const expBorderCol  = expSt==="confirmed"?C.bor:expSt==="rejected"?`${C.red}66`:`${C.yel}66`;
            const expStatusLabel= expSt==="confirmed"?(t.expStatusConfirmed||"✅ Accepté"):expSt==="rejected"?(t.expStatusRejected||"❌ Refusé"):(t.expStatusPending||"⏳ En attente");
            const expStatusColor= expSt==="confirmed"?C.grn:expSt==="rejected"?C.red:C.yel;
            return (
              <div key={e.id} className="card" style={{marginBottom:10,borderColor:expBorderCol}}>
                <div style={{display:"flex",alignItems:"center",gap:11}}>
                  <div style={{background:C.sur,borderRadius:10,padding:"7px 9px",textAlign:"center",minWidth:58,flexShrink:0}}>
                    <div style={{fontFamily:"JetBrains Mono",fontSize:14,fontWeight:700,color:expSt==="rejected"?C.red:C.blu}}>{e.amount.toFixed(2)}</div>
                    <div style={{fontSize:9,color:C.mut}}>EUR</div>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14,display:"flex",alignItems:"center",gap:6}}>
                      {e.recurringId&&<span style={{background:`${C.vio}18`,color:C.vio,borderRadius:4,padding:"1px 5px",fontSize:10,fontWeight:800,flexShrink:0}}>🔄</span>}
                      {e.label}
                      {atts.length>0&&<span style={{background:`${C.vio}18`,color:C.vio,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800,flexShrink:0}}>📎 {atts.length}</span>}
                    </div>
                    <div style={{fontSize:12,color:C.mut,marginTop:2}}>
                      <span style={{color:cfg.parents[e.paidBy]?.color}}>{cfg.parents[e.paidBy]?.name||`P${e.paidBy+1}`}</span>
                      {" · "}{e.category}{" · "}{(e.date||"").split("-").reverse().join("/")}
                      {e.split&&e.split!==50?<span style={{marginLeft:4,background:`${C.vio}18`,color:C.vio,borderRadius:4,padding:"1px 5px",fontSize:10,fontWeight:800}}>⚖️ {100-e.split}%/{e.split}%</span>:""}
                    </div>
                    {e.note&&<div style={{fontSize:11,color:C.mut,marginTop:2}}>{e.note}</div>}
                    {/* Status badge — toujours visible */}
                    <div style={{marginTop:5,display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",background:`${expStatusColor}15`,border:`1px solid ${expStatusColor}44`,borderRadius:20}}>
                      <span style={{fontSize:11,fontWeight:700,color:expStatusColor}}>{expStatusLabel}</span>
                    </div>
                  </div>
                  {/* Boutons émetteur */}
                  {(iAmExpSender||isAdm) && expSt==="pending" && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={()=>startEdit(e)} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={()=>del(e.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                    </div>
                  )}
                  {(iAmExpSender||isAdm) && expSt!=="pending" && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={()=>startEdit(e)} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={()=>del(e.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                    </div>
                  )}
                  {/* Receiver sans createdBy (legacy) ou admin sans rôle parent */}
                  {!iAmExpSender && !iAmExpReceiver && isAdm && expSt==="confirmed" && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={()=>startEdit(e)} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={()=>del(e.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                    </div>
                  )}
                </div>
                {/* Zone validation receveur */}
                {iAmExpReceiver && expSt==="pending" && (
                  <div style={{marginTop:12,padding:"12px 14px",background:`${C.yel}0d`,border:`1px solid ${C.yel}44`,borderRadius:10}}>
                    <div style={{fontSize:13,color:C.txt,marginBottom:10,lineHeight:1.5}}>
                      <strong style={{color:cfg.parents[e.createdBy]?.color||C.blu}}>{cfg.parents[e.createdBy]?.name||`P${(e.createdBy||0)+1}`}</strong>{" "}
                      {t.expPendingConfirmMsg||"a ajouté une dépense de"}{" "}
                      <strong>{e.amount.toFixed(2)} €</strong> ({e.label}).{" "}
                      {t.expPendingConfirmQ||"Pouvez-vous confirmer ?"}
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>confirmExp(e.id)}
                        style={{flex:1,padding:"10px",background:C.grn,color:"#fff",borderRadius:10,fontWeight:800,fontSize:13}}>
                        {t.expValidateBtn||"✅ Valider"}
                      </button>
                      <button onClick={()=>rejectExp(e.id)}
                        style={{flex:1,padding:"10px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:10,fontWeight:700,fontSize:13}}>
                        {t.expRejectBtn||"❌ Refuser"}
                      </button>
                    </div>
                  </div>
                )}
                {atts.length>0&&(
                  <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
                    {atts.map(a=>(
                      <div key={a.id} onClick={()=>openViewer(a)} style={{width:56,height:56,borderRadius:8,overflow:"hidden",border:`1.5px solid ${C.bor}`,background:C.sur,cursor:"pointer",position:"relative",flexShrink:0}}>
                        {a.thumb
                          ? <img src={a.thumb} alt={a.name} style={{width:"100%",height:"100%",objectFit:"cover"}} />
                          : <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                              <span style={{fontSize:20}}>{a.type==='application/pdf'?'📄':'🖼️'}</span>
                            </div>
                        }
                        <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,.45)",color:"#fff",fontSize:8,textAlign:"center",padding:"2px"}}>
                          {a.type==='application/pdf'?'PDF':a.name.split('.').pop().toUpperCase()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
      }

      {/* ── PDF Preview fullscreen ── */}
      {exportHtml&&(
        <div style={{position:"fixed",inset:0,zIndex:700,display:"flex",flexDirection:"column",background:"#111"}}>
          <div style={{display:"flex",gap:8,padding:"10px 14px",background:"#1a1a2e",alignItems:"center",flexShrink:0}}>
            <div style={{flex:1,fontSize:13,fontWeight:700,color:"#ede9fe"}}>📄 Rapport de dépenses — Duvia</div>
            <button
              onClick={()=>{
                iframePdfRef.current?.contentWindow?.postMessage('DUVIA_PRINT','*');
              }}
              style={{padding:"7px 16px",background:"#7B7CF5",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",letterSpacing:".2px"}}>
              🖨️ Imprimer → PDF
            </button>
            <button
              onClick={()=>setExportHtml(null)}
              style={{padding:"7px 12px",background:"rgba(255,255,255,.15)",color:"#fff",border:"none",borderRadius:8,fontSize:13,cursor:"pointer",fontWeight:700}}>
              ✕
            </button>
          </div>
          <iframe ref={iframePdfRef} srcDoc={exportHtml} style={{flex:1,border:"none",background:"white"}} title="Rapport PDF Duvia" sandbox="allow-same-origin allow-scripts allow-modals allow-popups allow-downloads" />
        </div>
      )}


      {/* ── Export Modal ── */}
      {showExportModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:C.card,borderRadius:20,padding:28,maxWidth:400,width:"100%",border:`1.5px solid ${C.bor}`,boxShadow:"0 20px 50px rgba(0,0,0,.35)",maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
              <div>
                <div style={{fontSize:17,fontWeight:900}}>📄 Export PDF <span style={{fontSize:11,background:`${C.vio}18`,color:C.vio,border:`1px solid ${C.vio}33`,borderRadius:6,padding:"2px 8px",fontWeight:800,verticalAlign:"middle"}}>Premium</span></div>
                <div style={{fontSize:11,color:C.mut,marginTop:3}}>Rapport A4 — données de l'application</div>
              </div>
              <button onClick={()=>setShowExportModal(false)} style={{padding:"6px 12px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:13,fontWeight:700,flexShrink:0}}>✕</button>
            </div>
            <div style={{background:`${C.vio}0c`,border:`1px solid ${C.vio}33`,borderRadius:12,padding:"14px 16px",marginBottom:16}}>
              <div style={{fontSize:11,fontWeight:800,color:C.vio,marginBottom:10}}>📅 Période à exporter</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
                {[
                  {label:"Ce mois",fn:()=>{const n=new Date();setExportFrom(toStr(new Date(n.getFullYear(),n.getMonth(),1)));setExportTo(toStr(new Date(n.getFullYear(),n.getMonth()+1,0)));}},
                  {label:"Mois dernier",fn:()=>{const n=new Date();setExportFrom(toStr(new Date(n.getFullYear(),n.getMonth()-1,1)));setExportTo(toStr(new Date(n.getFullYear(),n.getMonth(),0)));}},
                  {label:"3 mois",fn:()=>{const n=new Date();setExportFrom(toStr(new Date(n.getFullYear(),n.getMonth()-3,1)));setExportTo(toStr(n));}},
                  {label:"6 mois",fn:()=>{const n=new Date();setExportFrom(toStr(new Date(n.getFullYear(),n.getMonth()-6,1)));setExportTo(toStr(n));}},
                  {label:"Cette année",fn:()=>{const n=new Date();setExportFrom(toStr(new Date(n.getFullYear(),0,1)));setExportTo(toStr(n));}},
                  {label:"Tout",fn:()=>{setExportFrom("");setExportTo("");}},
                ].map(({label,fn})=>(
                  <button key={label} onClick={fn} style={{padding:"4px 10px",background:C.sur,color:C.txt,border:`1px solid ${C.bor}`,borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer"}}>{label}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:10}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,fontWeight:700,color:C.mut,marginBottom:4}}>Du</div>
                  <input type="date" value={exportFrom} onChange={e=>setExportFrom(e.target.value)} style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.bor}`,borderRadius:8,background:C.inp,color:C.txt,fontSize:12}} />
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,fontWeight:700,color:C.mut,marginBottom:4}}>Au</div>
                  <input type="date" value={exportTo} onChange={e=>setExportTo(e.target.value)} style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.bor}`,borderRadius:8,background:C.inp,color:C.txt,fontSize:12}} />
                </div>
              </div>
            </div>
            <div style={{background:C.sur,borderRadius:10,padding:"12px 14px",marginBottom:20}}>
              <div style={{fontSize:10,fontWeight:800,color:C.txt,marginBottom:8}}>📋 Contenu du rapport</div>
              {["Page de couverture — logo, période, date","Résumé & soldes par parent","Informations parents + enfants","Tableau dépenses (date, heure, catégorie…)","Tableau des remboursements","Justificatifs / pièces jointes","Historique des modifications","Récapitulatif de l'export"].map(item=>(
                <div key={item} style={{fontSize:10,color:C.mut,display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <span style={{color:C.grn,fontWeight:800}}>✓</span>{item}
                </div>
              ))}
            </div>
            <button onClick={generateLegalPDF} disabled={exportGenerating}
              style={{width:"100%",padding:"13px",background:`linear-gradient(135deg,${C.vio},${C.pin||C.red})`,color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,cursor:exportGenerating?"not-allowed":"pointer",opacity:exportGenerating?.6:1,boxShadow:`0 4px 16px ${C.vio}44`}}>
              {exportGenerating?"⏳ Génération en cours…":"📄 Générer le PDF"}
            </button>
            <div style={{fontSize:9,color:C.mut,textAlign:"center",marginTop:8}}>Une nouvelle fenêtre s'ouvrira — utilisez Ctrl+P / Cmd+P pour sauvegarder en PDF</div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── SYSTÈME SUIVI FILLEUL ───────────────────────────────────────────────────
// Actions pondérées
const REF_ACTION_WEIGHTS = {
  ADD_EXPENSE:1, SEND_MESSAGE:1, UPLOAD_DOC:1, ADD_EVENT:1, ADD_CONTACT:1,
  PARENT_ACCEPTED:1, OBSERVER_ACCEPTED:1,
  ADD_CHILD:0.5, CHANGE_ZONE:0.5, ACTIVATE_EVENT:0.5,
};
const REF_STRONG = new Set(["ADD_EXPENSE","SEND_MESSAGE","UPLOAD_DOC","ADD_EVENT","ADD_CONTACT","PARENT_ACCEPTED","OBSERVER_ACCEPTED"]);
const REF_ACTION_META = {
  ADD_EXPENSE:      {label:"Dépense ajoutée",     icon:"💸"},
  SEND_MESSAGE:     {label:"Message envoyé",       icon:"💬"},
  UPLOAD_DOC:       {label:"Document partagé",     icon:"📎"},
  ADD_EVENT:        {label:"Événement créé",        icon:"📅"},
  ADD_CONTACT:      {label:"Contact ajouté",        icon:"👤"},
  PARENT_ACCEPTED:  {label:"Parent accepté",        icon:"✅"},
  OBSERVER_ACCEPTED:{label:"Observateur accepté",   icon:"✅"},
  ADD_CHILD:        {label:"Enfant ajouté",          icon:"🧒"},
  CHANGE_ZONE:      {label:"Zone modifiée",          icon:"📍"},
  ACTIVATE_EVENT:   {label:"Événement activé",       icon:"🔔"},
};
const REF_SCORE_TARGET = 5;
const REF_STRONG_MIN   = 2;

function refCalcScore(actions){ return actions.reduce((s,a)=>s+(REF_ACTION_WEIGHTS[a]||0),0); }
function refCountStrong(actions){ return actions.filter(a=>REF_STRONG.has(a)).length; }
function refIsUnlocked(actions){ return refCalcScore(actions)>=REF_SCORE_TARGET && refCountStrong(actions)>=REF_STRONG_MIN; }

function useReferralTracking() {
  // Délègue au contexte applicatif (état centralisé dans App)
  const { refActions, showReferreePopup, setShowReferreePopup, showReferrerPopup, setShowReferrerPopup } = useApp();
  const actions = refActions || [];
  return {
    actions,
    score: refCalcScore(actions),
    strongCount: refCountStrong(actions),
    unlocked: refIsUnlocked(actions),
    showReferreePopup, setShowReferreePopup,
    showReferrerPopup, setShowReferrerPopup,
  };
}

// ─── POPUPS BONUS ─────────────────────────────────────────────────────────────
function ReferralBonusPopup({C, variant, onClose}) {
  const isReferree = variant==="referree";
  return (
    <div style={{position:"fixed",inset:0,zIndex:999,background:"rgba(23,16,58,.6)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:C.card,borderRadius:24,padding:"32px 28px",maxWidth:340,width:"100%",textAlign:"center",border:`2px solid ${C.vio}44`,boxShadow:`0 20px 60px ${C.vio}33`,animation:"popIn .35s cubic-bezier(.34,1.56,.64,1)"}}>
        <div style={{fontSize:52,marginBottom:12}}>{isReferree?"🎉":"🎁"}</div>
        <div style={{fontSize:20,fontWeight:800,marginBottom:8,background:`linear-gradient(90deg,${C.vio},${C.blu})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
          {isReferree?"Bonus débloqué !":"Bonne nouvelle !"}
        </div>
        <div style={{fontSize:14,color:C.mut,lineHeight:1.6,marginBottom:24}}>
          {isReferree
            ? `Félicitations ! Tu as complété toutes les actions requises. Tu passes en "Premium – ${FILLEUL_BONUS_DAYS}j restants" 🎉 Ton parrain reçoit également son bonus !`
            : `La personne que tu as parrainée a validé son compte. Ton bonus (jours + 🎰 tour de roue) est maintenant crédité sur ton compte !`
          }
        </div>
        <button onClick={onClose} style={{width:"100%",padding:"13px 0",borderRadius:12,border:"none",background:`linear-gradient(90deg,${C.vio},${C.blu})`,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",boxShadow:`0 4px 14px ${C.vio}44`}}>
          Super, merci ! 🙌
        </button>
      </div>
      <style>{`@keyframes popIn{from{transform:scale(.8);opacity:0}to{transform:scale(1);opacity:1}}`}</style>
    </div>
  );
}

// ─── CARTE PROGRESSION FILLEUL ────────────────────────────────────────────────
function ReferralProgressCard({C, refTracking}) {
  const {score,unlocked,showReferreePopup,setShowReferreePopup,showReferrerPopup,setShowReferrerPopup} = refTracking;
  const pct = Math.min((score/REF_SCORE_TARGET)*100,100);

  return (
    <>
      {showReferreePopup && <ReferralBonusPopup C={C} variant="referree" onClose={()=>setShowReferreePopup(false)} />}
      {showReferrerPopup && <ReferralBonusPopup C={C} variant="referrer" onClose={()=>setShowReferrerPopup(false)} />}

      <div style={{marginBottom:14,borderRadius:16,border:`1.5px solid ${unlocked?C.grn+"66":C.vio+"33"}`,background:unlocked?`${C.grn}08`:`${C.vio}06`,padding:"14px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
          <span style={{fontSize:16}}>{unlocked?"🏅":"🎯"}</span>
          <div style={{flex:1,fontSize:13,fontWeight:800,color:C.txt}}>Progression filleul</div>
          <span style={{fontSize:12,fontWeight:700,color:unlocked?C.grn:C.mut}}>{score.toFixed(1)} / {REF_SCORE_TARGET} pts</span>
        </div>
        <div style={{position:"relative",height:8,borderRadius:99,background:C.sur,overflow:"hidden",marginBottom:10}}>
          <div style={{position:"absolute",inset:0,right:`${100-pct}%`,background:`linear-gradient(90deg,${C.vio},${C.blu})`,borderRadius:99,transition:"right .5s cubic-bezier(.4,0,.2,1)",boxShadow:pct>0?`0 0 6px ${C.vio}55`:"none"}}/>
        </div>
        <div style={{fontSize:12,fontWeight:700,color:unlocked?C.grn:C.mut,textAlign:"center"}}>
          {unlocked?"🎉 Bonus débloqué !":"Continue pour débloquer la récompense"}
        </div>
      </div>
    </>
  );
}

// ─── PREMIUM TAB & PARRAINAGE ────────────────────────────────────────────────
function ParrainageSection() {
  const {C,t,sub,setSub,user,setUsers,users,st,days,addRefAction,refActions,showReferreePopup,setShowReferreePopup,showReferrerPopup,setShowReferrerPopup} = useApp();
  const isPremium = sub.plan==="premium" || sub._admin;
  const isEarned  = sub.plan==="earned_premium";
  const isTrial   = sub.plan==="trial_premium";
  const isFreemium= st==="freemium";

  const [copied,setCopied]         = useState(false);
  const [copiedLink,setCopiedLink] = useState(false);
  const [showInvite,setShowInvite] = useState(false);
  const [showDemo,setShowDemo]     = useState(false);
  const [demoStep,setDemoStep]     = useState(0);

  const code             = sub.refCode || user?.refCode || "—";
  const inviteLink       = `${APP_URL}?ref=${code}`;
  const refCount         = Math.max(sub.refCount||0, user?.refCount||0);
  const validatedCount   = Math.max(sub.validatedRefCount||0, user?.validatedRefCount||0);
  const daysEarned       = sub.trialExtension||0;
  const pendingSpins     = sub.pendingSpins||0;
  const isFilleul        = !!(user?.refUsed || sub.refUsed);
  const score            = refActions ? refActions.reduce((s,a)=>s+(REF_ACTION_WEIGHTS[a]||0),0) : 0;
  const unlocked         = refIsUnlocked(refActions||[]);
  const scorePct         = Math.min((score/REF_SCORE_TARGET)*100,100);

  // Bonus prochain filleul
  const bonusNext = isPremium
    ? refBonusDaysPremium((sub.monthlyRefCount||0)+1)
    : refBonusDaysTrial(validatedCount+1, daysEarned);

  function copyCode(){
    try{ navigator.clipboard.writeText(code); }catch(e){}
    const el=document.createElement("textarea"); el.value=code;
    document.body.appendChild(el); el.select(); document.execCommand("copy"); document.body.removeChild(el);
    setCopied(true); setTimeout(()=>setCopied(false),2000);
  }
  function copyLink(){
    try{ navigator.clipboard.writeText(inviteLink); }catch(e){}
    const el=document.createElement("textarea"); el.value=inviteLink;
    document.body.appendChild(el); el.select(); document.execCommand("copy"); document.body.removeChild(el);
    setCopiedLink(true); setTimeout(()=>setCopiedLink(false),2000);
  }
  function shareViaEmail(){
    const subj=encodeURIComponent("Rejoins-moi sur Duvia 🏡");
    const body=encodeURIComponent(`Salut !\n\nJe t'invite sur Duvia, l'app qui simplifie la coparentalité.\n\nTélécharge l'app : ${inviteLink}\nCode parrain : ${code}\n\nÀ bientôt sur Duvia !`);
    window.open(`mailto:?subject=${subj}&body=${body}`);
  }
  function shareViaSMS(){
    const body=encodeURIComponent(`Rejoins-moi sur Duvia 🏡 ${inviteLink} — Code : ${code}`);
    window.open(`sms:?body=${body}`);
  }

  function simulateReferral(){
    setShowDemo(true); setDemoStep(1);
    setTimeout(()=>{
      const newValidated = validatedCount+1;
      const bonus = isPremium
        ? refBonusDaysPremium((sub.monthlyRefCount||0)+1)
        : refBonusDaysTrial(newValidated, daysEarned);
      setSub(s=>({...s,
        validatedRefCount:newValidated,
        pendingSpins:(s.pendingSpins||0)+SPIN_PER_REF,
        trialExtension:(s.trialExtension||0)+bonus,
        plan:(!isPremium&&newValidated>=1)?"earned_premium":s.plan,
      }));
      if(user) setUsers(us=>us.map(u=>u.id===user.id?{...u,
        validatedRefCount:newValidated,
        pendingSpins:(u.pendingSpins||0)+SPIN_PER_REF,
        trialExtension:(u.trialExtension||0)+bonus,
        plan:(!isPremium&&newValidated>=1)?"earned_premium":u.plan,
      }:u));
      setDemoStep(2);
    },1400);
  }

  // ── Badge statut ─────────────────────────────────────────────────────────
  const statusBadge = isPremium
    ? {label:"Premium Actif ⭐", color:"#7B7CF5", bg:"#7B7CF533"}
    : isEarned
    ? {label:`Premium – ${days}j restants 🎁`, color:"#2DD4A8", bg:"#2DD4A833"}
    : isTrial
    ? {label:`Trial Premium – ${days}j restants`, color:"#5B98F2", bg:"#5B98F233"}
    : {label:"Freemium", color:"#7269A8", bg:"#7269A833"};

  return (
    <div>
      {/* Popups bonus */}
      {showReferreePopup && (
        <div style={{position:"fixed",inset:0,zIndex:999,background:"rgba(23,16,58,.65)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:24,padding:"32px 24px",maxWidth:320,width:"100%",textAlign:"center",border:`2px solid ${C.grn}44`,boxShadow:`0 20px 60px ${C.grn}33`}}>
            <div style={{fontSize:52,marginBottom:10}}>🎉</div>
            <div style={{fontSize:20,fontWeight:900,color:C.grn,marginBottom:8}}>Félicitations !</div>
            <div style={{fontSize:14,color:C.mut,lineHeight:1.6,marginBottom:20}}>
              Tu as complété les actions requises et passes en <strong style={{color:C.grn}}>Premium – {FILLEUL_BONUS_DAYS}j restants</strong> ! Ton parrain reçoit également son bonus 💜
            </div>
            <button onClick={()=>setShowReferreePopup(false)} style={{width:"100%",padding:"13px 0",borderRadius:12,border:"none",background:`linear-gradient(90deg,${C.grn},${C.blu})`,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"}}>
              Super, merci ! 🙌
            </button>
          </div>
        </div>
      )}
      {showReferrerPopup && (
        <div style={{position:"fixed",inset:0,zIndex:999,background:"rgba(23,16,58,.65)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:24,padding:"32px 24px",maxWidth:320,width:"100%",textAlign:"center",border:`2px solid ${C.vio}44`,boxShadow:`0 20px 60px ${C.vio}33`}}>
            <div style={{fontSize:52,marginBottom:10}}>🎁</div>
            <div style={{fontSize:20,fontWeight:900,color:C.vio,marginBottom:8}}>Bonne nouvelle !</div>
            <div style={{fontSize:14,color:C.mut,lineHeight:1.6,marginBottom:20}}>
              La personne que tu as parrainée a validé son compte. Ton bonus jours + 🎰 tour de roue est crédité !
            </div>
            <button onClick={()=>setShowReferrerPopup(false)} style={{width:"100%",padding:"13px 0",borderRadius:12,border:"none",background:`linear-gradient(90deg,${C.vio},${C.pin})`,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"}}>
              Super ! 🙌
            </button>
          </div>
        </div>
      )}

      {/* ── Statut actuel ──────────────────────────────────────────────── */}
      <div style={{marginBottom:12,padding:"12px 14px",background:statusBadge.bg,borderRadius:14,border:`1.5px solid ${statusBadge.color}44`,display:"flex",alignItems:"center",gap:10}}>
        <div style={{flex:1,fontSize:13,fontWeight:800,color:statusBadge.color}}>{statusBadge.label}</div>
        {(isTrial||isEarned) && (
          <div style={{fontSize:11,color:C.mut,textAlign:"right"}}>
            Plafond<br/><strong style={{color:statusBadge.color}}>{TRIAL_MAX_DAYS}j</strong> depuis J0
          </div>
        )}
      </div>

      {/* ── Mon code & boutons ─────────────────────────────────────────── */}
      <div className="card" style={{marginBottom:12,textAlign:"center",padding:"20px 16px",borderColor:`${C.pin}44`}}>
        <div style={{fontSize:11,color:C.mut,marginBottom:6,fontWeight:700,textTransform:"uppercase",letterSpacing:".1em"}}>Mon code parrain</div>
        <div style={{fontSize:28,fontWeight:900,letterSpacing:5,color:C.vio,fontFamily:"monospace",marginBottom:14,padding:"10px 16px",background:C.sur,borderRadius:12,display:"inline-block"}}>{code}</div>
        <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
          <button onClick={copyCode} style={{padding:"9px 18px",background:copied?`${C.grn}22`:C.sur,color:copied?C.grn:C.txt,border:`1.5px solid ${copied?C.grn:C.bor}`,fontSize:13,fontWeight:700,borderRadius:10,transition:"all .2s"}}>
            {copied?"✅ Copié !":"📋 Copier"}
          </button>
          <button onClick={()=>setShowInvite(true)} style={{padding:"9px 18px",background:`linear-gradient(135deg,${C.vio},${C.pin})`,color:"#fff",fontSize:13,fontWeight:700,borderRadius:10}}>
            🎁 Inviter un proche
          </button>
        </div>
        {/* Simulation démo */}
        <div style={{marginTop:12,paddingTop:12,borderTop:`1px dashed ${C.bor}`}}>
          <div style={{fontSize:10,color:C.mut,marginBottom:5,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em"}}>🧪 Mode démo</div>
          <button onClick={simulateReferral} disabled={showDemo&&demoStep===1} style={{padding:"7px 16px",background:`${C.vio}15`,color:C.vio,border:`1.5px dashed ${C.vio}`,fontSize:12,fontWeight:700,borderRadius:9,opacity:(showDemo&&demoStep===1)?0.5:1}}>
            Simuler un filleul validé ({bonusNext>0?`+${bonusNext}j + `:""}🎰×1)
          </button>
        </div>
      </div>

      {/* ── Stats ──────────────────────────────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
        {[
          {val:refCount,      label:"Invités",         color:C.mut},
          {val:validatedCount,label:"Validés",         color:C.grn},
          {val:`${daysEarned}j`,label:"Jours gagnés", color:C.blu},
          {val:`${pendingSpins}🎰`,label:"Tours roue", color:pendingSpins>0?C.yel:C.mut,highlight:pendingSpins>0},
        ].map((s,i)=>(
          <div key={i} className="card" style={{textAlign:"center",padding:"12px 6px",borderColor:s.highlight?`${s.color}66`:""}}>
            <div style={{fontSize:22,fontWeight:900,color:s.color}}>{s.val}</div>
            <div style={{fontSize:9,color:C.mut,marginTop:2,fontWeight:700,textTransform:"uppercase",letterSpacing:".05em"}}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Progression filleul (si l'utilisateur a été parrainé) ──────── */}
      {isFilleul && !unlocked && (
        <div style={{marginBottom:12,borderRadius:14,border:`1.5px solid ${C.vio}33`,background:`${C.vio}06`,padding:"14px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <span style={{fontSize:15}}>🎯</span>
            <div style={{flex:1,fontSize:13,fontWeight:800,color:C.txt}}>Ta progression (en tant que filleul)</div>
            <span style={{fontSize:12,fontWeight:700,color:C.vio}}>{score.toFixed(1)} / {REF_SCORE_TARGET} pts</span>
          </div>
          <div style={{position:"relative",height:8,borderRadius:99,background:C.sur,overflow:"hidden",marginBottom:8}}>
            <div style={{position:"absolute",inset:0,right:`${100-scorePct}%`,background:`linear-gradient(90deg,${C.vio},${C.blu})`,borderRadius:99,transition:"right .5s cubic-bezier(.4,0,.2,1)"}}/>
          </div>
          <div style={{fontSize:11,color:C.mut}}>
            Complète {REF_SCORE_TARGET} pts ({REF_STRONG_MIN} actions fortes) pour débloquer : <strong style={{color:C.grn}}>Premium – {FILLEUL_BONUS_DAYS}j</strong> pour toi + bonus pour ton parrain
          </div>
        </div>
      )}
      {isFilleul && unlocked && (
        <div style={{marginBottom:12,borderRadius:14,border:`1.5px solid ${C.grn}66`,background:`${C.grn}08`,padding:"12px 16px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22}}>🏅</span>
          <div style={{fontSize:13,fontWeight:800,color:C.grn}}>Filleul validé — merci de faire partie de la famille Duvia ! 💜</div>
        </div>
      )}

      {/* ── Tableau des récompenses ─────────────────────────────────────── */}
      <div className="card" style={{marginBottom:12,padding:"18px 16px"}}>
        <div style={{fontSize:12,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".1em",marginBottom:14}}>Vos récompenses parrain</div>

        {/* Phase Trial / Earned */}
        <div style={{fontSize:11,fontWeight:800,color:C.blu,textTransform:"uppercase",letterSpacing:".07em",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
          <span>🎁 Phase Premium sans abonnement</span>
          <span style={{background:`${C.blu}18`,color:C.blu,borderRadius:8,padding:"1px 7px",fontSize:10}}>plafond {TRIAL_MAX_DAYS}j depuis J0</span>
        </div>
        <div style={{borderRadius:10,overflow:"hidden",border:`1px solid ${C.bor}`,marginBottom:14}}>
          {[
            {rang:"1er filleul validé", jours:`+${REF_TRIAL_PALIERS[1]}j`, upgrade:"→ Premium – x j 🎁", color:C.grn, highlight:true},
            {rang:"2e filleul validé",  jours:`+${REF_TRIAL_PALIERS[2]}j`, upgrade:"",                   color:C.grn, highlight:false},
            {rang:"3e filleul et +",    jours:"0j",                        upgrade:"Plafond 30j atteint", color:C.mut, highlight:false},
          ].map((r,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",padding:"10px 12px",background:r.highlight?`${C.grn}08`:"transparent",borderBottom:i<2?`1px solid ${C.bor}`:"none"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:12,color:r.highlight?C.grn:C.txt,fontWeight:r.highlight?800:600}}>{r.rang}</div>
                {r.upgrade&&<div style={{fontSize:10,color:C.mut,marginTop:1}}>{r.upgrade}</div>}
              </div>
              <div style={{fontSize:13,fontWeight:900,color:r.color,marginRight:10,minWidth:28,textAlign:"right"}}>{r.jours}</div>
              <div style={{fontSize:11,color:C.yel,fontWeight:700,minWidth:40,textAlign:"right"}}>🎰 ×{SPIN_PER_REF}</div>
            </div>
          ))}
        </div>

        {/* Phase Premium abonné */}
        <div style={{fontSize:11,fontWeight:800,color:C.vio,textTransform:"uppercase",letterSpacing:".07em",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
          <span>⭐ Phase Premium abonné</span>
          <span style={{background:`${C.vio}18`,color:C.vio,borderRadius:8,padding:"1px 7px",fontSize:10}}>reset mensuel</span>

        </div>
        <div style={{borderRadius:10,overflow:"hidden",border:`1px solid ${isPremium?C.vio+"44":C.bor}`,opacity:isPremium?1:0.55}}>
          {[
            {rang:`Filleuls 1 à ${PREM_MAX_PER_MONTH} / mois`, jours:`+${PREM_BONUS_PER_REF}j chacun`, note:`max ${PREM_MAX_PER_MONTH * PREM_BONUS_PER_REF}j/mois`, color:C.vio},
            {rang:`Filleuls ${PREM_MAX_PER_MONTH+1}+ / mois`,  jours:"0j",                             note:"roue uniquement",                                   color:C.mut},
          ].map((r,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",padding:"10px 12px",background:i===0?`${C.vio}06`:"transparent",borderBottom:i===0?`1px solid ${C.bor}`:"none"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:12,color:r.color,fontWeight:i===0?800:600}}>{r.rang}</div>
                <div style={{fontSize:10,color:C.mut,marginTop:1}}>{r.note}</div>
              </div>
              <div style={{fontSize:13,fontWeight:900,color:r.color,marginRight:10,minWidth:40,textAlign:"right"}}>{r.jours}</div>
              <div style={{fontSize:11,color:C.yel,fontWeight:700,minWidth:40,textAlign:"right"}}>🎰 ×{SPIN_PER_REF}</div>
            </div>
          ))}
        </div>

        <div style={{marginTop:10,fontSize:11,color:C.mut,lineHeight:1.5}}>
          🎰 Tour de roue offert à chaque filleul validé quel que soit le statut. Pool <strong>Standard</strong> (Trial/Freemium) ou pool <strong>Abonnement ⭐</strong> (mois/an gratuit) pour les abonnés.
        </div>
      </div>

      {/* ── Comment ça marche ───────────────────────────────────────────── */}
      <div className="card" style={{marginBottom:12,padding:"16px 16px"}}>
        <div style={{fontSize:12,fontWeight:800,color:C.mut,textTransform:"uppercase",letterSpacing:".1em",marginBottom:12}}>Comment ça marche ?</div>
        {[
          {icon:"🔗", title:"Partagez votre lien",    desc:"Envoyez votre code ou lien personnalisé par e-mail ou SMS — invitations illimitées."},
          {icon:"✅", title:"Le filleul s'inscrit",   desc:`Il crée son compte via votre lien et démarre en Trial Premium (${TRIAL_BASE_DAYS}j).`},
          {icon:"🎯", title:"Il valide ses actions",  desc:`Dès qu'il atteint ${REF_SCORE_TARGET} pts d'engagement, il passe en "Premium – ${FILLEUL_BONUS_DAYS}j restants" et vous recevez votre bonus.`},
          {icon:"🔄", title:"Il peut aussi parrainer", desc:"Un filleul validé peut à son tour inviter des proches. Les mêmes règles s'appliquent."},
        ].map((s,i,arr)=>(
          <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",paddingBottom:i<arr.length-1?12:0,marginBottom:i<arr.length-1?12:0,borderBottom:i<arr.length-1?`1px solid ${C.bor}`:"none"}}>
            <div style={{width:34,height:34,borderRadius:10,background:`${C.vio}18`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>{s.icon}</div>
            <div>
              <div style={{fontSize:13,fontWeight:800,color:C.txt,marginBottom:2}}>{s.title}</div>
              <div style={{fontSize:12,color:C.mut,lineHeight:1.5}}>{s.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Modale Inviter ──────────────────────────────────────────────── */}
      {showInvite && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div style={{background:C.card,borderRadius:"20px 20px 0 0",padding:"24px 20px 32px",width:"100%",maxWidth:480,boxShadow:"0 -8px 32px rgba(0,0,0,.18)"}}>
            <div style={{width:40,height:4,background:C.bor,borderRadius:4,margin:"0 auto 20px"}}/>
            <div style={{fontSize:17,fontWeight:900,marginBottom:4}}>🎁 Inviter un proche</div>
            <div style={{fontSize:13,color:C.mut,marginBottom:16}}>Partagez le lien + votre code — votre proche démarre en Trial Premium</div>
            <div style={{background:C.sur,borderRadius:12,padding:"12px 14px",marginBottom:14,border:`1.5px solid ${C.bor}`}}>
              <div style={{fontSize:10,fontWeight:800,color:C.mut,textTransform:"uppercase",marginBottom:6}}>Lien d'invitation</div>
              <div style={{fontSize:12,color:C.vio,fontFamily:"monospace",wordBreak:"break-all",fontWeight:700,marginBottom:8}}>{inviteLink}</div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:11,color:C.mut}}>Code :</span>
                <span style={{fontSize:14,fontWeight:900,letterSpacing:3,color:C.vio,fontFamily:"monospace"}}>{code}</span>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
              {[
                {icon:copiedLink?"✅":"📋", label:copiedLink?"Copié !":"Copier le lien", action:copyLink, active:copiedLink},
                {icon:"✉️", label:"Par e-mail", action:shareViaEmail, active:false},
                {icon:"💬", label:"Par SMS",    action:shareViaSMS,   active:false},
              ].map((btn,i)=>(
                <button key={i} onClick={btn.action} style={{padding:"12px 6px",background:btn.active?`${C.grn}15`:C.sur,color:btn.active?C.grn:C.txt,border:`1.5px solid ${btn.active?C.grn:C.bor}`,borderRadius:12,fontSize:12,fontWeight:700,display:"flex",flexDirection:"column",alignItems:"center",gap:4,cursor:"pointer"}}>
                  <span style={{fontSize:22}}>{btn.icon}</span>
                  {btn.label}
                </button>
              ))}
            </div>
            <button onClick={()=>setShowInvite(false)} style={{width:"100%",padding:12,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* ── Modale démo ─────────────────────────────────────────────────── */}
      {showDemo && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:18,padding:26,maxWidth:300,width:"100%",textAlign:"center",border:`1.5px solid ${C.bor}`}}>
            {demoStep===1 ? (<>
              <div style={{fontSize:36,marginBottom:10}}>📨</div>
              <div style={{fontSize:15,fontWeight:800,marginBottom:6}}>Validation en cours…</div>
              <div style={{fontSize:13,color:C.mut,marginBottom:14}}>Un filleul atteint le score requis</div>
              <div style={{height:4,background:C.sur,borderRadius:4,overflow:"hidden"}}>
                <div style={{height:"100%",width:"70%",background:`linear-gradient(90deg,${C.vio},${C.pin})`,borderRadius:4}}/>
              </div>
            </>) : (<>
              <div style={{fontSize:36,marginBottom:10}}>🎉</div>
              <div style={{fontSize:15,fontWeight:800,color:C.grn,marginBottom:6}}>Filleul validé !</div>
              <div style={{fontSize:13,color:C.mut,marginBottom:6}}>
                {bonusNext>0
                  ? `+${bonusNext}j crédités sur votre compte`
                  : "Plafond atteint — roue offerte quand même !"}
              </div>
              <div style={{fontSize:20,marginBottom:14}}>🎰 +{SPIN_PER_REF} tour de roue</div>
              <button onClick={()=>{setShowDemo(false);setDemoStep(0);}} style={{padding:"10px 24px",background:`linear-gradient(90deg,${C.vio},${C.pin})`,color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer"}}>
                OK
              </button>
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ADMIN TAB ────────────────────────────────────────────────────────────────
function AdminTab() {
  const {C, sub, setSub, users, setUsers, setShowResetConfirm, simDate, setSimDate} = useApp();
  const [grantTarget, setGrantTarget] = useState("");
  // subscriberRows
  const subscriberRows = (() => {
    const all = (users||[]).filter(u => u.sub && u.sub.plan === "premium");
    return all.map(u => {
      const since = u.sub.premiumSince ? new Date(u.sub.premiumSince) : null;
      const cycle = u.sub.cycle;
      let expiry = null;
      if(since){ expiry = new Date(since); cycle==="yearly" ? expiry.setFullYear(expiry.getFullYear()+1) : expiry.setMonth(expiry.getMonth()+1); }
      const now = new Date();
      const isActive = expiry ? expiry > now : true;
      const daysLeft = expiry ? Math.ceil((expiry-now)/86400000) : null;
      return {name:u.name, email:u.email, since, cycle, expiry, isActive, daysLeft};
    });
  })();

  return (
    <div>
      {/* ── Simulateur de date ───────────────────────────────────────── */}
      <div className="card" style={{marginBottom:14,borderColor:`${C.blu}44`,background:`${C.blu}06`}}>
        <div style={{fontSize:11,fontWeight:800,color:C.blu,letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>📅 Simuler une date</div>
        <div style={{fontSize:12,color:C.mut,marginBottom:10}}>Simule une date future pour tester l'affichage des dépenses récurrentes.</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input type="date" value={simDate||""} onChange={e=>setSimDate(e.target.value||null)}
            style={{flex:1,minWidth:140}} />
          <button onClick={()=>setSimDate(null)}
            style={{padding:"0 14px",height:44,background:`${C.red}18`,color:C.red,border:`1.5px solid ${C.red}44`,borderRadius:10,fontWeight:700,fontSize:12}}>
            ✕ Réinitialiser
          </button>
        </div>
        {simDate && (
          <div style={{marginTop:8,fontSize:11,color:C.blu,fontWeight:700}}>
            📅 Date simulée : {new Date(simDate).toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
          </div>
        )}
      </div>

      {/* ── Réinitialisation ─────────────────────────────────────────── */}
      <div className="card" style={{marginBottom:14,borderColor:`${C.ora}44`,background:`${C.ora}06`}}>
        <div style={{fontSize:11,fontWeight:800,color:C.ora,letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>🔄 Réinitialisation</div>
        <div style={{fontSize:13,color:C.mut,marginBottom:14,lineHeight:1.6}}>
          Efface toutes les données locales : comptes, calendrier, dépenses, messages, configurations. L'application retourne à l'état initial.
        </div>
        <button onClick={()=>setShowResetConfirm(true)}
          style={{width:"100%",height:44,background:C.ora,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          🔄 Réinitialiser l'application
        </button>
      </div>

      {/* ── Mode Admin — Gestion des plans ──────────────────────────── */}
      <div className="card" style={{marginBottom:14,borderColor:"#FFD70044",background:"#FFD70008"}}>
        <div style={{fontSize:11,fontWeight:800,color:"#cc9900",letterSpacing:".1em",textTransform:"uppercase",marginBottom:4}}>👑 Mode Admin — Gestion des plans</div>
        <div style={{fontSize:11,color:"#cc9900",opacity:.7,marginBottom:14}}>
          Plan actuel : <strong>{subStatus(sub)}</strong>
          {sub._admin && " · 👑 Admin"}
        </div>

        {/* ── Bêta ── */}
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:800,color:"#7c3aed",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>🌟 Bêta</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={()=>setSub({...sub,plan:"trial_premium",accountCreatedAt:new Date().toISOString(),trialStart:new Date().toISOString(),premiumSince:null,trialExtension:0,pendingSpins:0})}
              style={{padding:"8px 14px",background:"#7c3aed18",color:"#7c3aed",border:"1.5px solid #7c3aed",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              🌟 Bêta active (Trial offert)
            </button>
          </div>
        </div>

        {/* ── Trial Premium ── */}
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:800,color:"#f59e0b",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>⏳ Trial Premium</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={()=>setSub({...sub,plan:"trial_premium",accountCreatedAt:new Date().toISOString(),trialStart:new Date().toISOString(),premiumSince:null,trialExtension:0,pendingSpins:0})}
              style={{padding:"8px 14px",background:"#f59e0b18",color:"#f59e0b",border:"1.5px solid #f59e0b",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              ⏳ Trial J+0 (15j restants)
            </button>
            <button onClick={()=>setSub({...sub,plan:"trial_premium",accountCreatedAt:new Date(Date.now()-11*86400000).toISOString(),trialStart:new Date(Date.now()-11*86400000).toISOString(),premiumSince:null,trialExtension:0,pendingSpins:0})}
              style={{padding:"8px 14px",background:"#ef444418",color:"#ef4444",border:"1.5px solid #ef4444",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              ⏰ Trial J-4 (fin imminente)
            </button>
            <button onClick={()=>setSub({...sub,plan:"earned_premium",accountCreatedAt:new Date(Date.now()-2*86400000).toISOString(),trialStart:new Date(Date.now()-2*86400000).toISOString(),premiumSince:null,trialExtension:5,validatedRefCount:1,pendingSpins:1})}
              style={{padding:"8px 14px",background:"#10b98118",color:"#10b981",border:"1.5px solid #10b981",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              🎁 Earned Premium (parrainage)
            </button>
          </div>
        </div>

        {/* ── Premium abonné ── */}
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:800,color:"#8b5cf6",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>⭐ Premium abonné</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={()=>setSub({...sub,plan:"premium",premiumSince:new Date().toISOString(),cycle:"monthly",_admin:false})}
              style={{padding:"8px 14px",background:"#8b5cf618",color:"#8b5cf6",border:"1.5px solid #8b5cf6",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              ⭐ Premium Mensuel (actif)
            </button>
            <button onClick={()=>setSub({...sub,plan:"premium",premiumSince:new Date().toISOString(),cycle:"yearly",_admin:false})}
              style={{padding:"8px 14px",background:"#8b5cf625",color:"#8b5cf6",border:"1.5px solid #8b5cf6",borderRadius:10,fontSize:12,fontWeight:800,cursor:"pointer"}}>
              ⭐ Premium Annuel (actif)
            </button>
            <button onClick={()=>setSub({...sub,plan:"premium",premiumSince:new Date(Date.now()-32*86400000).toISOString(),cycle:"monthly",_admin:false})}
              style={{padding:"8px 14px",background:"#ef444418",color:"#ef4444",border:"1.5px solid #ef4444",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              ❌ Premium Mensuel expiré
            </button>
            <button onClick={()=>setSub({...sub,plan:"premium",premiumSince:new Date(Date.now()-366*86400000).toISOString(),cycle:"yearly",_admin:false})}
              style={{padding:"8px 14px",background:"#ef444412",color:"#ef4444",border:"1.5px dashed #ef4444",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              ❌ Premium Annuel expiré
            </button>
          </div>
        </div>

        {/* ── Freemium ── */}
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>🔓 Freemium</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={()=>setSub({plan:"freemium",accountCreatedAt:new Date(Date.now()-31*86400000).toISOString(),trialStart:new Date(Date.now()-31*86400000).toISOString(),premiumSince:null,cycle:"yearly",refCode:sub.refCode,refUsed:sub.refUsed,refCount:sub.refCount||0,validatedRefCount:sub.validatedRefCount||0,trialExtension:0,pendingSpins:0,monthlyRefMonth:null,monthlyRefCount:0})}
              style={{padding:"8px 14px",background:"#6b728018",color:"#6b7280",border:"1.5px solid #6b7280",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              🔓 Freemium (trial expiré)
            </button>
          </div>
        </div>

        {/* ── Reset Admin ── */}
        <div style={{borderTop:"1px solid #FFD70033",paddingTop:12,marginTop:4}}>
          <button onClick={()=>setSub(makeAdminSub())}
            style={{padding:"8px 18px",background:"#FFD70022",color:"#cc9900",border:"1.5px solid #FFD70088",borderRadius:10,fontSize:12,fontWeight:800,cursor:"pointer"}}>
            👑 Restaurer mode Admin
          </button>
        </div>
      </div>

      {/* ── 🎁 Offrir Premium à un compte ─────────────────────────────── */}
      <div className="card" style={{borderColor:`${C.vio}44`,background:`${C.vio}06`}}>
        <div style={{fontSize:11,fontWeight:800,color:C.vio,letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>🎁 Offrir Premium à un compte</div>
        <div style={{fontSize:11,color:C.mut,marginBottom:10,lineHeight:1.5}}>
          S'applique à la prochaine connexion de ce compte, sur cet appareil. (Le statut d'abonnement n'est pas encore synchronisé dans le nuage — voir la spec multi-familles.)
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <select value={grantTarget} onChange={e=>setGrantTarget(e.target.value)}
            style={{flex:1,minWidth:180,height:38,borderRadius:8,border:`1.5px solid ${C.bor}`,padding:"0 10px",fontSize:13,background:C.card,color:C.txt}}>
            <option value="">— Choisir un compte —</option>
            {(users||[]).filter(u=>u.role!=="admin").map(u=>(
              <option key={u.id} value={u.id}>{u.name} ({u.email}){u.sub?.plan==="premium"?" ⭐ déjà Premium":""}</option>
            ))}
          </select>
          <button disabled={!grantTarget} onClick={()=>{
              setUsers(prev => prev.map(u => String(u.id)===String(grantTarget) ? {
                ...u,
                sub: { ...(u.sub||{}), plan:"premium", premiumSince:new Date().toISOString(), cycle:"yearly" },
              } : u));
              setGrantTarget("");
            }}
            style={{padding:"8px 16px",background:grantTarget?C.vio:C.bor,color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:800,cursor:grantTarget?"pointer":"not-allowed"}}>
            🎁 Donner Premium (1 an)
          </button>
        </div>
      </div>

      {/* ── Abonnés Premium ──────────────────────────────────────────── */}
      <div className="card" style={{borderColor:`${C.vio}44`,background:`${C.vio}06`}}>
        <div style={{fontSize:11,fontWeight:800,color:C.vio,letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>⭐ Abonnés Premium</div>
        {subscriberRows.length === 0 ? (
          <div style={{fontSize:13,color:C.mut,textAlign:"center",padding:"12px 0"}}>Aucun abonné Premium pour l'instant.</div>
        ) : (
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{background:C.sur}}>
                  {["Abonné","Souscrit le","Cycle","Échéance","Statut"].map(h=>(
                    <th key={h} style={{padding:"7px 8px",textAlign:"left",fontWeight:800,color:C.mut,borderBottom:`1.5px solid ${C.bor}`,whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subscriberRows.map((r,i)=>(
                  <tr key={i} style={{borderBottom:`1px solid ${C.bor}`,background:i%2===0?"transparent":C.sur}}>
                    <td style={{padding:"8px",fontWeight:700,color:C.txt}}>
                      <div>{r.name}</div>
                      <div style={{fontSize:10,color:C.mut}}>{r.email}</div>
                    </td>
                    <td style={{padding:"8px",color:C.txt,whiteSpace:"nowrap"}}>{r.since?r.since.toLocaleDateString("fr-FR"):"—"}</td>
                    <td style={{padding:"8px",whiteSpace:"nowrap"}}>
                      <span style={{background:`${C.vio}18`,color:C.vio,padding:"2px 8px",borderRadius:6,fontWeight:700,fontSize:11}}>
                        {r.cycle==="yearly"?"Annuel":"Mensuel"}
                      </span>
                    </td>
                    <td style={{padding:"8px",color:C.txt,whiteSpace:"nowrap"}}>
                      {r.expiry?r.expiry.toLocaleDateString("fr-FR"):"—"}
                      {r.daysLeft!==null&&<div style={{fontSize:10,color:r.daysLeft<=7?C.red:r.daysLeft<=30?C.yel:C.mut}}>{r.daysLeft>0?`J-${r.daysLeft}`:"Expiré"}</div>}
                    </td>
                    <td style={{padding:"8px"}}>
                      <span style={{background:r.isActive?`${C.grn}22`:`${C.red}22`,color:r.isActive?C.grn:C.red,padding:"2px 8px",borderRadius:6,fontWeight:800,fontSize:11,whiteSpace:"nowrap"}}>
                        {r.isActive?"✅ Actif":"❌ Expiré"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}


function PremiumTab() {
  const {C,t,sub,setSub,st,days,perms,setMenuTab,setShowMenu,users,user,setConfirmDeleteAccount} = useApp();
  const [confirm,setConfirm]=useState(false);
  const isPremium=st==="premium"||sub._admin;

  // ── Admin: build subscriber list from stored users ──────────────────────────
  // Each user may have sub data stored under user.sub (set at login/subscribe)
  // We also check DEMO_USERS as baseline; real subs come from localStorage users.
  const subscriberRows = sub._admin ? (() => {
    const all = (users||[]).filter(u => u.sub && u.sub.plan === "premium");
    return all.map(u => {
      const since = u.sub.premiumSince ? new Date(u.sub.premiumSince) : null;
      const cycle = u.sub.cycle;
      // Échéance = premiumSince + 1 mois ou + 1 an
      let expiry = null;
      if (since) {
        expiry = new Date(since);
        if (cycle === "yearly") expiry.setFullYear(expiry.getFullYear() + 1);
        else expiry.setMonth(expiry.getMonth() + 1);
      }
      const now = new Date();
      const isActive = expiry ? expiry > now : true;
      const daysLeft = expiry ? Math.ceil((expiry - now) / 86400000) : null;
      return { name: u.name, email: u.email, since, cycle, expiry, isActive, daysLeft };
    });
  })() : [];
  // badge: "free" = gratuit · "trial" = Trial/Bêta · "premium" = Premium abonné uniquement
  const items=[
    // ── Famille & Compte ───────────────────────────────────────────────────────
    {icon:"👥", label:"2 parents · 1 enfant (Trial : 2, Premium : illimité)", badge:"free"},
    {icon:"👁️", label:"Observateurs (1 gratuit → illimité)",    badge:"trial"},
    {icon:"📨", label:"Invitations SMS / WhatsApp / Email",      badge:"free"},
    // ── Calendrier ─────────────────────────────────────────────────────────────
    {icon:"📅", label:"Calendrier de garde",                     badge:"free"},
    {icon:"🌍", label:"Jours fériés 15+ pays",                  badge:"free"},
    {icon:"🌸", label:"Fête des mères / des pères",             badge:"trial"},
    {icon:"🎂", label:"Anniversaires parents & enfants",         badge:"trial"},
    {icon:"🗓️", label:"Dates personnalisées (2 en trial)",      badge:"trial"},
    // ── Emploi du temps ────────────────────────────────────────────────────────
    {icon:"🎒", label:"Emploi du temps des enfants",             badge:"trial"},
    // ── Dépenses ───────────────────────────────────────────────────────────────
    {icon:"💰", label:"Dépenses & remboursements",               badge:"free"},
    {icon:"📊", label:"Balance & soldes visibles",               badge:"trial"},
    {icon:"📄", label:"Export PDF calendrier annuel",           badge:"premium"},
    {icon:"📄", label:"Export PDF des dépenses",                 badge:"premium"},
    // ── Contacts ───────────────────────────────────────────────────────────────
    {icon:"📞", label:"Répertoire contacts",                     badge:"trial"},
    // ── Coffre-fort ────────────────────────────────────────────────────────────
    {icon:"🔐", label:"Coffre-fort illimité — 1 Go",            badge:"premium"},
    // ── Messagerie ─────────────────────────────────────────────────────────────
    {icon:"💬", label:"Messagerie famille (18 ans+ pour enfants)",badge:"trial"},
    // ── Jeu & Récompenses ──────────────────────────────────────────────────────
    {icon:"🎡", label:"Roue Duvia — jeu & récompenses",         badge:"trial"},
    // ── Parrainage ─────────────────────────────────────────────────────────────
    {icon:"🎁", label:"Parrainage",                              badge:"free"},
    // ── App ────────────────────────────────────────────────────────────────────
    {icon:"🌐", label:"5 langues (FR · EN · DE · ES · PT)",     badge:"free"},
    {icon:"🎨", label:"5 thèmes visuels",                        badge:"free"},
    {icon:"📱", label:"Installable sur mobile (PWA)",            badge:"free"},
  ];
  return (
    <div>
      {/* ── Card bêta ──────────────────────────────────────────────────────────── */}
      {isBeta() && !sub._admin && (
        <div className="card" style={{marginBottom:14,borderColor:C.vio,background:`linear-gradient(135deg,${C.vio}12,${C.blu}08)`,textAlign:"center",padding:"20px 18px"}}>
          <div style={{fontSize:36,marginBottom:8}}>🎉</div>
          <div style={{fontSize:17,fontWeight:900,color:C.vio,marginBottom:6}}>
            Bêta — Trial Premium gratuit 🎉
          </div>
          <div style={{fontSize:12,color:C.txt,lineHeight:1.7,marginBottom:10}}>
            Duvia est en phase bêta non commerciale.<br/>
            Toutes les fonctionnalités <strong>Trial Premium</strong> sont gratuites<br/>
            jusqu'au <strong>30 septembre 2026</strong>.<br/>
            <span style={{color:C.mut,fontSize:11}}>L'export PDF est réservé aux abonnés Premium.</span>
          </div>
          <div style={{
            display:"inline-block",
            background:C.vio,color:"#fff",
            borderRadius:20,padding:"6px 18px",
            fontSize:13,fontWeight:800,
          }}>
            ⏳ {BETA_DAYS_LEFT()} jours restants
          </div>
          <div style={{fontSize:11,color:C.mut,marginTop:12,lineHeight:1.5}}>
            À partir d'octobre 2026, un abonnement sera proposé.<br/>
            Vous serez prévenus avant la fin de la bêta.
          </div>
        </div>
      )}

      {/* Card statut — cachée pendant bêta si trial (la card bêta suffit) */}
      {(!isBeta() || isPremium || sub._admin) && (
        <div className="card" style={{marginBottom:14,borderColor:sub._admin?"#FFD700":isPremium?C.vio:st==="trial_premium"?C.yel:C.red,textAlign:"center",padding:"24px 18px"}}>
          <div style={{fontSize:42,marginBottom:8}}>{sub._admin?"👑":isPremium?"⭐":st==="trial_premium"?"⏳":"🔓"}</div>
          <div style={{fontSize:19,fontWeight:900,marginBottom:5,color:sub._admin?"#FFD700":isPremium?C.vio:st==="trial_premium"?C.yel:C.mut}}>
            {sub._admin?"Admin ⚙️":isPremium?"Premium Actif ⭐":st==="earned_premium"?`Premium – ${days}j restant${days>1?"s":""}  🎁`:st==="trial_premium"?`Trial Premium — ${days} jour${days>1?"s":""} restant${days>1?"s":""}` :"Freemium"}
          </div>
          {isPremium&&sub.premiumSince&&<div style={{fontSize:12,color:C.mut}}>{t.premSince} {new Date(sub.premiumSince).toLocaleDateString()} · {sub.cycle==="monthly"?t.monthly:t.yearly}</div>}
          {st==="trial_premium"&&<div style={{fontSize:12,color:C.mut,marginTop:4}}>Passez à Premium pour un accès illimité</div>}
          {st==="freemium"&&<div style={{fontSize:12,color:C.mut,marginTop:4}}>Compte gratuit permanent — fonctions limitées</div>}
        </div>
      )}

      {/* Pricing — verrouillé pendant la bêta */}
      {!isPremium&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
          {[{cy:"monthly",pr:t.monthly,save:null},{cy:"yearly",pr:t.yearly,save:t.yearlyNote}].map(p=>(
            <div key={p.cy} className="card" style={{borderColor:p.cy==="yearly"?C.vio:C.bor,textAlign:"center",padding:"16px 10px",position:"relative"}}>
              {p.save&&<div style={{position:"absolute",top:-9,left:"50%",transform:"translateX(-50%)",background:C.grn,color:"#fff",fontSize:9,fontWeight:800,padding:"2px 8px",borderRadius:8,whiteSpace:"nowrap"}}>2 mois offerts</div>}
              <div style={{fontSize:22,fontWeight:900,color:C.vio,filter:isBeta()?"blur(6px)":"none",userSelect:isBeta()?"none":"auto"}}>{p.pr}</div>
              <div style={{fontSize:11,color:C.mut,marginBottom:10,filter:isBeta()?"blur(4px)":"none",userSelect:isBeta()?"none":"auto"}}>{t.perFamily}</div>
              {isBeta() ? (
                <div style={{width:"100%",padding:"9px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,fontWeight:700,borderRadius:8,textAlign:"center"}}>
                  🔒 Dispo après la bêta
                </div>
              ) : (
                <button onClick={()=>setSub(s=>({...s,plan:"premium",premiumSince:new Date().toISOString(),cycle:p.cy,subscriberParentIdx:user?.parentIdx}))} style={{width:"100%",padding:"9px",background:p.cy==="yearly"?C.vio:C.sur,color:p.cy==="yearly"?"#fff":C.mut,border:`1.5px solid ${p.cy==="yearly"?C.vio:C.bor}`,fontSize:13}}>
                  Choisir
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Parrainage shortcut */}
      <div className="card" style={{marginBottom:14,borderColor:`${C.pin}33`,background:`${C.pin}06`,padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <div style={{fontSize:28}}>🎁</div>
        <div style={{flex:1,fontSize:14,fontWeight:800,color:C.pin}}>Parrainage</div>
        <button onClick={()=>{setMenuTab("parrainage");}} style={{padding:"8px 14px",background:`linear-gradient(135deg,${C.vio},${C.pin})`,color:"#fff",fontSize:12,fontWeight:700,borderRadius:8,flexShrink:0}}>
          Voir →
        </button>
      </div>
      <div className="card" style={{marginBottom:14}}>
        <div className="sec">Fonctionnalités incluses</div>
        {/* Légende */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12,paddingBottom:10,borderBottom:`1px solid ${C.bor}`}}>
          {[
            {bg:`${C.grn}22`,color:C.grn,label:"🆓 Gratuit"},
            {bg:`${C.vio}22`,color:C.vio,label:"⭐ Trial / Bêta"},
            {bg:`${C.pin}22`,color:C.pin,label:"💎 Premium"},
          ].map(b=>(
            <span key={b.label} style={{fontSize:10,fontWeight:800,background:b.bg,color:b.color,padding:"2px 8px",borderRadius:6}}>{b.label}</span>
          ))}
        </div>
        {items.map((f,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:i<items.length-1?`1px solid ${C.bor}`:"none"}}>
            <div style={{width:32,height:32,borderRadius:9,background:`${C.vio}18`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{f.icon}</div>
            <div style={{flex:1,fontSize:13,fontWeight:600,color:C.txt}}>{f.label}</div>
            <span style={{fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:6,flexShrink:0,
              background:f.badge==="free"?`${C.grn}22`:f.badge==="trial"?`${C.vio}22`:`${C.pin}22`,
              color:f.badge==="free"?C.grn:f.badge==="trial"?C.vio:C.pin,
            }}>
              {f.badge==="free"?"🆓 Gratuit":f.badge==="trial"?"⭐ Trial / Bêta":"💎 Premium"}
            </span>
          </div>
        ))}
      </div>
      {/* Cancel sub - premium only */}
      {isPremium&&(
        <div className="card" style={{borderColor:`${C.red}44`}}>
          <div className="sec">{t.cancelSub}</div>
          {!confirm?(
            <button onClick={()=>setConfirm(true)} style={{padding:"9px 18px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,fontSize:13}}>{t.cancelSub}</button>
          ):(
            <div>
              <div style={{fontSize:13,color:C.mut,marginBottom:10}}>{t.confirmCancel} ?</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{setSub(s=>({...s,plan:"freemium"}));setConfirm(false);}} style={{padding:"8px 16px",background:C.red,color:"#fff",fontSize:13}}>{t.confirmCancel}</button>
                <button onClick={()=>setConfirm(false)} style={{padding:"8px 16px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13}}>{t.cancel}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Supprimer le compte */}
      {user?.role !== "admin" && (
        <div className="card" style={{borderColor:`${C.red}22`}}>
          <div className="sec" style={{color:C.red}}>{t.deleteAccount||"Supprimer mon compte"}</div>
          <div style={{fontSize:12,color:C.mut,marginBottom:12,lineHeight:1.5}}>
            {t.deleteAccountDesc||"Action définitive. Toutes vos données seront supprimées."}
          </div>
          <button
            onClick={()=>setConfirmDeleteAccount(true)}
            style={{padding:"9px 18px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,fontSize:13,borderRadius:10,cursor:"pointer",fontWeight:700}}>
            🗑️ {t.deleteAccount||"Supprimer mon compte"}
          </button>
        </div>
      )}

    </div>
  );
}

// ─── HASH INTEGRITY ───────────────────────────────────────────────────────────
function hashMsg(from,toArr,content,ts){
  const s=[String(from),...[...toArr].map(String).sort(),content,ts].join('\x01');
  let h=0x811c9dc5>>>0;
  for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
  return h.toString(16).toUpperCase().padStart(8,'0');
}
function verifyMsg(m){return hashMsg(m.from,m.to,m.content,m.ts)===m.hash;}

// ─── MESSAGING TAB ────────────────────────────────────────────────────────────
function MessagingTab(){
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,myUid}=useApp();
  const [view,setView]=useState("list");
  const [convId,setConvId]=useState(null);
  const [draft,setDraft]=useState("");
  const [picked,setPicked]=useState([]);
  const [showProof,setShowProof]=useState(null);
  const [shakeDraft,setShakeDraft]=useState(false);
  const endRef=useRef(null);

  function _triggerShakeDraft(){ setShakeDraft(true); setTimeout(()=>setShakeDraft(false),600); }

  const myId=String(user?.id||"");
  const myName=user?.name||"?";

  // Participant map
  const pMap={};
  (users||[]).forEach(u=>{
    const col=(cfg.parents||[]).find(p=>p.name&&u.name&&p.name===u.name)?.color||C.vio;
    pMap[String(u.id)]={name:u.name,role:u.role,color:col,
      avatar:u.role==="admin"?"👑":u.role==="observer"?"👁️":u.role==="child"?"🧒":"👤"};
  });

  const contacts=(users||[]).filter(u=>String(u.id)!==myId&&u.name&&u.role!=="admin"&&!String(u.email||"").endsWith("@demo.fr"));

  function ck(ids){return[...new Set(ids)].map(String).sort().join('|');}

  // Build conversations
  const allConvs={};
  (msgs||[]).forEach(m=>{
    const ids=[String(m.from),...(m.to||[]).map(String)];
    if(!ids.includes(myId))return;
    const key=ck(ids);
    if(!allConvs[key])allConvs[key]={key,ids,msgs:[]};
    allConvs[key].msgs.push(m);
  });
  const convList=Object.values(allConvs).sort((a,b)=>{
    const la=a.msgs.at(-1)?.ts||'',lb=b.msgs.at(-1)?.ts||'';
    return lb.localeCompare(la);
  });

  const currentConv=convId?allConvs[convId]:null;
  const currentMsgs=(currentConv?.msgs||[]).slice().sort((a,b)=>a.ts.localeCompare(b.ts));

  // Mark read on open
  useEffect(()=>{
    if(!convId||!myUid)return;
    msgs.forEach(m=>{
      const ids=[String(m.from),...(m.to||[]).map(String)];
      if(ck(ids)!==convId)return;
      if((m.to||[]).map(String).includes(myId)&&!(m.readBy||[]).map(String).includes(myId))
        markCloudMessageRead(m.id, myUid);
    });
  },[convId,myUid,msgs]);

  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"});},[currentMsgs.length,view]);

  function sendMsg(toIds){
    const content=draft.trim();
    if(!content||!toIds.length)return;
    // ── Validations sécurité ────────────────────────────────────────
    if(content.length > LIMITS.MSG_MAX){
      alert((t.msgTooLong||"Message trop long (max {n} caractères).").replace("{n}",LIMITS.MSG_MAX));
      return;
    }
    if(!checkMsgRateLimit()){
      alert(t.msgRateLimit||"Trop de messages envoyés. Attends une minute avant de réessayer.");
      return;
    }
    if(!isCleanText(content)){
      _triggerShakeDraft();
      return;
    }
    const safeContent = sanitize(content);
    sendCloudMessage(myName, toIds, safeContent).then(()=>{
      setDraft("");
      addRefAction("SEND_MESSAGE");
      if(view==="new"){setConvId(ck([myId,...toIds]));setView("chat");}
    }).catch(e=>alert("⚠️ Erreur d'envoi : "+(e?.message||e)));
  }

  function convName(ids){return ids.filter(id=>id!==myId).map(id=>pMap[id]?.name||"?").join(", ");}
  function convColor(ids){const o=ids.find(id=>id!==myId);return o?(pMap[o]?.color||C.vio):C.vio;}

  // ── NEW CONVERSATION ──────────────────────────────────────────────────────
  if(view==="new") return(
    <div className="fi">
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>setView("list")} style={{padding:"6px 12px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>←</button>
        <div style={{fontSize:15,fontWeight:900}}>{t.msgNewTitle||"✏️ Nouveau message"}</div>
      </div>
      <div className="card" style={{marginBottom:12}}>
        <div style={{fontSize:11,color:C.mut,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>{t.msgRecipients||"Destinataires"}</div>
        {contacts.length===0&&<div style={{color:C.mut,fontSize:13}}>{t.msgNoOtherUsers||"Aucun autre utilisateur enregistré."}</div>}
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {contacts.map(u=>{
            const uid=String(u.id);const sel=picked.includes(uid);const col=pMap[uid]?.color||C.vio;
            return(
              <button key={uid} onClick={()=>setPicked(p=>sel?p.filter(x=>x!==uid):[...p,uid])} style={{
                padding:"8px 14px",background:sel?`${col}22`:C.sur,border:`2px solid ${sel?col:C.bor}`,
                borderRadius:20,display:"flex",alignItems:"center",gap:6,fontSize:13,fontWeight:700,
                color:sel?col:C.mut,transition:"all .15s",cursor:"pointer"
              }}>
                <span>{pMap[uid]?.avatar||"👤"}</span><span>{u.name}</span>{sel&&<span style={{fontSize:10}}>✓</span>}
              </button>
            );
          })}
        </div>
      </div>
      {picked.length>0&&(
        <div style={{display:"flex",gap:8,padding:"10px 12px",background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:22,alignItems:"center"}}>
          <input value={draft} onChange={e=>setDraft(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),sendMsg(picked))}
            placeholder={t.msgFirstPlaceholder||"Premier message…"} autoFocus
            className={shakeDraft?"duvia-shake":""}
            style={{flex:1,background:"transparent",border:"none",outline:"none",fontSize:14,color:C.txt}} />
          <button onClick={()=>sendMsg(picked)} disabled={!draft.trim()} style={{
            width:36,height:36,borderRadius:"50%",border:"none",cursor:draft.trim()?"pointer":"default",
            background:draft.trim()?`linear-gradient(135deg,${C.vio},${C.pin})`:`${C.vio}44`,
            color:"#fff",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0
          }}>→</button>
        </div>
      )}
    </div>
  );

  // ── CHAT VIEW ─────────────────────────────────────────────────────────────
  if(view==="chat"&&currentConv){
    const otherIds=currentConv.ids.filter(id=>id!==myId);
    const isGroup=otherIds.length>1;
    return(
      <div className="fi" style={{display:"flex",flexDirection:"column",height:"calc(100vh - 190px)"}}>
        {/* Header */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexShrink:0}}>
          <button onClick={()=>setView("list")} style={{padding:"6px 12px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>←</button>
          <div style={{position:"relative",flexShrink:0}}>
            <div style={{width:38,height:38,borderRadius:isGroup?11:"50%",background:isGroup?`linear-gradient(135deg,${C.vio},${C.pin})`:`linear-gradient(135deg,${convColor(currentConv.ids)},${C.blu})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,border:isGroup?`2px solid ${C.vio}44`:"none"}}>
              {isGroup?"👥":pMap[otherIds[0]]?.avatar||"👤"}
            </div>
            {isGroup&&(
              <div style={{position:"absolute",bottom:-4,right:-4,background:C.vio,color:"#fff",borderRadius:10,padding:"1px 5px",fontSize:8,fontWeight:900,border:`2px solid ${C.card}`}}>
                {currentConv.ids.length}
              </div>
            )}
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:1}}>
              {isGroup&&<span style={{fontSize:9,fontWeight:800,color:C.vio,background:`${C.vio}18`,border:`1px solid ${C.vio}33`,borderRadius:5,padding:"1px 5px",flexShrink:0}}>{t.msgGroupBadge||"GROUPE"}</span>}
              <div style={{fontSize:14,fontWeight:900,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{convName(currentConv.ids)}</div>
            </div>
            {isGroup
              ? <div style={{fontSize:10,color:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  👤 {currentConv.ids.map(id=>id===myId?(t.msgMe||"Moi"):pMap[id]?.name||"?").join(" · ")}
                </div>
              : <div style={{fontSize:10,color:C.grn,fontWeight:700}}>{t.msgSecure||"🔒 Messagerie sécurisée"}</div>
            }
          </div>
        </div>

        {/* Messages */}
        <div style={{flex:1,overflowY:"auto",paddingBottom:8}}>
          {currentMsgs.length===0&&(
            <div style={{textAlign:"center",padding:40,color:C.mut,fontSize:13}}>{t.msgStartConv||"Démarrez la conversation"}</div>
          )}
          {currentMsgs.map((m,idx)=>{
            const isMe=String(m.from)===myId;
            const verified=verifyMsg(m);
            const prev=currentMsgs[idx-1];
            const showDate=!prev||new Date(m.ts).toDateString()!==new Date(prev.ts).toDateString();
            const readOk=(m.readBy||[]).some(id=>String(id)!==myId);
            const hhmm=new Date(m.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
            const col=pMap[String(m.from)]?.color||C.vio;
            return(
              <div key={m.id}>
                {showDate&&<div style={{textAlign:"center",fontSize:11,color:C.mut,margin:"12px 0 8px",fontWeight:600}}>{new Date(m.ts).toLocaleDateString()}</div>}
                <div style={{display:"flex",flexDirection:isMe?"row-reverse":"row",alignItems:"flex-end",gap:6,marginBottom:6,paddingLeft:isMe?44:0,paddingRight:isMe?0:44}}>
                  {!isMe&&(
                    <div style={{width:30,height:30,borderRadius:"50%",background:`linear-gradient(135deg,${col},${C.blu})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>
                      {pMap[String(m.from)]?.avatar||"👤"}
                    </div>
                  )}
                  <div style={{maxWidth:"78%"}}>
                    {!isMe&&isGroup&&<div style={{fontSize:10,color:C.mut,marginBottom:2,fontWeight:700}}>{m.fromName}</div>}
                    <div onClick={()=>setShowProof(showProof===m.id?null:m.id)} style={{
                      padding:"10px 13px",
                      background:isMe?`linear-gradient(135deg,${C.vio},${C.pin})`:C.sur,
                      color:isMe?"#fff":C.txt,
                      borderRadius:isMe?"18px 18px 4px 18px":"18px 18px 18px 4px",
                      fontSize:14,lineHeight:1.45,cursor:"pointer",
                      border:isMe?"none":`1px solid ${C.bor}`,
                      boxShadow:"0 1px 4px rgba(0,0,0,.08)",wordBreak:"break-word"
                    }}>{m.content}</div>
                    {showProof===m.id&&(
                      <div style={{marginTop:4,padding:"7px 10px",background:verified?`${C.grn}15`:`${C.red}15`,borderRadius:8,border:`1px solid ${verified?C.grn:C.red}`,fontSize:10}}>
                        <div style={{fontWeight:800,color:verified?C.grn:C.red,marginBottom:2}}>
                          {verified?(t.msgVerified||"🔒 Message authentifié — Intégrité vérifiée"):(t.msgTampered||"⚠️ ALERTE — Message potentiellement modifié !")}
                        </div>
                        <div style={{color:C.mut,fontFamily:"monospace",letterSpacing:1,wordBreak:"break-all"}}>Hash: #{m.hash}</div>
                      </div>
                    )}
                    <div style={{fontSize:10,color:C.mut,marginTop:3,display:"flex",gap:4,justifyContent:isMe?"flex-end":"flex-start",alignItems:"center"}}>
                      {hhmm}{isMe&&<span style={{color:readOk?C.vio:C.bor,fontWeight:800}}>{readOk?"✓✓":"✓"}</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={endRef}/>
        </div>

        {/* Input */}
        <div style={{display:"flex",gap:8,paddingTop:10,borderTop:`1px solid ${C.bor}`,flexShrink:0,alignItems:"center"}}>
          <input value={draft} onChange={e=>setDraft(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),sendMsg(otherIds))}
            placeholder={t.msgPlaceholder||"Message…"}
            className={shakeDraft?"duvia-shake":""}
            style={{flex:1,padding:"10px 14px",background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:22,fontSize:14,color:C.txt,outline:"none"}} />
          <button onClick={()=>sendMsg(otherIds)} disabled={!draft.trim()} style={{
            width:42,height:42,borderRadius:"50%",border:"none",flexShrink:0,
            background:draft.trim()?`linear-gradient(135deg,${C.vio},${C.pin})`:`${C.vio}44`,
            color:"#fff",fontSize:20,display:"flex",alignItems:"center",justifyContent:"center",
            cursor:draft.trim()?"pointer":"default"
          }}>→</button>
        </div>
      </div>
    );
  }

  // ── LIST VIEW ─────────────────────────────────────────────────────────────
  return(
    <div className="fi">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontSize:16,fontWeight:900}}>💬 {t.tabMsg||"Messages"}</div>
          <div style={{fontSize:11,color:C.mut}}>{t.msgListSubtitle||"Sécurisés · Infalsifiables · Tap pour vérifier"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <button onClick={()=>{setPicked([]);setDraft("");setView("new");}} style={{
            padding:"8px 16px",background:`linear-gradient(135deg,${C.vio},${C.pin})`,
            color:"#fff",fontSize:13,fontWeight:800,borderRadius:20
          }}>{t.msgNewBtn||"✏️ Nouveau"}</button>
          <InfoBubble C={C} tipKey={`duvia_msgtip_${user?.id||"x"}`} title={t.tabMsg||"Messages"}>
            {t.msgTipBody||"Échangez des messages directement avec l'autre parent et les observateurs. Chaque message est horodaté et son intégrité peut être vérifiée à tout moment en appuyant dessus. Les conversations restent privées et sécurisées au sein de votre famille Duvia."}
          </InfoBubble>
        </div>
      </div>

      {contacts.length===0&&(
        <div className="card" style={{textAlign:"center",padding:32,color:C.mut}}>
          <div style={{fontSize:36,marginBottom:10}}>👥</div>
          <div style={{fontSize:14,fontWeight:700,marginBottom:6}}>{t.msgEmptyContactsTitle||"Aucun contact disponible"}</div>
          <div style={{fontSize:12}}>{t.msgEmptyContactsDesc||"Invitez l'autre parent à créer un compte Duvia pour pouvoir échanger."}</div>
        </div>
      )}

      {contacts.length>0&&convList.length===0&&(
        <div className="card" style={{textAlign:"center",padding:36,color:C.mut}}>
          <div style={{fontSize:40,marginBottom:12}}>💬</div>
          <div style={{fontSize:14,fontWeight:700,marginBottom:6}}>{t.msgEmptyConvTitle||"Aucune conversation"}</div>
          <div style={{fontSize:12}}>{t.msgEmptyConvDesc||"Appuyez sur « Nouveau » pour démarrer un échange sécurisé."}</div>
        </div>
      )}

      {convList.map(conv=>{
        const last=conv.msgs.at(-1);
        const unread=conv.msgs.filter(m=>(m.to||[]).map(String).includes(myId)&&!(m.readBy||[]).map(String).includes(myId)).length;
        const col=convColor(conv.ids);
        const otherIds=conv.ids.filter(id=>id!==myId);
        const isGroup=otherIds.length>1;
        const memberCount=conv.ids.length; // total including me
        return(
          <div key={conv.key} onClick={()=>{setConvId(conv.key);setView("chat");}} className="card" style={{
            marginBottom:10,cursor:"pointer",
            borderColor:unread>0?col:isGroup?C.vio+"55":C.bor,
            background:unread>0?`${col}08`:isGroup?`${C.vio}05`:C.card,transition:"all .15s"
          }}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              {/* Avatar */}
              <div style={{position:"relative",flexShrink:0}}>
                <div style={{width:46,height:46,borderRadius:isGroup?14:"50%",background:isGroup?`linear-gradient(135deg,${C.vio},${C.pin})`:`linear-gradient(135deg,${col},${C.blu})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,border:isGroup?`2px solid ${C.vio}44`:"none"}}>
                  {isGroup?"👥":pMap[otherIds[0]]?.avatar||"👤"}
                </div>
                {/* Group member count badge */}
                {isGroup&&(
                  <div style={{position:"absolute",bottom:-4,right:-4,background:C.vio,color:"#fff",borderRadius:10,padding:"1px 5px",fontSize:9,fontWeight:900,border:`2px solid ${C.card}`,lineHeight:1.4}}>
                    {memberCount}
                  </div>
                )}
                {unread>0&&<span style={{position:"absolute",top:-2,right:isGroup?8:-2,background:C.red,color:"#fff",borderRadius:"50%",width:18,height:18,fontSize:10,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800}}>{unread}</span>}
              </div>

              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:isGroup?2:3}}>
                  <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                    {isGroup&&<span style={{fontSize:9,fontWeight:800,color:C.vio,background:`${C.vio}18`,border:`1px solid ${C.vio}33`,borderRadius:5,padding:"1px 5px",flexShrink:0}}>{t.msgGroupBadge||"GROUPE"}</span>}
                    <div style={{fontSize:14,fontWeight:unread>0?900:700,color:unread>0?col:C.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{convName(conv.ids)}</div>
                  </div>
                  <div style={{fontSize:10,color:C.mut,flexShrink:0,marginLeft:8}}>
                    {last&&new Date(last.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
                  </div>
                </div>
                {/* Group members list */}
                {isGroup&&(
                  <div style={{fontSize:10,color:C.mut,marginBottom:3,display:"flex",alignItems:"center",gap:4}}>
                    <span style={{fontSize:11}}>👤</span>
                    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {conv.ids.map(id=>id===myId?(t.msgMe||"Moi"):pMap[id]?.name||"?").join(" · ")}
                    </span>
                  </div>
                )}
                <div style={{fontSize:12,color:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {last&&(
                    isGroup
                      ? <><span style={{color:String(last.from)===myId?C.vio:C.grn,fontWeight:700}}>{String(last.from)===myId?(t.msgYou||"Vous"):pMap[String(last.from)]?.name||"?"} : </span>{last.content}</>
                      : <>{String(last.from)===myId&&<span style={{color:C.vio}}>{t.msgYou||"Vous"} : </span>}{last.content}</>
                  ) || "—"}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Security info */}
      <div style={{marginTop:16,padding:"12px 14px",background:`${C.grn}08`,borderRadius:12,border:`1px solid ${C.grn}22`,display:"flex",gap:10,alignItems:"flex-start"}}>
        <span style={{fontSize:18,flexShrink:0}}>🔒</span>
        <div style={{fontSize:11,color:C.mut,lineHeight:1.5}}>
          {t.msgIntegrityFooter||"Chaque message est signé par un hash cryptographique unique (FNV-1a). Appuyez sur n'importe quel message pour vérifier son intégrité."}
        </div>
      </div>
    </div>
  );
}

// ─── SCHEDULE TAB ─────────────────────────────────────────────────────────────
const SUBJECT_COLORS = {
  "Mathématiques":"#4a9eff","Mathematics":"#4a9eff","Mathematik":"#4a9eff","Matemáticas":"#4a9eff","Matemática":"#4a9eff",
  "Français":"#ff6bb5","French":"#ff6bb5","Deutsch":"#ff6bb5","Lengua":"#ff6bb5","Português":"#ff6bb5",
  "Histoire-Géo":"#f5c842","History":"#f5c842","Geschichte":"#f5c842","Historia":"#f5c842","História":"#f5c842",
  "Sciences":"#3ecf8e","Science":"#3ecf8e","Naturwissenschaften":"#3ecf8e","Ciencias":"#3ecf8e","Ciências":"#3ecf8e",
  "Anglais":"#7c6fcd","English":"#7c6fcd","Englisch":"#7c6fcd","Inglés":"#7c6fcd","Inglês":"#7c6fcd",
  "EPS":"#ff9f43","PE":"#ff9f43","Sport":"#ff9f43","Ed. Física":"#ff9f43",
  "Arts plastiques":"#ff5e57","Art":"#ff5e57","Kunst":"#ff5e57","Arte":"#ff5e57","Artes":"#ff5e57",
  "Musique":"#3ecf8e","Music":"#3ecf8e","Musik":"#3ecf8e","Música":"#3ecf8e",
  "Physique-Chimie":"#4a9eff","Physics":"#4a9eff","Physik":"#4a9eff","Física":"#4a9eff",
  "SVT":"#3ecf8e","Biology":"#3ecf8e","Biologie":"#3ecf8e","Biología":"#3ecf8e","Biologia":"#3ecf8e",
};
function subjColor(subj) { return SUBJECT_COLORS[subj]||"#7c6fcd"; }

function ScheduleTab({prem: premProp, childReadOnly}) {
  const {C,t,cfg,setCfg,prem: ctxPrem,onUpgrade,user,setMenuTab,setConfigStep} = useApp();
  const prem = premProp !== undefined ? premProp : ctxPrem;
  const children = cfg.parents ? cfg.children : [];
  // childReadOnly: find the child's own index by name matching user.name
  const ownChildIdx = childReadOnly
    ? Math.max(0, (cfg.children||[]).findIndex(ch => ch.name && user?.name && ch.name.toLowerCase()===user.name.toLowerCase()))
    : 0;
  const [childIdx,setChildIdx] = useState(ownChildIdx);
  const [dayIdx,setDayIdx] = useState(0);
  const [showForm,setShowForm] = useState(false);
  const [editId,setEditId] = useState(null);
  const [form,setForm] = useState({subject:"",room:"",building:"",from:"08:00",to:"09:00"});
  const [err,setErr] = useState("");

  const dayNames = t.dayNames ? t.dayNames.slice(0,7) : ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"];
  const dayShort = t.dayShort ? t.dayShort.slice(0,7) : ["L","M","M","J","V","S","D"];
  const subjects = t.scheduleSubjects || ["Mathématiques","Français","Histoire-Géo","Sciences","Anglais","EPS","Arts plastiques","Musique","Technologie","Autre"];
  const child = cfg.children[childIdx];
  const scheduleKey = `schedule_child${child?.id||0}_day${dayIdx}`;
  const slots = (cfg.schedules||{})[scheduleKey]||[];

  function saveSlot() {
    const currentSlots = (cfg.schedules||{})[scheduleKey]||[];
    if(!prem && !editId && currentSlots.length>=1){onUpgrade();return;}
    if(!form.subject){setErr(t.scheduleErrSubject||"Matière requise");return;}
    if(!form.from||!form.to){setErr(t.scheduleErrTime||"Horaires requis");return;}
    const newSlot = {id:editId||Date.now(),...form};
    const all = cfg.schedules||{};
    const existing = all[scheduleKey]||[];
    let updated;
    if(editId) updated = existing.map(s=>s.id===editId?newSlot:s);
    else updated = [...existing,newSlot];
    updated = updated.sort((a,b)=>a.from.localeCompare(b.from));
    setCfg(c=>({...c,schedules:{...all,[scheduleKey]:updated}}));
    setShowForm(false);setEditId(null);setForm({subject:"",room:"",building:"",from:"08:00",to:"09:00"});setErr("");
  }
  function deleteSlot(id) {
    const all = cfg.schedules||{};
    const updated = (all[scheduleKey]||[]).filter(s=>s.id!==id);
    setCfg(c=>({...c,schedules:{...all,[scheduleKey]:updated}}));
  }
  function startEdit(slot) {
    setForm({subject:slot.subject,teacher:slot.teacher||'',room:slot.room,building:slot.building,from:slot.from,to:slot.to});
    setEditId(slot.id);setShowForm(true);
  }
  function cancelForm() {
    setShowForm(false);setEditId(null);setForm({subject:"",room:"",building:"",from:"08:00",to:"09:00"});setErr("");
  }

  if(!cfg.children||cfg.children.length===0||!cfg.children[0]?.name) {
    return (
      <div>
        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <div>
            <div style={{fontSize:16,fontWeight:900}}>🎒 {t.scheduleTitle||"Emploi du temps"}</div>
            <div style={{fontSize:11,color:C.mut}}>{t.scheduleWeeklySubtitle||"Planning hebdomadaire par enfant"}</div>
          </div>
          <InfoBubble C={C} tipKey={`duvia_scheduletip_${user?.id||"x"}`} title={t.scheduleTitle||"Emploi du temps"}>
            {t.scheduleTipBody||"Renseignez ici l'emploi du temps de chaque enfant : matières, salles, horaires. Il sera visible par tous les membres de la famille, sauf les observateurs."}
          </InfoBubble>
        </div>
        <div className="card" style={{textAlign:"center",padding:32,color:C.mut}}>
          <div style={{fontSize:32,marginBottom:10}}>🎒</div>
          <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>{t.scheduleNoChildren||"Configurez d'abord les enfants dans Configuration."}</div>
          <button onClick={()=>{setMenuTab("config");setConfigStep(0);}} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"8px 16px",background:`${C.vio}18`,border:`1.5px solid ${C.vio}`,color:C.vio,fontWeight:800,fontSize:13,borderRadius:20,cursor:"pointer"}}>
            ⚙️ {t.tabConfig||"Configuration"} › {t.stepId||"Identifiants"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fi">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontSize:16,fontWeight:900}}>🎒 {t.scheduleTitle||"Emploi du temps"}</div>
          <div style={{fontSize:11,color:C.mut}}>{t.scheduleWeeklySubtitle||"Planning hebdomadaire par enfant"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <InfoBubble C={C} tipKey={`duvia_scheduletip_${user?.id||"x"}`} title={t.scheduleTitle||"Emploi du temps"}>
            {t.scheduleTipBody||"Renseignez ici l'emploi du temps de chaque enfant : matières, salles, horaires. Il sera visible par tous les membres de la famille, sauf les observateurs."}
          </InfoBubble>
        </div>
      </div>

      {/* Child selector */}
      {cfg.children.length > 1 && (
        <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
          {cfg.children.filter(c=>c.name).map((ch,i)=>(
            <button key={ch.id} onClick={()=>{if(childReadOnly&&i!==ownChildIdx)return;setChildIdx(i);setShowForm(false);}}
              style={{padding:"3px 10px",background:childIdx===i?C.vio:C.sur,color:childIdx===i?"#fff":childReadOnly&&i!==ownChildIdx?C.mut+"88":C.mut,border:`1.5px solid ${childIdx===i?C.vio:C.bor}`,fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:5,opacity:childReadOnly&&i!==ownChildIdx?0.5:1}}>
              <span style={{fontSize:16,flexShrink:0}}>{ch.avatar||"🧒"}</span>{ch.name}
              {childReadOnly&&i!==ownChildIdx&&<span style={{fontSize:10}}>🔒</span>}
            </button>
          ))}
        </div>
      )}
      {cfg.children.filter(c=>c.name).length>0 && (
        <div style={{marginBottom:8,fontSize:12,color:C.txt,display:"flex",alignItems:"center",gap:5}}>
          <span style={{fontSize:15}}>{cfg.children[childIdx]?.avatar||"🧒"}</span>
          <span style={{fontWeight:800,color:C.vio}}>{cfg.children[childIdx]?.name}</span>
        </div>
      )}

      {/* Day selector */}
      <div style={{display:"flex",gap:6,marginBottom:16}}>
        {dayNames.map((d,i)=>{
          const k=`schedule_child${cfg.children[childIdx]?.id||0}_day${i}`;
          const count=(cfg.schedules||{})[k]?.length||0;
          return (
            <button key={i} onClick={()=>{setDayIdx(i);setShowForm(false);}} style={{flex:1,padding:"8px 4px",background:dayIdx===i?C.vio:C.sur,color:dayIdx===i?"#fff":C.mut,border:`1.5px solid ${dayIdx===i?C.vio:C.bor}`,borderRadius:10,fontSize:10,fontWeight:800,display:"flex",flexDirection:"column",alignItems:"center",gap:2,position:"relative"}}>
              <span style={{fontSize:13}}>{dayShort[i]}</span>
              <span style={{fontSize:8}}>{d.slice(0,3)}</span>
              {count>0&&<span style={{position:"absolute",top:-4,right:-4,background:dayIdx===i?C.grn:C.vio,borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800}}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Freemium banner — 1 cours/jour max */}
      {!prem && !childReadOnly && (
        <div onClick={onUpgrade} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",marginBottom:14,background:`${C.vio}10`,border:`1.5px dashed ${C.vio}55`,borderRadius:14,cursor:"pointer"}}>
          <span style={{fontSize:20,flexShrink:0}}>🔒</span>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:800,color:C.vio}}>Cours illimités — Premium</div>
            <div style={{fontSize:11,color:C.mut,marginTop:1}}>En gratuit : 1 cours par jour. Passez en Premium pour en ajouter autant que vous voulez.</div>
          </div>
          <div style={{flexShrink:0,padding:"5px 10px",background:`${C.vio}22`,color:C.vio,borderRadius:8,fontSize:11,fontWeight:800}}>⭐ Premium</div>
        </div>
      )}

      {/* Day view */}
      <div style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:800,color:C.txt}}>{dayNames[dayIdx]}</div>
          {!showForm && (!childReadOnly || childIdx===ownChildIdx) && (
            <button onClick={()=>{
              const currentSlots = (cfg.schedules||{})[scheduleKey]||[];
              if(!prem && currentSlots.length>=1){return;}
              setShowForm(true);setEditId(null);setForm({subject:"",room:"",building:"",from:"08:00",to:"09:00"});
            }} disabled={!prem && slots.length>=1}
              style={{padding:"7px 14px",background:(!prem&&slots.length>=1)?C.sur:`linear-gradient(135deg,${C.vio},${C.blu})`,color:(!prem&&slots.length>=1)?C.mut:"#fff",fontSize:12,fontWeight:800,opacity:(!prem&&slots.length>=1)?0.6:1,cursor:(!prem&&slots.length>=1)?"not-allowed":"pointer"}}>
              {(!prem&&slots.length>=1) ? "🔒 + Ajouter" : (t.scheduleAddSlot||"+ Ajouter")}
            </button>
          )}
        </div>

        {/* Timeline */}
        {slots.length===0 && !showForm && (
          <div style={{textAlign:"center",padding:"28px 0",color:C.mut,fontSize:13}}>
            <div style={{fontSize:28,marginBottom:8}}>📭</div>
            {t.scheduleNoSlots||"Aucun cours ce jour-là."}
          </div>
        )}

        {slots.map((slot,si)=>{
          const color=subjColor(slot.subject);
          return (
            <div key={slot.id} style={{display:"flex",gap:12,marginBottom:10,alignItems:"stretch"}}>
              {/* Time column */}
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",minWidth:46}}>
                <div style={{fontSize:11,fontWeight:800,color:C.mut}}>{slot.from}</div>
                <div style={{flex:1,width:2,background:`${color}55`,margin:"3px 0"}}></div>
                <div style={{fontSize:11,fontWeight:800,color:C.mut}}>{slot.to}</div>
              </div>
              {/* Card */}
              <div style={{flex:1,background:C.card,border:`1.5px solid ${C.bor}`,borderLeft:`4px solid ${color}`,borderRadius:"0 12px 12px 0",padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <span style={{background:`${color}22`,color:color,borderRadius:6,padding:"2px 8px",fontSize:12,fontWeight:800}}>{slot.subject}</span>
                  </div>
                  {slot.teacher&&<div style={{fontSize:11,color:C.mut,marginBottom:2}}>👤 <span style={{color:C.txt,fontWeight:600}}>{slot.teacher}</span></div>}
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    {slot.room && (
                      <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:C.mut}}>
                        <span>🚪</span>
                        <span style={{fontWeight:700,color:C.txt}}>{slot.room}</span>
                      </div>
                    )}
                    {slot.building && (
                      <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:C.mut}}>
                        <span>🏫</span>
                        <span style={{fontWeight:700,color:C.txt}}>{slot.building}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0}}>
                  {(!childReadOnly || childIdx===ownChildIdx) && (
                    <>
                      <button onClick={()=>startEdit(slot)} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:11}}>{t.scheduleEdit||"✎"}</button>
                      <button onClick={()=>deleteSlot(slot.id)} style={{padding:"5px 9px",background:`${C.red}18`,color:C.red,border:`1.5px solid ${C.red}44`,fontSize:11}}>✕</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <div className="card fi" style={{borderColor:C.vio,marginBottom:14}}>
          <div style={{fontSize:12,fontWeight:800,color:C.vio,marginBottom:14,letterSpacing:".06em",textTransform:"uppercase"}}>{editId?(t.scheduleEditTitle||"Modifier"):(t.scheduleAddTitle||"Nouveau cours")}</div>
          {err&&<div style={{background:`${C.red}22`,borderRadius:8,padding:"7px 12px",marginBottom:10,fontSize:12,color:C.red}}>{err}</div>}

          {/* Subject */}
          <div className="field">
            <label className="lbl">{t.scheduleSubject||"Matière"}</label>
            <input value={form.subject} onChange={e=>setForm(f=>({...f,subject:e.target.value}))} placeholder={t.schedulePlaceholderSubject||"ex: Mathématiques, EPS…"} />
          </div>

          {/* Teacher */}
          <div className="field">
            <label className="lbl">👤 {t.scheduleTeacher||"Professeur"}</label>
            <input value={form.teacher||""} onChange={e=>setForm(f=>({...f,teacher:e.target.value}))} placeholder={t.schedulePlaceholderTeacher||"ex: M. Dupont"} />
          </div>

          {/* Times */}
          <div className="row" style={{marginBottom:14}}>
            <div style={{flex:1}}>
              <label className="lbl">{t.scheduleFrom||"De"}</label>
              <input type="time" value={form.from} onChange={e=>setForm(f=>({...f,from:e.target.value}))} />
            </div>
            <div style={{flex:1}}>
              <label className="lbl">{t.scheduleTo||"À"}</label>
              <input type="time" value={form.to} onChange={e=>setForm(f=>({...f,to:e.target.value}))} />
            </div>
          </div>

          {/* Room + Building */}
          <div className="row" style={{marginBottom:16}}>
            <div style={{flex:1}}>
              <label className="lbl">🚪 {t.scheduleRoom||"Salle"}</label>
              <input value={form.room} onChange={e=>setForm(f=>({...f,room:e.target.value}))} placeholder={t.schedulePlaceholderRoom||"ex: 204"} />
            </div>
            <div style={{flex:1}}>
              <label className="lbl">🏫 {t.scheduleBuilding||"Bâtiment"}</label>
              <input value={form.building} onChange={e=>setForm(f=>({...f,building:e.target.value}))} placeholder={t.schedulePlaceholderBuilding||"ex: Bât. A"} />
            </div>
          </div>

          {/* Preview chip */}
          {form.subject && (
            <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:C.sur,borderRadius:10,flexWrap:"wrap"}}>
              <span style={{background:`${subjColor(form.subject)}22`,color:subjColor(form.subject),borderRadius:6,padding:"2px 8px",fontSize:12,fontWeight:800}}>{form.subject}</span>
              {form.from&&form.to&&<span style={{fontSize:11,color:C.mut}}>{form.from}–{form.to}</span>}
              {form.teacher&&<span style={{fontSize:11,color:C.mut}}>👤 {form.teacher}</span>}
              {form.room&&<span style={{fontSize:11,color:C.mut}}>🚪 {form.room}</span>}
              {form.building&&<span style={{fontSize:11,color:C.mut}}>🏫 {form.building}</span>}
            </div>
          )}

          <div style={{display:"flex",gap:8}}>
            <button onClick={saveSlot} style={{flex:1,padding:"10px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:14,fontWeight:800}}>
              {t.scheduleSave||"Enregistrer"}
            </button>
            <button onClick={cancelForm} style={{padding:"10px 16px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13}}>
              {t.scheduleCancel||"Annuler"}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── CONTACTS TAB ─────────────────────────────────────────────────────────────
const CAT_ICONS = {
  parents:"👨‍👩‍👧",observers:"👁️",school:"🏫",health:"🏥",other:"📋"
};
const CAT_COLORS_MAP = {
  parents:"blu",observers:"ora",school:"grn",health:"red",other:"mut"
};

// ─── EMERGENCY NUMBERS BY COUNTRY ─────────────────────────────────────────────
const EMERGENCY_NUMBERS = {
  FR:[
    {name:"🚨 Secours — Numéro Européen", phone:"112"},
    {name:"🚒 Pompiers",                   phone:"18"},
    {name:"🚑 SAMU",                       phone:"15"},
    {name:"👮 Police / Gendarmerie",        phone:"17"},
    {name:"🧏 Urgences sourds/muets (SMS)", phone:"114"},
  ],
  BE:[
    {name:"🚨 Secours — Numéro Européen",  phone:"112"},
    {name:"🚒 Pompiers",                   phone:"100"},
    {name:"👮 Police",                     phone:"101"},
  ],
  CH:[
    {name:"🚨 Secours — Numéro Européen",  phone:"112"},
    {name:"🚒 Pompiers",                   phone:"118"},
    {name:"🚑 Ambulance",                  phone:"144"},
    {name:"👮 Police",                     phone:"117"},
  ],
  LU:[
    {name:"🚨 Secours — Numéro Européen",  phone:"112"},
    {name:"🚒 Pompiers / Ambulance",       phone:"112"},
    {name:"👮 Police",                     phone:"113"},
  ],
  DE:[
    {name:"🚨 Notruf — Europaweite Nummer",phone:"112"},
    {name:"👮 Polizei",                    phone:"110"},
  ],
  AT:[
    {name:"🚨 Notruf — Europaweite Nummer",phone:"112"},
    {name:"🚒 Feuerwehr",                  phone:"122"},
    {name:"🚑 Rettung",                    phone:"144"},
    {name:"👮 Polizei",                    phone:"133"},
  ],
  NL:[
    {name:"🚨 Noodhulp — Europees nummer", phone:"112"},
  ],
  ES:[
    {name:"🚨 Emergencias — Número Europeo",phone:"112"},
    {name:"👮 Policía Nacional",            phone:"091"},
    {name:"🚒 Bomberos",                   phone:"080"},
    {name:"🚑 Emergencias médicas",        phone:"061"},
  ],
  PT:[
    {name:"🚨 Emergência — Número Europeu", phone:"112"},
  ],
  IT:[
    {name:"🚨 Emergenze — Numero Europeo",  phone:"112"},
    {name:"🚒 Vigili del fuoco",            phone:"115"},
    {name:"🚑 Ambulanza",                  phone:"118"},
    {name:"👮 Carabinieri",                phone:"112"},
    {name:"👮 Polizia",                    phone:"113"},
  ],
  GB:[
    {name:"🚨 Emergency",                  phone:"999"},
    {name:"🚨 Emergency (mobile/EU)",      phone:"112"},
    {name:"📞 Non-emergency police",       phone:"101"},
    {name:"🏥 NHS non-emergency",          phone:"111"},
  ],
  PL:[
    {name:"🚨 Ratownictwo — Numer Europejski",phone:"112"},
    {name:"🚒 Straż pożarna",              phone:"998"},
    {name:"🚑 Pogotowie",                  phone:"999"},
    {name:"👮 Policja",                    phone:"997"},
  ],
  CZ:[
    {name:"🚨 Záchranná — Evropské číslo", phone:"112"},
    {name:"🚒 Hasiči",                     phone:"150"},
    {name:"🚑 Záchranná",                  phone:"155"},
    {name:"👮 Policie",                    phone:"158"},
  ],
  SK:[
    {name:"🚨 Záchranná — Európske číslo", phone:"112"},
    {name:"🚑 Záchranná",                  phone:"155"},
    {name:"👮 Polícia",                    phone:"158"},
  ],
  HR:[
    {name:"🚨 Hitne službe — Europski broj",phone:"112"},
    {name:"🚒 Vatrogasci",                 phone:"193"},
    {name:"🚑 Hitna pomoć",                phone:"194"},
    {name:"👮 Policija",                   phone:"192"},
  ],
  CA:[
    {name:"🚨 Emergency",                  phone:"911"},
  ],
};

function ContactsTab({readOnly,addOnly,prem: premProp}) {
  const {C,t,cfg,setCfg,prem: ctxPrem,onUpgrade,setActivity,user,addRefAction} = useApp();
  const prem = premProp !== undefined ? premProp : ctxPrem;
  // addOnly: child can add contacts but not edit/delete
  const canAdd = !readOnly;
  const canDelete = !readOnly && !addOnly;
  const canEdit = !readOnly && !addOnly;
  const [showForm,setShowForm] = useState(false);
  const [editId,setEditId] = useState(null);
  const [form,setForm] = useState({name:"",phone:"",note:"",cat:"other"});
  const [err,setErr] = useState("");
  const [filter,setFilter] = useState("all");
  const [confirmDel,setConfirmDel] = useState(null); // contact object to confirm delete

  // Build auto-contacts from parents & observers in cfg
  const autoContacts = [];
  (cfg.parents||[]).filter(p=>p.name).forEach(p=>{
    autoContacts.push({id:`auto_parent_${p.id}`,name:p.name,phone:p.phone||"",note:t.roleParent||"Parent",cat:"parents",auto:true,color:p.color,avatar:p.avatar});
  });
  // Children with phone
  (cfg.children||[]).filter(ch=>ch.name).forEach(ch=>{
    if(ch.phone) autoContacts.push({id:`auto_child_${ch.id}`,name:ch.name,phone:ch.phone,note:t.contactsChild||"Enfant",cat:"other",auto:true,avatar:ch.avatar});
  });
  (cfg.observers||[]).forEach((o,i)=>{
    autoContacts.push({id:`auto_obs_${i}`,name:o.name||o.email,phone:o.phone||"",note:o.relation||t.roleObs||"Observateur",cat:"observers",auto:true});
  });

  // Emergency numbers from country config
  const country = cfg.country || "FR";
  const emergencyNums = (EMERGENCY_NUMBERS[country] || []).map((e,i)=>({
    id:`auto_emergency_${i}`,name:e.name,phone:e.phone,note:"",cat:"emergency",auto:true,emergency:true
  }));

  const customContacts = cfg.contacts || [];

  // Default contacts seeded on first render if none exist
  const allContacts = [...emergencyNums, ...autoContacts, ...customContacts];

  const CATS = [
    {key:"all",label:t.contactsCatAll||"🔍 Tous"},
    {key:"emergency",label:t.contactsCatEmergency||"🆘 Urgences"},
    {key:"parents",label:t.contactsCatParents||"👨‍👩‍👧 Parents"},
    {key:"observers",label:t.contactsCatObservers||"👁️ Observateurs"},
    {key:"school",label:t.contactsCatSchool||"🏫 École"},
    {key:"health",label:t.contactsCatHealth||"🏥 Santé"},
    {key:"other",label:t.contactsCatOther||"📋 Autres"},
  ];

  const filtered = filter==="all" ? allContacts : allContacts.filter(c=>c.cat===filter);

  // Group by cat for display
  const groups = {};
  filtered.forEach(c=>{
    if(!groups[c.cat]) groups[c.cat]=[];
    groups[c.cat].push(c);
  });

  function catColor(cat) {
    const map = {emergency:C.red,parents:C.blu,observers:C.ora,school:C.grn,health:C.red,other:C.mut};
    return map[cat]||C.mut;
  }
  function catLabel(cat) {
    const map = {emergency:t.contactsCatEmergency||"🆘 Urgences",parents:t.contactsCatParents,observers:t.contactsCatObservers,school:t.contactsCatSchool,health:t.contactsCatHealth,other:t.contactsCatOther};
    return (map[cat]||cat).replace(/^[^\w🆘]+/,"");
  }

  function saveContact() {
    if(!prem){onUpgrade();return;}
    if(!form.name.trim()){setErr(t.contactsName||"Nom requis");return;}
    const entry = {id:editId||Date.now(), name:form.name.trim(), phone:form.phone.trim(), note:form.note.trim(), cat:form.cat};
    const existing = cfg.contacts||[];
    const updated = editId ? existing.map(c=>c.id===editId?entry:c) : [...existing,entry];
    setCfg(c=>({...c,contacts:updated}));
    if(!editId){ setActivity(a=>({...a,contacts:{ts:new Date().toISOString(),by:String(user?.id||"")}})); addRefAction("ADD_CONTACT"); }
    cancelForm();
  }
  function deleteContact(id) {
    setCfg(c=>({...c,contacts:(c.contacts||[]).filter(x=>x.id!==id)}));
    setConfirmDel(null);
  }
  function startEdit(contact) {
    setForm({name:contact.name,phone:contact.phone||"",note:contact.note||"",cat:contact.cat});
    setEditId(contact.id);setShowForm(true);
  }
  function cancelForm() {
    setShowForm(false);setEditId(null);setForm({name:"",phone:"",note:"",cat:"other"});setErr("");
  }

  const catOrder = ["emergency","parents","observers","school","health","other"];
  const sortedGroups = catOrder.filter(k=>groups[k]);

  return (
    <div className="fi">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontSize:16,fontWeight:900}}>📞 {t.contactsTitle||"Répertoire"}</div>
          <div style={{fontSize:11,color:C.mut}}>{t.contactsSubtitle||"Numéros utiles partagés avec toute la famille"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <InfoBubble C={C} tipKey={`duvia_contactstip_${user?.id||"x"}`} title={t.contactsTitle||"Répertoire"}>
            {t.contactsTipBody||"Retrouvez ici les numéros utiles de la famille. Ce répertoire est visible par tous les membres de la famille."}
          </InfoBubble>
        </div>
      </div>

      {/* Category filter */}
      <div style={{display:"flex",gap:5,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
        {CATS.map(cat=>(
          <button key={cat.key} onClick={()=>setFilter(cat.key)} style={{whiteSpace:"nowrap",padding:"5px 11px",background:filter===cat.key?C.vio:C.sur,color:filter===cat.key?"#fff":C.mut,border:`1.5px solid ${filter===cat.key?C.vio:C.bor}`,borderRadius:20,fontSize:11,fontWeight:700,flexShrink:0}}>
            {cat.key==="all"?cat.label:cat.label}
          </button>
        ))}
      </div>

      {/* Add button (not for readOnly) */}
      {canAdd && !showForm && (
        <button onClick={()=>{if(!prem){onUpgrade();return;}setShowForm(true);setEditId(null);setForm({name:"",phone:"",note:"",cat:"other"});}} style={{width:"100%",padding:"11px",background:prem?`linear-gradient(135deg,${C.grn},${C.blu})`:`${C.ora}22`,color:prem?"#fff":C.ora,border:prem?"none":`1.5px solid ${C.ora}`,fontSize:13,fontWeight:800,marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          <span style={{fontSize:16}}>{prem?"":"🔒"}</span> {prem?((t.contactsAdd||"Ajouter un contact").replace(/^\+\s*/,"")):`${t.lockSection} — ${t.upgradeCTA}`}
        </button>
      )}

      {/* Add/Edit form */}
      {showForm && canAdd && prem && (
        <div className="card fi" style={{borderColor:C.grn,marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:800,color:C.grn,marginBottom:14,letterSpacing:".06em",textTransform:"uppercase"}}>
            {editId?(t.contactsEditTitle||"Modifier"):(t.contactsAddTitle||"Nouveau contact")}
          </div>
          {err&&<div style={{background:`${C.red}22`,borderRadius:8,padding:"7px 12px",marginBottom:10,fontSize:12,color:C.red}}>{err}</div>}

          {/* Category */}
          <div className="field">
            <label className="lbl">{t.contactsCatLabel||"Catégorie"}</label>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {CATS.filter(c=>c.key!=="all" && c.key!=="emergency").map(cat=>(
                <button key={cat.key} onClick={()=>setForm(f=>({...f,cat:cat.key}))} style={{padding:"5px 11px",background:form.cat===cat.key?catColor(cat.key):C.sur,color:form.cat===cat.key?"#fff":C.mut,border:`1.5px solid ${form.cat===cat.key?catColor(cat.key):C.bor}`,borderRadius:20,fontSize:11,fontWeight:700}}>
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div className="field">
            <label className="lbl">{t.contactsName||"Nom / Rôle"}</label>
            <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder={t.contactsPlaceholderName||"ex: Dr. Martin, École Jean Moulin…"} />
          </div>

          {/* Phone */}
          <div className="field">
            <label className="lbl">📞 {t.contactsPhone||"Téléphone"}</label>
            <input type="tel" value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder={t.regPhonePlaceholder||"ex: 06 12 34 56 78"} />
          </div>

          {/* Note */}
          <div className="field">
            <label className="lbl">💬 {t.contactsNote||"Note (optionnel)"}</label>
            <input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder={t.contactsPlaceholderNote||"ex: Urgences, cabinet 3ème étage…"} />
          </div>

          <div style={{display:"flex",gap:8}}>
            <button onClick={saveContact} style={{flex:1,padding:"10px",background:`linear-gradient(135deg,${C.grn},${C.blu})`,color:"#fff",fontSize:14,fontWeight:800}}>
              {t.contactsSave||"Enregistrer"}
            </button>
            <button onClick={cancelForm} style={{padding:"10px 16px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13}}>
              {t.contactsCancel||"Annuler"}
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {allContacts.length===0 && (
        <div style={{textAlign:"center",padding:"32px 0",color:C.mut}}>
          <div style={{fontSize:32,marginBottom:8}}>📭</div>
          <div style={{fontSize:13}}>{t.contactsEmpty||"Aucun contact enregistré."}</div>
        </div>
      )}

      {/* Contact groups */}
      {sortedGroups.map(cat=>(
        <div key={cat} style={{marginBottom:18}}>
          {/* Category header */}
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
            <div style={{width:4,height:18,borderRadius:2,background:catColor(cat)}}></div>
            <span style={{fontSize:11,fontWeight:800,color:catColor(cat),letterSpacing:".08em",textTransform:"uppercase"}}>{catLabel(cat)}</span>
            <span style={{fontSize:10,color:C.mut}}>· {groups[cat].length}</span>
          </div>

          {groups[cat].map(contact=>{
            const color = contact.emergency ? C.red : (contact.color||catColor(contact.cat));
            return (
              <div key={contact.id} style={{display:"flex",alignItems:"center",gap:12,background:contact.emergency?`${C.red}0d`:C.card,border:`1.5px solid ${contact.emergency?C.red:C.bor}`,borderLeft:`4px solid ${color}`,borderRadius:"0 12px 12px 0",padding:"12px 14px",marginBottom:8}}>
                {/* Avatar */}
                <div style={{width:38,height:38,borderRadius:12,background:`${color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0,border:`2px solid ${color}44`}}>
                  {contact.avatar || (contact.emergency?"🆘":contact.cat==="parents"?"👤":contact.cat==="observers"?"👁️":contact.cat==="school"?"🏫":contact.cat==="health"?"🏥":"📋")}
                </div>
                {/* Info */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:800,color:contact.emergency?C.red:C.txt,marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{contact.name}</div>
                  {contact.phone ? (
                    <a href={`tel:${contact.phone.replace(/\s/g,"")}`} style={{fontSize:contact.emergency?16:12,color:contact.emergency?C.red:C.blu,fontWeight:contact.emergency?900:700,textDecoration:"none",display:"flex",alignItems:"center",gap:4}}>
                      📞 {contact.phone}
                    </a>
                  ) : (
                    !contact.auto && <div style={{fontSize:11,color:C.mut}}>{t.contactsNoPhone||"— pas de numéro —"}</div>
                  )}
                  {contact.note && <div style={{fontSize:11,color:C.mut,marginTop:2}}>{contact.note}</div>}
                </div>
                {/* Actions */}
                <div style={{display:"flex",gap:5,flexShrink:0}}>
                  {contact.phone && (
                    <a href={`tel:${contact.phone.replace(/\s/g,"")}`} style={{display:"flex",alignItems:"center",justifyContent:"center",width:contact.emergency?38:32,height:contact.emergency?38:32,borderRadius:10,background:contact.emergency?C.red:`${C.grn}22`,border:contact.emergency?"none":`1.5px solid ${C.grn}44`,textDecoration:"none",fontSize:14}}>
                      {contact.emergency?<span style={{color:"#fff",fontWeight:900,fontSize:18}}>📞</span>:"📞"}
                    </a>
                  )}
                  {canEdit && !contact.auto && prem && (
                    <>
                      <button onClick={()=>startEdit(contact)} style={{width:32,height:32,padding:0,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontSize:13}}>✎</button>
                      <button onClick={()=>setConfirmDel(contact)} style={{width:32,height:32,padding:0,background:`${C.red}18`,color:C.red,border:`1.5px solid ${C.red}44`,borderRadius:10,fontSize:13}}>✕</button>
                    </>
                  )}
                  {canAdd && !canEdit && !contact.auto && prem && (
                    <div style={{fontSize:9,color:C.mut,padding:"3px 6px",background:C.sur,borderRadius:6,border:`1px solid ${C.bor}`}}>{t.contactsReadOnly||"Lecture"}</div>
                  )}
                  {canAdd && !readOnly && contact.auto && !contact.emergency && (
                    <div style={{fontSize:9,color:C.mut,padding:"3px 6px",background:C.sur,borderRadius:6,border:`1px solid ${C.bor}`}}>{t.contactsAuto||"Auto"}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {/* Confirmation suppression */}
      {confirmDel && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:16,padding:24,maxWidth:320,width:"100%",textAlign:"center",border:`1.5px solid ${C.bor}`,boxShadow:"0 12px 40px rgba(0,0,0,.3)"}}>
            <div style={{fontSize:36,marginBottom:10}}>🗑️</div>
            <div style={{fontSize:15,fontWeight:800,marginBottom:6}}>{t.vaultConfirmDel||"Supprimer ce contact ?"}</div>
            <div style={{fontSize:13,color:C.mut,marginBottom:4}}><strong style={{color:C.txt}}>{confirmDel.name}</strong></div>
            {confirmDel.phone && (
              <div style={{fontSize:12,color:C.mut,marginBottom:16}}>📞 {confirmDel.phone}</div>
            )}
            <div style={{display:"flex",gap:10,marginTop:18}}>
              <button onClick={()=>setConfirmDel(null)} style={{flex:1,padding:"10px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontWeight:700,borderRadius:10,fontSize:13}}>
                {t.vaultCancel||"Annuler"}
              </button>
              <button onClick={()=>deleteContact(confirmDel.id)} style={{flex:1,padding:"10px",background:C.red,color:"#fff",fontWeight:800,borderRadius:10,fontSize:13,border:"none"}}>
                🗑 {t.vaultDelete||"Supprimer"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── SPIN WHEEL ───────────────────────────────────────────────────────────────
// Règles du tableau des lots (version 2.0)
// ┌─────────────────────────────────────┬────────────┬──────────┬──────────────┐
// │ LOT                                 │ Souscript. │ Autres   │ Achat        │
// ├─────────────────────────────────────┼────────────┼──────────┼──────────────┤
// │ Perdu                               │ 48,9 %     │ 50,0 %   │ —            │
// │ 1 an offert                         │  0,1 %     │  0,0 %   │ —            │
// │ 1 mois offert                       │  1,0 %     │  0,0 %   │ —            │
// │ Thème Été 26 (21/06–23/07)          │ 20,0 %     │ 20,0 %   │ 0,49 €       │
// │ Thème Jeu vidéo (permanent)         │ 10,0 %     │ 10,0 %   │ 0,29 €       │
// │ Thème Licorne  (permanent)          │ 10,0 %     │ 10,0 %   │ 0,29 €       │
// │ Thème Tennis France 26 (24/05–04/06)│  5,0 %     │  5,0 %   │ 0,99 €       │
// │ Thème Coupe du Monde 26 (06/06–26/07│  5,0 %     │  5,0 %   │ 0,99 €       │
// └─────────────────────────────────────┴────────────┴──────────┴──────────────┘
// Fréquence : 7 jours (parents) · 2 jours (enfants/observateurs)
// Permission : OUI pour tous les rôles
// Si achat : devient permanent pour tous les thèmes

const WHEEL_PRIZES = [
  { id:"year",    label:"1 AN OFFERT",          labelKey:"wheelSegYear",    emoji:"🏆", color:"#FFD700", type:"payment",
    price:null,   validStart:null, validEnd:null },
  { id:"month",   label:"1 MOIS OFFERT",         labelKey:"wheelSegMonth",   emoji:"🎁", color:"#ff6bb5", type:"payment",
    price:null,   validStart:null, validEnd:null },
  { id:"theme",   label:"THÈME ÉTÉ 🌴",          labelKey:"wheelSegTheme",   emoji:"🌴", color:"#3ecf8e", type:"reward",
    price:0.49,   validStart:SUMMER_START, validEnd:SUMMER_END },
  { id:"video",   label:"THÈME JEU VIDÉO 🎮",    labelKey:"wheelSegVideo",   emoji:"🎮", color:"#7c6fcd", type:"reward",
    price:0.29,   validStart:null, validEnd:null },
  { id:"licorne", label:"THÈME LICORNE 🦄",       labelKey:"wheelSegLicorne", emoji:"🦄", color:"#ec4899", type:"reward",
    price:0.29,   validStart:null, validEnd:null },
  { id:"rg",      label:"THÈME TENNIS 🎾",        labelKey:"wheelSegRG",      emoji:"🎾", color:"#c2745a", type:"reward",
    price:0.99,   validStart:RG_START, validEnd:RG_END },
  { id:"wc",      label:"THÈME COUPE DU MONDE ⚽", labelKey:"wheelSegWC",     emoji:"⚽", color:"#2563eb", type:"reward",
    price:0.99,   validStart:WC_START, validEnd:WC_END },
  { id:"nothing", label:"PERDU",                  labelKey:"wheelSegNothing", emoji:"😅", color:"#9ca3af", type:"none",
    price:null,   validStart:null, validEnd:null },
];

// Helper: is a seasonal prize currently active on the wheel?
function isPrizeActive(p) {
  if(!p.validStart) return true; // permanent
  const n = new Date();
  return n >= p.validStart && n <= p.validEnd;
}

// ─── PROBABILITÉS PAR RÔLE ───────────────────────────────────────────────────
// "Souscripteur" = parent avec parentIdx === 0 (celui qui a souscrit l'abonnement)
// "Autres" = autre parent, enfant, observateur
const PROBS_SUBSCRIBER = { year:0.001, month:0.010, theme:0.200, video:0.100, licorne:0.100, rg:0.050, wc:0.050, nothing:0.489 };
const PROBS_OTHERS     = { year:0.000, month:0.000, theme:0.200, video:0.100, licorne:0.100, rg:0.050, wc:0.050, nothing:0.500 };

// 20 segments visuels : nothing×10, theme×4, video×2, licorne×2, rg×1, wc×1
// year et month sont "virtuels" (pas de segment propre) → atterrissent sur rien/mois visuellement
const P_NOTHING  = WHEEL_PRIZES[7]; // 😅
const P_THEME    = WHEEL_PRIZES[2]; // 🌴
const P_VIDEO    = WHEEL_PRIZES[3]; // 🎮
const P_LICORNE  = WHEEL_PRIZES[4]; // 🦄
const P_RG       = WHEEL_PRIZES[5]; // 🎾
const P_WC       = WHEEL_PRIZES[6]; // ⚽
const P_MONTH    = WHEEL_PRIZES[1]; // 🎁

const WHEEL_SEGS = [
  P_NOTHING,  // 0
  P_THEME,    // 1
  P_NOTHING,  // 2
  P_VIDEO,    // 3
  P_NOTHING,  // 4
  P_THEME,    // 5
  P_NOTHING,  // 6
  P_LICORNE,  // 7
  P_NOTHING,  // 8
  P_THEME,    // 9
  P_NOTHING,  // 10
  P_RG,       // 11
  P_NOTHING,  // 12
  P_THEME,    // 13
  P_NOTHING,  // 14
  P_VIDEO,    // 15
  P_WC,       // 16
  P_LICORNE,  // 17
  P_NOTHING,  // 18
  P_NOTHING,  // 19
];

// Couleurs visuelles des segments (correspondant à WHEEL_SEGS)
const WHEEL_SEG_COLORS = [
  "#9ca3af","#3ecf8e","#9ca3af","#7c6fcd","#9ca3af","#3ecf8e",
  "#9ca3af","#ec4899","#9ca3af","#3ecf8e","#9ca3af","#c2745a",
  "#9ca3af","#3ecf8e","#9ca3af","#7c6fcd","#2563eb","#ec4899",
  "#9ca3af","#9ca3af",
];

// Tirage pondéré avec prise en compte du rôle et des dates de validité
function pickSegment(isSubscriber = true) {
  const probs = isSubscriber ? PROBS_SUBSCRIBER : PROBS_OTHERS;

  // Redistribue les probabilités des lots hors-période vers "nothing"
  const active = { ...probs };
  ["theme","rg","wc"].forEach(id=>{
    const p = WHEEL_PRIZES.find(x=>x.id===id);
    if(p && !isPrizeActive(p)) { active.nothing += active[id]; active[id] = 0; }
  });

  // Tirage
  const r = Math.random(); let cum = 0;
  let prize = WHEEL_PRIZES[7]; // défaut: perdu
  for(const p of WHEEL_PRIZES) {
    const prob = active[p.id] || 0;
    cum += prob;
    if(r < cum) { prize = p; break; }
  }

  // Trouver le segment visuel correspondant
  const matchIdxs = WHEEL_SEGS.reduce((a,s,i)=>{ if(s.id===prize.id) a.push(i); return a; },[]);
  let segIdx;
  if(matchIdxs.length > 0) {
    segIdx = matchIdxs[Math.floor(Math.random()*matchIdxs.length)];
  } else {
    // year → atterrit visuellement sur un segment "nothing" aléatoire
    // month → atterrit visuellement sur un segment "nothing" aléatoire
    const nothingIdxs = WHEEL_SEGS.reduce((a,s,i)=>{ if(s.id==="nothing") a.push(i); return a; },[]);
    segIdx = nothingIdxs[Math.floor(Math.random()*nothingIdxs.length)];
  }
  return { segIdx, prize };
}

function WheelGame({ isPremium, isAdmin=false, restrictedRole=false, userId="", isSubscriber=true, isParent=true }) {
  const {C,t,lang,sub,setSub} = useApp();
  const [spinning, setSpinning] = useState(false);
  const [deg, setDeg] = useState(0);
  const [result, setResult] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [particles, setParticles] = useState([]);

  const now = Date.now();
  // Cooldown : 7 jours pour les parents, 2 jours pour enfants/observateurs
  const cooldownMs = isParent ? 7*24*60*60*1000 : 2*24*60*60*1000;
  const isAdminSub = isAdmin || sub._admin || false;
  // lastSpin per user (stocké dans sub.lastSpinByUser[userId])
  const lastSpinByUser = sub.lastSpinByUser || {};
  const lastSpin = lastSpinByUser[userId] || null;
  const hasBonusSpin = (sub.pendingSpins||0) > 0;
  const canSpin = isAdminSub || hasBonusSpin || !lastSpin || (now - new Date(lastSpin).getTime()) >= cooldownMs;
  const nextSpinDate = lastSpin ? new Date(new Date(lastSpin).getTime()+cooldownMs) : null;
  const hoursLeft = nextSpinDate ? Math.ceil((nextSpinDate.getTime()-now)/3600000) : 0;
  const daysLeft  = nextSpinDate ? Math.ceil((nextSpinDate.getTime()-now)/86400000) : 0;
  const showHours = hoursLeft <= 24;

  const SEGS = WHEEL_SEGS;
  const N = SEGS.length; // 20 segments
  const segDeg = 360/N;

  function spin() {
    if(spinning || (!canSpin && !isAdminSub) || !isPremium) return;
    const usingBonus = !isAdminSub && hasBonusSpin && lastSpin && (now - new Date(lastSpin).getTime()) < cooldownMs;
    setShowResult(false); setResult(null); setParticles([]);

    const { segIdx, prize } = pickSegment(isSubscriber);

    const segCenter = segIdx * segDeg + segDeg / 2;
    const targetMod = ((-segCenter) % 360 + 360) % 360;
    const currentMod = ((deg % 360) + 360) % 360;
    const delta = (targetMod - currentMod + 360) % 360;
    const target = deg + 360 * 7 + (delta === 0 ? 360 : delta);

    setSpinning(true);
    const start = deg;
    const dur = 4200;
    const t0 = performance.now();
    function frame(t) {
      const p = Math.min((t-t0)/dur, 1);
      const e = 1 - Math.pow(1-p, 4);
      setDeg(start + (target-start)*e);
      if(p < 1) { requestAnimationFrame(frame); }
      else {
        setDeg(start + (target-start));
        setSpinning(false);
        setResult(prize);
        setShowResult(true);
        if(!restrictedRole) {
          setSub(s=>({...s,
            lastSpinByUser: { ...(s.lastSpinByUser||{}), [userId]: new Date().toISOString() },
            pendingSpins: usingBonus ? Math.max(0,(s.pendingSpins||0)-1) : (s.pendingSpins||0),
            earnedTheme:   prize.id==="theme"   || s.earnedTheme,
            earnedVideo:   prize.id==="video"   || s.earnedVideo,
            earnedLicorne: prize.id==="licorne" || s.earnedLicorne,
            earnedRG:      prize.id==="rg"      || s.earnedRG,
            earnedWC:      prize.id==="wc"      || s.earnedWC,
          }));
        } else {
          // Rôles restreints → on enregistre quand même le cooldown
          setSub(s=>({...s, lastSpinByUser: { ...(s.lastSpinByUser||{}), [userId]: new Date().toISOString() }}));
        }
        if(prize.id!=="nothing") {
          setParticles(Array.from({length:40},(_,i)=>({
            id:i, x:50, y:50,
            vx:(Math.random()-0.5)*120, vy:(Math.random()-0.8)*120,
            color:[prize.color,"#FFD700","#ff6bb5","#4a9eff"][i%4],
            size:Math.random()*6+3,
          })));
          setTimeout(()=>setParticles([]),2000);
        }
      }
    }
    requestAnimationFrame(frame);
  }

  // SVG wheel
  function segPath(i) {
    const r = 110, cx=120, cy=120;
    const a1 = (i*segDeg-90) * Math.PI/180;
    const a2 = ((i+1)*segDeg-90) * Math.PI/180;
    const x1=cx+r*Math.cos(a1), y1=cy+r*Math.sin(a1);
    const x2=cx+r*Math.cos(a2), y2=cy+r*Math.sin(a2);
    return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2} Z`;
  }
  function emojiPos(i) {
    const r=75, cx=120, cy=120;
    const a = ((i+0.5)*segDeg-90)*Math.PI/180;
    return { x:cx+r*Math.cos(a), y:cy+r*Math.sin(a) };
  }

  const segColors = WHEEL_SEG_COLORS;
  const LOCALE = {fr:"fr-FR",en:"en-GB",de:"de-DE",es:"es-ES",pt:"pt-PT"}[lang] || "fr-FR";

  return (
    <div style={{textAlign:"center"}}>
      {/* Title */}
      <div style={{marginBottom:16}}>
        <div style={{fontSize:22,fontWeight:900,background:"linear-gradient(135deg,#FFD700,#ff6bb5,#7c6fcd)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
          {t.wheelTitle}
        </div>
        <div style={{fontSize:11,color:C.mut,marginTop:3}}>
          {isAdmin
            ? t.wheelAdminMode
            : restrictedRole
              ? `${t.wheelFunPrefix} ${isParent?t.unitDayAbbrevParent:t.unitDayAbbrevChild}`
              : `${t.wheelNormalPrefix} ${isParent?t.cooldown7days:t.cooldown2days} ${t.wheelPremiumSuffix}`}
        </div>
      </div>

      {/* Wheel */}
      <div style={{position:"relative",display:"inline-block",marginBottom:16}}>
        {/* Particles */}
        {particles.map(p=>(
          <div key={p.id} style={{
            position:"absolute",
            left:`calc(${p.x}% + ${p.vx*(1)}px)`,
            top:`calc(${p.y}% + ${p.vy*(1)}px)`,
            width:p.size,height:p.size,
            background:p.color,
            borderRadius:"50%",
            pointerEvents:"none",
            zIndex:20,
            animation:"confettiFall 1.5s ease-out forwards",
          }}/>
        ))}
        <style>{`
          @keyframes confettiFall { from{opacity:1;transform:scale(1)} to{opacity:0;transform:scale(0.3) translateY(40px)} }
          @keyframes popIn { from{transform:scale(0.4);opacity:0} to{transform:scale(1);opacity:1} }
          @keyframes shimmer { 0%,100%{opacity:0.5} 50%{opacity:1} }
        `}</style>

        {/* Pointer */}
        <div style={{position:"absolute",top:-18,left:"50%",transform:"translateX(-50%)",fontSize:26,zIndex:10,filter:"drop-shadow(0 2px 4px rgba(0,0,0,.4))"}}>▼</div>

        {/* SVG Wheel */}
        <svg width="240" height="240" viewBox="0 0 240 240"
          style={{display:"block",transform:`rotate(${deg}deg)`,transition:spinning?"none":"none",
            filter:"drop-shadow(0 8px 24px rgba(124,111,205,.4))",borderRadius:"50%"}}>
          {/* Segments */}
          {SEGS.map((seg,i)=>(
            <g key={i}>
              <path d={segPath(i)} fill={segColors[i]} stroke="white" strokeWidth="2"/>
              <path d={segPath(i)} fill="rgba(255,255,255,0.1)" stroke="none"/>
            </g>
          ))}
          {/* Emojis */}
          {SEGS.map((seg,i)=>{
            const pos=emojiPos(i);
            return <text key={i} x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="middle"
              fontSize="18" style={{userSelect:"none"}}>{seg.emoji}</text>;
          })}
          {/* Center */}
          <circle cx="120" cy="120" r="24" fill="white" stroke="#7c6fcd" strokeWidth="3"/>
          <text x="120" y="120" textAnchor="middle" dominantBaseline="middle" fontSize="16">✦</text>
        </svg>
      </div>

      {/* Button */}
      <div style={{marginBottom:14}}>
        {!isPremium ? (
          <div style={{padding:"11px 28px",background:`${C.vio}15`,border:`2px dashed ${C.vio}`,borderRadius:50,fontSize:13,fontWeight:800,color:C.vio,display:"inline-block"}}>
            {t.wheelLockedPremium}
          </div>
        ) : canSpin ? (
          <button onClick={spin} disabled={spinning} style={{
            padding:"13px 36px",
            background:spinning?"linear-gradient(135deg,#9b8ee0,#7ab5ff)":"linear-gradient(135deg,#FFD700,#ff9f43)",
            color:"#fff",fontSize:16,fontWeight:900,borderRadius:50,
            boxShadow:spinning?"none":"0 6px 20px rgba(255,215,0,.45)",
            transform:spinning?"scale(0.97)":"scale(1)",transition:"all .2s",
          }}>
            {spinning ? t.wheelSpinning : t.wheelLaunch}
          </button>
        ) : (
          <div style={{padding:"12px 20px",background:C.sur,borderRadius:14,border:`1.5px solid ${C.bor}`,display:"inline-block"}}>
            <div style={{fontSize:12,color:C.mut,fontWeight:700}}>{t.wheelNextSpinIn}</div>
            <div style={{fontSize:20,fontWeight:900,color:C.vio}}>
              {showHours ? `${hoursLeft}${t.wheelHourSuffix}` : `${daysLeft} ${daysLeft>1?t.wheelDayPlural:t.wheelDaySingular}`}
            </div>
            <div style={{fontSize:10,color:C.mut}}>{t.wheelOnDatePrefix} {nextSpinDate?.toLocaleDateString(LOCALE,{weekday:"long",day:"numeric",month:"long"})}</div>
          </div>
        )}
      </div>

      {/* Result */}
      {showResult && result && (
        <div style={{background:result.id==="nothing"?C.sur:`${result.color}18`,border:`2.5px solid ${result.color}`,borderRadius:18,padding:"18px 16px",marginBottom:14,animation:"popIn .4s cubic-bezier(.34,1.56,.64,1)"}}>
          <div style={{fontSize:44,marginBottom:6}}>{result.emoji}</div>
          <div style={{fontSize:20,fontWeight:900,color:result.color,marginBottom:6}}>{t[result.labelKey]||result.label}</div>
          <div style={{fontSize:12,color:C.mut,marginBottom:12,lineHeight:1.5}}>
            {result.type==="payment" && t.wheelResultPayment}
            {result.id==="theme" && (isSummerPeriod()?t.wheelResultThemeUnlocked:t.wheelResultThemeEarned)}
            {result.id==="video" && t.wheelResultVideoUnlocked}
            {result.id==="licorne" && t.wheelResultLicorneUnlocked}
            {result.id==="rg" && (isRGPeriod()?t.wheelResultRGUnlocked:t.wheelResultRGEarned)}
            {result.id==="wc" && (isWCPeriod()?t.wheelResultWCUnlocked:t.wheelResultWCEarned)}
            {result.id==="nothing" && `${t.wheelResultNothingPrefix} ${isParent?t.cooldown7days:t.cooldown2days} ${t.wheelResultNothingSuffix}`}
          </div>
          <button onClick={()=>setShowResult(false)} style={{padding:"8px 22px",background:result.color,color:"#fff",fontSize:13,fontWeight:800,borderRadius:20}}>
            {result.id==="nothing"?t.wheelOk:t.wheelGreat}
          </button>
        </div>
      )}

      {/* Prize table */}
      <div style={{textAlign:"left",marginTop:8}}>
        <div style={{fontSize:10,fontWeight:800,color:C.mut,letterSpacing:".08em",textTransform:"uppercase",marginBottom:8}}>{t.wheelPrizeTableTitle}</div>
        {WHEEL_PRIZES.map(p=>{
          const active = isPrizeActive(p);
          return (
            <div key={p.id} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"9px 10px",marginBottom:4,
              background:p.type==="payment"?`${p.color}08`:C.sur,borderRadius:10,
              border:`1.5px solid ${p.type==="payment"?p.color+"44":active?C.bor:C.bor+"44"}`,
              opacity:active?1:0.5}}>
              <div style={{width:30,height:30,borderRadius:8,background:`${p.color}22`,border:`2px solid ${p.color}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0,marginTop:1}}>{p.emoji}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:800,color:p.color}}>{t[p.labelKey]||p.label}</div>
                {p.type==="payment" ? (
                  <div style={{fontSize:9,color:C.mut,marginTop:2}}>{t.wheelPrizePaymentInfo}</div>
                ) : p.type==="reward" ? (
                  <div style={{fontSize:9,color:C.mut,marginTop:2}}>
                    {p.price&&<span style={{background:`${p.color}15`,color:p.color,borderRadius:5,padding:"1px 5px",fontWeight:700,marginRight:5}}>{t.wheelBuyPrefix} {p.price}{t.wheelBuyPermanentSuffix}</span>}
                    {p.validStart
                      ? <span>{p.validStart.toLocaleDateString(LOCALE,{day:"2-digit",month:"2-digit"})} → {p.validEnd.toLocaleDateString(LOCALE,{day:"2-digit",month:"2-digit"})}{!active?t.wheelAvailableByPurchase:""}</span>
                      : <span>{t.wheelPermanent}</span>}
                  </div>
                ) : (
                  <div style={{fontSize:9,color:C.mut,marginTop:2}}>{t.wheelTryAgainSoon}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Composant réutilisable : ligne de lot gagné ──────────────────────────────
function EarnedPrizeRow({ emoji, label, color, info, status, gift=false }) {
  const {C,t} = useApp();
  return (
    <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px",background:C.sur,borderRadius:10,
      border:`1.5px solid ${gift?color+"55":C.bor}`}}>
      <div style={{width:36,height:36,borderRadius:10,background:`${color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0,position:"relative"}}>
        {emoji}
        {gift && <span style={{position:"absolute",top:-4,right:-4,fontSize:11}}>🎁</span>}
      </div>
      <div style={{flex:1}}>
        <div style={{fontSize:13,fontWeight:800,color}}>{label}</div>
        <div style={{fontSize:11,color:C.mut}}>{gift?t.wheelGiftFromAdult:""}{info}</div>
      </div>
      <span style={{marginLeft:"auto",background:`${color}22`,color,borderRadius:8,padding:"2px 8px",fontSize:10,fontWeight:800,flexShrink:0}}>{status}</span>
    </div>
  );
}

// ─── CADEAU : achat de lots pour les enfants ──────────────────────────────────
// Lots achetables (hors prizes d'abonnement réservés au souscripteur)
const PURCHASABLE_PRIZES = [
  { id:"theme",   label:"Thème Été 26",             labelKey:"shopTheme",   emoji:"🌴", color:"#3ecf8e", price:0.49, validStart:SUMMER_START, validEnd:SUMMER_END  },
  { id:"video",   label:"Thème Jeu Vidéo",           labelKey:"shopVideo",   emoji:"🎮", color:"#7c6fcd", price:0.29, validStart:null, validEnd:null               },
  { id:"licorne", label:"Thème Licorne",             labelKey:"shopLicorne", emoji:"🦄", color:"#ec4899", price:0.29, validStart:null, validEnd:null               },
  { id:"rg",      label:"Thème Tennis France 26",    labelKey:"shopRG",      emoji:"🎾", color:"#c2745a", price:0.99, validStart:RG_START,    validEnd:RG_END       },
  { id:"wc",      label:"Thème Coupe du Monde 26",   labelKey:"shopWC",      emoji:"⚽", color:"#2563eb", price:0.99, validStart:WC_START,    validEnd:WC_END       },
];

function GiftShopSection() {
  const {C, t, lang, sub, setSub, users, user} = useApp();
  const LOCALE = {fr:"fr-FR",en:"en-GB",de:"de-DE",es:"es-ES",pt:"pt-PT"}[lang] || "fr-FR";
  const [step, setStep]     = useState("idle"); // idle | selectTarget | selectChild | confirm | success
  const [selPrize, setSelPrize] = useState(null);
  const [selChild, setSelChild] = useState(null);
  const [forSelf, setForSelf]   = useState(false);
  const [paying, setPaying]     = useState(false);

  const childUsers   = (users||[]).filter(u => u.role === "child");
  const giftedPrizes = sub.giftedPrizes || {};

  function prizeAlreadyGifted(prizeId, childId) {
    return !!(giftedPrizes[String(childId)]?.[prizeId]);
  }
  function prizeOwnedBySelf(prizeId) {
    return !!(sub[`earned_${prizeId}`] || sub[`earnedSelf_${prizeId}`]);
  }

  function startBuy(prize) {
    setSelPrize(prize);
    setSelChild(null);
    setForSelf(false);
    setStep("selectTarget");
  }

  function confirmPurchase() {
    if(!selPrize) return;
    setPaying(true);
    setTimeout(() => {
      if(forSelf) {
        setSub(s => ({ ...s, [`earnedSelf_${selPrize.id}`]: true }));
      } else {
        if(!selChild) return;
        const cid = String(selChild.id);
        setSub(s => ({
          ...s,
          giftedPrizes: {
            ...(s.giftedPrizes||{}),
            [cid]: { ...(s.giftedPrizes?.[cid]||{}), [selPrize.id]: true },
          }
        }));
      }
      setPaying(false);
      setStep("success");
    }, 1400);
  }

  function reset() { setStep("idle"); setSelPrize(null); setSelChild(null); setForSelf(false); }

  return (
    <div className="card" style={{marginBottom:14,border:`1.5px solid ${C.vio}33`}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{width:32,height:32,borderRadius:10,background:"linear-gradient(135deg,#FFD700,#ff9f43)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17}}>🎨</div>
        <div>
          <div style={{fontSize:14,fontWeight:900,color:C.txt}}>{t.giftShopTitle}</div>
          <div style={{fontSize:10,color:C.mut}}>{t.giftShopSubtitle}</div>
        </div>
      </div>

      {/* STEP: idle — grille des lots */}
      {step === "idle" && (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {PURCHASABLE_PRIZES.map(p => {
            const ownedSelf   = prizeOwnedBySelf(p.id);
            const allGifted   = childUsers.length > 0 && childUsers.every(ch => prizeAlreadyGifted(p.id, ch.id));
            const fullyOwned  = ownedSelf && (childUsers.length === 0 || allGifted);
            return (
              <button key={p.id} onClick={()=>!fullyOwned&&startBuy(p)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",
                  background:fullyOwned?C.sur:`${p.color}10`,borderRadius:12,
                  border:`1.5px solid ${fullyOwned?C.bor:p.color+"44"}`,
                  cursor:fullyOwned?"default":"pointer",textAlign:"left"}}>
                <div style={{width:36,height:36,borderRadius:10,background:`${p.color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{p.emoji}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:800,color:fullyOwned?C.mut:p.color}}>{t[p.labelKey]||p.label}</div>
                  <div style={{fontSize:10,color:C.mut,marginTop:1}}>
                    {p.validStart
                      ? `${p.validStart.toLocaleDateString(LOCALE,{day:"2-digit",month:"2-digit"})} → ${p.validEnd.toLocaleDateString(LOCALE,{day:"2-digit",month:"2-digit"})}${t.giftShopPermanentAfterPurchase}`
                      : t.wheelPermanent}
                  </div>
                </div>
                {fullyOwned
                  ? <span style={{background:C.sur,color:C.mut,borderRadius:8,padding:"3px 9px",fontSize:11,fontWeight:700,flexShrink:0}}>{t.giftShopObtained}</span>
                  : <span style={{background:`${p.color}22`,color:p.color,borderRadius:8,padding:"3px 9px",fontSize:12,fontWeight:900,flexShrink:0}}>{p.price.toFixed(2)} €</span>
                }
              </button>
            );
          })}
        </div>
      )}

      {/* STEP: selectTarget — pour moi ou pour un enfant */}
      {step === "selectTarget" && selPrize && (
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,padding:"10px 12px",background:`${selPrize.color}10`,borderRadius:12,border:`1.5px solid ${selPrize.color}44`}}>
            <span style={{fontSize:24}}>{selPrize.emoji}</span>
            <div>
              <div style={{fontSize:13,fontWeight:800,color:selPrize.color}}>{t[selPrize.labelKey]||selPrize.label}</div>
              <div style={{fontSize:11,color:C.mut}}>{selPrize.price.toFixed(2)} € · {t.wheelPermanent}</div>
            </div>
          </div>
          <div style={{fontSize:12,fontWeight:700,color:C.mut,marginBottom:10}}>{t.giftShopThemeFor}</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
            {/* Pour moi */}
            <button onClick={()=>{setForSelf(true);setSelChild(null);setStep("confirm");}}
              disabled={prizeOwnedBySelf(selPrize.id)}
              style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",
                background:prizeOwnedBySelf(selPrize.id)?C.sur:`${selPrize.color}12`,
                borderRadius:12,border:`1.5px solid ${prizeOwnedBySelf(selPrize.id)?C.bor:selPrize.color+"55"}`,
                opacity:prizeOwnedBySelf(selPrize.id)?0.5:1,
                cursor:prizeOwnedBySelf(selPrize.id)?"default":"pointer",textAlign:"left"}}>
              <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${C.vio},${C.blu})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🙋</div>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:800,color:prizeOwnedBySelf(selPrize.id)?C.mut:C.txt}}>{t.giftShopForMe}</div>
                <div style={{fontSize:10,color:C.mut}}>{t.giftShopActivateOnMyAccount}</div>
              </div>
              {prizeOwnedBySelf(selPrize.id)
                ? <span style={{fontSize:10,color:C.mut,fontWeight:700}}>{t.giftShopAlreadyOwned}</span>
                : <span style={{fontSize:16,color:selPrize.color}}>→</span>}
            </button>
            {/* Pour un enfant */}
            {childUsers.length > 0 && (
              <button onClick={()=>{setForSelf(false);setSelChild(childUsers.length===1?childUsers[0]:null);setStep("selectChild");}}
                style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",
                  background:`${selPrize.color}12`,borderRadius:12,
                  border:`1.5px solid ${selPrize.color}55`,
                  cursor:"pointer",textAlign:"left"}}>
                <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,#FFD700,#ff9f43)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🎁</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:800,color:C.txt}}>{t.giftShopGiftToChild}</div>
                  <div style={{fontSize:10,color:C.mut}}>{t.giftShopChildUnlocks}</div>
                </div>
                <span style={{fontSize:16,color:selPrize.color}}>→</span>
              </button>
            )}
          </div>
          <button onClick={reset} style={{width:"100%",padding:"9px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontSize:13,fontWeight:700}}>{t.cancel||"Annuler"}</button>
        </div>
      )}

      {/* STEP: selectChild */}
      {step === "selectChild" && selPrize && (
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,padding:"10px 12px",background:`${selPrize.color}10`,borderRadius:12,border:`1.5px solid ${selPrize.color}44`}}>
            <span style={{fontSize:24}}>{selPrize.emoji}</span>
            <div>
              <div style={{fontSize:13,fontWeight:800,color:selPrize.color}}>{t[selPrize.labelKey]||selPrize.label}</div>
              <div style={{fontSize:11,color:C.mut}}>{selPrize.price.toFixed(2)} € · {t.giftShopForChildLabel}</div>
            </div>
          </div>
          <div style={{fontSize:12,fontWeight:700,color:C.mut,marginBottom:8}}>{t.giftShopWhichChild}</div>
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
            {childUsers.map(ch => {
              const alreadyGifted = prizeAlreadyGifted(selPrize.id, ch.id);
              return (
                <button key={ch.id} onClick={()=>!alreadyGifted&&setSelChild(ch)}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",
                    background:selChild?.id===ch.id?`${selPrize.color}18`:C.sur,
                    borderRadius:10,border:`1.5px solid ${selChild?.id===ch.id?selPrize.color:alreadyGifted?C.bor+"88":C.bor}`,
                    opacity:alreadyGifted?0.45:1,cursor:alreadyGifted?"default":"pointer",textAlign:"left"}}>
                  <div style={{width:32,height:32,borderRadius:"50%",background:`linear-gradient(135deg,${C.grn},${C.blu})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🧒</div>
                  <div style={{flex:1,fontSize:13,fontWeight:700,color:alreadyGifted?C.mut:C.txt}}>{ch.name}</div>
                  {alreadyGifted
                    ? <span style={{fontSize:10,color:C.mut,fontWeight:700}}>{t.giftShopAlreadyGifted}</span>
                    : selChild?.id===ch.id&&<span style={{fontSize:16}}>✓</span>}
                </button>
              );
            })}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setStep("selectTarget")} style={{flex:1,padding:"10px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontSize:13,fontWeight:700}}>{t.giftShopBack}</button>
            <button onClick={()=>selChild&&setStep("confirm")} disabled={!selChild}
              style={{flex:2,padding:"10px",background:selChild?`linear-gradient(135deg,${selPrize.color},${selPrize.color}cc)`:"#ccc",
                color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:800,
                opacity:selChild?1:0.5,cursor:selChild?"pointer":"default"}}>
              {t.giftShopContinue}
            </button>
          </div>
        </div>
      )}

      {/* STEP: confirm */}
      {step === "confirm" && selPrize && (
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:36,marginBottom:8}}>{selPrize.emoji}</div>
          <div style={{fontSize:15,fontWeight:900,color:selPrize.color,marginBottom:4}}>{t[selPrize.labelKey]||selPrize.label}</div>
          <div style={{fontSize:13,color:C.mut,marginBottom:2}}>
            {forSelf ? t.giftShopForYourAccount : <>{t.giftShopForPrefix} <strong style={{color:C.txt}}>{selChild?.name}</strong></>}
          </div>
          <div style={{fontSize:12,color:C.mut,marginBottom:16}}>{t.giftShopUnlockedPermanently}</div>
          <div style={{background:C.sur,borderRadius:12,padding:"12px 14px",marginBottom:16,border:`1.5px solid ${C.bor}`,textAlign:"left"}}>
            <div style={{fontSize:10,fontWeight:800,color:C.mut,letterSpacing:".08em",textTransform:"uppercase",marginBottom:8}}>{t.giftShopSimulatedPayment}</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,color:C.txt}}>{t[selPrize.labelKey]||selPrize.label}</span>
              <span style={{fontSize:14,fontWeight:900,color:selPrize.color}}>{selPrize.price.toFixed(2)} €</span>
            </div>
            <div style={{marginTop:8,padding:"6px 10px",background:`${selPrize.color}12`,borderRadius:8,fontSize:10,color:C.mut}}>
              {t.giftShopProdNote}
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setStep(forSelf?"selectTarget":"selectChild")} style={{flex:1,padding:"10px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontSize:13,fontWeight:700}}>{t.giftShopBack}</button>
            <button onClick={confirmPurchase} disabled={paying}
              style={{flex:2,padding:"10px",background:paying?"#ccc":`linear-gradient(135deg,${selPrize.color},${selPrize.color}bb)`,
                color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:900,cursor:paying?"default":"pointer"}}>
              {paying ? t.giftShopProcessing : `${t.giftShopPayPrefix} ${selPrize.price.toFixed(2)} €`}
            </button>
          </div>
        </div>
      )}

      {/* STEP: success */}
      {step === "success" && selPrize && (
        <div style={{textAlign:"center",padding:"8px 0"}}>
          <div style={{fontSize:48,marginBottom:8}}>🎉</div>
          <div style={{fontSize:16,fontWeight:900,color:selPrize.color,marginBottom:4}}>
            {(t[selPrize.labelKey]||selPrize.label)}{forSelf ? t.giftShopActivatedSuffix : t.giftShopGiftedSuffix}
          </div>
          <div style={{fontSize:13,color:C.mut,marginBottom:16}}>
            {forSelf
              ? t.giftShopActiveOnAccount
              : <><strong style={{color:C.txt}}>{selChild?.name}</strong>{t.giftShopChildHasAccess}</>
            }
          </div>
          <button onClick={reset} style={{padding:"10px 28px",background:`linear-gradient(135deg,${selPrize.color},${selPrize.color}bb)`,color:"#fff",borderRadius:50,fontSize:13,fontWeight:800,border:"none"}}>
            {t.giftShopBuyAnother}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── GAME TAB ────────────────────────────────────────────────────────────────
function GameTab() {
  const {C,t,sub,setSub,prem,onUpgrade,st,isChild,isObs,isAdm,user,videoActive} = useApp();
  const isPremium = prem; // trial_premium + premium peuvent jouer (freemium : non)
  // Rôle du joueur
  const isParent  = user?.role === "parent";
  const isSubscriber = isParent && (user?.parentIdx === 0); // Parent souscripteur (parentIdx 0)
  const isAdult   = (isParent || isObs) && !isAdm; // adulte non-admin
  const restrictedRole = (isChild || isObs) && !isAdm; // roue sans gains d'abonnement
  const cooldownLabel = (isChild||isObs) ? t.cooldown2days : t.cooldown7days;
  const userId = String(user?.id || "");

  // Lots cadeaux reçus par cet enfant (si le joueur est un enfant)
  const myGifted = isChild ? (sub.giftedPrizes?.[userId] || {}) : {};

  return (
    <div className="fi">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontSize:16,fontWeight:900,background:"linear-gradient(135deg,#FFD700,#ff6bb5,#7c6fcd)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{t.wheelTitle}</div>
          <div style={{fontSize:11,color:C.mut}}>{restrictedRole ? `${t.wheelTabSubFunPrefix} ${cooldownLabel}` : `${t.wheelTabSubPremiumPrefix} ${cooldownLabel} ${t.wheelTabSubPremiumSuffix}`}</div>
        </div>
      </div>

      {/* Lock banner for freemium (not shown for restricted roles or trial users) */}
      {!prem && !restrictedRole && (
        <div onClick={onUpgrade} style={{cursor:"pointer",background:`linear-gradient(135deg,${C.vio}22,${C.blu}22)`,border:`2px dashed ${C.vio}`,borderRadius:14,padding:"20px",textAlign:"center",marginBottom:16}}>
          <div style={{fontSize:36,marginBottom:8}}>🔒</div>
          <div style={{fontWeight:900,fontSize:15,color:C.vio,marginBottom:6}}>{t.wheelPremiumFeature}</div>
          <div style={{fontSize:12,color:C.mut,marginBottom:14,lineHeight:1.6}}>
            {t.wheelPremiumDescLine1}<br/>{t.wheelPremiumDescLine2}
          </div>
          <button style={{padding:"11px 28px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:14,fontWeight:800,borderRadius:50}}>
            {t.wheelGoPremium}
          </button>
        </div>
      )}

      {/* Wheel game */}
      <div className="card" style={{marginBottom:14,borderColor:`${C.vio}44`,padding:"20px 14px"}}>
        <WheelGame
          isPremium={prem || restrictedRole}
          isAdmin={sub._admin||false}
          restrictedRole={restrictedRole}
          userId={userId}
          isSubscriber={isSubscriber}
          isParent={isParent || isAdm}
        />
      </div>

      {/* 🎁 Boutique cadeaux — visible pour les adultes Premium (parents + observateurs) */}
      {(prem || isAdm) && (isParent || isObs || isAdm) && !isChild && (
        <GiftShopSection />
      )}

      {/* Earned rewards showcase — lots gagnés à la roue + cadeaux reçus */}
      {(sub.earnedTheme||sub.earnedVideo||sub.earnedLicorne||sub.earnedRG||sub.earnedWC||sub.earnedBadge
        ||myGifted.theme||myGifted.video||myGifted.licorne||myGifted.rg||myGifted.wc) && (
        <div className="card" style={{marginBottom:14}}>
          <div className="sec">{isChild ? t.wheelMyPrizesChild : t.wheelMyPrizesAdult}</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {/* Legacy badge */}
            {sub.earnedBadge && !isChild && (
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px",background:C.sur,borderRadius:10,border:`1.5px solid ${C.bor}`}}>
                <div style={{width:36,height:36,borderRadius:10,background:"#7c6fcd22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>🏅</div>
                <div><div style={{fontSize:13,fontWeight:800,color:"#7c6fcd"}}>{t.wheelExclusiveBadge}</div>
                <div style={{fontSize:11,color:C.mut}}>{t.wheelComingSoonProfile}</div></div>
                <span style={{marginLeft:"auto",background:"#7c6fcd22",color:"#7c6fcd",borderRadius:8,padding:"2px 8px",fontSize:10,fontWeight:800}}>{t.wheelWon}</span>
              </div>
            )}
            {(sub.earnedTheme||myGifted.theme) && (() => {
              const g = !!myGifted.theme;
              return <EarnedPrizeRow emoji="🌴" label={t.shopTheme} color="#3ecf8e"
                info={g||isSummerPeriod()?t.wheelActivateViaMenu:t.wheelActivatableSummer}
                status={g||isSummerPeriod()?t.wheelActive:t.wheelPendingStatus} gift={g} />;
            })()}
            {(sub.earnedVideo||myGifted.video) && (() => {
              const g = !!myGifted.video;
              return <EarnedPrizeRow emoji="🎮" label={t.shopVideo} color="#8b5cf6"
                info={videoActive?t.wheelVideoActiveInfo:t.wheelActivateViaButton} status={videoActive?t.wheelActiveCheck:t.wheelApply} gift={g} />;
            })()}
            {(sub.earnedLicorne||myGifted.licorne) && (() => {
              const g = !!myGifted.licorne;
              return <EarnedPrizeRow emoji="🦄" label={t.shopLicorne} color="#ec4899"
                info={t.wheelActivateViaMenu} status={t.wheelActive} gift={g} />;
            })()}
            {(sub.earnedRG||myGifted.rg) && (() => {
              const g = !!myGifted.rg;
              return <EarnedPrizeRow emoji="🎾" label={t.shopRG} color="#c2745a"
                info={g||isRGPeriod()?t.wheelActivateViaMenu:t.wheelActivatableRG}
                status={g||isRGPeriod()?t.wheelActive:t.wheelPendingStatus} gift={g} />;
            })()}
            {(sub.earnedWC||myGifted.wc) && (() => {
              const g = !!myGifted.wc;
              return <EarnedPrizeRow emoji="⚽" label={t.shopWC} color="#2563eb"
                info={g||isWCPeriod()?t.wheelActivateViaMenu:t.wheelActivatableWC}
                status={g||isWCPeriod()?t.wheelActive:t.wheelPendingStatus} gift={g} />;
            })()}
          </div>
        </div>
      )}

    </div>
  );
}

// ─── GAME TAB END ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// VAULT TAB — Coffre-fort de documents
// ═══════════════════════════════════════════════════════════════════════════════
function VaultTab() {
  const { C, t, cfg, setCfg, user, prem, perms, onUpgrade, isObs, setActivity, addRefAction, sub, familySync } = useApp();
  const premFull = isPremFull(sub);

  // Identité cloud de la personne connectée (nécessaire pour savoir qui a uploadé quoi)
  const [uid, setUid] = useState(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUid(data?.user?.id || null));
  }, []);

  const { docs, loading: vaultLoading, error: vaultError, addDoc, updateDoc, togglePin: toggleVaultPin, removeDoc, openDoc } =
    useVault(familySync.familyId, uid);

  // Taille totale utilisée (en octets)
  const totalSizeBytes = useMemo(() =>
    docs.reduce((sum, d) => sum + (d.file_size || 0), 0),
  [docs]);
  const VAULT_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 Go
  const totalSizeMB = (totalSizeBytes / (1024 * 1024)).toFixed(1);
  const totalSizeGB = (totalSizeBytes / (1024 * 1024 * 1024)).toFixed(2);

  // Helper : si le doc a été ajouté par un parent supprimé
  function resolveAddedBy(name) {
    const deleted = (cfg.deletedParents||[]).find(d => d.name === name);
    return deleted
      ? { label:`${t.vaultDeletedParent||"Parent supprimé —"} ${name}`, deleted:true }
      : { label:name, deleted:false };
  }
  const [showForm, setShowForm] = useState(false);
  const [editDoc, setEditDoc] = useState(null);
  const [savingDoc, setSavingDoc] = useState(false);
  const [filterCat, setFilterCat] = useState("all");
  const [search, setSearch] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewUrlLoading, setPreviewUrlLoading] = useState(false);

  // Le fichier n'est plus en base64 dans le doc : on demande une URL
  // temporaire à Supabase Storage chaque fois qu'on ouvre l'aperçu.
  useEffect(() => {
    if (!previewDoc?.storage_path) { setPreviewUrl(null); return; }
    let cancelled = false;
    setPreviewUrlLoading(true);
    openDoc(previewDoc.storage_path)
      .then((url) => { if (!cancelled) setPreviewUrl(url); })
      .catch(() => { if (!cancelled) setPreviewUrl(null); })
      .finally(() => { if (!cancelled) setPreviewUrlLoading(false); });
    return () => { cancelled = true; };
  }, [previewDoc, openDoc]);

  const [showCatMenu, setShowCatMenu] = useState(false);
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  useEffect(() => {
    if (!showCatMenu && !showFilterMenu) return;
    const close = () => { setShowCatMenu(false); setShowFilterMenu(false); };
    const t2 = setTimeout(() => document.addEventListener("click", close), 0);
    return () => { clearTimeout(t2); document.removeEventListener("click", close); };
  }, [showCatMenu, showFilterMenu]);

  // Form state
  const [formName, setFormName] = useState("");
  const [shakeDocName, setShakeDocName] = useState(false);
  function _triggerShakeDocName(){ setShakeDocName(true); setTimeout(()=>setShakeDocName(false),600); }
  const [formCat, setFormCat] = useState(0);
  const [formDate, setFormDate] = useState(toStr(new Date()));
  const [formNotes, setFormNotes] = useState("");
  const [formFile, setFormFile] = useState(null); // { name, size, type, dataUrl }
  const [formShared, setFormShared] = useState(true);
  const fileRef = useRef();

  const vaultCats = t.vaultCats || [];

  function openAdd() {
    if (!prem) { onUpgrade(); return; } // Coffre-fort : Premium (y compris Bêta/trial)
    if (totalSizeBytes >= VAULT_MAX_BYTES) {
      alert(`⚠️ Limite de 1 Go atteinte (${totalSizeGB} Go utilisés). Supprimez des fichiers pour en ajouter.`);
      return;
    }
    setEditDoc(null);
    setFormName(""); setFormCat(0);
    setFormDate(toStr(new Date()));
    setFormNotes(""); setFormFile(null); setFormShared(true);
    setShowForm(true);
  }

  function openEdit(doc) {
    setEditDoc(doc);
    setFormName(doc.name); setFormCat(doc.category_idx||0);
    setFormDate(doc.doc_date||""); setFormNotes(doc.notes||"");
    setFormFile(doc.file_name ? { name: doc.file_name, size: doc.file_size, type: doc.mime_type, existing: true } : null);
    setFormShared(doc.shared!==false);
    setShowForm(true);
  }

  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const fileErr = validateVaultFile(f);
    if (fileErr) { alert(fileErr); e.target.value = ""; return; }
    // Vérification limite 1 Go total
    if (totalSizeBytes + f.size > VAULT_MAX_BYTES) {
      alert(`⚠️ Limite de stockage atteinte (1 Go max).\nUtilisé : ${totalSizeGB} Go · Fichier : ${(f.size/1024/1024).toFixed(1)} Mo`);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      // dataUrl = aperçu instantané dans le formulaire uniquement ; rawFile = ce
      // qui sera réellement envoyé à Supabase Storage à l'enregistrement.
      setFormFile({ name: sanitize(f.name).slice(0, LIMITS.DOC_NAME_MAX), size: f.size, type: f.type, dataUrl: ev.target.result, rawFile: f, existing: false });
    };
    reader.readAsDataURL(f);
  }

  async function saveDoc() {
    const cleanDocName = sanitize(formName).slice(0, LIMITS.DOC_NAME_MAX);
    if (!cleanDocName.trim()) return;
    if(!isCleanText(cleanDocName)){ _triggerShakeDocName(); return; }
    const cleanNotes = sanitize(formNotes).slice(0, LIMITS.NOTES_MAX);
    const maxDocs = perms?.maxVaultDocs ?? 5;
    if (!editDoc && docs.length >= maxDocs && maxDocs !== Infinity) { onUpgrade(); return; }
    setSavingDoc(true);
    try {
      if (editDoc) {
        const newFile = (formFile && !formFile.existing) ? formFile.rawFile : null;
        const removeFile = !formFile && !!editDoc.file_name;
        await updateDoc(editDoc.id, {
          name: cleanDocName, category_idx: formCat, doc_date: formDate, notes: cleanNotes, shared: formShared,
        }, newFile, removeFile);
      } else {
        await addDoc({
          name: cleanDocName, categoryIdx: formCat, docDate: formDate, notes: cleanNotes, shared: formShared,
          file: formFile ? formFile.rawFile : null,
        }, user?.name || "?");
        setActivity(a=>({...a,vault:{ts:new Date().toISOString(),by:String(user?.id||"")}}));
        addRefAction("UPLOAD_DOC");
      }
      setShowForm(false);
      setEditDoc(null);
    } catch (e) {
      alert("⚠️ Erreur lors de l'enregistrement du document : " + (e?.message || e));
    } finally {
      setSavingDoc(false);
    }
  }

  async function deleteDoc(id) {
    try {
      await removeDoc(id);
    } catch (e) {
      alert("⚠️ Erreur lors de la suppression : " + (e?.message || e));
    }
    setConfirmDel(null);
    if (previewDoc?.id === id) setPreviewDoc(null);
  }

  function togglePin(id) {
    toggleVaultPin(id).catch(e => alert("⚠️ Erreur : " + (e?.message || e)));
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes/1024).toFixed(1) + " KB";
    return (bytes/1048576).toFixed(1) + " MB";
  }

  const catIcon = (idx) => (vaultCats[idx] || "📝 Autre").split(" ")[0];
  const catLabel = (idx) => (vaultCats[idx] || "Autre").replace(/^[^\s]+ /, "");

  const filtered = docs.filter(d => {
    const matchCat = filterCat === "all" || d.category_idx === parseInt(filterCat);
    const matchSearch = !search || d.name.toLowerCase().includes(search.toLowerCase()) ||
      (d.notes||"").toLowerCase().includes(search.toLowerCase()) ||
      (d.added_by_name||"").toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const pinned = filtered.filter(d => d.pinned);
  const others = filtered.filter(d => !d.pinned);

  // Premium gate
  if (!prem) {
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18,padding:"40px 20px",textAlign:"center"}}>
        <div style={{fontSize:56}}>🗄️</div>
        <div style={{fontSize:18,fontWeight:900,color:C.txt}}>{t.vaultPremLock||"🔒 Coffre-fort — Premium"}</div>
        <div style={{fontSize:13,color:C.mut,maxWidth:280,lineHeight:1.6}}>{t.vaultPremDesc||"Stockez tous vos documents légaux en sécurité."}</div>
        <button onClick={onUpgrade} style={{height:48,padding:"0 28px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:15,fontWeight:800,borderRadius:12}}>
          {t.upgradeCTA||"⭐ Passer Premium"}
        </button>
      </div>
    );
  }

  // Premier chargement (les données viennent du nuage maintenant, plus de localStorage instantané)
  if (vaultLoading && docs.length === 0) {
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,padding:"60px 20px",textAlign:"center"}}>
        <div style={{fontSize:32}}>🗄️</div>
        <div style={{fontSize:13,color:C.mut}}>Chargement du coffre-fort…</div>
      </div>
    );
  }
  if (vaultError) {
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,padding:"60px 20px",textAlign:"center"}}>
        <div style={{fontSize:32}}>⚠️</div>
        <div style={{fontSize:13,color:C.red}}>{vaultError}</div>
      </div>
    );
  }

  // Preview modal
  if (previewDoc) {
    const f = previewDoc.file_name ? { name: previewDoc.file_name, size: previewDoc.file_size, type: previewDoc.mime_type } : null;
    return (
      <div className="fi">
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <button onClick={()=>setPreviewDoc(null)} style={{height:36,padding:"0 14px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>← Retour</button>
          <div style={{flex:1,fontWeight:800,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{previewDoc.name}</div>
        </div>
        <div className="card" style={{marginBottom:12}}>
          <div style={{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap"}}>
            <div style={{width:42,height:42,borderRadius:10,background:`${C.vio}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>
              {catIcon(previewDoc.category_idx)}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:4}}>{previewDoc.name}</div>
              <div style={{fontSize:12,color:C.mut,marginBottom:2}}>{catLabel(previewDoc.category_idx)} · {previewDoc.doc_date}</div>
              {previewDoc.notes && <div style={{fontSize:12,color:C.txt,marginTop:6,lineHeight:1.5,whiteSpace:"pre-wrap"}}>{previewDoc.notes}</div>}
              <div style={{fontSize:11,color:C.mut,marginTop:8}}>
                {t.vaultAddedBy||"Ajouté par"}: {(() => { const r=resolveAddedBy(previewDoc.added_by_name); return <b style={{color:r.deleted?C.red:undefined}}>{r.label}</b>; })()}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
            {!isObs && (
              <button onClick={()=>{ setPreviewDoc(null); openEdit(previewDoc); }} style={{padding:"7px 14px",background:`${C.vio}22`,color:C.vio,border:`1.5px solid ${C.vio}`,fontSize:12,fontWeight:700,borderRadius:8}}>
                ✎ {t.vaultEdit||"Modifier"}
              </button>
            )}
            {!isObs && (
              <button onClick={()=>setConfirmDel(previewDoc.id)} style={{padding:"7px 14px",background:`${C.red}15`,color:C.red,border:`1.5px solid ${C.red}44`,fontSize:12,fontWeight:700,borderRadius:8}}>
                🗑 {t.vaultDelete||"Supprimer"}
              </button>
            )}
          </div>
        </div>
        {f && (
          <div className="card">
            <div style={{fontSize:11,fontWeight:800,color:C.mut,marginBottom:12,letterSpacing:".08em",textTransform:"uppercase"}}>{t.vaultFileInfo||"Infos fichier"}</div>
            <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:32}}>{f.type?.includes("pdf") ? "📄" : f.type?.includes("image") ? "🖼️" : "📎"}</div>
              <div>
                <div style={{fontSize:13,fontWeight:700}}>{f.name}</div>
                <div style={{fontSize:11,color:C.mut}}>{f.type} · {formatSize(f.size)}</div>
              </div>
            </div>
            {previewUrlLoading && (
              <div style={{textAlign:"center",padding:16,fontSize:12,color:C.mut}}>Chargement du fichier…</div>
            )}
            {previewUrl && f.type?.startsWith("image") && (
              <img src={previewUrl} alt={f.name} style={{width:"100%",maxHeight:280,objectFit:"contain",borderRadius:10,border:`1.5px solid ${C.bor}`,marginBottom:10}} />
            )}
            {previewUrl && f.type?.includes("pdf") && (
              <div style={{background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:10,padding:12,marginBottom:10,fontSize:12,color:C.mut,textAlign:"center"}}>
                📄 Aperçu PDF non disponible dans l'app
              </div>
            )}
            {previewUrl && (
              <a href={previewUrl} download={f.name} target="_blank" rel="noreferrer" style={{display:"block",padding:"9px 0",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:13,fontWeight:700,borderRadius:10,textAlign:"center",textDecoration:"none"}}>
                ⬇️ {t.vaultDownload||"Télécharger"}
              </a>
            )}
          </div>
        )}
        {confirmDel && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <div style={{background:C.card,borderRadius:16,padding:24,maxWidth:320,width:"100%",textAlign:"center",border:`1.5px solid ${C.bor}`}}>
              <div style={{fontSize:32,marginBottom:10}}>🗑️</div>
              <div style={{fontSize:15,fontWeight:800,marginBottom:8}}>{t.vaultConfirmDel||"Supprimer ce document ?"}</div>
              <div style={{display:"flex",gap:10,marginTop:18}}>
                <button onClick={()=>setConfirmDel(null)} style={{flex:1,padding:"10px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontWeight:700}}>{t.vaultCancel||"Annuler"}</button>
                <button onClick={()=>deleteDoc(confirmDel)} style={{flex:1,padding:"10px",background:C.red,color:"#fff",fontWeight:800}}>🗑 {t.vaultDelete||"Supprimer"}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Add/edit form
  if (showForm) {
    return (
      <div className="fi">
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <button onClick={()=>{setShowForm(false);setEditDoc(null);}} style={{height:36,padding:"0 14px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:12,borderRadius:8}}>← {t.vaultCancel||"Annuler"}</button>
          <div style={{fontWeight:800,fontSize:14}}>{editDoc ? "✎ "+t.vaultEdit : "➕ "+t.vaultAdd}</div>
        </div>
        <div className="card" style={{display:"flex",flexDirection:"column",gap:14}}>
          <div className="field">
            <label className="lbl">{t.vaultName||"Nom du document"} *</label>
            <input value={formName} onChange={e=>setFormName(e.target.value)} placeholder="ex : Jugement du 12/03/2023" className={shakeDocName?"duvia-shake":""} />
          </div>
          <div className="row" style={{alignItems:"stretch"}}>
            <div className="field" style={{flex:2,position:"relative",marginBottom:0}}>
              <label className="lbl">{t.vaultCat||"Catégorie"}</label>
              <button onClick={()=>setShowCatMenu(v=>!v)} style={{width:"100%",height:44,padding:"0 12px",background:C.inp,border:`1.5px solid ${showCatMenu?C.vio:C.bor}`,color:C.txt,borderRadius:10,fontSize:13,textAlign:"left",display:"flex",alignItems:"center",gap:8,fontWeight:600,justifyContent:"space-between",boxSizing:"border-box"}}>
                <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{vaultCats[formCat]||"—"}</span>
                <span style={{fontSize:10,color:C.mut,flexShrink:0}}>{showCatMenu?"▲":"▼"}</span>
              </button>
              {showCatMenu && (
                <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:C.card,border:`1.5px solid ${C.vio}`,borderRadius:14,zIndex:50,overflow:"hidden",boxShadow:"0 8px 24px rgba(0,0,0,.18)"}}>
                  {vaultCats.map((c,i)=>(
                    <button key={i} onClick={()=>{setFormCat(i);setShowCatMenu(false);}}
                      style={{width:"100%",height:44,padding:"0 14px",background:i===formCat?`${C.vio}18`:"transparent",color:i===formCat?C.vio:C.txt,textAlign:"left",fontSize:13,fontWeight:i===formCat?800:600,display:"flex",alignItems:"center",gap:8,borderBottom:i<vaultCats.length-1?`1px solid ${C.bor}`:"none",borderRadius:0,transition:"background .1s"}}>
                      <span style={{fontSize:17,width:24,textAlign:"center"}}>{c.split(" ")[0]}</span>
                      <span>{c.replace(/^[^\s]+ /,"")}</span>
                      {i===formCat && <span style={{marginLeft:"auto",fontSize:12}}>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="field" style={{flex:1,marginBottom:0}}>
              <label className="lbl">{t.vaultDate||"Date"}</label>
              <input type="date" value={formDate} onChange={e=>setFormDate(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="lbl">{t.vaultNotes||"Notes"}</label>
            <textarea value={formNotes} onChange={e=>setFormNotes(e.target.value)}
              placeholder="ex : Version signée par les deux parties..."
              style={{background:C.inp,border:`1.5px solid ${C.bor}`,color:C.txt,borderRadius:10,padding:"11px 13px",fontFamily:"inherit",fontSize:14,width:"100%",outline:"none",resize:"vertical",minHeight:72}} />
          </div>
          <div className="field">
            <label className="lbl">{t.vaultUploadLabel||"Fichier (PDF, image)"}</label>
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
              <button onClick={()=>fileRef.current?.click()} style={{height:44,padding:"0 14px",background:`${C.vio}18`,color:C.vio,border:`1.5px solid ${C.vio}66`,fontSize:12,fontWeight:700,borderRadius:10,flexShrink:0}}>
                📎 {t.vaultUploadBtn||"Choisir un fichier"}
              </button>
              <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp" style={{display:"none"}} onChange={handleFile} />
              {formFile ? (
                <div style={{display:"flex",alignItems:"center",gap:6,flex:1,minWidth:0}}>
                  <span style={{fontSize:16}}>{formFile.type?.includes("pdf") ? "📄" : "🖼️"}</span>
                  <span style={{fontSize:12,color:C.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{formFile.name}</span>
                  <span style={{fontSize:10,color:C.mut,flexShrink:0}}>({formatSize(formFile.size)})</span>
                  <button onClick={()=>setFormFile(null)} style={{width:24,height:24,background:`${C.red}18`,color:C.red,border:"none",fontSize:12,borderRadius:6,flexShrink:0,padding:0}}>×</button>
                </div>
              ) : (
                <span style={{fontSize:12,color:C.mut}}>{t.vaultNoFile||"Aucun fichier"}</span>
              )}
            </div>
          </div>
          <label style={{display:"flex",alignItems:"center",gap:10,padding:"12px",background:C.sur,borderRadius:10,border:`1.5px solid ${C.bor}`,cursor:"pointer"}}>
            <input type="checkbox" checked={formShared} onChange={e=>setFormShared(e.target.checked)} />
            <div>
              <div style={{fontSize:12,fontWeight:700,color:C.txt}}>👥 {t.vaultShared||"Visible QUE par les parents"}</div>
              {cfg.parents?.length > 0 && (
                <div style={{fontSize:11,color:C.mut,marginTop:2}}>
                  {cfg.parents.map(p=>p.name||"Parent").join(", ")}
                </div>
              )}
            </div>
          </label>
          <button onClick={saveDoc} disabled={!formName.trim() || savingDoc} style={{height:50,background:(formName.trim()&&!savingDoc)?`linear-gradient(135deg,${C.vio},${C.blu})`:`${C.bor}`,color:(formName.trim()&&!savingDoc)?"#fff":C.mut,fontSize:15,fontWeight:800,borderRadius:12,cursor:(formName.trim()&&!savingDoc)?"pointer":"not-allowed",transition:"all .2s"}}>
            {savingDoc ? "⏳ Envoi…" : <>✓ {t.vaultSave||"Enregistrer"}</>}
          </button>
        </div>
      </div>
    );
  }

  // Main list
  const DocCard = ({doc}) => (
    <div style={{background:C.card,border:`1.5px solid ${doc.pinned?C.vio:C.bor}`,borderRadius:14,padding:"12px 14px",marginBottom:10,cursor:"pointer",transition:"all .15s",borderLeft:doc.pinned?`4px solid ${C.vio}`:undefined}}
      onClick={()=>setPreviewDoc(doc)}>
      <div style={{display:"flex",gap:12,alignItems:"center"}}>
        <div style={{width:40,height:40,borderRadius:10,background:`${C.vio}18`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>
          {catIcon(doc.category_idx)}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:14,fontWeight:800,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.name}</div>
          <div style={{fontSize:11,color:C.mut,marginTop:2}}>{catLabel(doc.category_idx)}{doc.doc_date ? " · " + doc.doc_date : ""}</div>
          {doc.notes && <div style={{fontSize:11,color:C.mut,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.notes}</div>}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"center",flexShrink:0}}>
          {doc.file_name && <span style={{fontSize:14}}>{doc.mime_type?.includes("pdf")?"📄":"🖼️"}</span>}
          {doc.shared && <span style={{fontSize:11,color:C.mut}}>👥</span>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="fi">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div>
          <div style={{fontSize:16,fontWeight:900}}>🗄️ {t.vaultTitle||"Coffre-fort"}</div>
          <div style={{fontSize:11,color:C.mut}}>{t.vaultSub||"Documents importants de la famille"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <InfoBubble C={C} tipKey={`duvia_vaulttip_${user?.id||"x"}`} title={t.vaultTitle||"Coffre-fort"}>
            {t.vaultTipBody||"Conservez ici les documents importants de la famille (jugements, médical, scolaire…). Réservé aux abonnés Premium. Limite : 1 Go de stockage total."}
          </InfoBubble>
        </div>
      </div>

      {/* Jauge de stockage — uniquement si full Premium */}
      {prem && (
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.mut,fontWeight:700,marginBottom:4}}>
            <span>Stockage utilisé</span>
            <span>{totalSizeBytes < 1024*1024 ? `${(totalSizeBytes/1024).toFixed(0)} Ko` : totalSizeGB + " Go"} / 1 Go</span>
          </div>
          <div style={{height:6,background:C.bor,borderRadius:4,overflow:"hidden"}}>
            <div style={{
              height:"100%",
              width:`${Math.min(100,(totalSizeBytes/VAULT_MAX_BYTES)*100)}%`,
              background:totalSizeBytes/VAULT_MAX_BYTES>0.9?C.red:totalSizeBytes/VAULT_MAX_BYTES>0.7?C.ora:C.vio,
              borderRadius:4,transition:"width .4s ease"
            }}/>
          </div>
          {totalSizeBytes/VAULT_MAX_BYTES>0.9&&(
            <div style={{fontSize:10,color:C.red,fontWeight:700,marginTop:4}}>⚠️ Stockage presque plein</div>
          )}
        </div>
      )}

      {/* Search + filter */}
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t.vaultSearch||"Rechercher…"}
          style={{flex:1,minWidth:0}} />
        <div style={{position:"relative",flexShrink:0}}>
          <button onClick={()=>setShowFilterMenu(v=>!v)}
            style={{height:44,padding:"0 14px",background:filterCat!=="all"?`${C.vio}18`:C.inp,border:`1.5px solid ${filterCat!=="all"?C.vio:C.bor}`,color:filterCat!=="all"?C.vio:C.txt,borderRadius:10,fontSize:13,display:"flex",alignItems:"center",gap:6,fontWeight:600,whiteSpace:"nowrap"}}>
            <span>{filterCat==="all" ? (t.vaultAll||"Tous") : vaultCats[parseInt(filterCat)]?.split(" ")[0]||"🗂️"}</span>
            <span style={{fontSize:10,color:C.mut}}>{showFilterMenu?"▲":"▼"}</span>
          </button>
          {showFilterMenu && (
            <div style={{position:"absolute",top:"calc(100% + 4px)",right:0,minWidth:220,background:C.card,border:`1.5px solid ${C.vio}`,borderRadius:14,zIndex:50,overflow:"hidden",boxShadow:"0 8px 24px rgba(0,0,0,.22)"}}>
              <button onClick={()=>{setFilterCat("all");setShowFilterMenu(false);}}
                style={{width:"100%",height:44,padding:"0 14px",background:filterCat==="all"?`${C.vio}18`:"transparent",color:filterCat==="all"?C.vio:C.txt,textAlign:"left",fontSize:13,fontWeight:filterCat==="all"?800:600,display:"flex",alignItems:"center",gap:8,borderBottom:`1px solid ${C.bor}`,borderRadius:0}}>
                <span style={{fontSize:17,width:24,textAlign:"center"}}>🗂️</span>
                <span>{t.vaultAll||"Tous"}</span>
                {filterCat==="all" && <span style={{marginLeft:"auto",fontSize:12}}>✓</span>}
              </button>
              {vaultCats.map((c,i)=>(
                <button key={i} onClick={()=>{setFilterCat(String(i));setShowFilterMenu(false);}}
                  style={{width:"100%",height:44,padding:"0 14px",background:filterCat===String(i)?`${C.vio}18`:"transparent",color:filterCat===String(i)?C.vio:C.txt,textAlign:"left",fontSize:13,fontWeight:filterCat===String(i)?800:600,display:"flex",alignItems:"center",gap:8,borderBottom:i<vaultCats.length-1?`1px solid ${C.bor}`:"none",borderRadius:0,transition:"background .1s"}}>
                  <span style={{fontSize:17,width:24,textAlign:"center"}}>{c.split(" ")[0]}</span>
                  <span>{c.replace(/^[^\s]+ /,"")}</span>
                  {filterCat===String(i) && <span style={{marginLeft:"auto",fontSize:12}}>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add button */}
      {!isObs && (
        <button onClick={openAdd} style={{width:"100%",marginBottom:14,height:44,background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:13,fontWeight:800,borderRadius:10}}>
          + {t.vaultAdd?.replace("+ ","")||"Ajouter un document"}
        </button>
      )}

      {/* Stats bar */}
      {docs.length > 0 && (
        <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
          {vaultCats.map((c,i)=>{
            const count = docs.filter(d=>d.category_idx===i).length;
            if (!count) return null;
            return (
              <button key={i} onClick={()=>setFilterCat(filterCat===String(i)?"all":String(i))}
                style={{display:"flex",alignItems:"center",gap:4,padding:"4px 10px",background:filterCat===String(i)?`${C.vio}22`:C.sur,border:`1.5px solid ${filterCat===String(i)?C.vio:C.bor}`,borderRadius:20,fontSize:11,color:filterCat===String(i)?C.vio:C.mut,fontWeight:700,cursor:"pointer"}}>
                <span>{c.split(" ")[0]}</span>
                <span style={{background:filterCat===String(i)?C.vio:C.bor,color:filterCat===String(i)?"#fff":C.txt,borderRadius:"50%",width:16,height:16,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800}}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 && (
        <div style={{textAlign:"center",padding:"48px 20px",color:C.mut}}>
          <div style={{fontSize:44,marginBottom:12}}>🗄️</div>
          <div style={{fontSize:14,fontWeight:700}}>{t.vaultEmpty||"Aucun document enregistré."}</div>
          {!isObs && <div style={{fontSize:12,marginTop:8,opacity:.7}}>Appuyez sur + pour ajouter un premier document</div>}
        </div>
      )}

      {/* Pinned section */}
      {pinned.length > 0 && (
        <div style={{marginBottom:4}}>
          <div style={{fontSize:10,fontWeight:800,color:C.vio,letterSpacing:".1em",textTransform:"uppercase",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
            <span>📌</span> {t.vaultPinned||"Épinglés"}
          </div>
          {pinned.map(doc=>(
            <div key={doc.id} style={{position:"relative"}}>
              <DocCard doc={doc} />
              {!isObs && (
                <button onClick={e=>{e.stopPropagation();togglePin(doc.id);}}
                  style={{position:"absolute",top:10,right:10,padding:"3px 8px",background:`${C.vio}22`,color:C.vio,border:"none",borderRadius:6,fontSize:10,fontWeight:700,zIndex:1}}>
                  {t.vaultUnpin||"Désépingler"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Other docs */}
      {others.length > 0 && (
        <div>
          {pinned.length > 0 && (
            <div style={{fontSize:10,fontWeight:800,color:C.mut,letterSpacing:".1em",textTransform:"uppercase",marginBottom:8,marginTop:4}}>
              {t.vaultOther||"Autres documents"}
            </div>
          )}
          {others.map(doc=>(
            <div key={doc.id} style={{position:"relative"}}>
              <DocCard doc={doc} />
              {!isObs && (
                <button onClick={e=>{e.stopPropagation();togglePin(doc.id);}}
                  style={{position:"absolute",top:10,right:10,padding:"3px 8px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:6,fontSize:10,fontWeight:700,zIndex:1}}>
                  {t.vaultPin||"Épingler"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Confirm delete modal (main list) */}
      {confirmDel && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,borderRadius:16,padding:24,maxWidth:320,width:"100%",textAlign:"center",border:`1.5px solid ${C.bor}`}}>
            <div style={{fontSize:32,marginBottom:10}}>🗑️</div>
            <div style={{fontSize:15,fontWeight:800,marginBottom:8}}>{t.vaultConfirmDel||"Supprimer ce document ?"}</div>
            <div style={{display:"flex",gap:10,marginTop:18}}>
              <button onClick={()=>setConfirmDel(null)} style={{flex:1,padding:"10px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontWeight:700}}>{t.vaultCancel||"Annuler"}</button>
              <button onClick={()=>deleteDoc(confirmDel)} style={{flex:1,padding:"10px",background:C.red,color:"#fff",fontWeight:800}}>🗑 {t.vaultDelete||"Supprimer"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ─── VAULT TAB END ────────────────────────────────────────────────────────────
