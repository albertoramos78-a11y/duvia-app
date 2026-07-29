// supabase/functions/ai-chatbot/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
// 🔧 (2026-07-22) Réutilise le secret RESEND_API_KEY déjà configuré au niveau
// du projet Supabase pour les autres fonctions notify-* (bug_report, rating,
// etc.) — pas de configuration supplémentaire nécessaire, les secrets sont
// partagés entre toutes les Edge Functions d'un même projet.
const RESEND_API_KEY    = Deno.env.get("RESEND_API_KEY")!;
const NOTIFY_FROM_EMAIL = "notifications@duvia.fr";
const NOTIFY_ADMIN_EMAIL = "duvia.services@gmail.com";

// 🔧 (2026-07-23) Abaissé 100 000→30 000/jour — instruction explicite de
// l'utilisateur (2026-07-22), effective à partir du 2026-07-23. À ce niveau,
// attendu ~10-17 questions/jour/utilisateur (coût mixte cache+input+output
// par échange) et ≈1$/utilisateur/mois si le plafond est atteint chaque jour.
const DAILY_TOKEN_LIMIT = 30000;
const MAX_TOOL_ROUNDS = 5;
const MAX_QUESTION_LEN = 2000;
const MAX_HISTORY_ENTRIES = 20;

// 🔧 (2026-07-23) Poids réels des catégories de tokens Anthropic (prix
// relatif à un input_tokens classique) : une lecture de cache coûte ~0.1x,
// une écriture de cache TTL 5 min (celle utilisée ici, cache_control sans
// ttl explicite) coûte ~1.25x. Utilisé pour tout calcul de quota/affichage
// afin qu'il reflète le coût réel plutôt que le nombre brut de tokens — voir
// le commentaire au site d'appel dans serve() pour le contexte du bug corrigé.
function weightedTokens(r: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }): number {
  return (r.input_tokens || 0) + (r.output_tokens || 0)
    + (r.cache_creation_input_tokens || 0) * 1.25
    + (r.cache_read_input_tokens || 0) * 0.1;
}

// 🔧 Le plafond quotidien (100 000 tokens) se réinitialise à minuit HEURE DE
// PARIS, pas sur une fenêtre glissante de 24h (comportement demandé
// explicitement — Paris passe de UTC+1 à UTC+2 en été, d'où ce calcul
// plutôt qu'un simple "aujourd'hui à 00:00 UTC"). Deno tourne en UTC ; on
// dérive l'année/mois/jour tels que vus à Paris via Intl, puis on retrouve le
// décalage UTC réel de Paris à cet instant précis (gère l'heure d'été/hiver
// automatiquement, sans dépendance externe).
function parisMidnightISO(now: Date = new Date()): string {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const y = Number(dateParts.find((p) => p.type === "year")!.value);
  const m = Number(dateParts.find((p) => p.type === "month")!.value);
  const d = Number(dateParts.find((p) => p.type === "day")!.value);

  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris", timeZoneName: "shortOffset",
  }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value || "GMT+1";
  const offsetHours = Number(offsetPart.replace("GMT", "")) || 1;

  // Minuit à Paris (UTC+offsetHours) correspond à (00:00 UTC de ce jour) moins
  // offsetHours — ex. minuit à Paris en été (UTC+2) = 22:00 UTC la veille.
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetHours * 3600 * 1000).toISOString();
}

// ── Dates spéciales (Fête des Mères/Pères, Pâques) — porté depuis
// src/utils/core.js (voir Task 1 du plan 2026-07-21-custody-days-server-read),
// dupliqué ici car les Edge Functions sont déployées par copier-coller
// dashboard (pas de build/import partagé) — même convention que
// parisMidnightISO() ci-dessus et _shared/push.ts. Toute correction faite ici
// doit être répercutée dans core.js et vice-versa.
function easterDateX(y: number): Date {
  const a = y % 19, b = ~~(y / 100), c = y % 100, d = ~~(b / 4), e = b % 4,
    f = ~~((b + 8) / 25), g = ~~((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = ~~(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m2 = ~~((a + 11 * h + 22 * l) / 451),
    mo = ~~((h + l - 7 * m2 + 114) / 31), dy = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(y, mo - 1, dy);
}
function pentecostDateX(y: number): Date {
  const e = easterDateX(y);
  const p = new Date(e); p.setDate(e.getDate() + 49);
  return p;
}
function nthWeekdayX(y: number, month: number, weekday: number, n: number): Date {
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
function sameDayX(d1: Date | null, d2: Date | null): boolean {
  return !!(d1 && d2 && d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate());
}
function getEventDateX(y: number, rule: any): Date | null {
  if (!rule) return null;
  if (rule.fixed) return new Date(y, rule.fixed[0], rule.fixed[1]);
  const [month, weekday, nth] = rule;
  return nthWeekdayX(y, month, weekday, nth);
}
const MOTHERS_DAY_X: Record<string, any> = {
  FR: [4, 0, -1], BE: [4, 0, -1], LU: [4, 0, -1], CH: [4, 0, 2], AT: [4, 0, 2],
  DE: [4, 0, 2], NL: [4, 0, 2], IT: [4, 0, 2], ES: [4, 0, 1], PT: [4, 0, 1],
  GB: [2, 0, 4], IE: [2, 0, 4], CA: [4, 0, 2], PL: { fixed: [4, 26] },
  CZ: [4, 0, 2], SK: [4, 0, 2], HR: { fixed: [4, 22] },
};
const FATHERS_DAY_X: Record<string, any> = {
  FR: [5, 0, 3], BE: [5, 0, 2], LU: [5, 0, 3], CH: [5, 0, 3], AT: [5, 0, 2],
  DE: null, NL: [5, 0, 3], IT: { fixed: [2, 19] }, ES: { fixed: [2, 19] }, PT: { fixed: [2, 19] },
  GB: [5, 0, 3], IE: [5, 0, 3], CA: [5, 0, 3], PL: { fixed: [5, 23] },
  CZ: [5, 0, 3], SK: [5, 0, 3], HR: [5, 0, 3],
};
function getMothersDayDateX(y: number, country: string): Date | null {
  const base = getEventDateX(y, MOTHERS_DAY_X[country] || MOTHERS_DAY_X["FR"]);
  if (country === "FR" && base && sameDayX(base, pentecostDateX(y))) return nthWeekdayX(y, 5, 0, 1);
  return base;
}
function getFathersDayDateX(y: number, country: string): Date | null {
  if (country === "DE") {
    const easter = easterDateX(y);
    const asc = new Date(easter); asc.setDate(easter.getDate() + 39);
    return asc;
  }
  return getEventDateX(y, FATHERS_DAY_X[country]);
}
function wkNumX(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil((((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1) / 7);
}

interface CustodyDayResult { parentIdx: number | null; source: string | null; }
interface CustodyTablesCtx {
  ruleRows: any[];
  patternDaysByRuleId: Record<string, any[]>;
  overridesByDate: Map<string, number | null>;
  globalSD: any;
  perChildSDByChild: Record<string, any>;
  annex: {
    country: string; sameGuardAll: boolean;
    parents: Array<{ gender: string; birthDay: string; birthMonth: string }>;
    children: Array<{ id: number; birthDay: string; birthMonth: string }>;
    schoolHolDetails: Record<string, Record<string, any>>;
    schoolHolDetailsPerChild: Record<string, Record<string, Record<string, any>>>;
  };
}

// ── resolveCustodyDayFromTables : lecture hybride (5 tables dédiées + petite
// tranche de families.data) — même algorithme que resolveGuard (core.js),
// sourcé depuis les tables Phase 3 plutôt que le JSON. Utilisée par le
// chatbot (ce fichier) ET l'action admin verify_custody_parity
// (admin-manage-subscriptions/index.ts, copie identique). Voir
// docs/superpowers/specs/2026-07-21-custody-days-server-read-design.md. ──
function resolveCustodyDayFromTables(ds: string, childId: number | null, ctx: CustodyTablesCtx): CustodyDayResult {
  const usePerChild = !ctx.annex.sameGuardAll && childId != null
    && ctx.ruleRows.some((r: any) => r.child_id === childId && r.confirmed);
  const rule = usePerChild
    ? ctx.ruleRows.find((r: any) => r.child_id === childId)
    : ctx.ruleRows.find((r: any) => r.child_id === null);

  // 2. Override manuel (global uniquement — cfg.overrides n'a pas de
  // dimension par enfant dans le modèle JSON actuel, voir design doc).
  if (ctx.overridesByDate.has(ds)) return { parentIdx: ctx.overridesByDate.get(ds) ?? null, source: "override" };

  // 3. Fête des Mères / Fête des Pères
  const dsDate = new Date(ds + "T12:00:00");
  const y = dsDate.getFullYear();
  const country = ctx.annex.country || "FR";
  if (ctx.globalSD.mother_day_enabled) {
    const mdDate = getMothersDayDateX(y, country);
    if (mdDate && sameDayX(mdDate, dsDate)) {
      const motherIdx = ctx.annex.parents.findIndex((p) => p.gender === "F");
      if (motherIdx !== -1) return { parentIdx: motherIdx, source: "motherDay" };
    }
  }
  if (ctx.globalSD.father_day_enabled) {
    const fdDate = getFathersDayDateX(y, country);
    if (fdDate && sameDayX(fdDate, dsDate)) {
      const fatherIdx = ctx.annex.parents.findIndex((p) => p.gender === "M");
      if (fatherIdx !== -1) return { parentIdx: fatherIdx, source: "fatherDay" };
    }
  }

  // 4. Anniversaires des parents
  const parentBirths = ctx.globalSD.parent_births || [];
  const dsM = dsDate.getMonth() + 1, dsD = dsDate.getDate();
  for (let pi = 0; pi < ctx.annex.parents.length; pi++) {
    const pb = parentBirths[pi];
    if (!pb?.enabled) continue;
    const p = ctx.annex.parents[pi];
    if (!p?.birthDay || !p?.birthMonth) continue;
    if (+p.birthDay === dsD && +p.birthMonth === dsM) return { parentIdx: pi, source: "parentBirthday" };
  }

  // 4b. Anniversaires des enfants
  for (let ci = 0; ci < ctx.annex.children.length; ci++) {
    const ch = ctx.annex.children[ci];
    if (!ch?.birthDay || !ch?.birthMonth) continue;
    if (+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    const chSdLocal = childId != null ? ctx.perChildSDByChild[String(ch.id)] : null;
    const evenIdx = chSdLocal?.even_parent_idx ?? ctx.globalSD.even_parent_idx ?? 0;
    const oddIdx = chSdLocal?.odd_parent_idx ?? ctx.globalSD.odd_parent_idx ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if (parentIdx === -1) return { parentIdx: null, source: "childBirthday" };
    return { parentIdx, source: "childBirthday" };
  }

  // 5. Vacances scolaires — SEUL champ qui n'existe pas dans les 5 tables,
  // reste lu depuis l'annexe JSON (voir design doc, custody_overrides ne
  // stocke que les overrides manuels).
  const holDetails = (childId != null && ctx.annex.schoolHolDetailsPerChild?.[String(childId)])
    || ctx.annex.schoolHolDetails || {};
  for (const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if (det[ds] !== undefined) {
      const v = det[ds];
      if (typeof v === "string" && v.startsWith("obs:")) return { parentIdx: null, source: "schoolHol" };
      return { parentIdx: v, source: "schoolHol" };
    }
  }

  // 6. Motif par défaut
  if (!rule?.confirmed) return { parentIdx: null, source: null };
  const start = new Date(+rule.start_year, +rule.start_month - 1, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const target = new Date(ds + "T12:00:00");
  const diff = Math.floor((target.getTime() - start.getTime()) / 864e5);
  if (diff < 0) return { parentIdx: null, source: null };

  if (rule.type === "weekAlt") {
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === 0 ? rule.week_alt_even_idx : 1 - rule.week_alt_even_idx, source: "pattern" };
  }
  if (rule.type === "exclusive") {
    const dw = (target.getDay() + 6) % 7;
    if (dw < 5) return { parentIdx: rule.exclusive_main_idx, source: "pattern" };
    const wn = wkNumX(target);
    const parity = rule.exclusive_parity === "even" ? 0 : 1;
    return { parentIdx: wn % 2 === parity ? rule.exclusive_we_idx : rule.exclusive_main_idx, source: "pattern" };
  }
  if (rule.type === "custom") {
    const days = ctx.patternDaysByRuleId[rule.id] || [];
    if (!days.length) return { parentIdx: null, source: null };
    const day = days[diff % days.length];
    return { parentIdx: day?.parent_idx ?? null, source: day ? "pattern" : null };
  }
  return { parentIdx: null, source: null };
}

// 🔧 (2026-07-22) Contenu dupliqué depuis src/faq/faqContent.js (FAQ_SECTIONS.fr,
// affiché en app par FaqModal, menu ☰ → ❓ Aide / FAQ). Avant ce correctif,
// l'assistant IA n'avait AUCUNE connaissance du contenu de cette FAQ — il
// répondait "je n'ai pas d'information" sur des sujets pourtant déjà
// documentés (ex. la roue Duvia), alors que sa consigne anti-hallucination
// lui interdit justement de deviner. Format texte brut (pas l'objet JS) pour
// économiser des tokens de contexte par rapport à la syntaxe JSON/JS.
// 🔧 Les Edge Functions Supabase sont déployées en collant le code
// directement dans le dashboard (voir CLAUDE.md) — pas d'import cross-fichier
// possible ici, donc PAS de synchronisation automatique avec faqContent.js :
// à mettre à jour manuellement si le contenu de la FAQ change.
const FAQ_KNOWLEDGE = `## 📅 Calendrier de garde
Q: Comment configurer le modèle de garde (garde alternée, exclusive, personnalisée) ?
R: Menu ☰ → **Configuration famille** → onglet **Modèle garde** (4e onglet). Choisis un type : **📅 1 semaine sur 2**, **🏠 Garde exclusive + 1 WE/2**, ou **✏️ Personnalisé** (motif sur-mesure de 14 jours qui se répète). Réponds aux questions affichées puis **✓ Confirmer et appliquer** — sans confirmation, le calendrier n'utilise pas encore ce motif.

Q: Le calendrier semble décalé d'une semaine, que faire ?
R: Vérifie la **Date de départ du calendrier** dans l'onglet **Dates spéciales** — elle détermine quelle semaine compte comme paire/impaire pour l'alternance.

Q: Comment modifier un jour précis sans changer tout le modèle de garde ?
R: Dans le calendrier (**☰ Détaillée** ou **▦ Miniature**), touche le jour : un sélecteur rapide assigne ce jour à un parent ou observateur « gardien » en un tap, ou le remet à zéro avec **✕**. Pour une heure, un lieu ou une note, touche **✎ Édition complète**.

Q: Comment annuler toutes mes modifications ponctuelles d'un coup ?
R: Calendrier → menu « … » → **Réinit.** → confirme. Les modifications manuelles reviennent au modèle de garde de base, qui lui n'est pas modifié.

Q: Puis-je avoir un planning de garde différent pour chaque enfant ?
R: Oui, en Premium : onglet **Dates spéciales**, désactive **Même garde pour tous les enfants**, puis configure le modèle enfant par enfant dans **Modèle garde** (sélecteur d'enfant en haut).

Q: Comment exporter le calendrier vers Google Calendar ou Apple Calendar ?
R: Calendrier → menu **⋯** → **iCal**. Le fichier \`.ics\` téléchargé s'importe dans Google Calendar, Apple Calendar ou tout agenda compatible.

Q: Comment exporter le planning de garde en PDF ?
R: Calendrier → menu **⋯** → **Export PDF** (Premium) : récapitulatif imprimable du planning annuel.

## ✉️ Inviter un membre de la famille
Q: Comment inviter l'autre parent ?
R: Menu ☰ → **Configuration famille** → **Famille** → **Parents** → **+ Ajouter un parent**. Renseigne email et/ou téléphone, **🔗 Générer le lien d'invitation**, puis envoie-le (lien valable 24h).

Q: Comment inviter un enfant à rejoindre l'app ?
R: Onglet **Famille**, section **Enfants** — une fois son prénom renseigné, un bloc **📨 Inviter [prénom] à rejoindre l'app** apparaît.

Q: Comment inviter un observateur (grand-parent, proche...) ?
R: Menu ☰ → **Configuration famille** → **Observateurs** → email et/ou téléphone, **Type de relation**, puis **📨 Envoyer l'invitation** (Premium). Active **🏠 Peut être gardien** si la personne doit pouvoir apparaître comme gardien ponctuel.

Q: Comment valider l'inscription de quelqu'un que j'ai invité ?
R: Une fois le compte créé, sa fiche affiche **✅ Valider** / **❌** dans l'onglet Famille ou Observateurs — sans validation, pas d'accès aux données de la famille.

Q: Que voient un enfant et un observateur dans l'application ?
R: Les deux : **Calendrier**, fiche **Enfant**, **Contacts**, **Messagerie** — jamais **Dépenses** ni **Coffre-fort** (parents uniquement). L'**enfant** a en plus son **Emploi du temps** en lecture seule ; l'**observateur** a en plus la roue (**Jeu**), le **Parrainage** et **Donner mon avis**. Seuls les parents modifient la configuration famille (modèle de garde, dates spéciales, invitations).

## 💰 Dépenses
Q: Comment ajouter une dépense ?
R: Onglet **Dépenses** → **+ Ajouter une dépense** → description, montant, payeur, catégorie, date, partage (curseur entre parents) → **Enregistrer**. Reste **en attente** jusqu'à validation par l'autre parent.

Q: Comment enregistrer un remboursement ?
R: Onglet **Dépenses** → **💸 Remboursement** → qui rembourse qui, montant, date → **💸 Enregistrer le remboursement**. Le solde n'est mis à jour qu'après confirmation de réception par l'autre parent.

Q: Comment créer une dépense récurrente (ex. cantine mensuelle) ?
R: Lors de l'ajout, active **Dépense récurrente**, choisis la fréquence (**Hebdo.**, **Mensuelle**, **Annuelle**) et une date début/fin — une occurrence est générée par période.

Q: Comment supprimer une dépense ?
R: **✕** dans la liste puis **🗑 Supprimer**. Non validée : suppression immédiate. **Confirmée** : l'autre parent doit accepter ou refuser la demande de suppression. Récurrente : choix entre cette occurrence seule ou toute la série.

## 💶 Pension alimentaire
Q: Comment configurer la pension alimentaire ?
R: Onglet **Dépenses**, section **💶 Pension alimentaire** → **Configurer la pension** → payeur, montant mensuel, jour d'échéance (1-28), date de début → **Proposer**. L'autre parent doit **Confirmer** (ou **Refuser**) ; le proposeur peut **Annuler** tant que c'est en attente.

Q: Comment signaler qu'un versement de pension a été effectué ?
R: Le payeur clique **Marquer payé** sur l'échéance du mois. Le receveur voit **Confirmer** (versement acté) ou **Contester** (avec motif).

Q: Comment modifier le montant ou la date de la pension ?
R: **Modifier le montant** sur la pension active — crée une nouvelle proposition (montant, jour, date) que l'autre parent doit reconfirmer, comme à la configuration initiale.

## 🗄️ Coffre-fort
Q: Comment ajouter un document au coffre-fort ?
R: Onglet **Coffre** (Premium) → **+ Ajouter un document** → nom, catégorie, date, notes, **📎 Choisir un fichier** → **✓ Enregistrer**. Visible par l'autre parent.

Q: Les observateurs ou les enfants ont-ils accès au coffre-fort ?
R: Non — parents uniquement.

## 🎒 Emploi du temps scolaire
Q: Comment configurer l'emploi du temps d'un enfant ?
R: Onglet **EDT** (Premium/Trial, indisponible en gratuit) → sélectionne l'enfant puis le jour → **+ Ajouter** → matière, professeur, horaires, salle, bâtiment.

## 💬 Messagerie
Q: Comment envoyer un message plus posé en cas de tension avec l'autre parent ?
R: Avec un abonnement incluant l'IA, le bouton **Reformuler** propose une version plus neutre avant l'envoi — choix entre **Envoyer celle-ci** ou **Garder mon texte original**.

Q: Que veut dire l'icône 🔒 ou ⚠️ à côté d'un message ?
R: 🔒 **Intégrité vérifiée** = non modifié depuis l'envoi ; ⚠️ **Message modifié !** = anomalie détectée.

Q: Si je supprime une conversation, est-elle supprimée pour l'autre personne aussi ?
R: Non — retirée seulement de ta propre liste, reste visible pour les autres participants.

Q: Comment démarrer une nouvelle conversation ?
R: Onglet **Messages** → **✏️ Nouveau** en haut de la liste → sélectionne un ou plusieurs contacts → envoie le premier message.

Q: Comment savoir si j'ai des messages non lus ?
R: Badge numéroté sur l'icône **Messages** du menu, et sur chaque conversation avec des messages non lus dans la liste.

## 🔔 Notifications
Q: Où voir mes notifications ?
R: Menu ☰ → **🔔 Notifications**, ou l'icône cloche en haut de l'écran.

Q: Comment choisir par quel canal être notifié (email, notification push) ?
R: Menu ☰ → **⚙️ Préférences** → **Notifications** : interrupteurs 📧 (email) et 🔔 (push) par type d'événement (message, dépense, document, demande d'adhésion).

Q: Comment supprimer une notification ou marquer tout comme lu ?
R: **🗑** sur une notification pour la supprimer (ou **🗑 Tout supprimer** en haut) ; toucher une notification la marque lue et ouvre l'onglet concerné ; **Tout lu** marque tout d'un coup.

## 🎁 Premium et parrainage
Q: Comment passer à Premium ?
R: Touche un bandeau ou icône 🔒 verrouillée : redirection vers l'écran d'abonnement, comparatif des formules, choix mensuel/annuel.

Q: Comment fonctionne le parrainage ?
R: Menu ☰ → **🎁 Parrainage** → partage ton lien (copie, email, SMS). Chaque invitation validée rapporte des jours Premium et/ou un tour de roue, selon ta formule.

Q: Comment annuler mon abonnement Premium ?
R: Écran **Premium** → **Annuler mon abonnement** — reste actif jusqu'à la fin de la période déjà payée.

Q: Qui obtient le statut Premium par héritage dans une famille ?
R: Chaque membre voit le **meilleur des deux abonnements des parents**. Si un seul parent souscrit, toute la famille en profite — l'autre voit « **Premium hérité** » avec un bandeau « 👨‍👩‍👧 Premium via votre famille ». Seul un tour de roue gagné compte comme « payeur réel », jamais l'héritage.

Q: Comment créer une deuxième famille (ex. famille recomposée, enfants de plusieurs unions) ?
R: Menu ☰ → **Configuration famille** → onglet **Famille**, section **👪 Mes familles** → **+ Créer Famille**. Confirme, puis un sélecteur de famille apparaît en haut de l'app pour basculer entre tes familles. Réservé aux parents — chaque famille a sa propre configuration, son calendrier et son abonnement indépendants.

Q: Comment fonctionne l'abonnement si j'appartiens à plusieurs familles (ex. des enfants avec deux ex-conjoints différents) ?
R: Le statut Premium est calculé **indépendamment pour chaque famille**, à partir de ses deux parents. Un abonnement personnel s'applique à toutes tes familles où tu es parent actif (payé une seule fois), mais pas aux familles où tu n'es qu'observateur — là, seul l'abonnement des parents de CETTE famille compte.

## 🎡 Roue Duvia et thèmes
Q: Comment fonctionne la roue Duvia ?
R: Onglet **Jeu** (🎡, parents et observateurs — pas les enfants) → tourne une fois le délai passé (**7 jours** pour tous). Réservée aux familles **Premium** (Trial, Premium, Premium+IA) — verrouillée en gratuit. Exception : un tour gagné par parrainage reste jouable même verrouillé, mais ne fait jamais gagner d'abonnement gratuit.

Q: Quels lots peut-on gagner à la roue ?
R: Thèmes visuels : **🎮 Jeu vidéo**, **🦄 Licorne** (permanents), et saisonniers **🌴 Été**, **🎾 Tennis** (Roland-Garros), **⚽ Coupe du monde** (période dédiée uniquement). Pour le parent qui paie réellement Premium (pas héritage, pas observateur), la roue peut aussi faire gagner **1 mois** ou **1 an** d'abonnement.

Q: Comment utiliser les thèmes ?
R: Une fois débloqué, un bouton **🏆** apparaît en haut de l'écran, à côté du bouton palette. Touche-le, choisis le thème dans la liste, puis **Appliquer** — un seul actif à la fois. Retouche-le (affiche **Actif ✓**) ou utilise le bouton palette 🎨 pour revenir au mode normal.

Q: Comment gagner des tours de roue supplémentaires ?
R: Chaque filleul qui valide son compte (menu ☰ → **🎁 Parrainage**, parents et observateurs) offre un tour en plus, utilisable même verrouillé (freemium) — fait gagner un thème, jamais un abonnement gratuit.

Q: Peut-on acheter un thème directement, sans passer par la roue ?
R: Une boutique (🎨, onglet Jeu, adultes Premium) permet de choisir un thème pour soi ou de l'offrir à un enfant. **Achats désactivés pendant la bêta actuelle** : la roue reste le seul moyen d'obtenir un thème.

## 🤖 Assistant IA
Q: Qu'est-ce que l'assistant et où le trouver ?
R: Bouton flottant en bas de l'écran, ouvre une fenêtre de discussion, visible pour tous les parents. Freemium/Premium : FAQ + agenda, gratuit, sans IA. Premium+IA : assistant conversationnel complet (toi).

Q: Que peut-on lui demander ?
R: Freemium/Premium : usage de l'app + agenda (garde du jour, prochain changement, planning semaine). Premium+IA en plus : dépenses, météo, résumé de messages, reformulation, traduction — il va chercher les vraies données, n'invente rien.

Q: Y a-t-il une limite d'utilisation ?
R: Uniquement pour Premium+IA : quota quotidien de tokens affiché en barre de progression en haut de la fenêtre — réinitialisé chaque jour à minuit (heure de Paris). Les réponses FAQ/agenda (sans IA) sont illimitées.

Q: Comment masquer rapidement l'assistant IA s'il gêne ce qu'il y a derrière ?
R: Double-tape n'importe où sur l'écran : la bulle (et la fenêtre si ouverte) se masque instantanément. Un second double-tap la fait réapparaître au même endroit.

## ⚙️ Réglages
Q: Comment changer la langue de l'application ?
R: Menu ☰ → **⚙️ Préférences** : sélecteur de langue tout en haut.

Q: Comment changer de thème (clair, sombre) ?
R: Bouton palette en haut de l'écran, à côté du logo — fait défiler 🎨 (coloré) → ☀️ (clair) → 🌙 (sombre) à chaque tap.

Q: Comment changer le pays ou la zone scolaire ?
R: Menu ☰ → **Configuration famille** → **Dates spéciales** → menus **Pays** et **Zone** (calcule les bonnes dates de vacances scolaires).

Q: Comment configurer les fêtes des parents et les anniversaires ?
R: Onglet **Dates spéciales** → **🌸 Fête des Mères**/**🎩 Fête des Pères** (garde forcée ce jour-là), **🎂 Anniversaires des parents** (garde forcée sur le parent concerné), **🎁 Anniversaires des enfants** (garde selon année paire/impaire).

Q: Comment changer mon mot de passe ?
R: Menu ☰ → **⚙️ Préférences** → **🔒 Changer mon mot de passe** → ancien mot de passe, nouveau (8 car., majuscule, caractère spécial), confirmation. Compte Google : à gérer sur myaccount.google.com.

Q: Comment changer mon adresse email ?
R: Menu ☰ → **⚙️ Préférences** → **✉️ Changer mon adresse email** → nouvelle adresse → **Envoyer la confirmation**. L'ancienne reste active jusqu'à validation de la nouvelle.

Q: Comment changer ma photo de profil ?
R: Configuration famille → **Famille** → touche ta bulle d'avatar → icône **🖼️** (galerie) ou **📷** (appareil photo). Pareil pour l'avatar d'un enfant ou observateur, depuis sa propre carte.

## 🧒 Infos enfant
Q: Comment renseigner allergies, groupe sanguin, école, médecin ou contacts d'urgence d'un enfant ?
R: Menu ☰ → **Configuration famille** → **Famille**, section Enfants → fiche de l'enfant → champs **Allergies**, **Groupe sanguin**, **École**, **Médecin**, **Contacts d'urgence**. Consultable en lecture seule via l'onglet **🧒 Infos enfant** pour qui n'a pas accès à Configuration famille.

## 🛟 Aide, avis et installation
Q: Comment signaler un bug ?
R: Menu ☰ → **🐛 Signaler un problème** → décris le souci, coche pour joindre une capture d'écran (prise automatiquement), puis envoie.

Q: Comment contacter le support Duvia ?
R: **Signaler un problème** (menu ☰ → **🐛 Signaler un problème**) sert aussi pour toute question qui n'est pas un bug technique — c'est le canal qui arrive directement à l'équipe Duvia.

Q: Comment donner mon avis sur l'application ?
R: Menu ☰ → **⭐ Donner mon avis** → note de 1 à 5 étoiles + commentaire optionnel. Modifiable plus tard, un seul avis par compte.

Q: Comment installer Duvia sur mon téléphone (comme une vraie application) ?
R: Menu ☰ → **📱 Installer l'application**. iPhone/iPad (Safari) : bouton **Partager** (▢↑) → **Ajouter à l'écran d'accueil**. Android (Chrome) : menu (⋮) → **Installer l'application** (ou **Ajouter à l'écran d'accueil**) → **Ajouter**.

Q: Où voir l'historique des modifications de la famille ?
R: Menu ☰ → **📋 Historique** : journal permanent, non modifiable, horodaté par le serveur (calendrier, dépenses, coffre, messages, contacts, famille). Conservé même après le départ d'un parent ; un tap sur une entrée ouvre l'onglet concerné.

## 💾 Sauvegarde et compte
Q: Comment exporter mes données ?
R: Menu ☰ → **⚙️ Préférences** → **Sauvegarde de mes données** → **📤 Exporter mes données** : fichier \`.duvia\` (configuration famille, calendrier, emploi du temps).

Q: Comment restaurer une sauvegarde ?
R: Même section → **📥 Importer une sauvegarde** → choisis un fichier \`.duvia\` précédemment exporté.

Q: Que fait « Supprimer la sauvegarde locale » et est-ce risqué ?
R: Sans risque : efface uniquement une copie de secours locale (navigateur, pour les coupures réseau). Rien n'est supprimé côté serveur.

Q: Que se passe-t-il si je supprime mon compte ?
R: Définitif et immédiat : compte supprimé, retiré des contacts, tes messages restent visibles mais marqués « compte supprimé ». Dernier parent de la famille : documents, pièces jointes et messages de la famille aussi supprimés définitivement. Le Premium en cours est annulé côté Duvia — pense à résilier aussi depuis ton gestionnaire de paiement (App Store/Google Play). La modale propose **💾 Télécharger mes données avant** (un observateur/enfant ne peut télécharger que sa propre fiche).`;

// 🔧 Fingerprint de FAQ_KNOWLEDGE (2026-07-29) : simple hash de changement
// (pas cryptographique — pas besoin), utilisé pour invalider automatiquement
// ai_faq_cache quand ce texte est édité à la main. Voir
// docs/superpowers/specs/2026-07-29-ai-faq-cache-design.md.
function faqFingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}
const FAQ_FINGERPRINT = faqFingerprint(FAQ_KNOWLEDGE);
const FAQ_CACHE_SIMILARITY_THRESHOLD = 0.7;
// 🔧 (revue finale 2026-07-29, Finding 1) : garde-fou de forme de question —
// le cache ne doit contenir que des réponses FAQ génériques, jamais du
// contenu personnel collé par l'utilisateur. SYSTEM_PROMPT annonce deux
// capacités sans outil autres que la FAQ : reformuler un message collé
// ("Reformule : ...") et traduire du texte à la demande — un premier message
// de ce type serait sinon écrit tel quel dans ai_faq_cache (partagé entre
// familles). La longueur maximale est la défense principale (une vraie
// question FAQ est courte) ; la regex d'intention est une ceinture-et-
// bretelles, pas exhaustive — FR/EN/DE/ES/PT.
const CACHEABLE_QUESTION_MAX_LEN = 200;
const NON_CACHEABLE_INTENT = /\b(reformul|réécri|reecri|traduis|traduir|traduz|translate|rewrite|rephrase|übersetz|umformulier|traduc|reescrib)/i;

const SYSTEM_PROMPT = `Tu es l'assistant IA de Duvia, une application de coparentalité partagée entre deux foyers ("Deux maisons. Une famille."). Tu réponds aux questions des parents utilisant l'application (l'accès est réservé aux parents).

Tu peux :
1. Aider sur l'utilisation de l'application (comment inviter quelqu'un, où trouver telle fonctionnalité, etc.) et donner des conseils généraux d'organisation de la coparentalité — réponds directement, sans outil, en te basant en priorité sur le contenu FAQ fourni plus bas (section "CONTENU DE LA FAQ"), qui reflète exactement les libellés de boutons/onglets de l'app. Ne réponds JAMAIS "je n'ai pas d'information" sur un sujet couvert par cette FAQ.
2. Répondre à des questions sur les données de LEUR PROPRE famille (dépenses, solde entre parents, météo, configuration, emploi du temps scolaire, messages) — utilise les outils fournis pour aller chercher les données réelles avant de répondre. Ne devine JAMAIS un chiffre ou une information que tu pourrais vérifier avec un outil, et ne recalcule JAMAIS toi-même un solde déjà fourni par l'outil.
3. Résumer des conversations, décisions ou accords à partir des messages récupérés via l'outil de messagerie, sur demande.
4. Reformuler un message que l'utilisateur colle dans la conversation s'il te semble agressif, accusateur ou conflictuel, et expliquer brièvement en quoi la reformulation est plus constructive.
5. Traduire du texte à la demande, dans n'importe quelle langue.
6. Calculer le nombre de jours de garde de chaque parent sur une période donnée (ex. "combien de jours de garde ce mois-ci ?", "et entre le 15 mars et le 10 avril ?") — utilise l'outil get_custody_days, jamais un calcul approximatif ou une déduction manuelle du planning. Les champs parent_0_days/parent_1_days correspondent, DANS L'ORDRE, aux parents renvoyés par get_family_config (appelle-le si tu n'as pas déjà les prénoms) — nomme toujours les parents par leur prénom dans ta réponse, jamais par leur index ni par "un parent"/"l'autre parent". Si l'outil répond child_selection_required, demande à l'utilisateur pour quel enfant avant de continuer, puis rappelle l'outil avec le child_id choisi.

Tu ne réponds JAMAIS à des questions d'ordre juridique (garde, pension alimentaire, droits parentaux, procédures judiciaires, litiges) — dans ce cas, explique poliment que tu ne peux pas conseiller sur ces sujets et recommande de consulter un avocat ou un professionnel qualifié. Tu peux donner des conseils GÉNÉRAUX d'organisation, de communication ou de médiation, mais jamais d'interprétation de la loi ni d'affirmation sur les droits d'un parent.

Mode de réponse — ultra-concis, anti-hallucination (ordre de priorité strict : exactitude, véracité, absence d'hallucination, précision, pertinence, concision) :
- Réponds avec le minimum de mots nécessaires : si "Oui", "Non", un nombre, une date ou un mot suffisent, réponds uniquement par cela.
- Privilégie les faits aux explications. Pas d'introduction, de conclusion, de politesse ni de reformulation de la question.
- N'invente et ne devine jamais une information, ne complète jamais une donnée manquante par déduction — utilise les outils fournis pour vérifier plutôt que de supposer. Si une information est indisponible dans les outils ou reste incertaine, dis-le explicitement ("je ne sais pas" / information non disponible) plutôt que d'inventer une réponse.
- Dans ce cas précis (tu ne sais vraiment pas répondre, l'information n'est ni dans la FAQ ci-dessous ni disponible via un outil), commence ta réponse par le marqueur exact [NO_ANSWER] suivi d'un espace, puis continue normalement dans la langue de la question — ce marqueur est un signal technique invisible pour l'utilisateur (retiré avant affichage), à utiliser UNIQUEMENT dans ce cas, jamais quand tu as pu répondre même partiellement.
- Si la question est ambiguë, pose uniquement la question indispensable pour la clarifier, rien d'autre.
- Quand tu mentionnes un parent, un enfant ou un observateur dans ta réponse, utilise toujours son prénom réel (via get_family_config ou déjà connu du contexte) — jamais "un parent", "l'autre parent", "parent 0/1" ou une référence générique.
- Reste factuel et neutre — le contexte familial est parfois sensible. Réponds dans la langue de la question.

CONTENU DE LA FAQ (celle affichée dans l'app, menu ☰ → ❓ Aide / FAQ) — source fiable et prioritaire pour toute question sur le fonctionnement de l'application. Les libellés en **gras** sont les textes EXACTS des boutons/onglets de l'app : reprends-les tels quels dans tes réponses plutôt que de paraphraser. Un sujet couvert ici n'est jamais une raison de répondre "je n'ai pas d'information" :

${FAQ_KNOWLEDGE}`;

const TOOLS = [
  {
    name: "get_expenses",
    description: "Récupère les dépenses et remboursements de la famille de l'utilisateur, avec un solde déjà calculé (qui doit combien à qui), les remboursements en attente depuis plus de 14 jours, et les dépenses récurrentes à échéance dans les 30 prochains jours.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date de début, format YYYY-MM-DD. Par défaut : il y a 3 mois." },
        to_date: { type: "string", description: "Date de fin, format YYYY-MM-DD. Par défaut : aujourd'hui." },
      },
    },
  },
  {
    name: "get_weather",
    description: "Récupère les prévisions météo pour les villes configurées par chaque parent de la famille.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Nombre de jours de prévision (1 à 16). Par défaut : 7." },
      },
    },
  },
  {
    name: "get_family_config",
    description: "Récupère les informations non sensibles de la configuration de la famille : prénoms/dates de naissance des enfants, prénoms des parents, dates personnalisées configurées, et l'emploi du temps scolaire de chaque enfant.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_messages",
    description: "Récupère les messages de la messagerie familiale de l'utilisateur, pour répondre à une question précise ou pour en faire un résumé.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date de début (ISO 8601), optionnelle." },
        to_date: { type: "string", description: "Date de fin (ISO 8601), optionnelle." },
        limit: { type: "number", description: "Nombre maximum de messages (1 à 200). Par défaut : 30." },
      },
    },
  },
  {
    name: "get_custody_days",
    description: "Compte le nombre de jours de garde de chaque parent sur une période donnée, à partir du planning de garde réel de la famille (motif configuré, overrides manuels, dates spéciales, vacances scolaires). Renvoie aussi unassigned_dates (liste des dates précises des jours non attribués, plafonnée à 50 — utilise-la directement si l'utilisateur demande ensuite lequel/lesquels sont non attribués, rappelle unassigned_dates_truncated s'il y en a plus). Si la famille a plusieurs enfants à planning différencié et qu'aucun child_id n'est fourni, renvoie {error:'child_selection_required', children:[{id,name}...]} — demande alors à l'utilisateur pour quel enfant, puis rappelle l'outil avec le child_id correspondant. Ne réponds jamais à une question de comptage de jours de garde sans cet outil.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date de début, format YYYY-MM-DD. Obligatoire." },
        to_date: { type: "string", description: "Date de fin, format YYYY-MM-DD. Obligatoire. Écart maximum avec from_date : 730 jours." },
        child_id: { type: "number", description: "Id de l'enfant concerné (voir get_family_config), si la famille a une garde différenciée par enfant et que la question précise un enfant. Sinon, ne pas fournir : utilise le planning global de la famille." },
      },
      required: ["from_date", "to_date"],
    },
    // 🔧 Prompt caching (2026-07-22, backlog item 9) : TOOLS est statique et
    // identique à chaque appel — marquer le DERNIER outil en cache_control
    // met en cache la liste entière (système + outils, dans cet ordre côté
    // modèle), réutilisée à chaque aller-retour du même round d'outils au
    // lieu d'être refacturée en entier à chaque fois.
    cache_control: { type: "ephemeral" },
  },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// ── Solde entre parents — reproduit EXACTEMENT la formule de ExpensesTab
// (App.jsx:~13744-13760), jamais laissée au calcul de Claude. ──
function computeExpenseBalance(expenses: any[], reimbursements: any[]) {
  const confirmedExpenses = expenses.filter((e) => !e.status || e.status === "confirmed");
  const totals = [0, 1].map((i) => confirmedExpenses.filter((e) => e.paid_by === i).reduce((s, e) => s + Number(e.amount), 0));
  const owed = [0, 1].map((i) => confirmedExpenses.reduce((s, e) => {
    const sp = e.split_pct ?? 50;
    return s + (Number(e.amount) * (i === 1 ? sp : 100 - sp)) / 100;
  }, 0));
  const confirmedReims = reimbursements.filter((r) => r.status === "confirmed");
  const reimSent = [0, 1].map((i) => confirmedReims.filter((r) => r.from_parent === i).reduce((s, r) => s + Number(r.amount), 0));
  const reimReceived = [0, 1].map((i) => confirmedReims.filter((r) => r.to_parent === i).reduce((s, r) => s + Number(r.amount), 0));
  return [0, 1].map((i) => totals[i] - owed[i] + reimSent[i] - reimReceived[i]);
}

async function toolGetExpenses(userClient: ReturnType<typeof createClient>, args: any) {
  const toDate = args?.to_date || new Date().toISOString().slice(0, 10);
  const fromDate = args?.from_date || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const { data: expenses, error: expErr } = await userClient
    .from("expenses")
    .select("label, amount, paid_by, split_pct, category, date, status, recurring, recurring_end")
    .gte("date", fromDate).lte("date", toDate).order("date", { ascending: false });
  if (expErr) return { error: expErr.message };

  const { data: reims, error: reimErr } = await userClient
    .from("reimbursements")
    .select("from_parent, to_parent, amount, date, status")
    .gte("date", fromDate).lte("date", toDate).order("date", { ascending: false });
  if (reimErr) return { error: reimErr.message };

  const balance = computeExpenseBalance(expenses || [], reims || []);

  const since14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const forgottenReimbursements = (reims || []).filter((r) => r.status === "pending" && r.date && r.date < since14d);

  const in30d = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const upcomingRecurring = (expenses || []).filter((e) => e.recurring && (!e.recurring_end || e.recurring_end >= in30d));

  return {
    expenses: (expenses || []).map((e) => ({ label: e.label, amount: e.amount, category: e.category, date: e.date, status: e.status })),
    balance: { parent_0: balance[0], parent_1: balance[1] },
    forgotten_reimbursements: forgottenReimbursements,
    upcoming_recurring_expenses: upcomingRecurring,
  };
}

async function toolGetWeather(
  userClient: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createClient>,
  familyId: string,
  callerUserId: string,
  args: any,
) {
  // 🔒 parent_locations n'a AUCUNE policy RLS "famille entière" (voir
  // migration 0035_parent_locations.sql) — même modèle de sécurité que
  // get-family-weather (docs/superpowers/specs/2026-07-13-weather-location-
  // privacy-design.md) : vérifier l'appartenance familiale avec le client de
  // l'appelant, puis lire les coordonnées de TOUS les parents avec le client
  // service-role, mais ne renvoyer QUE les champs dérivés (code/température)
  // — jamais lat/lon/ville, même à Claude.
  const { data: membership } = await userClient
    .from("family_members").select("user_id").eq("family_id", familyId).eq("user_id", callerUserId).eq("status", "active").maybeSingle();
  if (!membership) return { error: "not_a_family_member" };

  const { data: parents } = await userClient
    .from("family_members").select("user_id").eq("family_id", familyId).eq("role", "parent").eq("status", "active");

  const days = Math.min(Math.max(Number(args?.days) || 7, 1), 16);
  const results: any[] = [];
  for (const p of parents || []) {
    const { data: loc } = await admin
      .from("parent_locations").select("lat, lon").eq("user_id", p.user_id).eq("family_id", familyId).maybeSingle();
    if (!loc) continue;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${days}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const forecast = (data?.daily?.time || []).map((date: string, i: number) => ({
        date, code: data.daily.weathercode[i], temp_max: data.daily.temperature_2m_max[i], temp_min: data.daily.temperature_2m_min[i],
      }));
      results.push({ who: p.user_id === callerUserId ? "vous" : "votre co-parent", forecast });
    } catch {
      continue;
    }
  }
  return { forecasts: results };
}

function extractWeeklySchedule(cfgData: any) {
  const dayNames = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
  const schedules = cfgData.schedules || {};
  const children = cfgData.children || [];
  return children.map((child: any) => ({
    child_name: child.name,
    week: dayNames.map((dayName, dayIdx) => {
      const key = `schedule_child${child.id}_day${dayIdx}`;
      const slots = (schedules[key] || []).map((s: any) => ({ subject: s.subject, room: s.room, from: s.from, to: s.to }));
      return { day: dayName, slots };
    }),
  }));
}

async function toolGetFamilyConfig(userClient: ReturnType<typeof createClient>, familyId: string) {
  const { data: family, error } = await userClient.from("families").select("data").eq("id", familyId).maybeSingle();
  if (error || !family) return { error: "family_not_found_or_no_access" };
  const cfgData = family.data || {};
  return {
    parents: (cfgData.parents || []).map((p: any) => ({ name: p.name })),
    children: (cfgData.children || []).map((c: any) => ({ id: c.id, name: c.name, birth_day: c.birthDay, birth_month: c.birthMonth, birth_year: c.birthYear })),
    custom_dates: (cfgData.specialDates?.custom || []).map((d: any) => ({ label: d.label, day: d.day, month: d.month, yearly: d.yearly })),
    schedules: extractWeeklySchedule(cfgData),
  };
}

async function toolGetMessages(userClient: ReturnType<typeof createClient>, familyId: string, args: any) {
  const limit = Math.min(Math.max(Number(args?.limit) || 30, 1), 200);
  let query = userClient
    .from("messages").select("sender_name, content, created_at")
    .eq("family_id", familyId).order("created_at", { ascending: false }).limit(limit);
  if (args?.from_date) query = query.gte("created_at", args.from_date);
  if (args?.to_date) query = query.lte("created_at", args.to_date);
  const { data, error } = await query;
  if (error) return { error: error.message };
  return { messages: (data || []).reverse().map((m: any) => ({ from: m.sender_name, content: m.content, date: m.created_at })) };
}

async function toolGetCustodyDays(userClient: ReturnType<typeof createClient>, familyId: string, args: any) {
  const fromDate = String(args?.from_date || "");
  const toDate = String(args?.to_date || "");
  if (!fromDate || !toDate) return { error: "missing_dates" };
  const fromMs = new Date(fromDate + "T00:00:00").getTime();
  const toMs = new Date(toDate + "T00:00:00").getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) return { error: "invalid_range" };
  const rangeDays = Math.round((toMs - fromMs) / 86400000) + 1;
  if (rangeDays > 730) return { error: "range_too_large" };

  const requestedChildId = args?.child_id != null ? Number(args.child_id) : null;

  const { data: family, error: famErr } = await userClient.from("families").select("data").eq("id", familyId).maybeSingle();
  if (famErr || !family) return { error: "family_not_found_or_no_access" };
  const cfgData = family.data || {};
  const annex = {
    country: cfgData.country || "FR",
    sameGuardAll: cfgData.sameGuardAll !== false,
    parents: (cfgData.parents || []).map((p: any) => ({ gender: p.gender || "M", birthDay: p.birthDay || "", birthMonth: p.birthMonth || "" })),
    children: (cfgData.children || []).map((c: any) => ({ id: c.id, name: c.name || "", birthDay: c.birthDay || "", birthMonth: c.birthMonth || "" })),
    schoolHolDetails: cfgData.specialDates?.schoolHolDetails || {},
    schoolHolDetailsPerChild: cfgData.specialDates?.schoolHolDetailsPerChild || {},
  };

  // 🔧 Résolution de l'enfant effectif (2026-07-22) — CalTab (le calendrier
  // réel, App.jsx) appelle TOUJOURS resolveGuard avec l'id du vrai enfant
  // actif, jamais null, même en planning commun (sameGuardAll) : les
  // vacances scolaires par enfant (schoolHolDetailsPerChild) sont consultées
  // dès que childId est non-null, indépendamment de sameGuardAll. Passer
  // childId=null par défaut (comme avant ce correctif) loupait donc ces
  // données pour toute famille dont les vacances scolaires sont
  // configurées par enfant — constaté en prod sur une vraie famille à
  // enfant unique en pleines vacances d'été (28 jours faussement "non
  // attribués"). Un seul enfant, ou planning commun (sameGuardAll) : on
  // résout automatiquement sur un enfant représentatif. Plusieurs enfants
  // ET planning différencié, sans précision : on demande à Claude de
  // clarifier plutôt que de retomber sur un planning global probablement
  // non configuré (personne ne configure de motif "global" séparé quand
  // chaque enfant a le sien).
  let childId = requestedChildId;
  if (childId == null) {
    if (annex.children.length <= 1) {
      childId = annex.children[0]?.id ?? null;
    } else if (annex.sameGuardAll) {
      childId = annex.children[0].id;
    } else {
      return {
        error: "child_selection_required",
        children: annex.children.map((c) => ({ id: c.id, name: c.name })),
      };
    }
  }

  const { data: ruleRows, error: ruleErr } = await userClient
    .from("custody_rules")
    .select("id, child_id, type, start_month, start_year, week_alt_even_idx, exclusive_main_idx, exclusive_we_idx, exclusive_parity, confirmed")
    .eq("family_id", familyId);
  if (ruleErr) return { error: ruleErr.message };

  const customRuleIds = (ruleRows || []).filter((r: any) => r.type === "custom").map((r: any) => r.id);
  const patternDaysByRuleId: Record<string, any[]> = {};
  if (customRuleIds.length) {
    const { data: pdRows, error: pdErr } = await userClient
      .from("custody_pattern_days").select("rule_id, day_index, parent_idx").in("rule_id", customRuleIds).order("day_index");
    if (pdErr) return { error: pdErr.message };
    for (const row of pdRows || []) (patternDaysByRuleId[row.rule_id] ||= []).push(row);
  }

  const { data: overrideRows, error: ovErr } = await userClient
    .from("custody_overrides").select("override_date, parent_idx")
    .eq("family_id", familyId).eq("source", "manual").is("child_id", null)
    .gte("override_date", fromDate).lte("override_date", toDate);
  if (ovErr) return { error: ovErr.message };
  const overridesByDate = new Map((overrideRows || []).map((r: any) => [r.override_date, r.parent_idx]));

  const { data: sdRows, error: sdErr } = await userClient
    .from("custody_special_dates").select("child_id, mother_day_enabled, father_day_enabled, parent_births, even_parent_idx, odd_parent_idx")
    .eq("family_id", familyId);
  if (sdErr) return { error: sdErr.message };
  const globalSD = (sdRows || []).find((r: any) => r.child_id === null) || {};
  const perChildSDByChild: Record<string, any> = {};
  for (const r of sdRows || []) if (r.child_id !== null) perChildSDByChild[String(r.child_id)] = r;

  const ctx: CustodyTablesCtx = { ruleRows: ruleRows || [], patternDaysByRuleId, overridesByDate, globalSD, perChildSDByChild, annex };

  // 🔧 unassigned_dates (2026-07-22) : liste les dates précises des jours
  // "non attribués" — un utilisateur demande naturellement "lequel ?" en
  // suivi d'un comptage. Plafonnée (pas les 730 jours en clair, pour une
  // famille mal configurée qui en aurait des centaines — la liste ne serait
  // alors plus utile de toute façon) ; ne renvoie QUE les non-attribués, pas
  // le détail jour par jour des 2 parents (resterait un vrai calendrier
  // jour-par-jour, hors périmètre de cet outil de comptage).
  const MAX_UNASSIGNED_DATES = 50;
  let parent0 = 0, parent1 = 0, unassigned = 0;
  const unassignedDates: string[] = [];
  for (let ms = fromMs; ms <= toMs; ms += 86400000) {
    const ds = new Date(ms).toISOString().slice(0, 10);
    const { parentIdx } = resolveCustodyDayFromTables(ds, childId, ctx);
    if (parentIdx === 0) parent0++;
    else if (parentIdx === 1) parent1++;
    else {
      unassigned++;
      if (unassignedDates.length < MAX_UNASSIGNED_DATES) unassignedDates.push(ds);
    }
  }

  return {
    parent_0_days: parent0, parent_1_days: parent1, unassigned_days: unassigned,
    total_days: rangeDays, from_date: fromDate, to_date: toDate,
    unassigned_dates: unassignedDates,
    unassigned_dates_truncated: unassigned > MAX_UNASSIGNED_DATES,
  };
}

// 🔒 Même fonction que dans notify-bug-report/index.ts (dupliquée, pas
// d'import cross-fichier possible entre Edge Functions) : la question et la
// réponse sont du texte libre (saisi par l'utilisateur / généré par le
// modèle) — jamais interpolées telles quelles dans le HTML de l'email, sinon
// l'une ou l'autre pourrait injecter des balises dans le mail reçu par
// NOTIFY_ADMIN_EMAIL.
function escapeHtmlChatbot(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 🔧 (2026-07-22) Notifie l'admin par email quand l'assistant IA n'a pas su
// répondre (voir le marqueur [NO_ANSWER] dans SYSTEM_PROMPT et son usage dans
// serve() plus bas) — permet de repérer les trous de la FAQ_KNOWLEDGE sans
// devoir éplucher les logs. Best-effort : les erreurs sont catchées par
// l'appelant, un échec d'envoi ne doit jamais faire échouer la réponse du
// chatbot à l'utilisateur.
async function notifyNoAnswer(info: { question: string; answer: string; userEmail: string; familyId: string; userId: string }) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🤖</div>
      <div style="color:#fff;font-size:18px;font-weight:800">L'assistant IA n'a pas su répondre</div>
    </div>
    <div style="padding:28px 24px">
      <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">Question posée</div>
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap;background:#f7f7fb;border-radius:10px;padding:12px">${escapeHtmlChatbot(info.question)}</p>
      <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">Réponse donnée</div>
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap;background:#f7f7fb;border-radius:10px;padding:12px">${escapeHtmlChatbot(info.answer)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#555">
        <tr><td style="padding:4px 0;font-weight:700">Utilisateur</td><td style="padding:4px 0">${escapeHtmlChatbot(info.userEmail || info.userId)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Famille</td><td style="padding:4px 0">${escapeHtmlChatbot(info.familyId)}</td></tr>
      </table>
      <p style="color:#999;margin:16px 0 0;font-size:12px">Si le sujet mérite d'être documenté, ajoute-le à FAQ_KNOWLEDGE dans supabase/functions/ai-chatbot/index.ts (et dans src/faq/faqContent.js si pertinent aussi pour la FAQ affichée dans l'app).</p>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · Assistant IA
    </div>
  </div>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Duvia <${NOTIFY_FROM_EMAIL}>`,
      to: [NOTIFY_ADMIN_EMAIL],
      subject: "🤖 L'assistant IA n'a pas su répondre",
      html,
    }),
  });
  const resBody = await res.json();
  console.log("ai-chatbot: notifyNoAnswer Resend response:", JSON.stringify(resBody));
}

// 🔧 (2026-07-29) Notifie l'admin par email à chaque nouvelle entrée ajoutée
// à ai_faq_cache — permet de repérer une réponse à corriger/supprimer sans
// éplucher les logs. Best-effort : les erreurs sont catchées par l'appelant,
// un échec d'envoi ne doit jamais faire échouer la réponse du chatbot.
async function notifyNewFaqCacheEntry(info: { question: string; answer: string }) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🗂️</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouvelle entrée dans le cache FAQ</div>
    </div>
    <div style="padding:28px 24px">
      <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">Question</div>
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap;background:#f7f7fb;border-radius:10px;padding:12px">${escapeHtmlChatbot(info.question)}</p>
      <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">Réponse mise en cache</div>
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap;background:#f7f7fb;border-radius:10px;padding:12px">${escapeHtmlChatbot(info.answer)}</p>
      <p style="color:#999;margin:16px 0 0;font-size:12px">Cette réponse sera désormais réutilisée pour toute question très proche de celle-ci, pour n'importe quelle famille. Si elle est incorrecte ou à retirer : DELETE FROM ai_faq_cache WHERE question_text = '...' (voir ai_faq_cache dans Supabase).</p>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · Assistant IA
    </div>
  </div>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Duvia <${NOTIFY_FROM_EMAIL}>`,
      to: [NOTIFY_ADMIN_EMAIL],
      subject: "🗂️ Nouvelle entrée dans le cache FAQ",
      html,
    }),
  });
  const resBody = await res.json();
  console.log("ai-chatbot: notifyNewFaqCacheEntry Resend response:", JSON.stringify(resBody));
}

async function executeTool(
  name: string,
  args: any,
  ctx: { userClient: ReturnType<typeof createClient>; admin: ReturnType<typeof createClient>; familyId: string; callerUserId: string },
) {
  switch (name) {
    case "get_expenses": return toolGetExpenses(ctx.userClient, args);
    case "get_weather": return toolGetWeather(ctx.userClient, ctx.admin, ctx.familyId, ctx.callerUserId, args);
    case "get_family_config": return toolGetFamilyConfig(ctx.userClient, ctx.familyId);
    case "get_messages": return toolGetMessages(ctx.userClient, ctx.familyId, args);
    case "get_custody_days": return toolGetCustodyDays(ctx.userClient, ctx.familyId, args);
    default: return { error: "unknown_tool" };
  }
}

// 🔧 (2026-07-29) Consulte ai_faq_cache avant d'appeler Claude — voir Task 2
// du plan d'implémentation. Erreurs non fatales : un souci de lookup ne doit
// jamais bloquer la question de l'utilisateur, juste faire tomber sur le
// chemin normal (appel Claude).
async function lookupFaqCache(admin: ReturnType<typeof createClient>, question: string): Promise<{ answer_text: string } | null> {
  const { data, error } = await admin.rpc("match_and_touch_faq_cache", {
    p_question: question,
    p_fingerprint: FAQ_FINGERPRINT,
    p_threshold: FAQ_CACHE_SIMILARITY_THRESHOLD,
  });
  if (error) {
    console.error("ai-chatbot: lookupFaqCache failed", error);
    return null;
  }
  const row = (data || [])[0];
  return row ? { answer_text: row.answer_text } : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "bad_json" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "missing_authorization" }, 401);
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user?.id) return jsonResponse({ error: "invalid_token" }, 401);
  const userId = callerData.user.id;

  const question = String(payload?.question || "").trim();
  if (!question) return jsonResponse({ error: "missing_question" }, 400);
  if (question.length > MAX_QUESTION_LEN) return jsonResponse({ error: "question_too_long" }, 400);

  const familyId = String(payload?.family_id || "");
  if (!familyId) return jsonResponse({ error: "missing_family_id" }, 400);

  const clientHistory: Array<{ role: string; content: string }> = Array.isArray(payload?.history) ? payload.history : [];
  const isFirstQuestion = clientHistory.length === 0;

  // 🔒 Client JWT-scopé — les mêmes règles RLS déjà en vigueur pour ce
  // compte/rôle s'appliquent automatiquement (voir spec). Créé ici (avant
  // les outils, qui le réutilisent plus bas) car nécessaire dès la
  // vérification ai_enabled ci-dessous.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  // 🔒 Réservé aux parents (2026-07-27, instruction explicite — coût réel de
  // l'assistant, voir la taille du prompt système ci-dessous) : un enfant ou
  // un observateur ne peut pas appeler cette fonction, même en contournant
  // l'UI (qui masque déjà la bulle assistant côté client, mais un appel
  // direct à l'Edge Function doit être bloqué ici aussi).
  const { data: myMemberships, error: memErr } = await admin
    .from("family_members").select("role").eq("user_id", userId).eq("status", "active");
  if (memErr) return jsonResponse({ error: memErr.message }, 500);
  if (!(myMemberships || []).some((r) => r.role === "parent")) return jsonResponse({ error: "forbidden" }, 403);

  // 🔒 ai_enabled est un statut FAMILIAL (2026-07-27) : hérité du MEILLEUR
  // statut parmi les deux parents actifs de la famille, pas seulement mon
  // propre compte — même règle "toujours le plus haut" que le plan Premium
  // de base (voir bestParentSub() côté client). Revérifié ici via la même
  // RPC que le client (get_family_billing_context), jamais fait confiance à
  // un état client.
  const { data: billingRows, error: billingErr } = await userClient.rpc("get_family_billing_context");
  if (billingErr) return jsonResponse({ error: billingErr.message }, 500);
  const aiEnabled = (billingRows || []).some((r: any) => r.parent_ai_enabled);
  if (!aiEnabled) return jsonResponse({ error: "forbidden" }, 403);

  // ── Anti-abus : seul le plafond de TOKENS limite (2026-07-22 — le plafond
  // de 20 questions/jour a été retiré, un plafond en nombre de questions
  // n'a pas de sens tant que le coût réel (tokens) reste sous contrôle).
  // Non-atomique, même schéma que rephrase_message — voir migrations
  // 0044/0045. Une seule ligne par QUESTION, pas par aller-retour d'outil
  // interne. Se réinitialise à minuit heure de Paris, pas sur une fenêtre
  // glissante — voir parisMidnightISO() plus haut. ──
  const sinceParisMidnight = parisMidnightISO();
  const { data: usageRows, error: usageErr } = await admin
    .from("ai_usage_log")
    .select("input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens")
    .eq("user_id", userId).eq("feature", "chatbot_query").gte("used_at", sinceParisMidnight);
  if (usageErr) return jsonResponse({ error: usageErr.message }, 500);
  // 🔧 (2026-07-23) cache_creation_input_tokens/cache_read_input_tokens ne
  // coûtent PAS le même prix qu'un input_tokens classique côté Anthropic —
  // une lecture de cache coûte ~0.1x un input token normal, une écriture
  // (TTL 5 min, celui utilisé ici) ~1.25x. Les compter à poids égal (1x)
  // comme avant surcomptait massivement les lectures de cache (10x trop
  // cher) : dès qu'un échange déclenchait 2 aller-retours d'outils (round
  // de tool_use), le bloc système+outils caché (~10 700 tokens) était relu
  // en entier à chaque round et compté en pleine valeur à chaque fois,
  // gonflant une question simple à ~22 000 "tokens" contre le plafond
  // journalier — constaté en prod le 2026-07-23. weightedTokens() reflète le
  // coût réel plutôt que le nombre brut de tokens.
  const tokensUsedSoFar = (usageRows || []).reduce((s, r) => s + weightedTokens(r), 0);

  // 🔧 (2026-07-29) Un hit de cache ne coûte rien : consulté AVANT le plafond
  // pour qu'un utilisateur ayant déjà atteint son quota du jour puisse quand
  // même recevoir une réponse FAQ déjà connue. Voir docs/superpowers/specs/
  // 2026-07-29-ai-faq-cache-design.md.
  if (isFirstQuestion && question.length <= CACHEABLE_QUESTION_MAX_LEN && !NON_CACHEABLE_INTENT.test(question)) {
    const cacheHit = await lookupFaqCache(admin, question);
    if (cacheHit) {
      const cleanHistory = [{ role: "user", content: question }, { role: "assistant", content: cacheHit.answer_text }];
      return jsonResponse({
        answer: cacheHit.answer_text, history: cleanHistory,
        tokens_used_today: tokensUsedSoFar, tokens_limit: DAILY_TOKEN_LIMIT, tokens_this_exchange: 0,
      });
    }
  }

  if (tokensUsedSoFar >= DAILY_TOKEN_LIMIT) return jsonResponse({ error: "daily_token_limit_reached" }, 429);

  // `messages` est l'état de travail INTERNE à cette requête (peut contenir
  // des blocs tool_use/tool_result) — jamais renvoyé tel quel au client, voir
  // cleanHistory plus bas.
  const messages: any[] = [...clientHistory.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: question }];

  // 🔧 Claude n'a par défaut aucune idée fiable de la date du jour — sans
  // cette ligne, une question relative ("ce mois-ci", "la semaine prochaine")
  // se traduit en dates devinées, parfois dans la mauvaise année. Calculée
  // fraîche à CHAQUE requête, heure de Paris pour rester cohérent avec
  // parisMidnightISO() ci-dessus et le fuseau des utilisateurs.
  const todayParisStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  // 🔧 Prompt caching (2026-07-22, backlog item 9) : SYSTEM_PROMPT est
  // statique et identique à CHAQUE appel, y compris les multiples
  // aller-retours d'un même round d'outils — marqué cache_control pour
  // qu'Anthropic ne le refacture qu'une fois par fenêtre de cache plutôt que
  // de le refacturer en entier à chaque appel. La date du jour, elle,
  // change quotidiennement : gardée dans un bloc SÉPARÉ, non caché, placé
  // APRÈS le bloc statique — mélanger les deux aurait invalidé le cache du
  // gros bloc statique une fois par jour pour rien.
  const systemBlocks = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Date du jour (heure de Paris) : ${todayParisStr}. Utilise cette date comme référence fiable pour toute expression temporelle relative ("ce mois-ci", "la semaine prochaine", "hier", "dans 10 jours"...) — ne devine ni n'estime jamais la date actuelle autrement.` },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let toolWasUsed = false;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          system: systemBlocks,
          thinking: { type: "disabled" },
          tools: TOOLS,
          messages,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error("ai-chatbot: Anthropic error", errBody);
        return jsonResponse({ error: "chatbot_failed" }, 500);
      }
      const data = await res.json();
      totalInputTokens += data?.usage?.input_tokens || 0;
      totalOutputTokens += data?.usage?.output_tokens || 0;
      // 🔧 cache_creation_input_tokens (écriture, 1ère fois) et cache_read_
      // input_tokens (lecture, tous les appels suivants dans la fenêtre de
      // cache) sont des champs séparés de input_tokens — jamais inclus
      // dedans — donc à accumuler explicitement pour ne rien sous-compter.
      totalCacheCreationTokens += data?.usage?.cache_creation_input_tokens || 0;
      totalCacheReadTokens += data?.usage?.cache_read_input_tokens || 0;
      const content = data?.content || [];

      if (data?.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content });
        toolWasUsed = true;
        const toolResults = [];
        for (const block of content) {
          if (block.type !== "tool_use") continue;
          const result = await executeTool(block.name, block.input, { userClient, admin, familyId, callerUserId: userId });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // stop_reason "end_turn" (ou autre) : réponse finale.
      const textBlock = content.find((b: any) => b.type === "text");
      const rawAnswer = String(textBlock?.text || "").trim();
      if (!rawAnswer) return jsonResponse({ error: "chatbot_failed" }, 500);

      // 🔧 (2026-07-22) Détection "je ne sais pas" via un marqueur littéral
      // plutôt qu'un test de phrase ("je ne sais pas"...) : le chatbot répond
      // "dans la langue de la question" (voir SYSTEM_PROMPT), donc un test en
      // français raterait toute réponse en anglais/allemand/espagnol/
      // portugais. Le marqueur est retiré avant l'envoi au client — jamais
      // visible dans l'app ni dans l'historique renvoyé par le client au
      // prochain appel.
      const NO_ANSWER_MARKER = "[NO_ANSWER]";
      const isNoAnswer = rawAnswer.startsWith(NO_ANSWER_MARKER);
      const answer = (isNoAnswer ? rawAnswer.slice(NO_ANSWER_MARKER.length) : rawAnswer).trim();
      if (!answer) return jsonResponse({ error: "chatbot_failed" }, 500);

      if (isNoAnswer) {
        try {
          await notifyNoAnswer({ question, answer, userEmail: callerData.user.email || "", familyId, userId });
        } catch (e) {
          console.error("ai-chatbot: notifyNoAnswer failed", e);
        }
      }

      // 🔧 (2026-07-29) N'écrit dans ai_faq_cache que si la réponse est
      // générique (aucun outil utilisé, jamais spécifique à une famille) et
      // que Claude n'a pas répondu [NO_ANSWER] — voir docs/superpowers/specs/
      // 2026-07-29-ai-faq-cache-design.md. Best-effort, jamais fatal. `lang`
      // (colonne indicative/analytique, voir migration) reste volontairement
      // non renseignée dans cette itération : le client n'envoie aujourd'hui
      // aucun champ de langue à ai-chatbot (voir App.jsx, supabase.functions.
      // invoke("ai-chatbot", ...)), et l'ajouter n'apporterait qu'une
      // information indicative — pas nécessaire au fonctionnement du cache
      // (la correspondance pg_trgm sépare déjà naturellement les langues,
      // voir le design doc).
      if (isFirstQuestion && !toolWasUsed && !isNoAnswer
          && question.length <= CACHEABLE_QUESTION_MAX_LEN && !NON_CACHEABLE_INTENT.test(question)) {
        try {
          const { error: cacheErr } = await admin.from("ai_faq_cache").insert({
            question_text: question, answer_text: answer, faq_fingerprint: FAQ_FINGERPRINT,
          });
          if (cacheErr) {
            console.error("ai-chatbot: ai_faq_cache insert failed", cacheErr);
          } else {
            await notifyNewFaqCacheEntry({ question, answer });
          }
        } catch (e) {
          console.error("ai-chatbot: ai_faq_cache write failed", e);
        }
      }

      await admin.from("ai_usage_log").insert({
        user_id: userId, feature: "chatbot_query",
        input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
        cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens,
      });

      // 🔧 cleanHistory ne contient QUE des tours texte user/assistant — jamais
      // les blocs tool_use/tool_result internes à cette requête. Le client
      // renvoie cette valeur telle quelle comme `history` au prochain appel.
      const cleanHistory = [...clientHistory, { role: "user", content: question }, { role: "assistant", content: answer }].slice(-MAX_HISTORY_ENTRIES);
      const exchangeTokens = weightedTokens({
        input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
        cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens,
      });
      const tokensUsedToday = tokensUsedSoFar + exchangeTokens;
      // 🔧 tokens_this_exchange (2026-07-22) : tokens réels de CET échange
      // uniquement (question + tous les aller-retours d'outils inclus, cache
      // de prompt inclus), pas le cumul du jour — pour un affichage "N
      // tokens" sous chaque réponse côté client, distinct de la barre de
      // progression globale.
      return jsonResponse({
        answer, history: cleanHistory, tokens_used_today: tokensUsedToday, tokens_limit: DAILY_TOKEN_LIMIT,
        tokens_this_exchange: exchangeTokens,
      });
    }
    return jsonResponse({ error: "too_many_tool_rounds" }, 500);
  } catch (e) {
    console.error("ai-chatbot: request failed", e);
    return jsonResponse({ error: "chatbot_failed" }, 500);
  }
});
