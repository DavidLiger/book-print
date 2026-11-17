// scripts/test-livre.ts — le livre complet (MP6a) : page seule, texte fixe, sommaire, couleur du titre, plan et vrais numéros, page de notes,
// C2, C16 du livre, ajout et retrait de page d'une copie, « Miroir » d'une copie, pages du livre (création, ordre, suppression), QR du jeu,
// étape « Livre complet », routes. Tout est synthétique.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { c2Pages, computePlan, sideFault, type PartInput } from '../src/book/plan';
import { createCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { BookPageRefused, deleteBookPage, movePart, readBookPage, writeNewBookPage } from '../src/data/book-pages';
import { createSubject, firstPageOf, readPlan, readSubjectLayout } from '../src/data/subject-file';
import { readBook } from '../src/glbi/read';
import { addPage, PageChangeRefused, removePage } from '../src/layout/pages';
import { layoutSchema, subjectLayoutSchema, type Layout } from '../src/layout/schema';
import { computeParcours, STEPS, type ParcoursFacts } from '../src/parcours/steps';
import { readFacts } from '../src/parcours/facts';
import { bookPageContext, bookPageFaults, bookPageHtml } from '../src/render/book-page';
import { createPrintServer } from '../src/server/app';
import { cadreLivre } from './fixtures/livre';
import { BOOK_DIR, BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { synthese } from './fixtures/mises-en-page';
import { check, finish } from './test-lib';

type Dict = Record<string, any>;
const TRIM = { widthIn: 6, heightIn: 9 };
const MODELE = { id: '1T', empreinte: '0'.repeat(64), date: '2026-11-17T00:00:00.000Z' };

/** Une page du livre de synthèse : titre en couleur, texte fixe, sommaire, QR du jeu. */
function pageTitre(start: 'gauche' | 'droite' = 'droite'): Layout {
  return layoutSchema.parse({
    schemaVersion: 2, id: '1T', pages: 1, start, trim: TRIM,
    elements: [
      { id: 'titre', type: 'titre', page: 0, x: 15, y: 15, w: 120, h: 20, maxChars: 40, couleur: 'theme' },
      { id: 'accroche', type: 'texte', page: 0, x: 15, y: 40, w: 120, h: 20, maxChars: 80, texteFixe: { fr: 'Un livre à scanner', en: 'A book to scan' } },
      { id: 'sommaire', type: 'sommaire', page: 0, x: 15, y: 70, w: 120, h: 80 },
      { id: 'jeu', type: 'qr', page: 0, x: 50, y: 160, w: 40, h: 45, qrSideMm: 25, maxChars: 40, texteFixe: { fr: 'Le mini-jeu' } },
    ],
  });
}

// Schéma : page seule, réservée aux pages du livre ; texte fixe, sommaire, couleur.
{
  const one = pageTitre();
  check('schéma : une page seule admise pour une page du livre', layoutSchema.safeParse(one).success);
  const subjectFaults = subjectLayoutSchema.safeParse({ ...one, modele: MODELE });
  const msg = subjectFaults.success ? '' : subjectFaults.error.issues.map((i) => i.message).join(' | ');
  check('schéma : un sujet refuse page seule, sommaire et texte fixe', !subjectFaults.success && msg.includes('2 pages au moins') && msg.includes('sommaire') && msg.includes('texte fixe'), msg);
  const bad = (change: (l: Dict) => void, text: string, name: string) => {
    const l: Dict = structuredClone(one);
    change(l);
    const r = layoutSchema.safeParse(l);
    check(name, !r.success && r.error.issues.some((i) => i.message.includes(text)), r.success ? 'accepté' : r.error.issues.map((i) => i.message));
  };
  bad((l) => { l.elements[1].couleur = 'texte'; }, 'couleur réservé', 'schéma : couleur réservée au titre');
  bad((l) => { l.elements[0].couleur = 'rouge'; }, 'couleur', 'schéma : couleur papier, texte ou theme');
  bad((l) => { l.elements.push({ ...l.elements[2], id: 'sommaire-2' }); }, 'un seul sommaire', 'schéma : un seul sommaire par mise en page');
  bad((l) => { l.elements[1].texteFixe = {}; }, 'au moins une langue', 'schéma : texte fixe vide refusé');
  bad((l) => { l.elements.push({ id: 'img', type: 'illustration', page: 0, x: 1, y: 1, w: 5, h: 5, texteFixe: { fr: 'x' } }); }, 'texteFixe réservé', 'schéma : texte fixe refusé sur une illustration');
}

// Plan pur : numéros réels, page 1 à droite, page de notes avant la dernière partie, C16 du livre, C2.
{
  const part = (kind: 'page' | 'sujet', id: string, pages: number, start: PartInput['start'] = null, place: PartInput['place'] = kind === 'sujet' ? 'sujets' : 'debut'): PartInput => ({ kind, id, place, pages, start, error: null });
  const even = computePlan([part('page', 'titre', 1), part('sujet', 'a', 2), part('sujet', 'b', 2), part('page', 'secours', 1, null, 'fin')]);
  check('plan : numéros dans l’ordre, page 1 en tête', even.parts.map((p) => p.firstPage).join() === '1,2,4,6' && even.total === 6 && !even.notes);
  const odd = computePlan([part('page', 'titre', 1), part('sujet', 'a', 2), part('page', 'secours', 1, null, 'fin'), part('page', 'fin2', 1, null, 'fin')]);
  check('plan : total impair, une page de notes avant la dernière partie', odd.notes && odd.total === 6 && odd.parts.map((p) => p.kind).join() === 'page,sujet,page,notes,page' && odd.parts[4]!.firstPage === 6);
  const broken = computePlan([{ ...part('page', 'x', 1), pages: null, error: 'illisible' }, part('sujet', 'a', 2)]);
  check('plan : partie illisible, numéros inconnus après elle', broken.total === null && broken.parts[1]!.firstPage === null && !broken.notes);
  const side = computePlan([part('sujet', 'a', 2, 'gauche')]).parts[0]!;
  check('C16 du livre : sujet à gauche posé en page 1, nommé', sideFault(side)?.includes('Sujet a') === true && sideFault(side)!.includes('page 1'));
  check('C16 du livre : le bon côté passe', sideFault(computePlan([part('page', 'p', 1), part('sujet', 'a', 2, 'gauche')]).parts[1]!) === null);
  check('C2 : sous 24 pages, erreur', c2Pages(22, [24, 828], 22, null).errors.some((e) => e.includes('entre 24 et 828')));
  check('C2 : dans le barème, sans erreur ; écart au budget et au scénario, alertes', c2Pages(30, [24, 828], 46, 44).errors.length === 0 && c2Pages(30, [24, 828], 46, 44).alerts.length === 2);
}

// Ajouter et retirer une page d'une copie (P-53).
{
  try {
    addPage(layoutSchema.parse(synthese()), 'sujet');
    check('page ajoutée : refusée sous un élément à cheval', false);
  } catch (e) {
    check('page ajoutée : refusée sous un élément à cheval', e instanceof PageChangeRefused && e.message.includes('à cheval'));
  }
  const subject: Layout = layoutSchema.parse({
    schemaVersion: 2, id: '2Y', pages: 2, start: 'gauche', trim: TRIM,
    elements: [
      { id: 'texte-g', type: 'texte', page: 0, x: 15, y: 20, w: 100, h: 50, maxChars: 200 },
      { id: 'texte-d', type: 'texte', page: 1, x: 15, y: 20, w: 100, h: 50, maxChars: 200 },
      { id: 'qr', type: 'qr', page: 1, x: 60, y: 150, w: 40, h: 45, qrSideMm: 25, maxChars: 40 },
    ],
  });
  const three = addPage(subject, 'sujet');
  const qrBefore = subject.elements.find((e) => e.type === 'qr');
  const qrAfter = three.elements.find((e) => e.type === 'qr');
  check('page ajoutée : 2Y devient 3Y, avant la dernière page, le QR reste sur la dernière', three.id === '3Y' && three.pages === 3 && qrBefore!.page === 1 && qrAfter!.page === 2);
  const back = removePage(three, 1, 'sujet');
  check('page retirée : la page vide, retour à 2Y', back.id === '2Y' && JSON.stringify(back.elements) === JSON.stringify(subject.elements));
  try {
    removePage(three, 0, 'sujet');
    check('page retirée : une page non vide est refusée', false);
  } catch (e) {
    check('page retirée : une page non vide est refusée', e instanceof PageChangeRefused && e.message.includes('pas vide'));
  }
  const sansQr = layoutSchema.parse({ ...pageTitre(), elements: pageTitre().elements.filter((e) => e.type !== 'qr') });
  const page = addPage(sansQr, 'page');
  check('page du livre : la page s’ajoute à la fin', page.id === '2T' && page.elements.every((e) => e.page === 0));
  const avecQr = addPage(pageTitre(), 'page');
  check('page du livre avec le QR du jeu : la page s’ajoute avant la dernière, le QR reste sur la dernière', avecQr.pages === 2 && avecQr.elements.find((e) => e.type === 'qr')!.page === 1);
}

// Données : pages du livre, vrais numéros des sujets, ordre, suppression ; rendu ; étape « Livre complet ».
{
  const glbRoot = makeGlbi();
  const parent = tempDir();
  const dataRoot = path.join(parent, 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  cadreLivre(dataRoot, BOOK_ID);
  createCollection(dataRoot);
  createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  const book = () => JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'print-book.json'), 'utf8'));
  check('numéros : le sujet commence après les 5 pages liminaires', firstPageOf(dataRoot, book(), 'alpha') === 6);
  check('livrés : 1N copié dans la collection', fs.existsSync(path.join(dataRoot, 'collection', 'gabarits', '1N.json')));
  writeNewBookPage(dataRoot, BOOK_ID, 'titre', 'fin', subjectLayoutLike(pageTitre('gauche')));
  check('page du livre : écrite dans pages/, ajoutée à la fin', readBookPage(dataRoot, BOOK_ID, 'titre').pages === 1 && book().backMatter.join() === 'secours,titre');
  try {
    writeNewBookPage(dataRoot, BOOK_ID, 'alpha', 'debut', subjectLayoutLike(pageTitre()));
    check('page du livre : identifiant d’un sujet refusé', false);
  } catch (e) {
    check('page du livre : identifiant d’un sujet refusé', e instanceof BookPageRefused && e.message.includes('sujet'));
  }
  // 5 + 2 + 1 + 1 = 9 : une page de notes avant la dernière partie.
  const plan = readPlan(dataRoot, book(), true);
  check('plan lu : page de notes avant la dernière partie', plan.notes && plan.total === 10 && plan.parts.map((p) => p.id).join() === 'liminaires,alpha,secours,notes,titre' && plan.parts[4]!.firstPage === 10);
  movePart(dataRoot, BOOK_ID, 'titre', -1);
  check('ordre : « Monter » dans sa liste', book().backMatter.join() === 'titre,secours');
  const reading = readBook(glbRoot, BOOK_DIR);
  const ctx = bookPageContext(dataRoot, BOOK_ID, 'titre', reading, glbRoot);
  const html = bookPageHtml(ctx);
  check('rendu : texte fixe dans la langue de l’édition', html.includes('Un livre à scanner') && !html.includes('A book to scan'));
  check('rendu : sommaire, titre de la scène et vraie première page', html.includes('class="ligne"><b>alpha fr</b><span>6</span>'));
  check('rendu : titre du livre, en couleur du thème', /<h1 class="zone titre"[^>]*;color:#[0-9a-fA-F]{3,8}"/.test(html));
  check('rendu : QR du jeu (jeu.svg), légende en texte fixe', ctx.qr?.file === 'jeu.svg' && html.includes('Le mini-jeu'));
  check('fautes : page complète sans faute', bookPageFaults(ctx).length === 0, bookPageFaults(ctx));
  const noGame = bookPageContext(dataRoot, BOOK_ID, 'titre', { ...reading, gameQr: null }, glbRoot);
  check('QR du jeu : livre sans jeu, erreur nommée', bookPageFaults(noGame).some((f) => f.startsWith('C9') && f.includes('pas de jeu')));
  const facts = () => readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR);
  const step = () => STEPS.find((s) => s.id === 'livre-complet')!.evaluate(facts());
  check('étape : Livre complet, C2 en erreur sous 24 pages', step().state === 'erreur' && step().reasons.some((r) => r.includes('C2')), step());
  deleteBookPage(dataRoot, BOOK_ID, 'titre');
  check('suppression : rangée dans pages/.supprimes/, sortie de la liste', !book().backMatter.includes('titre') && fs.readdirSync(path.join(dataRoot, BOOK_ID, 'pages', '.supprimes')).some((n) => n.startsWith('titre.')));

  // Routes : état du livre, ajout d'une page, « Miroir » et ajout de page sur la copie d'un sujet.
  put(parent, 'config.local.json', { glbRoot, dataRoot });
  const server = createPrintServer(path.join(parent, 'config.local.json'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  const headers = { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
  const post = (route: string, body: unknown) =>
    new Promise<{ status: number; json: Dict }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: route, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const state = await post('/api/livre/state', { dir: BOOK_DIR });
  check('route : état du livre, parties et modèles', state.status === 200 && state.json.parts.length === 3 && state.json.models.some((m: Dict) => m.id === '1N'), state.json);
  const added = await post('/api/livre/ajouter', { dir: BOOK_DIR, pageId: 'notes-fin', model: '1N', place: 'fin' });
  check('route : ajout d’une page du livre depuis 1N', added.status === 200 && book().backMatter.includes('notes-fin'), added.json);
  const copy = await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'alpha' });
  const mirrored = await post('/api/mise-en-page/miroir', { dir: BOOK_DIR, subjectId: 'alpha', empreinte: copy.json.empreinte });
  check('route : « Miroir » sur la copie d’un sujet, côté changé', mirrored.status === 200 && readSubjectLayout(dataRoot, BOOK_ID, 'alpha')!.start === 'droite', mirrored.json);
  const grown = await post('/api/mise-en-page/ajouter-page', { dir: BOOK_DIR, subjectId: 'alpha', empreinte: mirrored.json.empreinte });
  const subject = JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'subject.json'), 'utf8'));
  check('route : page ajoutée au sujet, subject.json suit (pages, identifiant de la copie)', grown.status === 200 && subject.pages === 3 && subject.template === '3A' && readSubjectLayout(dataRoot, BOOK_ID, 'alpha')!.id === '3A' && readSubjectLayout(dataRoot, BOOK_ID, 'alpha')!.modele.id === '2A', grown.json);
  server.close();
}

// Étape « Livre complet », calcul pur.
{
  const base = (livre: ParcoursFacts['livre']): ParcoursFacts => ({
    configError: null, book: { bookId: 'x', errors: [], alerts: [] },
    folder: { exists: true, error: null, printBook: 'ok', printBookError: null },
    pricing: { error: null, retained: true, retainedErrors: [], deviation: [], bookAlert: null },
    collection: { exists: true, error: null },
    gabarits: { error: null, valid: 1, invalid: [], orphans: [], overlaps: [] },
    droits: { error: null, missing: 0, faults: [], toCheck: [] },
    workflows: { error: null, todo: [], faults: [] },
    styles: { error: null, count: 1, faults: [], todo: [], alerts: [] },
    subjects: [],
    livre,
  });
  const state = (livre: ParcoursFacts['livre']) => computeParcours(base(livre)).steps.find((s) => s.id === 'livre-complet')!;
  const part = { kind: 'page' as const, id: 'p', place: 'debut' as const, firstPage: 1, pages: 1, side: 'droite' as const, start: 'droite' as const, status: null, errors: [] as string[] };
  check('étape : après Sujets, n’exige que Mises en page', state({ parts: [part], total: 24, notes: false, errors: [], alerts: [] }).state === 'validee');
  check('étape : aucune partie, à faire', state({ parts: [], total: 0, notes: false, errors: [], alerts: [] }).state === 'a-faire');
  check('étape : alerte (budget, sujet pas prêt) valide', state({ parts: [part], total: 24, notes: false, errors: [], alerts: ['C2, écart'] }).state === 'alerte');
  check('étape : faute d’une partie, erreur nommée', state({ parts: [{ ...part, errors: ['C16, côté'] }], total: 24, notes: false, errors: [], alerts: [] }).reasons.some((r) => r.includes('p : C16')));
}

function subjectLayoutLike(l: Layout) {
  return { ...l, modele: MODELE };
}

finish('livre');
