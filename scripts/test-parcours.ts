// scripts/test-parcours.ts — critères des étapes, verrouillage, lecture des faits et route `/api/parcours` (spec §5.3). L'export réel
// passe par Chromium : il est dans test-ui. Fixtures synthétiques seulement.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { retainScenario, saveScenario } from '../src/data/pricing-file';
import { createSubject, readResearch, updateSubject } from '../src/data/subject-file';
import { subjectContext } from '../src/render/subject';
import { mergeImport, parseResearch } from '../src/research/import';
import { applyBlockAction, applyClaimAction, type Data } from '../src/research/state';
import { researchEd4, syntheseEd4 } from './fixtures/recherche-ed4';
import { addMissingDefaults, ensureIllustrationRights, setIllustrationRights } from '../src/rights/registry';
import { readFacts } from '../src/parcours/facts';
import { computeParcours, isValidated, STEPS, type ParcoursFacts, type StepDef, type SubjectFacts } from '../src/parcours/steps';
import type { ScenarioInput } from '../src/pricing/scenarios';
import { createPrintServer } from '../src/server/app';
import { BOOK_DIR, BOOK_ID, dirLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng } from './fixtures/make-png';
import { check, finish } from './test-lib';

const LONG_AGO = 1_000_000;
const goodSubject = (over: Partial<SubjectFacts> = {}): SubjectFacts => ({
  id: 'alpha', title: 'Alpha', error: null, status: 'relu', pages: 2, template: '2A', theme: 'foret',
  templateError: null, blocksGap: { missing: [], extra: [] }, miseEnPage: { source: 'layout.json', errors: [] }, duplicateBlocks: null,
  research: { state: 'ok', error: null }, blocks: { total: 7, valide: 7, aRelire: 0, aReprendre: 0 }, claims: { total: 3, propose: 0 },
  illustrations: { error: null, zones: 1, missing: 0, errors: [], alerts: [] }, ready: { errors: [] }, ...over,
});
const good = (): ParcoursFacts => ({
  configError: null,
  book: { bookId: 'dino', errors: [], alerts: [] },
  folder: { exists: true, error: null, printBook: 'ok', printBookError: null },
  pricing: { error: null, retained: true, retainedErrors: [], deviation: [], bookAlert: null },
  collection: { exists: true, error: null },
  gabarits: { error: null, valid: 1, invalid: [], orphans: [], overlaps: [] },
  droits: { error: null, missing: 0, faults: [], toCheck: [] },
  workflows: { error: null, todo: [], faults: [] },
  styles: { error: null, count: 1, faults: [], todo: [], alerts: [] },
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
check('registre : Livre, Prix, Collection, Gabarits, Droits, Workflows, Styles, Sujets, dans cet ordre', bookSteps.map((s) => s.id).join() === 'livre,prix,collection,gabarits,droits,workflows,styles,sujets');
check('registre : Styles exige Workflows (IC2)', STEPS.find((s) => s.id === 'styles')!.requires.join() === 'workflows');
check('registre : Workflows exige Droits', STEPS.find((s) => s.id === 'workflows')!.requires.join() === 'droits');
check('registre : Prix, Collection et Gabarits dépendent de l’étape précédente', bookSteps.slice(0, 4).every((s, i) => s.requires.join() === (bookSteps[i - 1]?.id ?? '')));
check('registre : Sujets exige Gabarits ; plus d’étape Essai (ED6)', !STEPS.some((s) => s.id === 'essai') && STEPS.find((s) => s.id === 'sujets')!.requires.join() === 'gabarits');
check('registre : Droits exige Collection', STEPS.find((s) => s.id === 'droits')!.requires.join() === 'collection');
check('registre : second niveau, Mise en page d’abord, Illustrations entre Relecture et Aperçu', subjectSteps.map((s) => s.label).join() === 'Mise en page,Recherche,Relecture,Illustrations,Aperçu,Prêt');
check('registre : Recherche exige Mise en page (ED1)', subjectSteps[1]!.requires.join() === 'sujet-mise-en-page');
check('registre : Illustrations exige Recherche', subjectSteps[3]!.requires.join() === 'sujet-recherche');
check('registre : Aperçu exige Recherche, pas Relecture', subjectSteps[4]!.requires.join() === 'sujet-recherche');
check('numéros 1 à 8', run().steps.map((s) => s.number).join() === '1,2,3,4,5,6,7,8');
check('registre : Prêt exige Relecture, Illustrations et Aperçu (ED6)', subjectSteps[5]!.requires.join() === 'sujet-relecture,sujet-illustrations,sujet-apercu');
check('second niveau : numéroté à part', run().subjects[0]!.steps.map((s) => s.number).join() === '1,2,3,4,5,6');

// Tout au vert
check('tout est validé', states() === 'validee,validee,validee,validee,validee,validee,validee,validee', states());
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
check('Livre : une alerte ne verrouille pas la suite', states((f) => { f.book!.alerts = ['a']; }) === 'alerte,validee,validee,validee,validee,validee,validee,validee');

// Prix
expectStep('Prix : aucun scénario retenu, à faire', 'prix', (f) => { f.pricing.retained = false; }, 'a-faire', 'Retenir un scénario');
expectStep('Prix : pricing.json invalide, erreur', 'prix', (f) => { f.pricing.error = 'pricing.json invalide'; }, 'erreur', 'pricing.json');
expectStep('Prix : scénario retenu en erreur', 'prix', (f) => { f.pricing.retainedErrors = ['Format absent']; }, 'erreur', 'Scénario retenu : Format absent');
expectStep('Prix : écart avec print-book.json, alerte', 'prix', (f) => { f.pricing.deviation = ['Pages : 44 et 46']; }, 'alerte', 'Pages');
expectStep('Prix : print-book.json illisible, alerte', 'prix', (f) => { f.pricing.bookAlert = 'écart non contrôlé'; }, 'alerte', 'écart non contrôlé');
check('Prix : une alerte ne verrouille pas la suite', states((f) => { f.pricing.deviation = ['x']; }) === 'validee,alerte,validee,validee,validee,validee,validee,validee');

// Collection
expectStep('Collection : absente, à faire', 'collection', (f) => { f.collection.exists = false; }, 'a-faire', 'Créer la collection');
expectStep('Collection : invalide, erreur', 'collection', (f) => { f.collection.error = 'style.json invalide'; }, 'erreur', 'style.json');

// Droits (MP4)
expectStep('Droits : registre illisible, erreur', 'droits', (f) => { f.droits.error = 'rights.json invalide'; }, 'erreur', 'rights.json invalide');
expectStep('Droits : entrée invalide, erreur', 'droits', (f) => { f.droits.faults = ['alpha : licence manquante']; }, 'erreur', 'licence manquante');
expectStep('Droits : entrée à commercialOk non, erreur', 'droits', (f) => { f.droits.faults = ['alpha : usage commercial refusé']; }, 'erreur', 'usage commercial refusé');
expectStep('Droits : entrées par défaut absentes, à faire', 'droits', (f) => { f.droits.missing = 5; }, 'a-faire', '5 entrées par défaut');
expectStep('Droits : à vérifier, alerte', 'droits', (f) => { f.droits.toCheck = ['alpha']; }, 'alerte', 'alpha');
expectStep('Droits : verrouillé sans Collection', 'droits', (f) => { f.collection.exists = false; }, 'verrouillee', 'Collection', 'verrouillée');
check('Droits : une erreur n’interdit pas Sujets', step('sujets', (f) => { f.droits.faults = ['x']; }).state === 'validee');
check('Droits à faire : la page s’y ouvre', run((f) => { f.droits.missing = 1; }).open === 'droits');

// Workflows (IC1)
expectStep('Workflows : workflows.json illisible, erreur', 'workflows', (f) => { f.workflows.error = 'workflows.json invalide'; }, 'erreur', 'workflows.json invalide');
expectStep('Workflows : workflow refusé, erreur', 'workflows', (f) => { f.workflows.faults = ['nœud 34 (ImageScale, taille finale) absent']; }, 'erreur', 'nœud 34');
expectStep('Workflows : à déposer, à faire', 'workflows', (f) => { f.workflows.todo = ['Déposer le workflow de génération.']; }, 'a-faire', 'Déposer le workflow');
check('Workflows : une erreur passe avant le travail à faire', step('workflows', (f) => { f.workflows.todo = ['a']; f.workflows.faults = ['b']; }).state === 'erreur');
expectStep('Workflows : verrouillé par Droits en erreur', 'workflows', (f) => { f.droits.faults = ['x']; }, 'verrouillee', 'Droits', 'verrouillée');
check('Workflows : une alerte de Droits ne le verrouille pas', step('workflows', (f) => { f.droits.toCheck = ['niedot294a']; }).state === 'validee');
check('Workflows à faire : Sujets reste ouvert, sans dépendre de lui', step('sujets', (f) => { f.workflows.todo = ['a']; }).state === 'validee');
check('Workflows à faire : la page s’y ouvre', run((f) => { f.workflows.todo = ['a']; }).open === 'workflows');

// Styles (IC2)
expectStep('Styles : bibliothèque illisible, erreur', 'styles', (f) => { f.styles.error = 'collection/styles/ n\'est pas un dossier réel'; }, 'erreur', 'dossier réel');
expectStep('Styles : style invalide ou référence absente, erreur', 'styles', (f) => { f.styles.faults = ['Crayonné : référence à déposer.']; }, 'erreur', 'référence à déposer');
expectStep('Styles : aucun style, à faire', 'styles', (f) => { f.styles.count = 0; }, 'a-faire', 'style de base');
expectStep('Styles : style par défaut à choisir, à faire', 'styles', (f) => { f.styles.todo = ['Choisir le style par défaut du livre.']; }, 'a-faire', 'par défaut');
expectStep('Styles : mélange de styles, alerte', 'styles', (f) => { f.styles.alerts = ['Plusieurs styles dans le livre : Style de base (alpha/illustration) ; Crayonné (beta/illustration).']; }, 'alerte', 'alpha/illustration');
check('Styles : une erreur passe avant le travail à faire', step('styles', (f) => { f.styles.todo = ['a']; f.styles.faults = ['b']; }).state === 'erreur');
expectStep('Styles : verrouillé par Workflows à faire', 'styles', (f) => { f.workflows.todo = ['a']; }, 'verrouillee', 'Workflows', 'verrouillée');
check('Styles à faire : Sujets reste ouvert, sans dépendre de lui', step('sujets', (f) => { f.styles.count = 0; }).state === 'validee');
check('Styles à faire : la page s’y ouvre', run((f) => { f.styles.count = 0; }).open === 'styles');

// Illustrations d'un sujet (MP4)
const images = (change: Change = () => {}) => run(change).subjects[0]!.steps.find((s) => s.id === 'sujet-illustrations')!;
const withImages = (over: Partial<SubjectFacts['illustrations']>): Change => (f) => { f.subjects[0]!.illustrations = { error: null, zones: 1, missing: 0, errors: [], alerts: [], ...over }; };
check('Illustrations : toutes les zones ont leur image, validée', images().state === 'validee');
check('Illustrations : une zone sans image, à faire', images(withImages({ missing: 1 })).state === 'a-faire' && images(withImages({ missing: 1 })).reasons[0] === '1 zone sans image.');
check('Illustrations : C5 ou C11 en erreur, erreur', images(withImages({ errors: ['C5, illustration : 150 ppp'] })).state === 'erreur');
check('Illustrations : une erreur passe avant une zone vide', images(withImages({ missing: 1, errors: ['C11, x'] })).state === 'erreur');
check('Illustrations : alerte, validée quand même', images(withImages({ alerts: ['C11, y'] })).state === 'alerte' && isValidated(images(withImages({ alerts: ['C11, y'] })).state));
check('Illustrations : sujet impossible à poser, erreur', images(withImages({ error: 'Thème inconnu' })).state === 'erreur');
check('Illustrations : verrouillée sans Recherche', images((f) => { f.subjects[0]!.research.state = 'absent'; }).state === 'verrouillee');
check('Illustrations : sujet relu sans image, s’ouvre sur elle', run(withImages({ missing: 1 })).subjects[0]!.open === 'sujet-illustrations');
check('Illustrations : sans image, Aperçu reste ouvert et validé', run(withImages({ missing: 1 })).subjects[0]!.steps.find((s) => s.id === 'sujet-apercu')!.state === 'validee');
check('Illustrations : sans image, Sujets reste validé', step('sujets', withImages({ missing: 1 })).state === 'validee');

// Verrouillage et réouverture
const noBook: Change = (f) => { f.book = null; };
check('verrouillage : tout après Livre', states(noBook) === 'a-faire,verrouillee,verrouillee,verrouillee,verrouillee,verrouillee,verrouillee,verrouillee', states(noBook));
check('verrouillage : le motif nomme la première étape à valider', step('gabarits', noBook).reasons[0] === 'Valider d\'abord « Livre ».' && step('prix', noBook).reasons[0] === 'Valider d\'abord « Livre ».');
check('verrouillage : libellé', step('prix', noBook).stateLabel === 'verrouillée');
const noScenario: Change = (f) => { f.pricing.retained = false; };
check('étape redevenue non validée : les suivantes se reverrouillent', states(noScenario) === 'validee,a-faire,verrouillee,verrouillee,verrouillee,verrouillee,verrouillee,verrouillee', states(noScenario));
check('reverrouillage : Mises en page renvoie à Prix', step('gabarits', noScenario).reasons[0] === 'Valider d\'abord « Prix ».');
check('une erreur verrouille aussi la suite', states((f) => { f.pricing.error = 'x'; }) === 'validee,erreur,verrouillee,verrouillee,verrouillee,verrouillee,verrouillee,verrouillee');
check('collection présente et prix non validé : Collection reste verrouillée', step('collection', noScenario).state === 'verrouillee');
check('réouverture : première étape non validée, Livre', run(noBook).open === 'livre');
check('réouverture : première étape non validée, Prix', run(noScenario).open === 'prix');
check('isValidated : validée et alerte seulement', isValidated('validee') && isValidated('alerte') && !isValidated('a-faire') && !isValidated('erreur') && !isValidated('verrouillee'));

// Sujets
const oneSubject = (over: Partial<SubjectFacts>) => (f: ParcoursFacts) => { f.subjects = [goodSubject(over)]; };
expectStep('Sujets : aucun sujet, à faire', 'sujets', (f) => { f.subjects = []; }, 'a-faire', 'Créer un premier sujet');
expectStep('Sujets : un sujet en brouillon, à faire', 'sujets', oneSubject({ status: 'brouillon' }), 'a-faire', '1 sujet à relire, sur 1');
expectStep('Sujets : un sujet sur deux à relire', 'sujets', (f) => { f.subjects = [goodSubject(), goodSubject({ id: 'b', status: 'brouillon' })]; }, 'a-faire', '1 sujet à relire, sur 2');
expectStep('Sujets : sujet illisible, erreur', 'sujets', oneSubject({ error: 'subject.json invalide' }), 'erreur', 'alpha : subject.json invalide');
check('Sujets : prêt compte comme relu', step('sujets', oneSubject({ status: 'prêt' })).state === 'validee');
check('Sujets : verrouillé par Collection', step('sujets', (f) => { f.collection.exists = false; }).state === 'verrouillee' && step('sujets', (f) => { f.collection.exists = false; }).reasons[0] === 'Valider d\'abord « Collection ».');

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
check('sujet illisible : Mise en page en erreur, Recherche verrouillée', sub({ error: 'illisible' }, 'sujet-mise-en-page').state === 'erreur' && sub({ error: 'illisible' }, 'sujet-recherche').state === 'verrouillee');
// ED4 : identifiant de bloc en double, écart des en-têtes.
const dup: Partial<SubjectFacts> = { ...noResearch, duplicateBlocks: 'Identifiant de bloc en double : corps-p2 (corps, p2 et corps-p2). Renommer l\'élément ou le paragraphe dans l\'étape Mise en page.' };
check('ED4 Recherche : identifiant de bloc en double, erreur nommée, même sans recherche', sub(dup, 'sujet-recherche').state === 'erreur' && sub(dup, 'sujet-recherche').reasons[0]!.includes('corps-p2 (corps, p2 et corps-p2)'));
const headingGap: Partial<SubjectFacts> = { blocksGap: { missing: ['en-tête de corps-p2'], extra: [] } };
check('ED4 Recherche : en-tête manquant, erreur, second import proposé', sub(headingGap, 'sujet-recherche').state === 'erreur' && sub(headingGap, 'sujet-recherche').reasons[0]!.includes('en-tête de corps-p2') && sub(headingGap, 'sujet-recherche').reasons[0]!.includes('second import'));
check('ED4 Recherche : en-tête en trop, erreur', sub({ blocksGap: { missing: [], extra: ['en-tête de capsule'] } }, 'sujet-recherche').reasons[0]!.includes('blocs en trop : en-tête de capsule'));
const toRead: Partial<SubjectFacts> = { status: 'brouillon', blocks: { total: 7, valide: 4, aRelire: 2, aReprendre: 1 } };
check('Relecture : blocs à relire et à reprendre', sub(toRead, 'sujet-relecture').state === 'a-faire' && sub(toRead, 'sujet-relecture').reasons[0] === '2 blocs à relire, 1 bloc à reprendre.', sub(toRead, 'sujet-relecture'));
check('blocs à relire : Aperçu reste ouvert, pour voir un débordement', sub(toRead, 'sujet-apercu').state === 'a-faire');
check('blocs à relire : ouverture sur Relecture', levelOf(toRead).open === 'sujet-relecture');
const allRead: Partial<SubjectFacts> = { status: 'brouillon' };
check('Relecture : tous les blocs validés', sub(allRead, 'sujet-relecture').state === 'validee');
check('Aperçu : brouillon, à faire', sub(allRead, 'sujet-apercu').state === 'a-faire' && sub(allRead, 'sujet-apercu').reasons[0]!.includes('marquer relu'));
check('Aperçu : relu, validé', sub({}, 'sujet-apercu').state === 'validee');
check('tout validé sauf Prêt : ouverture sur Prêt (ED6)', levelOf({}).open === 'sujet-pret');
check('Prêt : relu, à faire, avec le geste à faire', sub({}, 'sujet-pret').state === 'a-faire' && sub({}, 'sujet-pret').reasons[0]!.includes('Marquer le sujet prêt'));
check('Prêt : marqué prêt, contrôles sans erreur, validé', sub({ status: 'prêt' }, 'sujet-pret').state === 'validee');
const readyBroken = sub({ status: 'prêt', ready: { errors: ['C9 : QR absent : 01-alpha.svg introuvable', 'C13 : texte de remplissage'] } }, 'sujet-pret');
check('Prêt : marqué prêt mais un contrôle repasse en erreur, étape en erreur nommant chaque contrôle', readyBroken.state === 'erreur' && readyBroken.reasons.join(' ').includes('C9') && readyBroken.reasons.join(' ').includes('C13') && readyBroken.reasons.join(' ').includes('marqué prêt'), readyBroken);
check('Prêt : l\'erreur ne dépend que des données, le statut écrit reste prêt', goodSubject({ status: 'prêt' }).status === 'prêt');
check('Prêt : non marqué, des erreurs de contrôle ne passent pas l\'étape en erreur', sub({ ready: { errors: ['C9 : QR absent'] } }, 'sujet-pret').state === 'a-faire');
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
check('fichiers : collection absente, Collection à faire', stateOf('collection').state === 'a-faire' && stateOf('gabarits').state === 'verrouillee');
createCollection(dataRoot);
check('fichiers : collection créée, Mises en page validées par les gabarits livrés', stateOf('collection').state === 'validee' && stateOf('gabarits').state === 'validee');
check('fichiers : aucun sujet, Sujets à faire', stateOf('sujets').state === 'a-faire');
{
  const style = path.join(dataRoot, 'collection', 'style.json');
  const saved = fs.readFileSync(style, 'utf8');
  put(dataRoot, 'collection/style.json', '{}');
  check('fichiers : style invalide, Collection en erreur', stateOf('collection').state === 'erreur' && stateOf('gabarits').state === 'verrouillee');
  put(dataRoot, 'collection/style.json', saved);

}
{
  const bookFile = path.join(dataRoot, BOOK_ID, 'print-book.json');
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  const after = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  void book;

  // Faits d'un sujet, lus sur les fichiers
  const facts = () => onDisk().subjects[0]!;
  check('sujet lu : titre de la scène, brouillon', facts().title === 'alpha fr' && facts().status === 'brouillon' && facts().template === '2A');
  check('sujet lu : mise en page validée, recherche absente', facts().steps[0]!.state === 'validee' && facts().steps[1]!.state === 'a-faire' && facts().steps[2]!.state === 'verrouillee', facts().steps);
  check('sujet lu : Sujets à faire', stateOf('sujets').state === 'a-faire');
  const research = path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'research.json');
  put(dataRoot, `${BOOK_ID}/subjects/alpha/research.json`, '{');
  check('research.json illisible : Recherche en erreur, Sujets non bloqué', facts().steps[1]!.state === 'erreur' && facts().error === null, facts());
  fs.rmSync(research);
  updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, status: 'relu' } }));
  check('sujet relu : Sujets validé', stateOf('sujets').state === 'validee');

  // Droits et illustrations, lus sur les fichiers, sans écriture
  const images = () => readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR).subjects[0]!.illustrations;
  const rights = path.join(dataRoot, BOOK_ID, 'rights.json');
  const emptyRights = fs.readFileSync(rights, 'utf8');
  const common = path.join(dataRoot, 'collection', 'rights.json');
  const commonSaved = fs.readFileSync(common, 'utf8');
  check('Droits : collection neuve, seule la référence reste à vérifier', stateOf('droits').state === 'alerte' && stateOf('droits').reasons[0]!.includes('niedot294a'), stateOf('droits'));
  const commonFile = JSON.parse(commonSaved);
  put(dataRoot, 'collection/rights.json', { ...commonFile, entries: commonFile.entries.slice(0, 3) });
  check('Droits : registre créé avant MP4, à faire', stateOf('droits').state === 'a-faire' && stateOf('droits').reasons[0]!.includes('8 entrées'), stateOf('droits'));
  addMissingDefaults(dataRoot);
  check('Droits : après l’ajout, alerte seulement', stateOf('droits').state === 'alerte');
  put(dataRoot, `${BOOK_ID}/rights.json`, { schemaVersion: 1, entries: [{ id: 'a', kind: 'modele-3d', name: 'A', author: 'B', license: 'CC BY 4.0', credit: '', commercialOk: 'oui' }], illustrations: [] });
  check('Droits : entrée invalide, erreur', stateOf('droits').state === 'erreur' && stateOf('droits').reasons[0] === 'a : crédit vide', stateOf('droits'));
  put(dataRoot, `${BOOK_ID}/rights.json`, { schemaVersion: 1, entries: [{ id: 'a', kind: 'modele-3d', name: 'A', author: 'B', license: 'X', credit: 'C', commercialOk: 'non' }], illustrations: [] });
  check('Droits : commercialOk non, erreur', stateOf('droits').state === 'erreur' && stateOf('droits').reasons[0]!.includes('refusé'));
  put(dataRoot, `${BOOK_ID}/rights.json`, { schemaVersion: 1, entries: [{ id: 'andika', kind: 'police', name: 'A', author: 'B', license: 'X', credit: 'C', commercialOk: 'oui' }], illustrations: [] });
  check('Droits : même identifiant dans les deux registres, erreur', stateOf('droits').reasons[0]!.includes('deux registres'), stateOf('droits'));
  put(dataRoot, `${BOOK_ID}/rights.json`, '{');
  check('Droits : rights.json illisible, erreur', stateOf('droits').state === 'erreur' && stateOf('droits').reasons[0]!.includes('conservé tel quel'));
  check('rights.json illisible : Illustrations le dit', images().error?.includes('conservé tel quel') === true, images());
  fs.writeFileSync(rights, emptyRights);
  check('Illustrations lues : une zone, sans image', images().zones === 1 && images().missing === 1 && images().errors.length === 0, images());
  const place = (width: number, height: number, zoom = 1) => updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({
    ...d,
    subject: { ...d.subject, illustrations: [{ zone: 'illustration', file: 'illustrations/alpha/illustration.png', width, height, framing: { focusX: 0.5, focusY: 0.5, zoom } }] },
  }));
  place(1838, 2775);
  check('Illustrations lues : fichier absent du disque, erreur', images().errors.some((e) => e.includes('absent du disque')), images());
  fs.mkdirSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha'), { recursive: true });
  const png = path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'illustration.png');
  fs.writeFileSync(png, makePng(1838, 2775, 3, () => [1, 2, 3]));
  ensureIllustrationRights(dataRoot, BOOK_ID, 'alpha', 'illustration');
  check('Illustrations lues : sans droits, C11 rouge', images().errors.some((e) => e.startsWith('C11')), images());
  setIllustrationRights(dataRoot, BOOK_ID, 'alpha', 'illustration', ['sdxl-base-1-0']);
  check('Illustrations lues : modèle d’IA seul, alerte', images().errors.length === 0 && images().alerts.some((e) => e.includes('modèle 3D')), images());
  place(1838, 2775, 1.2);
  check('Illustrations lues : zoom, C5 rouge', images().errors.some((e) => e.startsWith('C5')), images());
  place(1838, 2775);
  check('Illustrations lues : retour au vert', images().errors.length === 0);
  fs.writeFileSync(png, makePng(600, 900, 3, () => [1, 2, 3]));
  check('Illustrations lues : dimensions lues dans le fichier, pas dans subject.json', images().errors.some((e) => e.startsWith('C5')), images());
  fs.rmSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha'), { recursive: true });
  fs.writeFileSync(rights, emptyRights);
  fs.writeFileSync(common, commonSaved);
  updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, illustrations: [] } }));

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

{
  // ED4 : un sujet à chaîne, capsule et question importé ; relecture des en-têtes comptée ; intertitre ajouté à la mise en page : écart des en-têtes.
  const glb = makeGlbi();
  const data = path.join(tempDir(), 'donnees');
  fs.mkdirSync(data);
  createBookFolder(data, BOOK_ID);
  createCollection(data);
  put(data, 'collection/gabarits/2Q.json', syntheseEd4('2Q', undefined, undefined, { sansIntertitreP2: true }));
  createSubject(data, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2Q', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  const ctx = subjectContext(data, BOOK_ID, 'alpha', []);
  const file = parseResearch(JSON.stringify({ ...researchEd4(), blocks: researchEd4().blocks.map((b) => (b.type === 'paragraphe' && b.paragraphe === 'p2' ? { ...b, heading: undefined } : b)) }));
  const merged = mergeImport(file, null, ctx.subject, ctx.expected);
  updateSubject(data, BOOK_ID, 'alpha', () => ({ subject: merged.subject, research: merged.research }));
  const facts = () => readFacts({ ok: true, config: { glbRoot: glb, dataRoot: data } }, BOOK_DIR);
  const sujet = () => facts().subjects[0]!;
  const recherche = () => computeParcours(facts()).subjects[0]!.steps.find((x) => x.id === 'sujet-recherche')!;
  check('ED4 parcours : import conforme, Recherche validée', recherche().state === 'validee', recherche());
  check('ED4 parcours : 9 blocs à relire', sujet().blocks.total === 9 && sujet().blocks.aRelire === 9, sujet().blocks);
  updateSubject(data, BOOK_ID, 'alpha', (d) => {
    let x: Data = { subject: d.subject, research: d.research! };
    for (const id of ['c1', 'c2', 'c3']) x = applyClaimAction(x, id, { kind: 'valider' }, new Date());
    for (const b of x.subject.blocks) x = applyBlockAction(x, b.id, { kind: 'valider' });
    return x;
  });
  check('ED4 parcours : textes validés, en-têtes à relire, blocs pas encore relus', sujet().blocks.valide === 6 && sujet().blocks.aRelire === 3, sujet().blocks);
  updateSubject(data, BOOK_ID, 'alpha', (d) => {
    let x: Data = { subject: d.subject, research: d.research! };
    for (const b of x.subject.blocks) if (b.heading) x = applyBlockAction(x, b.id, { kind: 'valider-entete' });
    return x;
  });
  check('ED4 parcours : en-têtes validés, tous les blocs relus', sujet().blocks.valide === 9 && computeParcours(facts()).subjects[0]!.steps.find((x) => x.id === 'sujet-relecture')!.state === 'validee', sujet().blocks);
  // Intertitre ajouté au second paragraphe dans la mise en page du sujet.
  const layoutFile = path.join(data, BOOK_ID, 'subjects', 'alpha', 'layout.json');
  const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  layout.chaines[0].paragraphes[1] = { id: 'p2', intertitre: true, headingMaxChars: 28, maxChars: 330 };
  fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2));
  check('ED4 parcours : intertitre ajouté, en-tête manquant compté dans l’écart', sujet().blocksGap.missing.join() === 'en-tête de corps-p2' && sujet().blocksGap.extra.length === 0, sujet().blocksGap);
  check('ED4 parcours : Recherche en erreur, en-tête nommé, second import proposé', recherche().state === 'erreur' && recherche().reasons[0]!.includes('en-tête de corps-p2') && recherche().reasons[0]!.includes('second import'), recherche());
  // Second import avec l'intertitre : l'écart se règle.
  const ctx2 = subjectContext(data, BOOK_ID, 'alpha', []);
  const second = mergeImport(parseResearch(JSON.stringify(researchEd4())), readResearch(data, BOOK_ID, 'alpha'), ctx2.subject, ctx2.expected);
  updateSubject(data, BOOK_ID, 'alpha', () => ({ subject: second.subject, research: second.research }));
  check('ED4 parcours : second import, écart réglé, Recherche validée', recherche().state === 'validee' && sujet().blocksGap.missing.length === 0, recherche());
  check('ED4 parcours : le paragraphe changé repasse à relire, les autres gardés', sujet().blocks.aRelire === 1 && sujet().blocks.valide === 8, sujet().blocks);
  // Un élément nommé comme un paragraphe : Recherche en erreur, nommée.
  layout.elements.push({ id: 'corps-p3', type: 'chiffre-cle', page: 1, x: 100, y: 212.5, w: 20, h: 3, maxChars: 10 });
  fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2));
  check('ED4 parcours : identifiant en double, Recherche en erreur', recherche().state === 'erreur' && recherche().reasons[0]!.startsWith('Identifiant de bloc en double : corps-p3'), recherche());
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
check('route : étapes et ouverture', reply.status === 200 && view.steps.length === 8 && view.open === 'workflows' && view.steps[5].reasons.join().includes('Déposer le workflow de génération') && view.steps[3].stateLabel === 'validée' && view.subjects.length === 1 && view.subjects[0].steps.length === 6, view);
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
