// scripts/test-parcours.ts — critères des étapes, verrouillage, lecture des faits et route `/api/parcours` (spec §5.3). L'export réel
// passe par Chromium : il est dans test-ui. Fixtures synthétiques seulement.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { retainScenario, saveScenario } from '../src/data/pricing-file';
import { createSubject, updateSubject } from '../src/data/subject-file';
import { readFacts } from '../src/parcours/facts';
import { computeParcours, isValidated, STEPS, type ParcoursFacts, type StepDef, type SubjectFacts } from '../src/parcours/steps';
import type { ScenarioInput } from '../src/pricing/scenarios';
import { bookSnapshot, ESSAI_CONTROL_FILE, readEssaiControl } from '../src/render/essai';
import { createPrintServer } from '../src/server/app';
import { BOOK_DIR, BOOK_ID, dirLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

const LONG_AGO = 1_000_000;
const goodSubject = (over: Partial<SubjectFacts> = {}): SubjectFacts => ({
  id: 'alpha', title: 'Alpha', error: null, status: 'relu', pages: 2, template: '2A', theme: 'foret',
  research: { state: 'ok', error: null }, blocks: { total: 7, valide: 7, aRelire: 0, aReprendre: 0 }, claims: { total: 3, propose: 0 }, ...over,
});
const good = (): ParcoursFacts => ({
  configError: null,
  book: { bookId: 'dino', errors: [], alerts: [] },
  folder: { exists: true, error: null, printBook: 'ok', printBookError: null },
  pricing: { error: null, retained: true, retainedErrors: [], deviation: [], bookAlert: null },
  collection: { exists: true, error: null },
  essai: { renderError: null, control: { dateMs: 2 * LONG_AGO, errors: [], alerts: [] }, controlError: null, styleMs: LONG_AGO, printBookMs: LONG_AGO, bookChanged: null },
  subjects: [goodSubject()],
});
type Change = (f: ParcoursFacts) => void;
const run = (change: Change = () => {}) => {
  const facts = good();
  change(facts);
  return computeParcours(facts);
};
const step = (id: string, change?: Change) => run(change).steps.find((s) => s.id === id)!;
const states = (change?: Change) => run(change).steps.map((s) => s.state).join();
const expectStep = (name: string, id: string, change: Change, state: string, reason: string, label = state) => {
  const s = step(id, change);
  check(name, s.state === state && s.stateLabel === (label === 'a-faire' ? 'à faire' : label) && s.reasons.join(' ').includes(reason), s);
};

// Registre
const bookSteps = STEPS.filter((s) => s.scope === 'livre');
const subjectSteps = STEPS.filter((s) => s.scope === 'sujet');
check('registre : Livre, Prix, Collection, Essai, Sujets, dans cet ordre', bookSteps.map((s) => s.id).join() === 'livre,prix,collection,essai,sujets');
check('registre : Prix, Collection et Essai dépendent de l’étape précédente', bookSteps.slice(0, 4).every((s, i) => s.requires.join() === (bookSteps[i - 1]?.id ?? '')));
check('registre : Sujets exige Collection et non Essai', STEPS.find((s) => s.id === 'sujets')!.requires.join() === 'collection');
check('registre : second niveau, Recherche, Relecture, Aperçu', subjectSteps.map((s) => s.label).join() === 'Recherche,Relecture,Aperçu');
check('registre : Aperçu exige Recherche, pas Relecture', subjectSteps[2]!.requires.join() === 'sujet-recherche');
check('numéros 1 à 5', run().steps.map((s) => s.number).join() === '1,2,3,4,5');
check('second niveau : numéroté à part', run().subjects[0]!.steps.map((s) => s.number).join() === '1,2,3');

// Tout au vert
check('tout est validé', states() === 'validee,validee,validee,validee,validee', states());
check('tout validé : ouverture sur la dernière étape', run().open === 'sujets');
check('tout validé : aucun motif', run().steps.every((s) => s.reasons.length === 0));

// Livre
expectStep('Livre : configuration invalide, erreur', 'livre', (f) => { f.configError = 'config.local.json absent'; }, 'erreur', 'config.local.json');
expectStep('Livre : aucun livre, à faire', 'livre', (f) => { f.book = null; }, 'a-faire', 'Choisir un livre');
expectStep('Livre : lecture en erreur', 'livre', (f) => { f.book!.errors = ['a', 'b']; }, 'erreur', '2 erreurs de lecture');
expectStep('Livre : bookId absent', 'livre', (f) => { f.book!.bookId = null; }, 'erreur', 'bookId');
expectStep('Livre : dossier absent, à faire', 'livre', (f) => { f.folder.exists = false; }, 'a-faire', 'Créer le dossier');
expectStep('Livre : print-book.json absent, à faire', 'livre', (f) => { f.folder.printBook = 'absent'; }, 'a-faire', 'Créer le dossier');
expectStep('Livre : print-book.json invalide, erreur', 'livre', (f) => { f.folder.printBook = 'invalide'; f.folder.printBookError = 'pageBudget'; }, 'erreur', 'pageBudget');
expectStep('Livre : dossier refusé, erreur', 'livre', (f) => { f.folder.error = 'pas un dossier réel'; }, 'erreur', 'dossier réel');
expectStep('Livre : alerte de lecture', 'livre', (f) => { f.book!.alerts = ['a']; }, 'alerte', '1 alerte de lecture');
check('Livre : une alerte ne verrouille pas la suite', states((f) => { f.book!.alerts = ['a']; }) === 'alerte,validee,validee,validee,validee');

// Prix
expectStep('Prix : aucun scénario retenu, à faire', 'prix', (f) => { f.pricing.retained = false; }, 'a-faire', 'Retenir un scénario');
expectStep('Prix : pricing.json invalide, erreur', 'prix', (f) => { f.pricing.error = 'pricing.json invalide'; }, 'erreur', 'pricing.json');
expectStep('Prix : scénario retenu en erreur', 'prix', (f) => { f.pricing.retainedErrors = ['Format absent']; }, 'erreur', 'Scénario retenu : Format absent');
expectStep('Prix : écart avec print-book.json, alerte', 'prix', (f) => { f.pricing.deviation = ['Pages : 44 et 46']; }, 'alerte', 'Pages');
expectStep('Prix : print-book.json illisible, alerte', 'prix', (f) => { f.pricing.bookAlert = 'écart non contrôlé'; }, 'alerte', 'écart non contrôlé');
check('Prix : une alerte ne verrouille pas la suite', states((f) => { f.pricing.deviation = ['x']; }) === 'validee,alerte,validee,validee,validee');

// Collection
expectStep('Collection : absente, à faire', 'collection', (f) => { f.collection.exists = false; }, 'a-faire', 'Créer la collection');
expectStep('Collection : invalide, erreur', 'collection', (f) => { f.collection.error = 'style.json invalide'; }, 'erreur', 'style.json');

// Essai
const noControl: Change = (f) => { f.essai.control = null; };
expectStep('Essai : aucun export, à faire', 'essai', noControl, 'a-faire', 'Exporter');
expectStep('Essai : rendu impossible, erreur', 'essai', (f) => { f.essai.renderError = 'ne tient pas'; }, 'erreur', 'ne tient pas');
expectStep('Essai : contrôle en erreur', 'essai', (f) => { f.essai.control!.errors = ['C3', 'C4']; }, 'erreur', 'C3, C4 en erreur');
expectStep('Essai : contrôle en alerte', 'essai', (f) => { f.essai.control!.alerts = ['C8']; }, 'alerte', 'C8 en alerte');
expectStep('Essai : fichier de contrôle illisible, à refaire', 'essai', (f) => { f.essai.control = null; f.essai.controlError = 'illisible.'; }, 'a-faire', 'Relancer', 'à refaire');
expectStep('Essai : style.json plus récent, à refaire', 'essai', (f) => { f.essai.styleMs = 3 * LONG_AGO; }, 'a-faire', 'collection/style.json modifié', 'à refaire');
expectStep('Essai : print-book.json plus récent, à refaire', 'essai', (f) => { f.essai.printBookMs = 3 * LONG_AGO; }, 'a-faire', 'print-book.json modifié', 'à refaire');
expectStep('Essai : même date que le style, à refaire', 'essai', (f) => { f.essai.styleMs = f.essai.control!.dateMs; }, 'a-faire', 'modifié', 'à refaire');
expectStep('Essai : périmé et en erreur, à refaire d’abord', 'essai', (f) => { f.essai.styleMs = 3 * LONG_AGO; f.essai.control!.errors = ['C3']; }, 'a-faire', 'modifié', 'à refaire');
expectStep('Essai : format ou fiche changés depuis l’export, à refaire', 'essai', (f) => { f.essai.bookChanged = true; }, 'a-faire', 'print-book.json modifié', 'à refaire');
check('Essai : subjects seul a changé, reste validé malgré la date', step('essai', (f) => { f.essai.bookChanged = false; f.essai.printBookMs = 3 * LONG_AGO; }).state === 'validee');
expectStep('Essai : les deux fichiers plus récents', 'essai', (f) => { f.essai.styleMs = 3 * LONG_AGO; f.essai.printBookMs = 3 * LONG_AGO; }, 'a-faire', 'collection/style.json et print-book.json', 'à refaire');

// Verrouillage et réouverture
const noBook: Change = (f) => { f.book = null; };
check('verrouillage : tout après Livre', states(noBook) === 'a-faire,verrouillee,verrouillee,verrouillee,verrouillee', states(noBook));
check('verrouillage : le motif nomme la première étape à valider', step('essai', noBook).reasons[0] === 'Valider d\'abord « Livre ».' && step('prix', noBook).reasons[0] === 'Valider d\'abord « Livre ».');
check('verrouillage : libellé', step('prix', noBook).stateLabel === 'verrouillée');
const noScenario: Change = (f) => { f.pricing.retained = false; };
check('étape redevenue non validée : les suivantes se reverrouillent', states(noScenario) === 'validee,a-faire,verrouillee,verrouillee,verrouillee', states(noScenario));
check('reverrouillage : Essai renvoie à Prix', step('essai', noScenario).reasons[0] === 'Valider d\'abord « Prix ».');
check('une erreur verrouille aussi la suite', states((f) => { f.pricing.error = 'x'; }) === 'validee,erreur,verrouillee,verrouillee,verrouillee');
check('collection présente et prix non validé : Collection reste verrouillée', step('collection', noScenario).state === 'verrouillee');
check('réouverture : première étape non validée, Livre', run(noBook).open === 'livre');
check('réouverture : première étape non validée, Prix', run(noScenario).open === 'prix');
check('réouverture : première étape non validée, Essai', run(noControl).open === 'essai');
check('réouverture : une alerte ne retient pas', run((f) => { f.book!.alerts = ['a']; f.essai.control = null; }).open === 'essai');
check('réouverture : à refaire retient', run((f) => { f.essai.styleMs = 3 * LONG_AGO; }).open === 'essai');
check('isValidated : validée et alerte seulement', isValidated('validee') && isValidated('alerte') && !isValidated('a-faire') && !isValidated('erreur') && !isValidated('verrouillee'));

// Sujets
const oneSubject = (over: Partial<SubjectFacts>) => (f: ParcoursFacts) => { f.subjects = [goodSubject(over)]; };
expectStep('Sujets : aucun sujet, à faire', 'sujets', (f) => { f.subjects = []; }, 'a-faire', 'Créer un premier sujet');
expectStep('Sujets : un sujet en brouillon, à faire', 'sujets', oneSubject({ status: 'brouillon' }), 'a-faire', '1 sujet à relire, sur 1');
expectStep('Sujets : un sujet sur deux à relire', 'sujets', (f) => { f.subjects = [goodSubject(), goodSubject({ id: 'b', status: 'brouillon' })]; }, 'a-faire', '1 sujet à relire, sur 2');
expectStep('Sujets : sujet illisible, erreur', 'sujets', oneSubject({ error: 'subject.json invalide' }), 'erreur', 'alpha : subject.json invalide');
check('Sujets : prêt compte comme relu', step('sujets', oneSubject({ status: 'prêt' })).state === 'validee');
check('Sujets : Essai à refaire ne le verrouille pas', step('sujets', noControl).state === 'validee');
check('Sujets : une couleur modifiée ne reverrouille pas le contenu', step('sujets', (f) => { f.essai.styleMs = 3 * LONG_AGO; }).state === 'validee');
check('Sujets : verrouillé par Collection', step('sujets', (f) => { f.collection.exists = false; }).state === 'verrouillee' && step('sujets', (f) => { f.collection.exists = false; }).reasons[0] === 'Valider d\'abord « Collection ».');
check('Essai à faire : ouverture sur Essai, Sujets accessible', run(noControl).open === 'essai');

// Second niveau
const levelOf = (over: Partial<SubjectFacts>) => {
  const facts = good();
  facts.subjects = [goodSubject(over)];
  return computeParcours(facts).subjects[0]!;
};
const sub = (over: Partial<SubjectFacts>, id: string) => levelOf(over).steps.find((s) => s.id === id)!;
const noResearch: Partial<SubjectFacts> = { status: 'brouillon', research: { state: 'absent', error: null }, blocks: { total: 0, valide: 0, aRelire: 0, aReprendre: 0 } };
check('Recherche : absente, à faire', sub(noResearch, 'sujet-recherche').state === 'a-faire' && sub(noResearch, 'sujet-recherche').reasons[0]!.includes('Préparer'));
check('sans recherche : Relecture et Aperçu verrouillés', sub(noResearch, 'sujet-relecture').state === 'verrouillee' && sub(noResearch, 'sujet-apercu').state === 'verrouillee' && sub(noResearch, 'sujet-apercu').reasons[0] === 'Valider d\'abord « Recherche ».');
check('sans recherche : ouverture sur Recherche', levelOf(noResearch).open === 'sujet-recherche');
const badResearch: Partial<SubjectFacts> = { research: { state: 'invalide', error: 'research.json invalide' } };
check('Recherche : fichier invalide, erreur', sub(badResearch, 'sujet-recherche').state === 'erreur' && sub(badResearch, 'sujet-recherche').reasons[0] === 'research.json invalide');
check('sujet illisible : Recherche en erreur', sub({ error: 'illisible' }, 'sujet-recherche').state === 'erreur');
const toRead: Partial<SubjectFacts> = { status: 'brouillon', blocks: { total: 7, valide: 4, aRelire: 2, aReprendre: 1 } };
check('Relecture : blocs à relire et à reprendre', sub(toRead, 'sujet-relecture').state === 'a-faire' && sub(toRead, 'sujet-relecture').reasons[0] === '2 blocs à relire, 1 bloc à reprendre.', sub(toRead, 'sujet-relecture'));
check('blocs à relire : Aperçu reste ouvert, pour voir un débordement', sub(toRead, 'sujet-apercu').state === 'a-faire');
check('blocs à relire : ouverture sur Relecture', levelOf(toRead).open === 'sujet-relecture');
const allRead: Partial<SubjectFacts> = { status: 'brouillon' };
check('Relecture : tous les blocs validés', sub(allRead, 'sujet-relecture').state === 'validee');
check('Aperçu : brouillon, à faire', sub(allRead, 'sujet-apercu').state === 'a-faire' && sub(allRead, 'sujet-apercu').reasons[0]!.includes('marquer relu'));
check('Aperçu : relu, validé', sub({}, 'sujet-apercu').state === 'validee');
check('tout validé : ouverture sur Aperçu', levelOf({}).open === 'sujet-apercu');
{
  const custom: StepDef = { id: 'sujet-texte', label: 'Texte', scope: 'sujet', requires: [], evaluate: (_f, s) => ({ state: 'a-faire', reasons: [s?.id ?? 'x'] }) };
  const parcours = computeParcours(good(), [...STEPS.filter((s) => s.scope === 'livre'), custom]);
  check('sujet : calculé pour chaque sujet, hors des étapes du livre', parcours.subjects[0]!.steps[0]!.reasons[0] === 'alpha' && parcours.steps.every((s) => s.scope === 'livre'));
  check('sujet : ne change pas l’ouverture du livre', parcours.open === 'sujets');
}
check('requires inconnu : verrouillée, sans planter', computeParcours(good(), [{ id: 'a', label: 'A', scope: 'livre', requires: ['rien'], evaluate: () => ({ state: 'validee', reasons: [] }) }]).steps[0]!.state === 'verrouillee');

// Lecture des faits sur des fichiers
const scenario: ScenarioInput = {
  name: 'Essai',
  binding: 'paperback',
  trim: { widthIn: 6, heightIn: 9 },
  ink: 'premium-color',
  pages: { mode: 'saisi', pages: 46 },
  marketplace: 'amazon.fr',
  vat: 'reduced',
  price: { kind: 'ht', amount: 12 },
};
const glbRoot = makeGlbi();
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
const config = { ok: true as const, config: { glbRoot, dataRoot } };
const onDisk = (dir: string | null = BOOK_DIR) => computeParcours(readFacts(config, dir));
const stateOf = (id: string) => onDisk().steps.find((s) => s.id === id)!;
const listing = (root: string): string[] => fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listing(path.join(root, e.name)) : [path.join(root, e.name)])).sort();
const controlPath = `${BOOK_ID}/export/${ESSAI_CONTROL_FILE}`;
const control = (date: Date, level = 'ok') => ({ schemaVersion: 1, date: date.toISOString(), bookId: BOOK_ID, theme: 'foret', checks: [{ id: 'C1', label: 'Pages', level, details: [] }] });

check('fichiers : configuration invalide', computeParcours(readFacts({ ok: false, message: 'absent' }, BOOK_DIR)).steps[0]!.state === 'erreur');
check('fichiers : aucun livre choisi', onDisk(null).steps[0]!.reasons[0] === 'Choisir un livre.');
check('fichiers : dossier inconnu, lecture en erreur', stateOf('livre').state === 'a-faire' && onDisk('..').steps[0]!.state === 'erreur');
createBookFolder(dataRoot, BOOK_ID);
check('fichiers : dossier créé, Livre validé', stateOf('livre').state === 'validee' && stateOf('prix').state === 'a-faire');
saveScenario(dataRoot, BOOK_ID, scenario);
check('fichiers : scénario enregistré, pas encore retenu', stateOf('prix').state === 'a-faire');
retainScenario(dataRoot, BOOK_ID, 's1');
const prixState = stateOf('prix');
check('fichiers : scénario retenu, Prix passe', isValidated(prixState.state), prixState);
{
  const bookFile = path.join(dataRoot, BOOK_ID, 'print-book.json');
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...book, pageBudget: 46 });
  check('fichiers : aucun écart, Prix validé', stateOf('prix').state === 'validee', stateOf('prix'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...book, pageBudget: 48 });
  check('fichiers : écart de pages, alerte', stateOf('prix').state === 'alerte' && stateOf('prix').reasons[0]!.includes('Pages'), stateOf('prix'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, '{');
  check('fichiers : print-book.json illisible, Livre en erreur', stateOf('livre').state === 'erreur' && stateOf('prix').state === 'verrouillee');
  fs.rmSync(bookFile);
  check('fichiers : print-book.json absent, Livre à faire', stateOf('livre').state === 'a-faire' && stateOf('livre').reasons[0]!.includes('Créer'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...book, pageBudget: 46 });
  const pricingFile = `${BOOK_ID}/pricing.json`;
  const saved = fs.readFileSync(path.join(dataRoot, pricingFile), 'utf8');
  put(dataRoot, pricingFile, '{');
  check('fichiers : pricing.json illisible, Prix en erreur', stateOf('prix').state === 'erreur');
  put(dataRoot, pricingFile, saved.replace('"pages": 46', '"pages": 47'));
  check('fichiers : scénario retenu faux, Prix en erreur', stateOf('prix').state === 'erreur' && stateOf('prix').reasons[0]!.includes('nombre pair'), stateOf('prix'));
  put(dataRoot, pricingFile, saved);
}
check('fichiers : collection absente, Collection à faire', stateOf('collection').state === 'a-faire' && stateOf('essai').state === 'verrouillee');
createCollection(dataRoot);
check('fichiers : collection créée, Essai à faire', stateOf('collection').state === 'validee' && stateOf('essai').state === 'a-faire');
check('fichiers : aucun sujet, Sujets à faire', stateOf('sujets').state === 'a-faire');
{
  const style = path.join(dataRoot, 'collection', 'style.json');
  const saved = fs.readFileSync(style, 'utf8');
  put(dataRoot, 'collection/style.json', '{}');
  check('fichiers : style invalide, Collection en erreur', stateOf('collection').state === 'erreur' && stateOf('essai').state === 'verrouillee');
  put(dataRoot, 'collection/style.json', saved);

  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(style, past, past);
  fs.utimesSync(path.join(dataRoot, BOOK_ID, 'print-book.json'), past, past);
  put(dataRoot, controlPath, control(new Date()));
  check('export conservé : Essai validé', stateOf('essai').state === 'validee', stateOf('essai'));
  check('export conservé : relu tel quel', readEssaiControl(dataRoot, BOOK_ID).control?.theme === 'foret');
  put(dataRoot, controlPath, control(new Date(), 'alerte'));
  check('export avec une alerte : Essai en alerte', stateOf('essai').state === 'alerte' && stateOf('essai').reasons[0]!.includes('C1'));
  put(dataRoot, controlPath, control(new Date(), 'erreur'));
  check('export avec une erreur : Essai en erreur', stateOf('essai').state === 'erreur' && stateOf('essai').reasons[0]!.includes('C1'));
  put(dataRoot, controlPath, control(new Date()));
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(style, future, future);
  check('style.json modifié : à refaire', stateOf('essai').stateLabel === 'à refaire' && stateOf('essai').reasons[0]!.includes('style.json'), stateOf('essai'));
  fs.utimesSync(style, past, past);
  fs.utimesSync(path.join(dataRoot, BOOK_ID, 'print-book.json'), future, future);
  check('print-book.json modifié : à refaire', stateOf('essai').stateLabel === 'à refaire' && stateOf('essai').reasons[0]!.includes('print-book.json'));
  fs.utimesSync(path.join(dataRoot, BOOK_ID, 'print-book.json'), past, past);
  put(dataRoot, controlPath, '{');
  check('contrôle : JSON illisible, à refaire', stateOf('essai').stateLabel === 'à refaire' && stateOf('essai').reasons[0]!.includes(ESSAI_CONTROL_FILE));
  put(dataRoot, controlPath, { ...control(new Date()), bookId: 'autre' });
  check('contrôle : autre livre, à refaire', stateOf('essai').stateLabel === 'à refaire');
  put(dataRoot, controlPath, { ...control(new Date()), date: 'hier' });
  check('contrôle : date invalide, à refaire', stateOf('essai').stateLabel === 'à refaire');
  put(dataRoot, controlPath, { ...control(new Date()), plus: 1 });
  check('contrôle : clé inconnue, à refaire', stateOf('essai').stateLabel === 'à refaire');
  put(dataRoot, controlPath, control(new Date()));

  // Un format qui ne tient pas : la collection reste valide, l'essai est impossible.
  const bookFile = path.join(dataRoot, BOOK_ID, 'print-book.json');
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...book, edition: { ...book.edition, trim: { widthIn: 2, heightIn: 3 } } });
  check('format trop petit : Essai en erreur', stateOf('essai').state === 'erreur' && stateOf('essai').reasons[0]!.includes('ne tient pas'), stateOf('essai'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, book);
  fs.utimesSync(bookFile, past, past);
}
{
  // Créer un sujet écrit `subjects` dans print-book.json : l'essai ne redevient pas à refaire.
  const bookFile = path.join(dataRoot, BOOK_ID, 'print-book.json');
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  put(dataRoot, controlPath, { ...control(new Date()), book: bookSnapshot(book) });
  createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  const now = new Date(Date.now() + 60_000);
  fs.utimesSync(bookFile, now, now);
  check('sujet créé : print-book.json plus récent, Essai reste validé', stateOf('essai').state === 'validee', stateOf('essai'));
  const after = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...after, edition: { ...after.edition, trim: { widthIn: 6, heightIn: 8 } } });
  check('format changé : Essai à refaire', stateOf('essai').stateLabel === 'à refaire' && stateOf('essai').reasons[0]!.includes('print-book.json'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, after);
  const fiche = [{ id: 'taille', picto: 'taille', label: { fr: 'Longueur', en: 'Length', es: 'Largo' } }];
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...after, fiche });
  check('fiche du livre changée : Essai à refaire', stateOf('essai').stateLabel === 'à refaire');
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...after, fiche: [{ ...fiche[0], picto: 'inconnu' }] });
  check('fiche du livre, pictogramme inconnu : Essai en erreur', stateOf('essai').state === 'erreur' && stateOf('essai').reasons[0]!.includes('pictogramme inconnu'), stateOf('essai'));
  put(dataRoot, `${BOOK_ID}/print-book.json`, after);

  // Faits d'un sujet, lus sur les fichiers
  const facts = () => onDisk().subjects[0]!;
  check('sujet lu : titre de la scène, brouillon', facts().title === 'alpha fr' && facts().status === 'brouillon' && facts().template === '2A');
  check('sujet lu : recherche absente', facts().steps[0]!.state === 'a-faire' && facts().steps[2]!.state === 'verrouillee');
  check('sujet lu : Sujets à faire', stateOf('sujets').state === 'a-faire');
  const research = path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'research.json');
  put(dataRoot, `${BOOK_ID}/subjects/alpha/research.json`, '{');
  check('research.json illisible : Recherche en erreur, Sujets non bloqué', facts().steps[0]!.state === 'erreur' && facts().error === null, facts());
  fs.rmSync(research);
  updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, status: 'relu' } }));
  check('sujet relu : Sujets validé', stateOf('sujets').state === 'validee');
  const file = path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'subject.json');
  const saved = fs.readFileSync(file, 'utf8');
  put(dataRoot, `${BOOK_ID}/subjects/alpha/subject.json`, '{');
  check('subject.json illisible : Sujets en erreur, menu affiché', stateOf('sujets').state === 'erreur' && stateOf('sujets').reasons[0]!.includes('subject.json'), stateOf('sujets'));
  fs.rmSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha'), { recursive: true });
  check('sujet listé sans dossier : Sujets en erreur', stateOf('sujets').state === 'erreur' && stateOf('sujets').reasons[0]!.includes('absent'));
  put(dataRoot, `${BOOK_ID}/subjects/alpha/subject.json`, saved);
}
{
  // Aucun fichier d'état : le calcul laisse les deux racines intactes.
  const before = [...listing(dataRoot), ...listing(glbRoot)].join();
  onDisk();
  onDisk(null);
  check('calcul : aucun fichier écrit', [...listing(dataRoot), ...listing(glbRoot)].join() === before);
  const code = ['facts.ts', 'steps.ts'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'parcours', f), 'utf8')).join('');
  check('code du parcours : aucune écriture', !/writeFile|appendFile|renameSync|mkdirSync|rmSync|openSync|copyFile/.test(code));
}
{
  // Dossier du livre remplacé par un lien : un fait, pas une panne du menu.
  const other = tempDir();
  const glb2 = makeGlbi();
  const data2 = path.join(other, 'donnees');
  fs.mkdirSync(data2);
  dirLink(tempDir(), path.join(data2, BOOK_ID));
  const linked = computeParcours(readFacts({ ok: true, config: { glbRoot: glb2, dataRoot: data2 } }, BOOK_DIR));
  check('dossier du livre lié : Livre en erreur', linked.steps[0]!.state === 'erreur' && linked.steps[0]!.reasons[0]!.includes('dossier réel'), linked.steps[0]);
}

// Route
function request(port: number, opts: { method?: string; path: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const configPath = path.join(parent, 'config.local.json');
put(parent, 'config.local.json', { glbRoot, dataRoot });
const server = createPrintServer(configPath);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const host = `127.0.0.1:${port}`;
const headers = { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
const post = (body: unknown, h: Record<string, string> = headers) => request(port, { path: '/api/parcours', headers: h, body: JSON.stringify(body) });

const reply = await post({ dir: BOOK_DIR });
const view = JSON.parse(reply.body);
check('route : étapes et ouverture', reply.status === 200 && view.steps.length === 5 && view.open === 'sujets' && view.steps[3].stateLabel === 'validée' && view.subjects.length === 1 && view.subjects[0].steps.length === 3, view);
check('route : livre non choisi', JSON.parse((await post({ dir: null })).body).open === 'livre');
check('route : GET refusé', (await request(port, { method: 'GET', path: '/api/parcours', headers })).status === 405);
const { 'x-book-print': _h, ...noHeader } = headers;
check('route : sans en-tête, refusée', (await post({ dir: null }, noHeader)).status === 403);
const { Origin: _o, ...noOrigin } = headers;
check('route : sans Origin, refusée', (await post({ dir: null }, noOrigin)).status === 403);
check('route : Origin d’un autre site, refusée', (await post({ dir: null }, { ...headers, Origin: 'https://attaque.example' })).status === 403);
check('route : Host refusé', (await post({ dir: null }, { ...headers, Host: 'attaque.example' })).status === 403);
check('route : text/plain refusé', (await post({ dir: null }, { ...headers, 'Content-Type': 'text/plain' })).status === 403);
check('route : corps sans dir, 400', (await post({})).status === 400);
check('route : dir d’un autre type, 400', (await post({ dir: 1 })).status === 400);
check('route : clé inconnue, 400', (await post({ dir: null, autre: 1 })).status === 400);
check('route : JSON invalide, 400', (await request(port, { path: '/api/parcours', headers, body: '{' })).status === 400);
check('route : chemin refusé, Livre en erreur sans panne', JSON.parse((await post({ dir: '../..' })).body).steps[0].state === 'erreur');
put(parent, 'config.local.json', '{');
const bad = JSON.parse((await post({ dir: BOOK_DIR })).body);
check('route : configuration invalide, Livre en erreur, 200', bad.steps[0].state === 'erreur' && bad.steps[0].reasons[0].includes('config.local.json') && bad.steps[1].state === 'verrouillee', bad);
await new Promise((resolve) => server.close(resolve));

finish('parcours');
