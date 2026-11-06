// scripts/test-research.ts — sujets, import, états, prompt et contrôle des URL (spec §5.2). Le réseau n'est jamais utilisé : `fetch` et le DNS
// sont injectés. Fixtures synthétiques seulement.
import fs from 'node:fs';
import path from 'node:path';
import { createCollection, readCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { readPrintBook } from '../src/data/pricing-file';
import { createSubject, firstPageOf, keepDatedCopies, QR_LEGEND_DEFAULT, readResearch, readSubject, RESEARCH_FILE, SubjectRefused, subjectFolder, subjectIdFor, SUBJECT_FILE, updateSubject } from '../src/data/subject-file';
import { expectedBlocks } from '../src/research/blocks';
import { ResearchRefused } from '../src/research/errors';
import { checkAgainst, mergeImport, parseResearch } from '../src/research/import';
import { AGE_TARGET, researchPrompt } from '../src/research/prompt';
import { applyBlockAction, applyClaimAction, type Data } from '../src/research/state';
import { checkUrl, checkUrls, isPrivateAddress, MAX_REDIRECTS, type UrlDeps } from '../src/research/url-check';
import { researchJsonSchema } from '../src/schema/research';
import { TEMPLATE_2A } from '../src/templates/2A';
import { FIRST_SUBJECT_PAGE, TEMPLATES, templateFits } from '../src/templates';
import { makeResearch } from './fixtures/recherche';
import { BOOK_ID, dirLink, fileLink, put, tempDir } from './fixtures/make-glbi';
import { SCHEMA_FILE, schemaText } from './gen-research-schema';
import { check, finish } from './test-lib';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const refusal = (fn: () => unknown): string => {
  try {
    fn();
    return '';
  } catch (e) {
    return e instanceof ResearchRefused || e instanceof SubjectRefused ? e.message : `AUTRE : ${(e as Error).message}`;
  }
};
const refused = (name: string, fn: () => unknown, text: string) => {
  const m = refusal(fn);
  check(name, m.includes(text) && !m.startsWith('AUTRE'), m);
};

// Schéma exporté
check('schéma versionné identique au schéma généré', fs.readFileSync(SCHEMA_FILE, 'utf8').replace(/\r\n/g, '\n') === schemaText());
check('schéma exporté : objets stricts', (researchJsonSchema() as { additionalProperties?: boolean }).additionalProperties === false);

// Données
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
createBookFolder(dataRoot, BOOK_ID);
createCollection(dataRoot);
const collection = readCollection(dataRoot)!;
const themes = Object.keys(collection.style.palette.themes);
const fiche = collection.style.fiche;
const expected = expectedBlocks(TEMPLATE_2A, fiche, 'fr');
const SCENES = ['alpha', 'beta', 'Gamma_2', 'nul', 'delta_', 'DELTA'];
const newSubject = (sceneId: string, over = {}) => createSubject(dataRoot, BOOK_ID, { sceneId, pages: 2, template: '2A', theme: 'foret', ...over }, SCENES, themes);
const book = () => readPrintBook(dataRoot, BOOK_ID).book!;
const bookFile = path.join(dataRoot, BOOK_ID, 'print-book.json');

// Identifiant
check('identifiant : minuscules et tirets', subjectIdFor('Gamma_2') === 'gamma-2' && subjectIdFor('alpha') === 'alpha');
check('identifiant : tirets répétés ou finaux retirés', subjectIdFor('a__b_') === 'a-b');
refused('identifiant : nom réservé par Windows', () => subjectIdFor('NUL'), 'réservé par Windows');
refused('identifiant : scène invalide', () => subjectIdFor('../x'), 'Scène refusée');

// Création
const created = newSubject('alpha');
check('création : sujet écrit, brouillon, sans bloc', created.id === 'alpha' && created.status === 'brouillon' && created.blocks.length === 0 && created.illustrations.length === 0);
check('création : légende générique', created.qrLegend?.fr === QR_LEGEND_DEFAULT.fr);
check('création : titre lu dans la scène', Object.keys(created.title).length === 0 && created.sceneId === 'alpha');
check('création : ajouté au livre', book().subjects.join() === 'alpha');
check('création : fichier relu', readSubject(dataRoot, BOOK_ID, 'alpha').template === '2A');
check('création : aucun fichier temporaire', fs.readdirSync(subjectFolder(dataRoot, BOOK_ID, 'alpha')!).join() === SUBJECT_FILE);
check('création : pageBudget inchangé', book().pageBudget === 46);
refused('création : même sujet deux fois', () => newSubject('alpha'), 'existe déjà');
refused('création : scène inconnue', () => newSubject('omega'), 'Scène inconnue');
refused('création : gabarit inconnu', () => newSubject('beta', { template: '2Z' }), 'Gabarit inconnu');
refused('création : gabarit, nom de prototype', () => newSubject('beta', { template: 'constructor' }), 'Gabarit inconnu');
refused('création : pages et gabarit différents', () => newSubject('beta', { pages: 4 }), 'a 2 pages');
refused('création : thème inconnu', () => newSubject('beta', { theme: 'rose' }), 'Thème inconnu');
refused('création : nom réservé', () => newSubject('nul'), 'réservé par Windows');
check('création refusée : livre inchangé', book().subjects.join() === 'alpha');
newSubject('Gamma_2');
check('création : identifiant dérivé de la scène', book().subjects.join() === 'alpha,gamma-2' && readSubject(dataRoot, BOOK_ID, 'gamma-2').sceneId === 'Gamma_2');
newSubject('delta_');
refused('création : deux scènes pour un même identifiant', () => newSubject('DELTA'), 'existe déjà');
fs.mkdirSync(path.join(dataRoot, BOOK_ID, 'subjects', 'beta'));
refused('création : dossier orphelin conservé', () => newSubject('beta'), 'existe déjà');
fs.rmdirSync(path.join(dataRoot, BOOK_ID, 'subjects', 'beta'));

// Pages
check('première page : somme des sujets précédents', firstPageOf(dataRoot, book(), 'alpha') === FIRST_SUBJECT_PAGE && firstPageOf(dataRoot, book(), 'gamma-2') === FIRST_SUBJECT_PAGE + 2 && firstPageOf(dataRoot, book(), 'delta') === FIRST_SUBJECT_PAGE + 4);
check('page suivante : après le dernier sujet', firstPageOf(dataRoot, book(), '') === FIRST_SUBJECT_PAGE + 6);
check('registre : 2A passe en page paire, pas en page impaire', templateFits(TEMPLATES['2A']!, 8) && !templateFits(TEMPLATES['2A']!, 9));
check('registre : un gabarit libre se pose partout', templateFits({ ...TEMPLATE_2A, start: 'libre' }, 9));
{
  const saved = fs.readFileSync(bookFile, 'utf8');
  const odd = path.join(subjectFolder(dataRoot, BOOK_ID, 'delta')!, SUBJECT_FILE);
  const value = JSON.parse(fs.readFileSync(odd, 'utf8'));
  fs.writeFileSync(odd, JSON.stringify({ ...value, pages: 3, template: '3A' }));
  refused('côté de départ incompatible : refus', () => newSubject('beta'), 'ne peut pas commencer en page 13');
  fs.writeFileSync(odd, JSON.stringify(value));
  fs.writeFileSync(bookFile, saved);
}

// Écriture : liens et fichiers invalides
{
  const dir = subjectFolder(dataRoot, BOOK_ID, 'alpha')!;
  const file = path.join(dir, SUBJECT_FILE);
  const saved = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ abîmé');
  refused('écriture : JSON illisible refusé', () => updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => d), 'JSON valide');
  check('écriture : fichier illisible conservé', fs.readFileSync(file, 'utf8') === '{ abîmé');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), pages: 1 }));
  const invalid = fs.readFileSync(file, 'utf8');
  refused('écriture : schéma invalide refusé', () => updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => d), 'invalide');
  check('écriture : fichier invalide conservé', fs.readFileSync(file, 'utf8') === invalid);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), id: 'autre' }));
  refused('écriture : autre identifiant refusé', () => readSubject(dataRoot, BOOK_ID, 'alpha'), 'porte l\'identifiant autre');
  fs.writeFileSync(file, saved);

  const research = path.join(dir, RESEARCH_FILE);
  fs.writeFileSync(research, '{}');
  refused('écriture : research.json invalide refusé', () => updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => d), 'research.json invalide');
  check('écriture : research.json invalide conservé', fs.readFileSync(research, 'utf8') === '{}');
  fs.rmSync(research);

  const saneBook = fs.readFileSync(bookFile, 'utf8');
  fs.writeFileSync(bookFile, '{');
  refused('écriture : print-book.json illisible refusé', () => newSubject('beta'), 'print-book.json');
  check('écriture : print-book.json illisible conservé', fs.readFileSync(bookFile, 'utf8') === '{');
  fs.writeFileSync(bookFile, saneBook);

  fs.renameSync(file, `${file}.vrai`);
  if (fileLink(`${file}.vrai`, file)) {
    refused('lien : subject.json refusé', () => readSubject(dataRoot, BOOK_ID, 'alpha'), 'fichier réel');
    fs.rmSync(file);
  }
  fs.renameSync(`${file}.vrai`, file);

  fs.renameSync(bookFile, `${bookFile}.vrai`);
  if (fileLink(`${bookFile}.vrai`, bookFile)) {
    refused('lien : print-book.json refusé', () => newSubject('beta'), 'fichier réel');
    fs.rmSync(bookFile);
  }
  fs.renameSync(`${bookFile}.vrai`, bookFile);
  refused('sujet absent', () => readSubject(dataRoot, BOOK_ID, 'inconnu'), 'Dossier du sujet inconnu absent');
  refused('identifiant de sujet refusé', () => subjectFolder(dataRoot, BOOK_ID, '../alpha'), 'Sujet refusé');
}

// Liens de dossier. Une jonction ne se retire pas sans risque sous Windows : chaque cas a son propre dossier de données, et le lien y reste.
const linkedBook = () => {
  const root = path.join(tempDir(), 'donnees');
  fs.mkdirSync(root);
  createBookFolder(root, BOOK_ID);
  createSubject(root, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha'], ['foret']);
  return root;
};
{
  const root = linkedBook();
  const dir = path.join(root, BOOK_ID, 'subjects', 'alpha');
  const moved = path.join(tempDir(), 'alpha');
  fs.cpSync(dir, moved, { recursive: true });
  fs.rmSync(dir, { recursive: true });
  dirLink(moved, dir);
  const before = fs.readFileSync(path.join(moved, SUBJECT_FILE), 'utf8');
  refused('lien : dossier du sujet refusé en lecture', () => readSubject(root, BOOK_ID, 'alpha'), 'dossier réel');
  refused('lien : dossier du sujet refusé en écriture', () => updateSubject(root, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, status: 'relu' } })), 'dossier réel');
  check('lien : la cible n’est pas touchée', fs.readFileSync(path.join(moved, SUBJECT_FILE), 'utf8') === before);
}
{
  const root = linkedBook();
  const subjects = path.join(root, BOOK_ID, 'subjects');
  const outside = tempDir();
  fs.rmSync(subjects, { recursive: true });
  dirLink(outside, subjects);
  refused('lien : dossier subjects/ refusé', () => subjectFolder(root, BOOK_ID, 'alpha'), 'dossier réel');
  refused('lien : création refusée sous subjects/ lié', () => createSubject(root, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2A', theme: 'foret' }, ['beta'], ['foret']), 'dossier réel');
  check('lien : rien d’écrit dans la cible', fs.readdirSync(outside).length === 0);
}

// Blocs attendus
check('blocs attendus : chapeau, texte et une valeur par information', expected.map((b) => b.id).join() === 'chapeau,texte,fiche-taille,fiche-poids,fiche-epoque,fiche-regime,fiche-lieu', expected);
check('blocs attendus : limites de la zone', expected[0]!.maxChars === 140 && expected[1]!.maxChars === 600 && expected[2]!.maxChars === 28);
check('blocs attendus : ni titre, ni QR, ni folio', !expected.some((b) => /titre|qr|folio|bandeau|illustration/.test(b.zone)));
check('blocs attendus : libellé de la fiche dans la langue', expected[2]!.label === 'Taille' && expectedBlocks(TEMPLATE_2A, fiche, 'en')[2]!.label === fiche[0]!.label.en);

// Prompt
{
  const prompt = researchPrompt({ subjectId: 'alpha', subjectTitle: 'Alpha fr', bookTitle: 'Livre fr', lang: 'fr', templateId: '2A', pages: 2, blocks: expected, today: '2026-11-06' });
  check('prompt : sujet, âge, langue, gabarit', ['Alpha fr', AGE_TARGET, 'français', 'Gabarit : 2A', 'alpha', 'sujet de 2 pages'].every((t) => prompt.includes(t)));
  check('prompt : chaque bloc avec sa limite', prompt.includes('"zone": "texte", "type": "texte" : texte, 600 caractères au plus') && prompt.includes('"item": "taille"') && prompt.includes('28 caractères au plus'));
  check('prompt : règles du §5.2', ['Une source au moins par affirmation', 'paraphrase', 'Aucune citation longue', 'fait débattu', 'debattue'].every((t) => prompt.includes(t)));
  check('prompt : schéma inclus', prompt.includes(JSON.stringify(researchJsonSchema(), null, 2)));
  const code = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'research', 'prompt.ts'), 'utf8');
  check('prompt : modèle générique, aucun sujet du livre', !/dinosaure|rex|paléonto/i.test(code));
}

// Import : lecture
const text = (change: (f: any) => void = () => {}) => {
  const f = makeResearch();
  change(f);
  return JSON.stringify(f);
};
const parseRefused = (name: string, change: (f: any) => void, field: string) => refused(`import : ${name}`, () => parseResearch(text(change)), `champ ${field}`);
check('import : fichier valide', parseResearch(text()).claims.length === 3);
check('import : BOM accepté', parseResearch(`﻿${text()}`).subjectId === 'alpha');
refused('import : JSON invalide', () => parseResearch('{'), 'JSON valide');
parseRefused('champ manquant, nommé', (f) => delete f.generatedAt, 'generatedAt');
parseRefused('champ inconnu', (f) => { f.plus = 1; }, '(racine)');
parseRefused('affirmation sans source', (f) => { f.claims[1].sources = []; }, 'claims.1.sources');
parseRefused('source sans url', (f) => delete f.claims[0].sources[0].url, 'claims.0.sources.0.url');
parseRefused('URL en javascript:', (f) => { f.claims[0].sources[0].url = 'javascript:alert(1)'; }, 'claims.0.sources.0.url');
parseRefused('paraphrase trop longue', (f) => { f.claims[0].sources[0].support = 'x'.repeat(401); }, 'claims.0.sources.0.support');
parseRefused('confiance inconnue', (f) => { f.claims[0].confidence = 'moyenne'; }, 'claims.0.confidence');
parseRefused('affirmation en double', (f) => { f.claims[1].id = 'c1'; }, 'claims.1.id');
parseRefused('bloc citant une affirmation inconnue', (f) => { f.blocks[1].claims[0] = 'c9'; }, 'blocks.1.claims.0');
parseRefused('bloc sans affirmation', (f) => { f.blocks[0].claims = []; }, 'blocks.0.claims');
parseRefused('bloc de type inconnu', (f) => { f.blocks[0].type = 'titre'; }, 'blocks.0.type');
parseRefused('version inconnue', (f) => { f.schemaVersion = 2; }, 'schemaVersion');
parseRefused('langue inconnue', (f) => { f.lang = 'de'; }, 'lang');

const against = (change: (f: any) => void = () => {}) => () => checkAgainst(JSON.parse(text(change)), 'alpha', 'fr', expected);
check('import : fichier conforme au gabarit', refusal(against()) === '');
refused('import : mauvais subjectId', against((f) => { f.subjectId = 'beta'; }), 'champ subjectId');
refused('import : mauvaise langue', against((f) => { f.lang = 'en'; }), 'champ lang');
refused('import : zone inconnue', against((f) => { f.blocks[0].zone = 'autre'; }), 'champ blocks.0.zone');
refused('import : information de fiche inconnue', against((f) => { f.blocks[2].item = 'autre'; }), 'champ blocks.2.zone');
refused('import : type différent de la zone', against((f) => { f.blocks[0].type = 'texte'; }), 'champ blocks.0.type');
refused('import : bloc en double', against((f) => { f.blocks.push(f.blocks[0]); }), 'bloc en double');
refused('import : bloc manquant', against((f) => { f.blocks.splice(1, 1); }), 'bloc manquant, texte');
check('import : texte trop long accepté (compteur et C12)', refusal(against((f) => { f.blocks[0].text = 'x'.repeat(500); })) === '');

// Import : premier import
const subject0 = readSubject(dataRoot, BOOK_ID, 'alpha');
const first = mergeImport(makeResearch(), null, subject0, expected);
check('premier import : affirmations proposées', first.research.claims.every((c) => c.status === 'propose' && c.validatedAt === null && c.note === ''));
check('premier import : blocs à relire, type du gabarit', first.subject.blocks.length === 7 && first.subject.blocks.every((b) => b.state === 'a-relire') && first.subject.blocks[2]!.id === 'fiche-taille');
check('premier import : texte dans la langue', first.subject.blocks[0]!.text.fr!.startsWith('Voici'));
check('premier import : brouillon', first.subject.status === 'brouillon' && !first.same);

// États
const fresh = (): Data => structuredClone({ subject: first.subject, research: first.research });
const claimOf = (d: Data, id: string) => d.research.claims.find((c) => c.id === id)!;
const blockOf = (d: Data, id: string) => d.subject.blocks.find((b) => b.id === id)!;
const act = (d: Data, id: string, kind: 'valider' | 'rejeter') => applyClaimAction(d, id, { kind }, NOW);
const fix = (d: Data, id: string, text: string) => applyClaimAction(d, id, { kind: 'corriger', text }, NOW);
const validateAll = () => {
  let d = fresh();
  for (const id of ['c1', 'c2', 'c3']) d = act(d, id, 'valider');
  for (const b of d.subject.blocks) d = applyBlockAction(d, b.id, { kind: 'valider' });
  return d;
};
{
  const d = act(fresh(), 'c1', 'valider');
  check('affirmation : proposée → validée, datée', claimOf(d, 'c1').status === 'valide' && claimOf(d, 'c1').validatedAt === NOW.toISOString());
  check('affirmation validée : bloc inchangé', blockOf(d, 'chapeau').state === 'a-relire');
  refused('affirmation : déjà validée', () => act(d, 'c1', 'valider'), 'déjà validée');
  const r = act(fresh(), 'c1', 'rejeter');
  check('affirmation : proposée → rejetée', claimOf(r, 'c1').status === 'rejete' && claimOf(r, 'c1').validatedAt === null);
  check('rejet : blocs qui la citent à reprendre, même à relire', blockOf(r, 'chapeau').state === 'a-reprendre' && blockOf(r, 'fiche-lieu').state === 'a-reprendre');
  check('rejet : les autres blocs ne bougent pas', blockOf(r, 'texte').state === 'a-relire');
  refused('affirmation : déjà rejetée', () => act(r, 'c1', 'rejeter'), 'déjà rejetée');
  const back = act(r, 'c1', 'valider');
  check('affirmation : rejetée → validée', claimOf(back, 'c1').status === 'valide');
  const c = fix(fresh(), 'c1', '  Texte de David.  ');
  check('affirmation : proposée → corrigée', claimOf(c, 'c1').status === 'corrige' && claimOf(c, 'c1').correctedText === 'Texte de David.' && claimOf(c, 'c1').text.startsWith('Le Fictivore'));
  check('correction d’une proposition : blocs inchangés', blockOf(c, 'chapeau').state === 'a-relire');
  refused('correction vide', () => fix(fresh(), 'c1', '   '), 'Correction vide');
  refused('affirmation inconnue', () => act(fresh(), 'c9', 'valider'), 'Affirmation inconnue');
  const n = applyClaimAction({ ...fresh(), subject: { ...fresh().subject, status: 'relu' } }, 'c1', { kind: 'note', text: 'à revoir' }, NOW);
  check('note : ni statut ni brouillon', claimOf(n, 'c1').note === 'à revoir' && claimOf(n, 'c1').status === 'propose' && n.subject.status === 'relu');
}
{
  refused('bloc : affirmations non validées', () => applyBlockAction(act(fresh(), 'c2', 'valider'), 'texte', { kind: 'valider' }), 'non validées, c3');
  let d = act(fresh(), 'c1', 'valider');
  d = applyBlockAction(d, 'chapeau', { kind: 'valider' });
  check('bloc : validé quand toutes ses affirmations le sont', blockOf(d, 'chapeau').state === 'valide');
  check('corrigée compte comme validée', blockOf(applyBlockAction(fix(fresh(), 'c1', 'Corrigé.'), 'chapeau', { kind: 'valider' }), 'chapeau').state === 'valide');
  const after = fix(d, 'c1', 'Corrigé après.');
  check('correction après validation : blocs à reprendre', blockOf(after, 'chapeau').state === 'a-reprendre' && blockOf(after, 'fiche-lieu').state === 'a-reprendre');
  const again = fix(fix(fresh(), 'c1', 'Une.'), 'c1', 'Deux.');
  check('seconde correction : le bloc repart à reprendre', blockOf(again, 'chapeau').state === 'a-reprendre');
  const rejected = act(d, 'c1', 'rejeter');
  check('rejet après validation : bloc à reprendre', blockOf(rejected, 'chapeau').state === 'a-reprendre');
  check('bloc à reprendre : revalidé après correction', blockOf(applyBlockAction(after, 'chapeau', { kind: 'valider' }), 'chapeau').state === 'valide');
  const edited = applyBlockAction(d, 'chapeau', { kind: 'texte', text: 'Nouveau.' });
  check('texte d’un bloc validé : à relire', blockOf(edited, 'chapeau').state === 'a-relire' && blockOf(edited, 'chapeau').text.fr === 'Nouveau.');
  check('texte d’un bloc à reprendre : reste à reprendre', blockOf(applyBlockAction(after, 'chapeau', { kind: 'texte', text: 'X' }), 'chapeau').state === 'a-reprendre');
  check('même texte : rien ne change', blockOf(applyBlockAction(d, 'chapeau', { kind: 'texte', text: blockOf(d, 'chapeau').text.fr! }), 'chapeau').state === 'valide');
  refused('bloc sans texte : refusé', () => applyBlockAction(applyBlockAction(act(fresh(), 'c1', 'valider'), 'chapeau', { kind: 'texte', text: '  ' }), 'chapeau', { kind: 'valider' }), 'sans texte');
  refused('bloc inconnu', () => applyBlockAction(fresh(), 'autre', { kind: 'valider' }), 'Bloc inconnu');

  // Citations
  const r = act(act(fresh(), 'c3', 'rejeter'), 'c2', 'valider');
  check('citation rejetée : bloc à reprendre', blockOf(r, 'texte').state === 'a-reprendre');
  const cut = applyBlockAction(r, 'texte', { kind: 'citer', claims: ['c2'] });
  check('citation retirée : le bloc peut être validé', blockOf(applyBlockAction(cut, 'texte', { kind: 'valider' }), 'texte').state === 'valide');
  refused('citation : au moins une', () => applyBlockAction(fresh(), 'texte', { kind: 'citer', claims: [] }), 'au moins une');
  refused('citation : affirmation inconnue', () => applyBlockAction(fresh(), 'texte', { kind: 'citer', claims: ['c9'] }), 'Affirmation inconnue');
  refused('citation : deux fois', () => applyBlockAction(fresh(), 'texte', { kind: 'citer', claims: ['c2', 'c2'] }), 'deux fois');
  const added = applyBlockAction(validateAll(), 'chapeau', { kind: 'citer', claims: ['c1', 'c2'] });
  check('citation changée sur un bloc validé : à relire', blockOf(added, 'chapeau').state === 'a-relire' && blockOf(added, 'chapeau').claims.join() === 'c1,c2');

  // Brouillon
  const relu = validateAll();
  relu.subject.status = 'relu';
  check('correction : sujet relu repasse en brouillon', fix(structuredClone(relu), 'c1', 'Autre.').subject.status === 'brouillon');
  check('rejet : sujet relu repasse en brouillon', act(structuredClone(relu), 'c1', 'rejeter').subject.status === 'brouillon');
  check('texte : sujet relu repasse en brouillon', applyBlockAction(structuredClone(relu), 'chapeau', { kind: 'texte', text: 'X' }).subject.status === 'brouillon');
  check('citation : sujet relu repasse en brouillon', applyBlockAction(structuredClone(relu), 'chapeau', { kind: 'citer', claims: ['c2'] }).subject.status === 'brouillon');
  check('même texte : sujet relu inchangé', applyBlockAction(structuredClone(relu), 'chapeau', { kind: 'texte', text: blockOf(relu, 'chapeau').text.fr! }).subject.status === 'relu');
}

// Second import
{
  const base = validateAll();
  const edited = fix(applyBlockAction(base, 'texte', { kind: 'texte', text: 'Texte de David.' }), 'c1', 'Fait corrigé par David.');
  const noted = applyClaimAction(edited, 'c2', { kind: 'note', text: 'Vu.' }, NOW);
  const redone = applyBlockAction(applyBlockAction(noted, 'chapeau', { kind: 'valider' }), 'fiche-lieu', { kind: 'valider' });
  redone.research.claims[1]!.sources[0]!.urlCheck = { date: NOW.toISOString(), code: 200, error: null };
  redone.subject.status = 'relu';

  const same = mergeImport(makeResearch(), redone.research, redone.subject, expected);
  check('second import identique : rien ne change', same.same && same.summary.claimsKept === 3 && same.summary.blocksKept === 7);
  check('second import identique : correction, note et contrôle gardés', claimOf(same, 'c1').correctedText === 'Fait corrigé par David.' && claimOf(same, 'c1').status === 'corrige' && claimOf(same, 'c2').note === 'Vu.' && claimOf(same, 'c2').sources[0]!.urlCheck?.code === 200);
  check('second import identique : texte de David gardé, sujet relu', blockOf(same, 'texte').text.fr === 'Texte de David.' && same.subject.status === 'relu');

  const changedClaim = makeResearch();
  changedClaim.claims[1]!.text = 'Le Fictivore mesure trois mètres.';
  const m = mergeImport(changedClaim, redone.research, redone.subject, expected);
  check('affirmation modifiée : proposée, sans note', claimOf(m, 'c2').status === 'propose' && claimOf(m, 'c2').note === '' && m.summary.claimsChanged === 1 && m.summary.claimsKept === 2);
  check('affirmation modifiée : blocs gardés à reprendre', blockOf(m, 'texte').state === 'a-reprendre' && blockOf(m, 'fiche-taille').state === 'a-reprendre' && blockOf(m, 'texte').text.fr === 'Texte de David.');
  check('affirmation modifiée : les autres blocs gardés', blockOf(m, 'chapeau').state === 'valide' && m.summary.blocksToRedo === 3);
  check('affirmation modifiée : sujet en brouillon', m.subject.status === 'brouillon');

  const changedSource = makeResearch();
  changedSource.claims[2]!.sources[0]!.url = 'https://autre.example/page';
  check('source modifiée : proposée', claimOf(mergeImport(changedSource, redone.research, redone.subject, expected), 'c3').status === 'propose');

  const changedBlock = makeResearch();
  changedBlock.blocks[1]!.text = 'Nouvelle proposition.';
  const b = mergeImport(changedBlock, redone.research, redone.subject, expected);
  check('proposition modifiée : remplace le texte, à relire', blockOf(b, 'texte').text.fr === 'Nouvelle proposition.' && blockOf(b, 'texte').state === 'a-relire' && b.summary.blocksChanged === 1);

  const removed = makeResearch();
  removed.claims = removed.claims.filter((c) => c.id !== 'c3');
  removed.blocks[1]!.claims = ['c2'];
  removed.blocks[5]!.claims = ['c2'];
  const r = mergeImport(removed, redone.research, redone.subject, expected);
  check('affirmation retirée : comptée', r.summary.claimsRemoved === 1 && !r.research.claims.some((c) => c.id === 'c3'));

  const kept = keepDatedCopies(dataRoot, BOOK_ID, 'alpha', NOW);
  check('copie datée : le sujet seul, sans recherche', kept.length === 1 && kept[0] === `subject.${NOW.toISOString().replace(/[:.]/g, '-')}.json`, kept);
  updateSubject(dataRoot, BOOK_ID, 'alpha', () => ({ subject: first.subject, research: first.research }));
  check('écriture : recherche et blocs relus', readResearch(dataRoot, BOOK_ID, 'alpha')!.claims.length === 3 && readSubject(dataRoot, BOOK_ID, 'alpha').blocks.length === 7);
  const later = new Date(NOW.getTime() + 1000);
  const copies = keepDatedCopies(dataRoot, BOOK_ID, 'alpha', later);
  const dir = subjectFolder(dataRoot, BOOK_ID, 'alpha')!;
  check('copies datées : les deux fichiers', copies.length === 2 && copies.every((c) => fs.existsSync(path.join(dir, c))));
  check('copie datée : contenu identique', fs.readFileSync(path.join(dir, copies[0]!), 'utf8') === fs.readFileSync(path.join(dir, RESEARCH_FILE), 'utf8'));
  let again = '';
  try {
    keepDatedCopies(dataRoot, BOOK_ID, 'alpha', later);
  } catch (e) {
    again = (e as NodeJS.ErrnoException).code ?? '';
  }
  check('copie datée : rien n’est écrasé', again === 'EEXIST');
}

// Contrôle des URL : aucun réseau
type Reply = { status: number; location?: string };
function fakeResponse({ status, location }: Reply): Response {
  return new Response(null, { status, headers: location ? { location } : {} });
}
function deps(routes: Record<string, Reply | Reply[]>, over: Partial<UrlDeps> = {}): UrlDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.redirect !== 'manual') throw new Error('redirection automatique');
      const route = routes[`${init.method} ${url}`] ?? routes[url];
      if (!route) throw new TypeError('fetch failed');
      return fakeResponse(Array.isArray(route) ? route.shift()! : route);
    },
    lookup: async () => ['93.184.216.34'],
    now: () => NOW,
    timeoutMs: 200,
    ...over,
  };
}
const A = 'https://site.example/a';
const B = 'https://site.example/b';
{
  const ok = deps({ [A]: { status: 200 } });
  const r = await checkUrl(A, ok);
  check('URL : réponse', r.code === 200 && r.error === null && r.date === NOW.toISOString(), r);
  check('URL : HEAD suffit', ok.calls.join() === `HEAD ${A}`, ok.calls);
  const head = deps({ [`HEAD ${A}`]: { status: 405 }, [`GET ${A}`]: { status: 200 } });
  check('URL : HEAD refusé puis GET', (await checkUrl(A, head)).code === 200 && head.calls.join() === `HEAD ${A},GET ${A}`, head.calls);
  check('URL : 404 confirmé en GET', (await checkUrl(A, deps({ [A]: { status: 404 } }))).code === 404);
  const hang = deps({}, { fetch: (_u, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('annulé')))), timeoutMs: 20 });
  const late = await checkUrl(A, hang);
  check('URL : délai dépassé', late.code === null && late.error!.includes('aucune réponse en'), late);
  const deaf = await checkUrl(A, deps({}, { fetch: () => new Promise(() => {}), timeoutMs: 20 }));
  check('URL : délai, même si fetch n’entend pas', deaf.code === null, deaf);
  check('URL : serveur injoignable', (await checkUrl(A, deps({}))).error === 'aucune réponse du serveur');
  for (const [name, url] of [
    ['127.0.0.1', 'http://127.0.0.1/x'], ['127.1 écrit court', 'http://127.1/x'], ['décimal', 'http://2130706433/x'], ['10/8', 'http://10.1.2.3/'], ['192.168/16', 'http://192.168.1.1/'], ['172.16/12', 'http://172.20.0.1/'], ['169.254/16', 'http://169.254.169.254/latest'],
    ['::1', 'http://[::1]/'], ['IPv4 dans IPv6', 'http://[::ffff:127.0.0.1]/'], ['fc00::/7', 'http://[fd00::1]/'], ['fe80::/10', 'http://[fe80::1]/'],
    ['localhost', 'http://localhost:4200/'], ['nom sans point', 'http://serveur/'], ['.local', 'http://nas.local/'],
  ]) {
    const d = deps({ [url!]: { status: 200 } });
    const res = await checkUrl(url!, d);
    check(`URL privée refusée : ${name}`, res.code === null && res.error!.includes('privée') && d.calls.length === 0, { res, calls: d.calls });
  }
  const dnsPrivate = deps({ [A]: { status: 200 } }, { lookup: async () => ['93.184.216.34', '10.0.0.1'] });
  check('URL : nom qui résout vers une adresse privée', (await checkUrl(A, dnsPrivate)).error!.includes('privée') && dnsPrivate.calls.length === 0);
  check('URL : nom introuvable', (await checkUrl(A, deps({}, { lookup: async () => { throw new Error('ENOTFOUND'); } }))).error === 'nom de domaine introuvable');
  check('URL : aucune adresse', (await checkUrl(A, deps({}, { lookup: async () => [] }))).error === 'nom de domaine introuvable');
  for (const url of ['ftp://site.example/a', 'file:///etc/passwd', 'javascript:alert(1)']) {
    const d = deps({});
    const res = await checkUrl(url, d);
    check(`URL : schéma interdit, ${url.slice(0, 5)}`, res.code === null && res.error!.includes('schéma refusé') && d.calls.length === 0, res);
  }
  check('URL : invalide', (await checkUrl('pas une url', deps({}))).error === 'URL invalide');
  check('URL : identifiants refusés', (await checkUrl('https://a:b@site.example/', deps({}))).error!.includes('identifiants'));
  const hop = deps({ [A]: { status: 301, location: B }, [B]: { status: 200 } });
  check('redirection suivie', (await checkUrl(A, hop)).code === 200 && hop.calls.join() === `HEAD ${A},HEAD ${B}`, hop.calls);
  const relative = deps({ [A]: { status: 302, location: '/b' }, [B]: { status: 200 } });
  check('redirection relative', (await checkUrl(A, relative)).code === 200);
  const toPrivate = deps({ [A]: { status: 302, location: 'http://169.254.169.254/latest' } });
  const blocked = await checkUrl(A, toPrivate);
  check('redirection vers une adresse privée', blocked.code === null && blocked.error!.includes('privée') && toPrivate.calls.length === 1, blocked);
  const toFile = deps({ [A]: { status: 302, location: 'file:///etc/passwd' } });
  check('redirection vers un schéma interdit', (await checkUrl(A, toFile)).error!.includes('schéma refusé'));
  const hosts: string[] = [];
  const rebind = deps({ [A]: { status: 302, location: 'https://interne.example/' } }, { lookup: async (h) => { hosts.push(h); return h === 'interne.example' ? ['10.0.0.1'] : ['93.184.216.34']; } });
  check('redirection : DNS vérifié à chaque saut', (await checkUrl(A, rebind)).error!.includes('privée') && hosts.join() === 'site.example,interne.example', hosts);
  const loop = deps({ [A]: { status: 302, location: A } });
  const loopResult = await checkUrl(A, loop);
  check('redirections : 5 au plus', loopResult.code === null && loopResult.error!.includes('5 redirections') && loop.calls.length === MAX_REDIRECTS + 1, loop.calls.length);
  check('5 redirections admises', (await checkUrl('https://site.example/0', deps(Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`https://site.example/${i}`, { status: 301, location: `https://site.example/${i + 1}` }]).concat([['https://site.example/5', { status: 200 } as never]]))))).code === 200);
  check('3xx sans Location : code final', (await checkUrl(A, deps({ [A]: { status: 304 } }))).code === 304);

  let running = 0;
  let peak = 0;
  const many = Array.from({ length: 12 }, (_, i) => `https://site.example/${i}`);
  const results = await checkUrls([...many, many[0]!], deps({}, {
    fetch: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return fakeResponse({ status: 200 });
    },
  }));
  check('URL : 4 requêtes à la fois', peak === 4, peak);
  check('URL : chaque adresse une fois', results.size === 12);
  check('adresses publiques admises', !isPrivateAddress('93.184.216.34') && !isPrivateAddress('2606:2800:220:1::1'));
  const code = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'research', 'url-check.ts'), 'utf8');
  check('URL : le corps n’est jamais lu', !/\.text\(\)|\.json\(\)|\.arrayBuffer\(\)|\.blob\(\)/.test(code));
}

finish('recherche');
