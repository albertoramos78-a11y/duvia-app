// ─────────────────────────────────────────────────────────────────────────────
// src/utils/core.test.js
// Suite de tests unitaires (runner intégré Node : `node:test`, aucune dépendance).
// Lancer :  TZ=Europe/Paris node --test
// Le fuseau Europe/Paris est requis pour le test de non-régression « fuseau ».
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toStr, pad,
  validatePassword,
  isValidEmail,
  normalizePhoneDigits, isLikelyPhoneIdentifier, identifierToAuthEmail,
  makeRefCode,
  validateVaultFile,
  makeMsgRateLimiter,
  easterDate, pentecostDate, nthWeekday, sameDay, getMothersDayDate,
  containsBadWord, isCleanText,
  upsertMessageById, addReader,
  insertValidatedParent, reconcileOwnParentSlot, placeholderNameFromEmail,
} from "./core.js";

// ── B1 — validatePassword (majuscule + caractère spécial désormais requis) ────
test("validatePassword : refuse trop court", () => {
  assert.match(validatePassword("Ab1!"), /trop court/);
  assert.match(validatePassword(""), /trop court/);
  assert.match(validatePassword(null), /trop court/);
});

test("validatePassword : refuse sans majuscule", () => {
  assert.match(validatePassword("motdepasse!"), /majuscule/);
});

test("validatePassword : refuse sans caractère spécial", () => {
  assert.match(validatePassword("MotDePasse1"), /caractère spécial/);
});

test("validatePassword : accepte un mot de passe conforme", () => {
  assert.equal(validatePassword("MotDePasse!"), null);
  assert.equal(validatePassword("Abcdef1$"), null);
});

test("validatePassword : majuscule accentuée acceptée (À)", () => {
  assert.equal(validatePassword("ÀbcdefG!"), null);
});

test("validatePassword : refuse trop long (>72)", () => {
  assert.match(validatePassword("A!" + "a".repeat(80)), /trop long/);
});

// ── B4 — getMothersDayDate : exception Pentecôte (France) ─────────────────────
test("getMothersDayDate FR 2023 : reportée au 1er dimanche de juin (coïncidence Pentecôte)", () => {
  const d = getMothersDayDate(2023, "FR");
  assert.equal(toStr(d), "2023-06-04"); // PAS 2023-05-28
});

test("getMothersDayDate FR : années sans coïncidence = dernier dimanche de mai", () => {
  assert.equal(toStr(getMothersDayDate(2024, "FR")), "2024-05-26");
  assert.equal(toStr(getMothersDayDate(2025, "FR")), "2025-05-25");
  assert.equal(toStr(getMothersDayDate(2026, "FR")), "2026-05-31");
});

test("getMothersDayDate : l'exception ne s'applique qu'à la France", () => {
  // Espagne : 1er dimanche de mai, indépendant de la Pentecôte.
  assert.equal(toStr(getMothersDayDate(2023, "ES")), "2023-05-07");
});

test("pentecostDate = Pâques + 49 jours", () => {
  assert.equal(toStr(easterDate(2023)), "2023-04-09");
  assert.equal(toStr(pentecostDate(2023)), "2023-05-28");
});

test("nthWeekday : dernier dimanche de mai 2023", () => {
  assert.equal(toStr(nthWeekday(2023, 4, 0, -1)), "2023-05-28");
});

test("sameDay : compare jour/mois/année sans l'heure", () => {
  assert.equal(sameDay(new Date(2024, 0, 1, 9), new Date(2024, 0, 1, 23)), true);
  assert.equal(sameDay(new Date(2024, 0, 1), new Date(2024, 0, 2)), false);
  assert.equal(sameDay(null, new Date()), false);
});

// ── B5 — toStr : non-régression fuseau horaire (date locale, pas UTC) ─────────
test("toStr : renvoie la date LOCALE même juste après minuit (Europe/Paris)", () => {
  // 1er juillet 00:30 heure de Paris (UTC+2 l'été) => UTC = 30 juin 22:30.
  const d = new Date(2024, 6, 1, 0, 30, 0);
  assert.equal(toStr(d), "2024-07-01");
  // Démonstration du bug d'origine : toISOString aurait renvoyé la veille.
  if (process.env.TZ === "Europe/Paris") {
    assert.equal(d.toISOString().slice(0, 10), "2024-06-30");
    assert.notEqual(toStr(d), d.toISOString().slice(0, 10));
  }
});

test("pad : zéro-padding sur 2 chiffres", () => {
  assert.equal(pad(3), "03");
  assert.equal(pad(12), "12");
});

// ── Email / téléphone ─────────────────────────────────────────────────────────
test("isValidEmail", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("parent.test@duvia.fr"), true);
  assert.equal(isValidEmail("pas-un-email"), false);
  assert.equal(isValidEmail("a@b.c"), false); // TLD < 2 caractères
  assert.equal(isValidEmail("a@ b.co"), false); // espace
});

test("normalizePhoneDigits : 06.., +33.., 0033.. convergent vers le même numéro", () => {
  assert.equal(normalizePhoneDigits("06 12 34 56 78"), "33612345678");
  assert.equal(normalizePhoneDigits("+33 6 12 34 56 78"), "33612345678");
  assert.equal(normalizePhoneDigits("0033612345678"), "33612345678");
  assert.equal(normalizePhoneDigits("06.12.34.56.78"), "33612345678");
  assert.equal(normalizePhoneDigits(""), "");
});

test("isLikelyPhoneIdentifier", () => {
  assert.equal(isLikelyPhoneIdentifier("0612345678"), true);
  assert.equal(isLikelyPhoneIdentifier("+33612345678"), true);
  assert.equal(isLikelyPhoneIdentifier("a@b.co"), false); // contient @
  assert.equal(isLikelyPhoneIdentifier("lol"), false);    // pas assez de chiffres
  assert.equal(isLikelyPhoneIdentifier(""), false);
});

test("identifierToAuthEmail", () => {
  assert.equal(identifierToAuthEmail("Parent@Duvia.FR"), "parent@duvia.fr");
  assert.equal(identifierToAuthEmail("06 12 34 56 78"), "tel33612345678@phone.duvia.app");
  // même numéro sous deux formes => même email technique (pas de doublon de compte)
  assert.equal(identifierToAuthEmail("+33612345678"), identifierToAuthEmail("0612345678"));
  assert.equal(identifierToAuthEmail(""), "");
});

// ── Code parrain ──────────────────────────────────────────────────────────────
test("makeRefCode : format DUV-XXXX-0000", () => {
  assert.match(makeRefCode(1718000000000, "marie@duvia.fr"), /^DUV-MARI-\d{4}$/);
  // id court => padding à gauche
  assert.equal(makeRefCode(5, "bob@x.fr"), "DUV-BOBX-0005");
  // email vide => base XXXX
  assert.match(makeRefCode(42, ""), /^DUV-XXXX-0042$/);
});

// ── Fichiers coffre-fort ──────────────────────────────────────────────────────
const mkFile = (name, type, sizeMB) => ({ name, type, size: sizeMB * 1024 * 1024 });
test("validateVaultFile : PDF valide => null", () => {
  assert.equal(validateVaultFile(mkFile("acte.pdf", "application/pdf", 1)), null);
});
test("validateVaultFile : type interdit", () => {
  assert.match(validateVaultFile(mkFile("virus.exe", "application/x-msdownload", 0.1)), /non autorisé/);
});
test("validateVaultFile : trop lourd", () => {
  assert.match(validateVaultFile(mkFile("scan.pdf", "application/pdf", 20)), /trop lourd/);
});
test("validateVaultFile : accepté par extension si mime vide", () => {
  assert.equal(validateVaultFile(mkFile("photo.PNG", "", 0.5)), null);
});
test("validateVaultFile : fichier absent => null", () => {
  assert.equal(validateVaultFile(null), null);
});

// ── Anti-spam messages ────────────────────────────────────────────────────────
test("makeMsgRateLimiter : autorise jusqu'à la limite puis bloque, et libère après 60 s", () => {
  let now = 1_000_000;
  const limiter = makeMsgRateLimiter(3, () => now);
  assert.equal(limiter(), true);
  assert.equal(limiter(), true);
  assert.equal(limiter(), true);
  assert.equal(limiter(), false); // 4e dans la même minute => bloqué
  now += 61_000;                  // une minute plus tard
  assert.equal(limiter(), true);  // la fenêtre glissante s'est vidée
});

// ── Filtre insultes ───────────────────────────────────────────────────────────
test("containsBadWord : détecte insultes directes + leet/ponctuation", () => {
  assert.equal(containsBadWord("espèce de connard"), true);
  assert.equal(containsBadWord("f.u.c.k you"), true);   // collapse ponctuation
  assert.equal(containsBadWord("encul3"), true);        // leet 3->e
  assert.equal(containsBadWord("c0nnard"), true);       // leet 0->o
});
test("isCleanText : laisse passer un texte sain et les mots courts non isolés", () => {
  assert.equal(isCleanText("Bonjour Marie, à demain"), true);
  assert.equal(isCleanText("concert ce soir"), true);   // 'con' ≠ mot entier => OK
  assert.equal(isCleanText("technique de garde"), true);
});
test("containsBadWord : 'con' bloqué uniquement en mot entier", () => {
  assert.equal(containsBadWord("quel con"), true);
  assert.equal(containsBadWord("concombre"), false);
});
test("isCleanText : mots du quotidien ne collisionnent plus avec la liste (regression 2026-07-08)", () => {
  assert.equal(isCleanText("il faut acheter une salopette pour le ski"), true);
  assert.equal(isCleanText("on a pris un pain bâtard à la boulangerie"), true);
  assert.equal(isCleanText("attention à la bordure du trottoir"), true);
  assert.equal(isCleanText("je suis crevé, dure journée"), true);
  assert.equal(isCleanText("j'adore les crevettes"), true);
  assert.equal(isCleanText("arrête de t'engueuler avec ta sœur"), true);
});
test("containsBadWord : les mots déplacés en mot-entier restent détectés isolément", () => {
  assert.equal(containsBadWord("sale salope"), true);
  assert.equal(containsBadWord("quelle ordure"), true);
  assert.equal(containsBadWord("ta gueule"), true);
});

// ── Filtre insultes DE/ES/PT (2026-07-08) ─────────────────────────────────────
test("containsBadWord : détecte les insultes allemandes/espagnoles/portugaises", () => {
  assert.equal(containsBadWord("du bist ein Arschloch"), true);
  assert.equal(containsBadWord("eres un gilipollas"), true);
  assert.equal(containsBadWord("seu idiota"), true);
});
test("isCleanText : mots du quotidien DE/ES/PT ne collisionnent pas", () => {
  assert.equal(isCleanText("das ist idiotensicher"), true);      // 'idiot' en mot-entier only
  assert.equal(isCleanText("das ist Blödsinn"), true);            // 'blöd' en mot-entier only
  assert.equal(isCleanText("tuvimos una disputa sobre el calendario"), true); // 'puta' substring
  assert.equal(isCleanText("tivemos uma disputa sobre o calendário"), true);
});

// ── B3 — dédup messagerie ─────────────────────────────────────────────────────
test("upsertMessageById : n'ajoute pas deux fois le même id (doublon optimiste + realtime)", () => {
  const m = { id: "msg1", content: "salut" };
  const after1 = upsertMessageById([], m);
  assert.equal(after1.length, 1);
  const after2 = upsertMessageById(after1, m); // même message rediffusé par Supabase
  assert.equal(after2.length, 1);
  assert.equal(after2, after1); // référence inchangée => pas de re-render inutile
});
test("upsertMessageById : ajoute bien un message d'id différent", () => {
  const list = upsertMessageById([{ id: "a" }], { id: "b" });
  assert.deepEqual(list.map((m) => m.id), ["a", "b"]);
});
test("addReader : ajoute un lecteur, sans doublon, et tolère read_by absent", () => {
  assert.deepEqual(addReader({ id: "x", read_by: ["u1"] }, "u2").read_by, ["u1", "u2"]);
  const same = { id: "x", read_by: ["u1"] };
  assert.equal(addReader(same, "u1"), same);                 // déjà lecteur => objet inchangé
  assert.deepEqual(addReader({ id: "y" }, "u1").read_by, ["u1"]); // read_by undefined => pas de crash
});

// ── Validation d'invité : le membre validé doit APPARAÎTRE (bug signalé) ──────
test("insertValidatedParent : place l'invité validé en parent 2 (créateur en 1)", () => {
  const parents = [{ name: "Marie", email: "marie@x.fr" }];
  const out = insertValidatedParent(parents, { userId: "uid-B", displayName: "Paul Dupont", email: "paul@x.fr", gender: "M", role: "parent" });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Marie");            // créateur intact
  assert.equal(out[1].userId, "uid-B");
  assert.equal(out[1].name, "Paul Dupont");      // vrai nom serveur, PAS le placeholder email
  assert.equal(out[1].email, "paul@x.fr");
  assert.equal(out[1].gender, "M");
  assert.equal(out[1].inviteStatus, "accepted");
});

test("insertValidatedParent : repli sur la partie locale de l'email si displayName absent", () => {
  const out = insertValidatedParent([{ name: "Marie" }], { userId: "uid-B", email: "paul@x.fr", role: "parent" });
  assert.equal(out[1].name, "paul");
});

test("insertValidatedParent : n'écrase pas un nom déjà présent en parent 2", () => {
  const parents = [{ name: "Marie" }, { name: "Paul Martin", email: "paul@x.fr" }];
  const out = insertValidatedParent(parents, { userId: "uid-B", email: "paul@x.fr", role: "parent" });
  assert.equal(out[1].name, "Paul Martin");
  assert.equal(out[1].userId, "uid-B"); // userId quand même rattaché pour réconciliation
});

test("insertValidatedParent : ignore les rôles non-parent", () => {
  const parents = [{ name: "Marie" }];
  const out = insertValidatedParent(parents, { userId: "uid-O", email: "mamie@x.fr", role: "observer" });
  assert.deepEqual(out, [{ name: "Marie" }]); // inchangé
});

test("placeholderNameFromEmail", () => {
  assert.equal(placeholderNameFromEmail("paul.dupont@x.fr"), "paul.dupont");
  assert.equal(placeholderNameFromEmail(""), "");
});

// ── Réconciliation côté invité : remplace le nom provisoire par le vrai nom ───
test("reconcileOwnParentSlot : l'invité remplace le placeholder par son vrai nom", () => {
  const parents = [{ name: "Marie" }, { userId: "uid-B", name: "paul", email: "paul@x.fr" }];
  const me = { role: "parent", name: "Paul Dupont", email: "paul@x.fr", parentIdx: 1, gender: "M" };
  const out = reconcileOwnParentSlot(parents, me, "uid-B");
  assert.notEqual(out, null);
  assert.equal(out[1].name, "Paul Dupont");
  assert.equal(out[0].name, "Marie"); // l'autre parent intact
});

test("reconcileOwnParentSlot : ne touche pas un vrai nom déjà saisi", () => {
  const parents = [{ name: "Marie" }, { userId: "uid-B", name: "Paul Dupont", email: "paul@x.fr" }];
  const me = { role: "parent", name: "Paul Dupont", email: "paul@x.fr", parentIdx: 1 };
  assert.equal(reconcileOwnParentSlot(parents, me, "uid-B"), null); // aucun changement
});

test("reconcileOwnParentSlot : retrouve son créneau par email si userId absent", () => {
  const parents = [{ name: "Marie" }, { name: "paul", email: "paul@x.fr" }]; // pas de userId écrit
  const me = { role: "parent", name: "Paul Dupont", email: "paul@x.fr" };
  const out = reconcileOwnParentSlot(parents, me, "uid-B");
  assert.notEqual(out, null);
  assert.equal(out[1].name, "Paul Dupont");
  assert.equal(out[1].userId, "uid-B");
});

test("reconcileOwnParentSlot : un observateur ne modifie aucun parent", () => {
  const parents = [{ name: "Marie" }];
  assert.equal(reconcileOwnParentSlot(parents, { role: "observer", name: "Mamie" }, "uid-O"), null);
});

test("reconcileOwnParentSlot : sans correspondance fiable, ignore me.parentIdx (créneau d'une autre famille) — pas de fiche fantôme", () => {
  const parents = [{ name: "Marie" }]; // une seule fiche, aucune ne correspond à "me"
  const me = { role: "parent", name: "AR Cool", email: "moi@autrefamille.fr", parentIdx: 1 };
  assert.equal(reconcileOwnParentSlot(parents, me, "uid-X"), null);
});

// ── Consentement RGPD première utilisation ───────────────────────────────────
import { isRgpdConsentValid, makeRgpdConsentRecord } from "./core.js";

test("makeRgpdConsentRecord : version + horodatage", () => {
  const rec = makeRgpdConsentRecord("2026-06-01", "2026-06-18T10:00:00.000Z");
  assert.equal(rec.version, "2026-06-01");
  assert.equal(rec.acceptedAt, "2026-06-18T10:00:00.000Z");
});

test("isRgpdConsentValid : accepte la bonne version, refuse le reste", () => {
  const raw = JSON.stringify(makeRgpdConsentRecord("2026-06-01", "2026-06-18T10:00:00.000Z"));
  assert.equal(isRgpdConsentValid(raw, "2026-06-01"), true);
  assert.equal(isRgpdConsentValid(raw, "2026-09-01"), false); // version différente => redemander
  assert.equal(isRgpdConsentValid(null, "2026-06-01"), false);
  assert.equal(isRgpdConsentValid("pas du json", "2026-06-01"), false);
  assert.equal(isRgpdConsentValid(JSON.stringify({version:"2026-06-01"}), "2026-06-01"), false); // acceptedAt manquant
});

// ── Verrouillage email parent (l'invité ne doit pas éditer l'autre parent) ────
import { isParentEmailLocked } from "./core.js";

test("isParentEmailLocked : l'invité (idx 1) ne peut PAS éditer l'email du créateur (idx 0)", () => {
  const creator = { name: "ALB2", email: "pere2@gmail.com" }; // pas d'inviteStatus
  assert.equal(isParentEmailLocked(creator, 0, 1), true);
});
test("isParentEmailLocked : mon propre email est verrouillé (lié au compte)", () => {
  assert.equal(isParentEmailLocked({ email: "moi@x.fr" }, 1, 1), true);
});
test("isParentEmailLocked : parent ayant rejoint (userId) verrouillé", () => {
  assert.equal(isParentEmailLocked({ userId: "uid-B", email: "b@x.fr" }, 1, 0), true);
});
test("isParentEmailLocked : créneau parent 2 vierge éditable par le créateur (saisie manuelle avant invitation)", () => {
  assert.equal(isParentEmailLocked({ name: "", email: "" }, 1, 0), false);
});

import { markDepartedParents, effectiveCreatorIdx } from "./core.js";

test("markDepartedParents : créateur parti SANS userId (cas réel) marqué left par élimination", () => {
  const parents = [{ name: "pere3@g.fr", email: "pere3@g.fr" }, { userId: "B", name: "mere3", email: "mere3@g.fr" }];
  const out = markDepartedParents(parents, {
    activeIds: ["B"], inactiveIds: ["A"], myUid: "B", myEmail: "mere3@g.fr",
  });
  assert.equal(out[0].left, true);
  assert.equal(out[1].left, undefined);
});

test("markDepartedParents : invité parti AVEC userId marqué left", () => {
  const parents = [{ userId: "A", email: "a@x.fr" }, { userId: "B", email: "b@x.fr" }];
  const out = markDepartedParents(parents, { activeIds: ["A"], inactiveIds: ["B"], myUid: "A", myEmail: "a@x.fr" });
  assert.equal(out[1].left, true);
  assert.equal(out[0].left, undefined);
});

test("markDepartedParents : ma propre fiche n'est jamais marquée (match par email, sans userId)", () => {
  const parents = [{ name: "moi", email: "moi@x.fr" }, { userId: "B", email: "b@x.fr" }];
  const out = markDepartedParents(parents, { activeIds: ["me", "B"], inactiveIds: [], myUid: "me", myEmail: "moi@x.fr" });
  assert.equal(out, null);
});

test("markDepartedParents : aucun départ → une fiche parent2 vierge n'est PAS marquée", () => {
  const parents = [{ name: "moi", email: "moi@x.fr" }, { name: "", email: "" }];
  assert.equal(markDepartedParents(parents, { activeIds: ["me"], inactiveIds: [], myUid: "me", myEmail: "moi@x.fr" }), null);
});

test("markDepartedParents : invitation en attente jamais marquée même s'il y a un départ", () => {
  const parents = [{ name: "moi", email: "moi@x.fr" }, { email: "invite@x.fr", inviteStatus: "pending" }];
  const out = markDepartedParents(parents, { activeIds: ["me"], inactiveIds: ["gone"], myUid: "me", myEmail: "moi@x.fr" });
  assert.equal(out, null);
});

test("markDepartedParents : idempotent (déjà marqué → null)", () => {
  const parents = [{ email: "pere@x.fr", left: true }, { userId: "B", email: "mere@x.fr" }];
  assert.equal(markDepartedParents(parents, { activeIds: ["B"], inactiveIds: ["A"], myUid: "B", myEmail: "mere@x.fr" }), null);
});

test("markDepartedParents : enregistre leftAt à la date fournie", () => {
  const parents = [{ name: "pere", email: "pere@x.fr" }, { userId: "B", email: "mere@x.fr" }];
  const out = markDepartedParents(parents, {
    activeIds: ["B"], inactiveIds: ["A"], myUid: "B", myEmail: "mere@x.fr", now: "2026-06-22T10:00:00.000Z",
  });
  assert.equal(out[0].left, true);
  assert.equal(out[0].leftAt, "2026-06-22T10:00:00.000Z");
});

test("markDepartedParents : ré-invitation acceptée → la fiche redevient non-partie", () => {
  const parents = [{ userId: "A", email: "a@x.fr", left: true }, { userId: "B", email: "b@x.fr" }];
  const out = markDepartedParents(parents, { activeIds: ["A", "B"], inactiveIds: [], myUid: "B", myEmail: "b@x.fr" });
  assert.equal("left" in out[0], false);
});

test("effectiveCreatorIdx : créateur présent → 0", () => {
  assert.equal(effectiveCreatorIdx([{ userId: "A" }, { userId: "B" }]), 0);
});

test("effectiveCreatorIdx : créateur parti → le parent restant (1) devient créateur", () => {
  assert.equal(effectiveCreatorIdx([{ left: true }, { userId: "B" }]), 1);
});

test("effectiveCreatorIdx : tableau vide ou tous partis → 0 (défaut sûr)", () => {
  assert.equal(effectiveCreatorIdx([]), 0);
  assert.equal(effectiveCreatorIdx([{ left: true }]), 0);
});

test("markDepartedParents : stampe leftAt à la date fournie, le retire au retour", () => {
  const parents = [{ name: "pere", email: "p@x.fr" }, { userId: "B", email: "m@x.fr" }];
  const out = markDepartedParents(parents, { activeIds: ["B"], inactiveIds: ["A"], myUid: "B", myEmail: "m@x.fr", now: "2026-06-22T10:00:00.000Z" });
  assert.equal(out[0].leftAt, "2026-06-22T10:00:00.000Z");
  // ré-invitation acceptée → left ET leftAt disparaissent
  const back = markDepartedParents(out, { activeIds: ["B", "A2"], inactiveIds: [], myUid: "B", myEmail: "m@x.fr" });
  // out[0] n'a pas de userId actif → reste parti ; simulate son retour via userId
  const rejoined = [{ ...out[0], userId: "A2" }, out[1]];
  const back2 = markDepartedParents(rejoined, { activeIds: ["B", "A2"], inactiveIds: [], myUid: "B", myEmail: "m@x.fr" });
  assert.equal("leftAt" in back2[0], false);
  assert.equal("left" in back2[0], false);
});

import { formatActorName } from "./core.js";

test("formatActorName : renvoie le nom tel quel si la personne est toujours active", () => {
  const removed = new Set(["uid-toti"]);
  assert.strictEqual(formatActorName("Sissi", "uid-sissi", removed), "Sissi");
});

test("formatActorName : ajoute (parti) si le userId est dans removedUserIds", () => {
  const removed = new Set(["uid-toti"]);
  assert.strictEqual(formatActorName("Toti", "uid-toti", removed), "Toti (parti)");
});

test("formatActorName : pas de userId → nom tel quel (ancienne ligne sans instantané)", () => {
  const removed = new Set(["uid-toti"]);
  assert.strictEqual(formatActorName("Parent 1", null, removed), "Parent 1");
});

test("formatActorName : removedUserIds absent (famille pas encore chargée) → nom tel quel", () => {
  assert.strictEqual(formatActorName("Toti", "uid-toti", null), "Toti");
});

test("formatActorName : nom vide → chaîne vide", () => {
  assert.strictEqual(formatActorName("", "uid-toti", new Set(["uid-toti"])), "");
});

import { makeSchoolHolIdentity } from "./core.js";

test("makeSchoolHolIdentity : capture userId et name du parent à l'index donné", () => {
  const parents = [{ name: "Sissi", userId: "uid-sissi" }, { name: "Toti", userId: "uid-toti" }];
  assert.deepStrictEqual(makeSchoolHolIdentity(parents, 1), { u: "uid-toti", n: "Toti" });
});

test("makeSchoolHolIdentity : parent sans userId (pas encore lié à un compte) → u null", () => {
  const parents = [{ name: "Sissi" }];
  assert.deepStrictEqual(makeSchoolHolIdentity(parents, 0), { u: null, n: "Sissi" });
});

test("makeSchoolHolIdentity : index hors tableau → u et n null", () => {
  const parents = [{ name: "Sissi", userId: "uid-sissi" }];
  assert.deepStrictEqual(makeSchoolHolIdentity(parents, 5), { u: null, n: null });
});

import { toggleMessageReaction } from "./core.js";

test("toggleMessageReaction : ajoute une réaction quand il n'y en avait aucune", () => {
  const result = toggleMessageReaction({}, "uid-a", "👍");
  assert.deepEqual(result, { "👍": ["uid-a"] });
});

test("toggleMessageReaction : change de réaction (l'ancienne disparaît)", () => {
  const result = toggleMessageReaction({ "👍": ["uid-a"] }, "uid-a", "❤️");
  assert.deepEqual(result, { "❤️": ["uid-a"] });
});

test("toggleMessageReaction : retaper la même réaction la retire (bascule off)", () => {
  const result = toggleMessageReaction({ "👍": ["uid-a"] }, "uid-a", "👍");
  assert.deepEqual(result, {});
});

test("toggleMessageReaction : ne touche pas aux réactions des autres personnes", () => {
  const result = toggleMessageReaction({ "👍": ["uid-a", "uid-b"] }, "uid-a", "❤️");
  assert.deepEqual(result, { "👍": ["uid-b"], "❤️": ["uid-a"] });
});

test("toggleMessageReaction : reactions null/undefined traité comme vide", () => {
  assert.deepEqual(toggleMessageReaction(null, "uid-a", "😂"), { "😂": ["uid-a"] });
  assert.deepEqual(toggleMessageReaction(undefined, "uid-a", "😂"), { "😂": ["uid-a"] });
});

import { isMemberIdentityLocked } from "./core.js";

test("isMemberIdentityLocked : verrouillé si userId présent (compte réel lié)", () => {
  assert.equal(isMemberIdentityLocked({ userId: "abc-123", email: "x@y.z" }), true);
});

test("isMemberIdentityLocked : pas verrouillé sans userId (jamais rejoint)", () => {
  assert.equal(isMemberIdentityLocked({ email: "x@y.z" }), false);
});

test("isMemberIdentityLocked : entrée null/undefined traitée comme non verrouillée", () => {
  assert.equal(isMemberIdentityLocked(null), false);
  assert.equal(isMemberIdentityLocked(undefined), false);
});

import { parseGuardId, resolveCustomDateGuardians, toggleGuardId, guardianStripeBackground, guardianNamesLabel } from "./core.js";

test("parseGuardId : parent préfixé p:", () => {
  assert.deepEqual(parseGuardId("p:123"), { type: "parent", id: "123" });
});

test("parseGuardId : observateur préfixé obs:", () => {
  assert.deepEqual(parseGuardId("obs:abc-def"), { type: "observer", id: "abc-def" });
});

test("parseGuardId : préfixe inconnu ou vide → null", () => {
  assert.equal(parseGuardId("xyz:1"), null);
  assert.equal(parseGuardId(""), null);
  assert.equal(parseGuardId(null), null);
  assert.equal(parseGuardId(undefined), null);
});

test("resolveCustomDateGuardians : lit guardIds (parent + observateur)", () => {
  const parents = [{ id: 1, name: "Alberto", color: "#0000ff" }, { id: 2, name: "Sissi", color: "#ec4899" }];
  const observers = [{ id: "obs-1", name: "Isa", color: null, canGuard: true }];
  const cd = { guardIds: ["p:2", "obs:obs-1"] };
  const result = resolveCustomDateGuardians(cd, parents, observers);
  assert.deepEqual(result, [
    { type: "parent", id: "2", name: "Sissi", color: "#ec4899", avatar: null },
    { type: "observer", id: "obs-1", name: "Isa", color: null, avatar: null },
  ]);
});

test("resolveCustomDateGuardians : fallback legacy parentId (une seule chaîne, pas de préfixe)", () => {
  const parents = [{ id: 1, name: "Alberto", color: "#0000ff" }];
  const cd = { parentId: "1" };
  const result = resolveCustomDateGuardians(cd, parents, []);
  assert.deepEqual(result, [{ type: "parent", id: "1", name: "Alberto", color: "#0000ff", avatar: null }]);
});

test("resolveCustomDateGuardians : guardIds vide ou absent → tableau vide (calendrier par défaut)", () => {
  assert.deepEqual(resolveCustomDateGuardians({ guardIds: [] }, [], []), []);
  assert.deepEqual(resolveCustomDateGuardians({}, [], []), []);
  assert.deepEqual(resolveCustomDateGuardians(null, [], []), []);
});

test("resolveCustomDateGuardians : guardIds explicitement vide prime sur parentId legacy (désélection)", () => {
  const parents = [{ id: 1, name: "Alberto", color: "#0000ff" }];
  const cd = { guardIds: [], parentId: "1" };
  assert.deepEqual(resolveCustomDateGuardians(cd, parents, []), []);
});

test("resolveCustomDateGuardians : id qui ne correspond plus à personne est ignoré silencieusement", () => {
  const parents = [{ id: 1, name: "Alberto", color: "#0000ff" }];
  const cd = { guardIds: ["p:1", "p:999", "obs:ghost"] };
  const result = resolveCustomDateGuardians(cd, parents, []);
  assert.deepEqual(result, [{ type: "parent", id: "1", name: "Alberto", color: "#0000ff", avatar: null }]);
});

test("toggleGuardId : ajoute si absent", () => {
  assert.deepEqual(toggleGuardId(["p:1"], "obs:2"), ["p:1", "obs:2"]);
});

test("toggleGuardId : retire si déjà présent", () => {
  assert.deepEqual(toggleGuardId(["p:1", "obs:2"], "p:1"), ["obs:2"]);
});

test("toggleGuardId : tableau absent traité comme vide", () => {
  assert.deepEqual(toggleGuardId(null, "p:1"), ["p:1"]);
  assert.deepEqual(toggleGuardId(undefined, "p:1"), ["p:1"]);
});

test("guardianStripeBackground : null si moins de 2 gardiens", () => {
  assert.equal(guardianStripeBackground([]), null);
  assert.equal(guardianStripeBackground([{ color: "#ec4899" }]), null);
});

test("guardianStripeBackground : dégradé à bandes égales pour 2 gardiens", () => {
  const result = guardianStripeBackground([{ color: "#ec4899" }, { color: "#0000ff" }]);
  assert.equal(result, "linear-gradient(to right, #ec489940 0%, #ec489940 50%, #0000ff40 50%, #0000ff40 100%)");
});

test("guardianStripeBackground : couleur de repli si un gardien n'a pas de couleur", () => {
  const result = guardianStripeBackground([{ color: null }, { color: "#0000ff" }]);
  assert.equal(result, "linear-gradient(to right, #71717a40 0%, #71717a40 50%, #0000ff40 50%, #0000ff40 100%)");
});

test("guardianNamesLabel : joint les prénoms avec ' + '", () => {
  assert.equal(guardianNamesLabel([{ name: "Sissi" }, { name: "Alberto" }]), "Sissi + Alberto");
});

test("guardianNamesLabel : ignore les entrées sans nom, tableau vide → chaîne vide", () => {
  assert.equal(guardianNamesLabel([{ name: "" }, { name: "Isa" }]), "Isa");
  assert.equal(guardianNamesLabel([]), "");
});
