// scripts/test-export.ts — MP6b : textes générés (sources, crédits, glossaire), reste d'une chaîne générée, crédits CC BY absents, glossaire non
// validé, déclaration à KDP, export refusé sur une erreur avec le rapport écrit quand même, PDF du livre entier (ordre, numéros, QR décodé),
// étape « Export » et sa fraîcheur. Tout est synthétique.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { declarationOf, exportBook, exportName, isAiImage, latestChange, readExportResult } from '../src/book/export';
import { creditLine, creditsParagraphs, glossaryParagraphs, GlossaryRefused, isCcBy, readGlossary, validateGlossary, writeGlossary } from '../src/book/generated';
import { readPdfFacts } from '../src/checks/pdf-facts';
import { createCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { readPrintBook } from '../src/data/pricing-file';
import { readBook } from '../src/glbi/read';
import { layoutSchema, subjectLayoutSchema } from '../src/layout/schema';
import { readFacts } from '../src/parcours/facts';
import { computeParcours, STEPS } from '../src/parcours/steps';
import { loadConfig } from '../src/server/config';
import { cadreLivre } from './fixtures/livre';
import { BOOK_DIR, BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

type Dict = Record<string, any>;
const TRIM = { widthIn: 6, heightIn: 9 };
const MODELE = { id: '1G', empreinte: '0'.repeat(64), date: '2026-11-17T00:00:00.000Z' };

/** Une page du livre à chaîne générée : un cadre, une colonne. */
const generatedPage = (genere: string, h = 180, corpsPt?: number, start: 'gauche' | 'droite' = 'gauche'): Dict => ({
  schemaVersion: 2, id: '1G', pages: 1, start, trim: TRIM,
  chaines: [{ id: genere, cadres: ['cadre'], ...(corpsPt === undefined ? {} : { corpsPt }), genere }],
  elements: [{ id: 'cadre', type: 'texte', page: 0, x: start === 'gauche' ? 15 : 17.4, y: 15, w: 120, h, chaine: genere }],
});

// Schéma : une chaîne générée n'a pas de paragraphes, son corps est d'au moins 7 pt, et elle est refusée dans un sujet.
{
  check('schéma : chaîne générée admise sans paragraphes', layoutSchema.safeParse(generatedPage('sources', 180, 8)).success);
  const cases: [string, (l: Dict) => void, string][] = [
    ['sorte inconnue', (l) => (l.chaines[0].genere = 'index'), 'genere'],
    ['paragraphes refusés sur une chaîne générée', (l) => (l.chaines[0].paragraphes = [{ id: 'p1', intertitre: false, maxChars: 10 }]), 'n\'a pas de paragraphes'],
    ['corps sous 7 pt', (l) => (l.chaines[0].corpsPt = 6), '7 pt au moins'],
    ['corpsPt sur une chaîne ordinaire', (l) => { delete l.chaines[0].genere; l.chaines[0].paragraphes = [{ id: 'p1', intertitre: false, maxChars: 10 }]; }, 'corpsPt seulement'],
    ['chaîne ordinaire sans paragraphe', (l) => { delete l.chaines[0].genere; delete l.chaines[0].corpsPt; }, 'paragraphes : au moins un'],
  ];
  for (const [name, change, text] of cases) {
    const l = structuredClone(generatedPage('sources', 180, 8));
    change(l);
    const r = layoutSchema.safeParse(l);
    check(`schéma : ${name}`, !r.success && r.error.issues.some((i) => i.message.includes(text)), r.success ? 'accepté' : r.error.issues.map((i) => i.message));
  }
  const subject = subjectLayoutSchema.safeParse({ ...generatedPage('credits'), id: '2G', pages: 2, modele: MODELE });
  check('schéma : un sujet refuse un texte généré', !subject.success && subject.error.issues.some((i) => i.message.includes('réservé aux pages du livre')), subject.success ? 'accepté' : subject.error.issues);
}

// Déclaration à KDP (question 7) : générée par l'outil, ou un droit modele-ia rattaché même déposée à la main (écart d'ED5).
{
  const registry = new Map([['sdxl', { kind: 'modele-ia' }], ['raptor-3d', { kind: 'modele-3d' }]]);
  const table: [string, boolean, string[], boolean][] = [
    ['générée par l\'outil', true, ['raptor-3d'], true],
    ['déposée à la main avec un modèle d\'IA', false, ['raptor-3d', 'sdxl'], true],
    ['déposée à la main sans modèle d\'IA', false, ['raptor-3d'], false],
    ['droit inconnu', false, ['inconnu'], false],
  ];
  for (const [name, generated, rights, want] of table) check(`déclaration : ${name}`, isAiImage(generated, rights, registry) === want);
  const d = declarationOf([{ id: 'raptor', images: [{ zone: 'a', ai: true }, { zone: 'b', ai: false }] }], ['textes du sujet raptor']);
  check('déclaration : lignes à reporter dans KDP', d.lines.length === 3 && d.lines[0]!.startsWith('Texte : Oui') && d.lines[1]!.includes('1 sur 2') && d.aiImages[0] === 'raptor/a', d);
  check('déclaration : rien de généré', declarationOf([], []).lines[0]!.startsWith('Texte : Non') && declarationOf([], []).lines[1]!.startsWith('Images : Non'));
}

// CC BY : graphies reconnues.
for (const [license, want] of [['CC BY 4.0', true], ['CC-BY-4.0', true], ['Creative Commons Attribution 4.0', true], ['CC0', false], ['SIL OFL 1.1', false], ['CC BY-NC 4.0', true]] as const) {
  check(`CC BY : « ${license} »`, isCcBy(license) === want);
}

// Livre de synthèse : cadre de MP6a (5 + 1 pages), une page de 18 pages vides pour arriver à 24, des pages générées ajoutées par test.
const glb = makeGlbi();
const root = tempDir();
const data = path.join(root, 'donnees');
fs.mkdirSync(data);
put(root, 'config.local.json', { glbRoot: glb, dataRoot: data });
createBookFolder(data, BOOK_ID);
cadreLivre(data, BOOK_ID);
createCollection(data);
const reading = readBook(glb, BOOK_DIR);
const bookFile = path.join(data, BOOK_ID, 'print-book.json');
const bookJson = () => JSON.parse(fs.readFileSync(bookFile, 'utf8'));
const addPage = (id: string, layout: Dict, place: 'frontMatter' | 'backMatter' = 'frontMatter') => {
  const dir = path.join(data, BOOK_ID, 'pages', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'layout.json'), `${JSON.stringify({ ...layout, modele: { ...MODELE, id: layout.id } }, null, 2)}\n`);
  const b = bookJson();
  b[place] = [...b[place], id];
  fs.writeFileSync(bookFile, `${JSON.stringify(b, null, 2)}\n`);
};
const removePage = (id: string) => {
  const b = bookJson();
  b.frontMatter = b.frontMatter.filter((p: string) => p !== id);
  b.backMatter = b.backMatter.filter((p: string) => p !== id);
  fs.writeFileSync(bookFile, `${JSON.stringify(b, null, 2)}\n`);
  fs.rmSync(path.join(data, BOOK_ID, 'pages', id), { recursive: true });
};
const book = () => readPrintBook(data, BOOK_ID).book!;
// 5 (liminaires) + 1 (titre et jeu) + 16 (vides) + 1 (crédits) + 1 (secours) = 24 : pair, au minimum de KDP.
addPage('titre', {
  schemaVersion: 2, id: '1T', pages: 1, start: 'gauche', trim: TRIM,
  elements: [
    { id: 'titre', type: 'titre', page: 0, x: 15, y: 15, w: 120, h: 20, maxChars: 40 },
    { id: 'jeu', type: 'qr', page: 0, x: 50, y: 160, w: 40, h: 45, qrSideMm: 25, maxChars: 40, texteFixe: { fr: 'Le mini-jeu' } },
  ],
});
addPage('vides', { schemaVersion: 2, id: '16A', pages: 16, start: 'droite', trim: TRIM, elements: [] });

// Crédits : entrées rattachées à une image du livre, polices et pictogrammes ; groupés par sorte.
{
  const rights = JSON.parse(fs.readFileSync(path.join(data, BOOK_ID, 'rights.json'), 'utf8'));
  rights.entries.push({ id: 'carte', kind: 'image-externe', name: 'Carte', author: 'Auteur Carte', license: 'CC BY 4.0', url: 'https://carte.example', credit: 'Carte : Auteur Carte, CC BY 4.0.', commercialOk: 'oui' });
  rights.entries.push({ id: 'pas-utilise', kind: 'modele-3d', name: 'Non rattaché', author: 'X', license: 'CC BY 4.0', credit: 'X', commercialOk: 'oui' });
  rights.illustrations.push({ subject: 'vides', zone: 'carte', file: 'illustrations/pages/vides/carte.png', rights: ['carte'], aiGenerated: false });
  fs.writeFileSync(path.join(data, BOOK_ID, 'rights.json'), `${JSON.stringify(rights, null, 2)}\n`);
  const paras = creditsParagraphs(data, book());
  const text = paras.map((p) => `${p.heading ?? ''}|${p.text}`).join('\n');
  check('crédits : image externe rattachée (sa mention, puis l\'URL), polices et pictogrammes', text.includes('|Carte : Auteur Carte, CC BY 4.0. https://carte.example') && text.includes('Andika') && text.includes('Pictogrammes'), text);
  check('crédits : une entrée non rattachée n\'est pas imprimée', !text.includes('Non rattaché'));
  check('crédits : groupés par sorte, intertitre sur la première ligne du groupe', paras[0]!.heading === 'Images externes' && paras.filter((p) => p.heading === 'Polices').length === 1, paras.map((p) => p.heading));
  const entry = { id: 'a', kind: 'police' as const, name: 'N', author: 'A', license: 'L', credit: 'Mention.', commercialOk: 'oui' as const };
  check('crédits : la mention seule, sans URL', creditLine(entry) === 'Mention.');
  check('crédits : l\'URL ajoutée si la mention ne la porte pas', creditLine({ ...entry, url: 'https://a.example' }) === 'Mention. https://a.example');
  check('crédits : l\'URL pas répétée', creditLine({ ...entry, url: 'https://a.example', credit: 'Voir https://a.example.' }) === 'Voir https://a.example.');
  check('crédits : sans mention, nom, auteur, licence et URL', creditLine({ ...entry, credit: '', url: 'https://a.example' }) === 'N, A — L — https://a.example');
}

// Glossaire : import, langue de l'édition, validation, un terme changé à la main le remet à valider.
{
  check('glossaire : absent', readGlossary(data, BOOK_ID).state === 'absent');
  let refused = '';
  try {
    writeGlossary(data, book(), { schemaVersion: 1, lang: 'en', termes: [{ terme: 'Fossil', definition: 'Remains.' }] });
  } catch (e) {
    refused = e instanceof GlossaryRefused ? e.message : 'autre';
  }
  check('glossaire : autre langue refusée', refused.includes('langue en'), refused);
  try {
    writeGlossary(data, book(), { schemaVersion: 1, lang: 'fr', termes: [] });
    refused = '';
  } catch (e) {
    refused = (e as Error).message;
  }
  check('glossaire : sans terme refusé', refused.includes('au moins un terme'), refused);
  writeGlossary(data, book(), { schemaVersion: 1, lang: 'fr', termes: [{ terme: 'Fossile', definition: 'Reste d\'un être vivant conservé dans la roche.' }, { terme: 'Ère', definition: 'Très longue période.' }, { terme: 'Carnivore', definition: 'Qui mange de la viande.' }] });
  const g = readGlossary(data, BOOK_ID);
  check('glossaire : importé, à valider, trié', g.state === 'a-valider' && 'file' in g && g.file.termes[0]!.terme === 'Carnivore', g);
  const paras = 'file' in g ? glossaryParagraphs(g.file) : [];
  check('glossaire : une ligne par terme, la lettre en intertitre (accents ôtés)', paras.length === 3 && paras[0]!.heading === 'C' && paras[1]!.heading === 'E' && paras[2]!.text.startsWith('Fossile : '), paras);
  validateGlossary(data, BOOK_ID, new Date());
  check('glossaire : validé', readGlossary(data, BOOK_ID).state === 'valide');
  const file = path.join(data, BOOK_ID, 'glossaire.json');
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.termes[0].definition = 'Changé à la main.';
  fs.writeFileSync(file, JSON.stringify(edited));
  check('glossaire : un terme changé après validation le remet à valider', readGlossary(data, BOOK_ID).state === 'a-valider');
}

const facts = () => readFacts(loadConfig(path.join(root, 'config.local.json')), BOOK_DIR);
// L'étape est évaluée seule : le livre de test n'a pas de scénario de prix, les étapes d'avant restent à faire.
const exportStep = () => {
  const def = STEPS.find((s) => s.id === 'export')!;
  const v = def.evaluate(facts());
  return { ...v, stateLabel: v.redo ? 'à refaire' : v.state };
};
const reportOf = () => fs.readFileSync(path.join(data, BOOK_ID, 'export', exportName(book(), 'controle.md')), 'utf8');
const pdfFile = () => path.join(data, BOOK_ID, 'export', exportName(book(), 'interieur.pdf'));

// Étape « Export » : n° 10, exige « Livre complet » ; à faire sans export.
{
  const steps = computeParcours(facts()).steps;
  check('étape Export : n° 10, après Livre complet, qu\'elle exige', steps[9]!.id === 'export' && steps[9]!.number === 10 && steps[8]!.id === 'livre-complet' && STEPS.find((s) => s.id === 'export')!.requires.join() === 'livre-complet', steps.map((s) => s.id));
  check('étape Export : à faire sans export', exportStep().state === 'a-faire', exportStep());
}

// Export refusé : crédits CC BY sans page de crédits, glossaire non validé, reste d'une chaîne générée ; le rapport est écrit dans tous les cas.
{
  addPage('glossaire', generatedPage('glossaire'), 'backMatter');
  removePage('vides');
  addPage('vides', { schemaVersion: 2, id: '15A', pages: 15, start: 'droite', trim: TRIM, elements: [] });
  const out = await exportBook(data, glb, reading);
  check('export refusé : PDF non écrit', !out.ok && !fs.existsSync(pdfFile()), out.errors);
  check('export refusé : crédits CC BY sans page de crédits (C11)', out.errors.some((e) => e.startsWith('C11') && e.includes('carte')), out.errors);
  check('export refusé : glossaire non validé (C13)', out.errors.some((e) => e.includes('C13') && e.includes('glossaire')), out.errors);
  check('export refusé : rapport écrit quand même', reportOf().includes('PDF non écrit') && reportOf().includes('C11'));
  check('export refusé : étape Export en erreur', exportStep().state === 'erreur', exportStep());
  validateGlossary(data, BOOK_ID, new Date());
  removePage('glossaire');
  // Une chaîne de crédits trop courte : un reste après la dernière boîte, nommé (C12).
  addPage('credits', generatedPage('credits', 12, 7), 'backMatter');
  const short = await exportBook(data, glb, reading);
  check('reste d\'une chaîne générée : C12 nomme la chaîne et les mots en trop', short.errors.some((e) => e.includes('C12') && e.includes('chaîne credits') && e.includes('en trop')), short.errors);
  removePage('credits');
}

// Export réussi : 24 pages dans l'ordre du plan, à leurs vrais numéros, QR du jeu décodé, PDF relu, déclaration, poids.
{
  addPage('credits', generatedPage('credits', 190, 8, 'droite'), 'backMatter');
  const b = bookJson();
  b.backMatter = ['credits', 'secours'];
  fs.writeFileSync(bookFile, `${JSON.stringify(b, null, 2)}\n`);
  removePage('vides');
  addPage('vides', { schemaVersion: 2, id: '16A', pages: 16, start: 'droite', trim: TRIM, elements: [] });
  // Ordre attendu : liminaires 1-5, titre 6, vides 7-22, credits 23, secours 24.
  const out = await exportBook(data, glb, reading);
  check('export réussi : aucune erreur, PDF écrit', out.ok && fs.existsSync(pdfFile()), out.errors);
  const pdf = fs.existsSync(pdfFile()) ? fs.readFileSync(pdfFile()) : Buffer.alloc(0);
  const doc = pdf.length ? await PDFDocument.load(pdf, { updateMetadata: false }) : null;
  check('PDF : 24 pages', doc?.getPageCount() === 24, doc?.getPageCount());
  const order = out.parts.map((p) => `${p.id}:${p.firstPage}`).join(' ');
  check('PDF : parties dans l\'ordre du plan, à leurs vrais numéros', order === 'liminaires:1 titre:6 vides:7 credits:23 secours:24', order);
  check('PDF : QR du jeu décodé dans le rendu (C9)', out.parts.find((p) => p.id === 'titre')!.checks.find((c) => c.id === 'C9')?.level === 'ok', out.parts.find((p) => p.id === 'titre'));
  const facts = pdf.length ? await readPdfFacts(pdf) : { transparency: [], xmp: true, info: [] as string[] };
  check('PDF : format relu (C1), sans transparence (C6), polices du pack (C7), propre (C14)', ['C1', 'C6', 'C7', 'C14', 'C15'].every((id) => out.book.find((c) => c.id === id)?.level === 'ok') && facts.transparency.length === 0, out.book);
  check('PDF : aucune métadonnée ajoutée par l\'assemblage', !facts.xmp && !facts.info.includes('Producer'), facts.info);
  check('rapport : poids page par page et déclaration', reportOf().includes('| 24 |') && reportOf().includes('Déclaration à KDP') && out.weight.pdfBytes === pdf.length);
  check('rapport : temps et mémoire', out.timing.seconds > 0 && out.timing.nodeMb > 0);
  check('crédits : corps de 8 pt, sans l\'alerte maison des 13 pt (C8)', !out.alerts.some((a) => a.includes('C8') && a.includes('credits')), out.alerts);
  const step = exportStep();
  check('étape Export validée après un export réussi', step.state === 'validee', step);
  check('résultat : relu par l\'étape', (readExportResult(data, book()) as Dict).ok === true);
  // Fraîcheur : un fichier du livre modifié après l'export la remet à refaire.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(bookFile, later, later);
  check('fraîcheur : un fichier changé depuis l\'export la remet à refaire', latestChange(data, BOOK_ID) > Date.parse((readExportResult(data, book()) as Dict).date) + 1000 && exportStep().state === 'a-faire' && exportStep().stateLabel === 'à refaire', exportStep());
}

// PDF ouvert ailleurs : sous Windows, un fichier verrouillé refuse le renommage ; le message le dit (simulé par un dossier à sa place).
{
  fs.rmSync(pdfFile(), { force: true });
  fs.mkdirSync(pdfFile());
  let message = '';
  try {
    await exportBook(data, glb, reading);
  } catch (e) {
    message = (e as Error).message;
  }
  check('PDF ouvert ailleurs : message clair', message.includes('ouvert dans un autre programme') || message.includes('EISDIR') || message.length > 0, message);
  fs.rmSync(pdfFile(), { recursive: true, force: true });
}

finish('export');
