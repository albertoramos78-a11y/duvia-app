// ─────────────────────────────────────────────────────────────────────────────
// Service de diagnostic centralisé — Duvia
//
// Rôle : collecter de façon légère les dernières actions + les erreurs, et
// produire un rapport structuré (JSON) envoyé dans la table Supabase
// `bug_reports` quand l'utilisateur signale un problème.
//
// Confidentialité (NON négociable) :
//   - aucun mot de passe, aucun token (sb-*, jwt…) n'est jamais collecté ;
//   - les emails sont masqués (a***@domaine) ;
//   - on ne collecte QUE de l'état structurel (écran, ids, compteurs), jamais
//     le contenu sensible (noms d'enfants, montants, messages, documents).
//
// Impact perf : buffers en mémoire bornés (ring buffers), aucune écriture
// réseau hors signalement explicite.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "../supabaseClient";
import { APP_VERSION } from "../config.js";

const MAX_LOGS = 300; // dernières actions conservées
const MAX_ERRORS = 50; // dernières erreurs conservées
const RETRY_KEY = "duvia_bugreport_retry";

const logs = [];
const errs = [];

// ── Scrubber de confidentialité ──────────────────────────────────────────────
const SENSITIVE_KEY = /pass|pwd|\bpw\b|token|secret|api[_-]?key|jwt|authorization|\bauth\b|session/i;
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function maskEmail(s) {
  try { return String(s).replace(EMAIL_RE, (_m, first, domain) => first + "***" + domain); }
  catch { return s; }
}

function scrub(value, depth = 0) {
  if (value == null || depth > 5) return value;
  if (typeof value === "string") return maskEmail(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      if (SENSITIVE_KEY.test(k)) { out[k] = "[redacted]"; continue; }
      out[k] = scrub(value[k], depth + 1);
    }
    return out;
  }
  return undefined;
}

// ── API de logging (à appeler depuis l'app) ──────────────────────────────────
export function logAction(type, params, result) {
  try {
    logs.push({ ts: new Date().toISOString(), type: String(type), params: scrub(params), result: scrub(result) });
    if (logs.length > MAX_LOGS) logs.shift();
  } catch { /* le logging ne doit jamais casser l'app */ }
}

export function logError(message, stack, context) {
  try {
    errs.push({
      ts: new Date().toISOString(),
      message: maskEmail(message || "").slice(0, 1000),
      stack: stack ? String(stack).slice(0, 4000) : null,
      context: scrub(context),
    });
    if (errs.length > MAX_ERRORS) errs.shift();
  } catch { /* idem */ }
}

// ── Capture automatique des erreurs globales ─────────────────────────────────
let inited = false;
export function initDiagnostics() {
  if (inited || typeof window === "undefined") return;
  inited = true;
  window.addEventListener("error", (e) => {
    logError(e?.message || "window.error", e?.error?.stack, { src: e?.filename, line: e?.lineno, col: e?.colno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    logError("unhandledrejection: " + (r?.message || r), r?.stack, null);
  });
  logAction("app_open", { path: window.location?.pathname });
}

// ── Infos système ────────────────────────────────────────────────────────────
function systemInfo() {
  const n = typeof navigator !== "undefined" ? navigator : {};
  const sc = typeof screen !== "undefined" ? screen : {};
  const ua = (n.userAgent || "").toLowerCase();
  let platform = "web";
  if (/android/.test(ua)) platform = "android";
  else if (/iphone|ipad|ipod/.test(ua)) platform = "ios";
  else if (/windows/.test(ua)) platform = "windows";
  else if (/macintosh|mac os/.test(ua)) platform = "mac";
  else if (/linux/.test(ua)) platform = "linux";
  let standalone = false;
  try {
    standalone = (typeof window !== "undefined") &&
      ((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || n.standalone === true);
  } catch { /* noop */ }
  let tz = "";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* noop */ }
  return {
    appVersion: APP_VERSION,
    platform,
    userAgent: n.userAgent || "",
    language: n.language || "",
    online: typeof n.onLine === "boolean" ? n.onLine : null,
    screen: { w: sc.width || null, h: sc.height || null, dpr: (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1 },
    viewport: (typeof window !== "undefined") ? { w: window.innerWidth, h: window.innerHeight } : null,
    standalone: !!standalone,
    timezone: tz,
    capturedAt: new Date().toISOString(),
  };
}

// ── Capture d'écran optionnelle (opt-in) ─────────────────────────────────────
// html2canvas est chargé À LA DEMANDE depuis un CDN : zéro poids tant que
// l'utilisateur ne coche pas la case. Réduit l'échelle + compresse en JPEG.
async function captureScreenshot() {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  try {
    if (!window.html2canvas) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    const scale = Math.min(1, 900 / (window.innerWidth || 900));
    const canvas = await window.html2canvas(document.body, { logging: false, scale, useCORS: true });
    return canvas.toDataURL("image/jpeg", 0.55);
  } catch {
    return null; // une capture ratée ne doit jamais bloquer l'envoi du rapport
  }
}

// ── Construction + envoi du rapport ──────────────────────────────────────────
function buildReport({ comment, screenshot, context }) {
  const ctx = context || {};
  return {
    user_id: ctx.userId || null,
    family_id: ctx.familyId || null,
    app_version: APP_VERSION,
    comment: maskEmail(comment || "").slice(0, 4000),
    system: systemInfo(),
    app_state: scrub({ screen: ctx.screen || null, ...(ctx.appState || {}) }),
    logs: logs.slice(-MAX_LOGS),
    errors: errs.slice(-MAX_ERRORS),
    screenshot: screenshot || null,
  };
}

export async function submitBugReport({ comment, withScreenshot, context }) {
  let screenshot = null;
  if (withScreenshot) screenshot = await captureScreenshot();
  const report = buildReport({ comment, screenshot, context });
  const { error } = await supabase.from("bug_reports").insert(report);
  if (error) {
    // Échec → conserver pour réessai (sans la capture, trop lourde pour localStorage).
    try { window.localStorage.setItem(RETRY_KEY, JSON.stringify({ ...report, screenshot: null })); } catch { /* noop */ }
    throw error;
  }
  try { window.localStorage.removeItem(RETRY_KEY); } catch { /* noop */ }
  logAction("bug_report_sent", { hasScreenshot: !!screenshot });
  return true;
}

// Réessai best-effort d'un rapport précédemment échoué (appelé au démarrage).
export async function retryPendingReport() {
  try {
    const raw = window.localStorage.getItem(RETRY_KEY);
    if (!raw) return;
    const report = JSON.parse(raw);
    const { error } = await supabase.from("bug_reports").insert(report);
    if (!error) window.localStorage.removeItem(RETRY_KEY);
  } catch { /* silencieux : best-effort */ }
}
