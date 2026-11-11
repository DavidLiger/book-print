// scripts/test-mises-en-page.ts — mises en page version 2 (ED1) : schéma et refus, lecture dans la collection, conversion de la version 1 au
// HTML identique, pose (fond perdu, élément à cheval, côté de départ), rendu des éléments ajoutés, C17 (chaque cas permis et interdit), C16,
// copie dans un sujet, étapes du parcours, routes. Tout est synthétique.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { c17Overlaps, overlapFault, overlapFaults } from '../src/checks/overlaps';
import { readPdfFacts } from '../src/checks/pdf-facts';
import { runChecks } from '../src/checks/rules';
import { createCollection, readCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { createSubject, readSubjectLayout, SubjectRefused, updateSubject } from '../src/data/subject-file';
import { copyModel } from '../src/layout/files';
import { fromV1 } from '../src/layout/from-v1';
import { elementsOf, placeMiseEnPage, sameFormat } from '../src/layout/model';
import { placeLayout, startFault } from '../src/layout/place';
import { layoutSchema, subjectLayoutSchema } from '../src/layout/schema';
import { readFacts } from '../src/parcours/facts';
import { computeParcours, STEPS, type ParcoursFacts } from '../src/parcours/steps';
import { buildEssai, packFonts } from '../src/render/essai';
import { controlTemplate, templateContent, templatePreview } from '../src/render/gabarit';
import { renderHtml } from '../src/render/html';
import { measureHtml, renderPdf } from '../src/render/pdf';
import { subjectContext, subjectHtml } from '../src/render/subject';
import { expectedBlocks, zoneLimit } from '../src/research/blocks';
import { mergeImport } from '../src/research/import';
import { createPrintServer } from '../src/server/app';
import { readTemplates, templateOf } from '../src/templates/files';
import { BLEED_MM, GeometryRefused, layoutTemplate, type LayoutPage, type LayoutZone } from '../src/templates/geometry';
import { TEMPLATE_2A } from './fixtures/gabarits';
import { synthese, W } from './fixtures/mises-en-page';
import { BOOK_DIR, BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makeResearch } from './fixtures/recherche';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { check, finish } from './test-lib';

type Dict = Record<string, any>;
const SIX_NINE = { widthIn: 6, heightIn: 9 };
const LETTER = { widthIn: 8.5, heightIn: 11 };
const MARGINS = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 15 };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const expectThrows = (name: string, fn: () => unknown, kind: new (...a: never[]) => Error, text: string) => {
  try {
    fn();
    check(name, false);
  } catch (e) {
    check(name, e instanceof kind && e.message.includes(text), (e as Error).message);
  }
};
/** Objets image distincts du PDF : `facts.images` compte une image par page qui la cite. */
const imageObjects = (pdf: Uint8Array) => {
  let n = 0;
  return PDFDocument.load(pdf).then((doc) => {
    for (const [, obj] of doc.context.enumerateIndirectObjects()) if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image') n++;
    return n;
  });
};
const newData = (collection = true) => {
  const dataRoot = path.join(tempDir(), 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  if (collection) createCollection(dataRoot);
  return dataRoot;
};
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else out[path.relative(root, full)] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(root);
  return out;
};

// Schéma version 2 : la mise en page de synthèse, puis chaque refus.
{
  const ok = layoutSchema.safeParse(synthese());
  check('schéma : mise en page de synthèse admise', ok.success, ok.error?.issues);
  const refused = (name: string, change: (l: Dict) => void, text: string) => {
    const l = synthese() as Dict;
    change(l);
    const r = layoutSchema.safeParse(l);
    check(`schéma refusé : ${name}`, !r.success && r.error.issues.some((i) => i.message.includes(text)), r.success ? 'admis' : r.error.issues.map((i) => i.message));
  };
  const el = (l: Dict, id: string) => l.elements.find((e: Dict) => e.id === id);
  refused('autre schemaVersion', (l) => (l.schemaVersion = 3), 'schemaVersion');
  refused('start libre (version 1 seulement)', (l) => (l.start = 'libre'), 'start');
  refused('identifiant et pages incompatibles', (l) => (l.pages = 4), 'incompatible');
  refused('élément en double', (l) => l.elements.push({ ...el(l, 'chapeau') }), 'en double');
  refused('élément sur une page absente', (l) => (el(l, 'chapeau').page = 2), 'page 2');
  refused('élément hors de la page rognée', (l) => (el(l, 'chapeau').x = 40), 'hors de la page rognée');
  refused('largeur nulle', (l) => (el(l, 'chapeau').w = 0), 'largeur positive');
  refused('icône sur un texte', (l) => (el(l, 'texte').icone = 'taille'), 'icone réservé');
  refused('alignement sur un texte', (l) => (el(l, 'texte').alignement = 'milieu'), 'alignement réservé');
  refused('alignement inconnu', (l) => (el(l, 'capsule').alignement = 'centre'), '"milieu"');
  refused('sorte sur un texte', (l) => (el(l, 'texte').sorte = 'capsule'), 'sorte réservé');
  refused('flèche sur une légende', (l) => (el(l, 'legende').fleche = { x: 1, y: 1 }), 'fleche réservé');
  refused('image sur une étiquette', (l) => (el(l, 'etiquette').image = 'panorama'), 'image réservé');
  refused('consigne sur un chapeau', (l) => (el(l, 'chapeau').consigne = 'x'), 'consigne réservé');
  refused('consigne trop longue', (l) => (el(l, 'legende').consigne = 'x'.repeat(301)), '300 caractères');
  refused('encadré sans couleur', (l) => delete el(l, 'capsule').encadre, 'encadre attendu');
  refused('bandeau sans maxChars', (l) => delete el(l, 'bandeau').maxChars, 'maxChars attendu');
  refused('heading fixe et headingMaxChars', (l) => (el(l, 'capsule').heading = { fr: 'a', en: 'b', es: 'c' }), 'pas les deux');
  refused('question sans en-tête', (l) => delete el(l, 'question').headingMaxChars, 'headingMaxChars attendu');
  refused('légende vers un élément qui n’est pas une illustration', (l) => (el(l, 'legende').image = 'texte'), 'aucune illustration');
  refused('légende vers un élément absent', (l) => (el(l, 'legende').image = 'absente'), 'aucune illustration');
  refused('point de la flèche hors de la page', (l) => (el(l, 'etiquette').fleche = { x: 200, y: 10 }), 'hors de la page');
  refused('point de la flèche dans l’étiquette', (l) => (el(l, 'etiquette').fleche = { x: 100, y: 25 }), 'dans l\'étiquette');
  refused('QR ailleurs que sur la dernière page', (l) => (el(l, 'qr').page = 0), 'dernière page');
  refused('QR sans côté', (l) => delete el(l, 'qr').qrSideMm, 'côté du QR');
  refused('deux QR', (l) => l.elements.push({ ...el(l, 'qr'), id: 'qr2' }), 'un seul QR');
  refused('élément à texte à cheval', (l) => Object.assign(el(l, 'chapeau'), { double: true }), 'sont à cheval');
  refused('élément à cheval sur une page droite', (l) => Object.assign(l, { start: 'droite' }), 'page droite');
  refused('élément à cheval sur la dernière page', (l) => Object.assign(el(l, 'panorama'), { page: 1, w: W, double: true }), 'dernière page');
  refused('fond perdu sur un texte', (l) => (el(l, 'chapeau').fondPerdu = ['haut']), 'vont au bord');
  refused('fond perdu sans toucher le bord', (l) => (el(l, 'bandeau').fondPerdu = ['bas']), 'sans toucher');
  refused('fond perdu en double', (l) => (el(l, 'bandeau').fondPerdu = ['exterieur', 'exterieur']), 'en double');
  // Les champs d'ED2 sont admis depuis ED2 (test:texte-detoure) ; ici, chacun sans ce qui le rend valable.
  refused('cadre d’une chaîne absente (ED2)', (l) => Object.assign(el(l, 'texte'), { chaine: 'corps', maxChars: undefined }), 'absente de chaines');
  refused('colonnes hors d’une chaîne (ED2)', (l) => (el(l, 'texte').colonnes = 2), 'seulement sur un cadre de chaîne');
  refused('détouré à cheval (ED2)', (l) => Object.assign(el(l, 'panorama'), { detoure: true, habillage: 'gauche' }), 'pas à cheval');
  refused('habillage sans détouré (ED2)', (l) => (el(l, 'panorama').habillage = 'gauche'), 'seulement pour un détouré');
  refused('chaîne vers un cadre absent (ED2)', (l) => (l.chaines = [{ id: 'corps', cadres: ['absent'], paragraphes: [{ id: 'p1', intertitre: false, maxChars: 10 }] }]), 'absent des éléments');
  refused('champ inconnu', (l) => (el(l, 'texte').couleur = 'rouge'), 'couleur');
  check('schéma : capsule sans en-tête admise (comme GB1)', layoutSchema.safeParse({ ...synthese(), elements: synthese().elements.map((e) => (e.id === 'capsule' ? { ...e, headingMaxChars: undefined } : e)) }).success);
  check('schéma : question à en-tête fixe admise', layoutSchema.safeParse({ ...synthese(), elements: synthese().elements.map((e) => (e.id === 'question' ? { ...e, headingMaxChars: undefined, heading: { fr: 'Pourquoi ?', en: 'Why?', es: '¿Por qué?' } } : e)) }).success);
  const subjectRefusal = subjectLayoutSchema.safeParse(synthese());
  check('layout.json d’un sujet : modele exigé', !subjectRefusal.success && subjectRefusal.error.issues.some((i) => i.path.join() === 'modele'));
  const badHash = subjectLayoutSchema.safeParse({ ...synthese(), modele: { id: '2A', empreinte: 'abc', date: new Date().toISOString() } });
  check('layout.json d’un sujet : empreinte SHA-256 exigée', !badHash.success && badHash.error.issues.some((i) => i.message.includes('SHA-256')));
}

// Lecture dans la collection : versions 1 et 2 ensemble, refus seul, icône contrôlée contre le style, jamais réécrit.
{
  const dataRoot = newData();
  const style = readCollection(dataRoot)!.style;
  put(dataRoot, 'collection/gabarits/2Y.json', synthese());
  const unknownIcon = synthese('2X') as Dict;
  unknownIcon.elements.find((e: Dict) => e.id === 'capsule').icone = 'inconnue';
  put(dataRoot, 'collection/gabarits/2X.json', unknownIcon);
  const broken = { ...synthese('2W'), elements: [] as unknown[], extra: 1 };
  put(dataRoot, 'collection/gabarits/2W.json', broken);
  const before = fs.readFileSync(path.join(dataRoot, 'collection', 'gabarits', '2W.json'), 'utf8');
  const lib = readTemplates(dataRoot, style);
  const entry = (id: string) => lib.entries.find((e) => e.id === id)!;
  check('lecture : 2A (version 1) et 2Y (version 2) valides ensemble', entry('2A').template !== null && entry('2Y').template !== null && 'schemaVersion' in entry('2Y').template!);
  check('lecture : icône inconnue du style, nommée', entry('2X').template === null && entry('2X').error!.includes('icône inconnue'), entry('2X').error);
  check('lecture : version 2 invalide refusée seule', entry('2W').template === null && entry('2W').error!.includes('extra'), entry('2W').error);
  check('lecture : fichier invalide jamais réécrit', fs.readFileSync(path.join(dataRoot, 'collection', 'gabarits', '2W.json'), 'utf8') === before);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, 'collection', 'gabarits', '2Y.json'))).digest('hex');
  const found = templateOf(lib, '2Y');
  check('lecture : empreinte des octets lus', 'sha256' in found && found.sha256 === sha);
  check('format : version 2 du livre, version 1 de tout format', sameFormat(entry('2Y').template!, SIX_NINE) && !sameFormat(entry('2Y').template!, LETTER) && sameFormat(TEMPLATE_2A, LETTER));
  expectThrows('pose : version 2 d’un autre format refusée, sans mise à l’échelle', () => placeMiseEnPage(entry('2Y').template!, LETTER, MARGINS, 6), GeometryRefused, 'faite pour 6 × 9"');
}

// Conversion de la version 1 : HTML identique, à l'octet, pour l'essai aux cinq thèmes, en 6 × 9" et en 8,5 × 11".
{
  const dataRoot = newData();
  const read = readCollection(dataRoot)!;
  for (const trim of [SIX_NINE, LETTER]) {
    const converted = fromV1(TEMPLATE_2A, trim, read.style.margins, 6);
    for (const theme of Object.keys(read.style.palette.themes)) {
      const a = buildEssai(trim, read, theme, TEMPLATE_2A).html;
      const b = buildEssai(trim, read, theme, converted).html;
      check(`conversion : HTML identique, essai ${trim.widthIn} × ${trim.heightIn}", ${theme}`, a === b);
    }
    const pa = layoutTemplate(TEMPLATE_2A, trim, read.style.margins, 6);
    const pb = placeMiseEnPage(converted, trim, read.style.margins, 6);
    check(`conversion : même géométrie, ${trim.widthIn} × ${trim.heightIn}"`, pa.every((p, i) => p.zones.every((z, j) => {
      const o = pb[i]!.zones[j]!;
      return o.id === z.id && near(o.rect.left, z.rect.left) && near(o.rect.right, z.rect.right) && near(o.rect.top, z.rect.top) && near(o.rect.bottom, z.rect.bottom) && o.bleedEdges.join() === z.bleedEdges.join();
    })));
  }
  const converted = fromV1(TEMPLATE_2A, SIX_NINE, read.style.margins, 6);
  check('conversion : version 2, format du livre, ordre des zones gardé', converted.schemaVersion === 2 && converted.trim.widthIn === 6 && converted.elements.map((e) => e.id).join() === TEMPLATE_2A.sheets.flatMap((s) => s.zones.map((z) => z.id)).join());
  check('conversion : bandeau 2A, fond perdu haut et extérieur', JSON.stringify(converted.elements[0]!.fondPerdu) === '["haut","exterieur"]' && converted.elements[0]!.x === 0 && converted.elements[0]!.w === 152.4);
  check('conversion : coordonnées au millionième', converted.elements.every((e) => [e.x, e.y, e.w, e.h].every((n) => Math.round(n * 1e6) / 1e6 === n)));
  check('conversion : contraintes et champs repris', converted.elements.find((e) => e.id === 'qr')!.qrSideMm === 25 && converted.elements.find((e) => e.id === 'fiche')!.itemMaxChars === 28);
  check('conversion : blocs attendus inchangés', JSON.stringify(expectedBlocks(converted, read.style.fiche, 'fr')) === JSON.stringify(expectedBlocks(TEMPLATE_2A, read.style.fiche, 'fr')));
  check('conversion : limite du titre et de la légende du QR', zoneLimit(converted, 'titre') === 40 && zoneLimit(converted, 'qr') === 44);
  const libre = fromV1({ ...TEMPLATE_2A, start: 'libre' }, SIX_NINE, read.style.margins, 7);
  check('conversion : gabarit libre posé en page 7, départ à droite', libre.start === 'droite');
  expectThrows('conversion : côté de départ refusé', () => fromV1(TEMPLATE_2A, SIX_NINE, read.style.margins, 7), GeometryRefused, 'page droite');
  expectThrows('conversion : format trop petit refusé', () => fromV1(TEMPLATE_2A, { widthIn: 2, heightIn: 3 }, read.style.margins, 6), GeometryRefused, 'ne tient pas');
}

// Pose : fond perdu, élément à cheval, côté de départ (C16).
{
  const layout = layoutSchema.parse(synthese());
  const pages = placeLayout(layout, MARGINS, 6);
  const zone = (page: number, id: string) => pages[page]!.zones.find((z) => z.id === id)!;
  const [debut, fin] = [zone(0, 'panorama'), zone(1, 'panorama')];
  check('à cheval : posé sur ses deux pages, une fois chacune', pages[0]!.zones.filter((z) => z.id === 'panorama').length === 1 && debut.double === 'debut' && fin.double === 'fin');
  check('à cheval : même taille sur les deux pages', near(debut.rect.right - debut.rect.left, fin.rect.right - fin.rect.left) && near(debut.rect.right - debut.rect.left, 2 * W + 2 * BLEED_MM));
  check('à cheval : continu au pli (décalé d’une largeur rognée)', near(debut.rect.left, 0) && near(fin.rect.left, -W - BLEED_MM + 0) && near(fin.rect.right, pages[1]!.widthMm));
  check('à cheval : fond perdu extérieur et haut sur chaque page', debut.bleedEdges.join() === 'outer,top' && fin.bleedEdges.join() === 'outer,top' && near(debut.rect.top, 0));
  const bandeau = zone(0, 'bandeau');
  check('bandeau : fond perdu extérieur sur la page gauche, rien côté pli', near(bandeau.rect.left, 0) && near(bandeau.rect.right, BLEED_MM + W) && bandeau.bleedEdges.join() === 'outer');
  check('bandeau : titre posé dans la zone de sécurité', near(bandeau.textRect!.left, pages[0]!.safe.left) && near(bandeau.textRect!.right, pages[0]!.safe.right) && near(bandeau.textRect!.top, BLEED_MM + 110));
  const etiquette = zone(1, 'etiquette');
  check('étiquette : point visé en coordonnées de la page', near(etiquette.fleche!.x, 40) && near(etiquette.fleche!.y, BLEED_MM + 70));
  check('légende : image et consigne reprises', zone(1, 'legende').image === 'panorama' && zone(1, 'legende').consigne!.startsWith('Ce que'));
  check('capsule : icône et sorte reprises', zone(0, 'capsule').icone === 'taille' && zone(0, 'capsule').sorte === 'capsule' && zone(0, 'capsule').headingMaxChars === 18);
  const right = { ...synthese('2V'), start: 'droite', elements: synthese().elements.filter((e) => e.id !== 'panorama' && e.id !== 'legende') };
  const rightLayout = layoutSchema.parse(right);
  const rp = placeLayout(rightLayout, MARGINS, 7);
  check('page droite : fond perdu extérieur à droite', near(rp[0]!.zones.find((z) => z.id === 'bandeau')!.rect.right, rp[0]!.widthMm) && near(rp[0]!.zones.find((z) => z.id === 'bandeau')!.rect.left, 0));
  check('C16 : côté juste, aucune faute', startFault(layout, 6) === null);
  check('C16 : page impaire pour une mise en page gauche, nommée', startFault(layout, 7)!.includes('page 7 est une page droite'));
  expectThrows('C16 : la pose est refusée', () => placeLayout(layout, MARGINS, 7), GeometryRefused, 'commence sur une page gauche');
  const noSafe = layoutSchema.parse({ ...synthese('2U'), elements: [{ id: 'bandeau', type: 'bandeau', page: 0, x: 0, y: 0, w: 10, h: 10, maxChars: 4 }] });
  expectThrows('bandeau hors de la zone de sécurité : refusé', () => placeLayout(noSafe, MARGINS, 6), GeometryRefused, 'aucune place pour le titre');
}

// C17 : chaque cas permis et chaque cas interdit, sur la géométrie.
{
  const z = (id: string, type: string, rect = { left: 0, top: 0, right: 10, bottom: 10 }): LayoutZone => ({ id, type: type as LayoutZone['type'], rect, bleedEdges: [], constraints: undefined });
  const fault = (below: string, above: string) => overlapFault(z('a', below), z('b', above));
  for (const [b, a] of [['texte', 'chapeau'], ['titre', 'texte'], ['fiche', 'legende'], ['chiffre-cle', 'etiquette'], ['folio', 'texte'], ['legende', 'bandeau'], ['encadre', 'encadre']]) {
    check(`C17 interdit : ${a} sur ${b} (deux éléments à texte)`, fault(b!, a!)?.includes('deux éléments à texte') === true);
  }
  check('C17 interdit : encadré sur un cadre de texte', fault('texte', 'encadre')?.includes('un encadré sur un cadre de texte') === true);
  for (const above of ['fond', 'illustration', 'picto', 'texte', 'folio', 'bandeau']) check(`C17 interdit : ${above} au-dessus du QR`, fault('qr', above)?.includes('rien au-dessus du QR') === true);
  for (const below of ['texte', 'encadre', 'picto', 'legende', 'titre']) check(`C17 interdit : ${below} sous le QR`, fault(below, 'qr')?.includes('sous le QR') === true);
  for (const below of ['titre', 'chapeau', 'texte', 'encadre', 'fiche', 'legende', 'etiquette', 'folio', 'chiffre-cle']) check(`C17 interdit : illustration sur ${below}`, fault(below, 'illustration')?.includes('une illustration sur un élément à texte') === true);
  for (const above of ['titre', 'chapeau', 'texte', 'encadre', 'etiquette']) check(`C17 permis : ${above} sur un fond`, fault('fond', above) === null);
  for (const above of ['titre', 'chapeau', 'encadre']) check(`C17 permis : ${above} sur un bandeau`, fault('bandeau', above) === null);
  for (const above of ['encadre', 'legende', 'etiquette', 'chiffre-cle', 'picto']) check(`C17 permis : ${above} sur une illustration`, fault('illustration', above) === null);
  for (const below of ['fond', 'bandeau', 'illustration']) check(`C17 permis : QR sur ${below}`, fault(below, 'qr') === null);
  check('C17 permis : folio sous le QR (décision de David, ED1)', fault('folio', 'qr') === null);
  check('C17 : bords qui se touchent, sans faute', overlapFaults([{ zones: [z('a', 'texte'), z('b', 'texte', { left: 10, top: 0, right: 20, bottom: 10 })] } as unknown as LayoutPage]).length === 0);
  check('C17 : recouvrement sous 0,05 mm toléré', overlapFaults([{ zones: [z('a', 'texte'), z('b', 'texte', { left: 9.96, top: 0, right: 20, bottom: 10 })] } as unknown as LayoutPage]).length === 0);
  check('C17 : recouvrement de 0,1 mm vu', overlapFaults([{ zones: [z('a', 'texte'), z('b', 'texte', { left: 9.9, top: 0, right: 20, bottom: 10 })] } as unknown as LayoutPage]).length === 1);
  const layout = layoutSchema.parse(synthese());
  check('C17 : mise en page de synthèse sans faute', c17Overlaps(placeLayout(layout, MARGINS, 6)).level === 'ok', c17Overlaps(placeLayout(layout, MARGINS, 6)));
  check('C17 : 2A converti sans faute (folio sous le QR)', c17Overlaps(placeMiseEnPage(fromV1(TEMPLATE_2A, SIX_NINE, MARGINS, 6), SIX_NINE, MARGINS, 6)).level === 'ok');
  const doubled = { ...synthese(), elements: [...synthese().elements, { id: 'tard', type: 'illustration', page: 0, x: 100, y: 125, w: 40, h: 30 }] };
  const doubledFaults = overlapFaults(placeLayout(layoutSchema.parse(doubled), MARGINS, 6));
  check('C17 : illustration posée sur le bandeau et le chapeau, nommée une fois', doubledFaults.some((f) => f.startsWith('tard (illustration) sur bandeau')) && doubledFaults.length === new Set(doubledFaults).size, doubledFaults);
  const overText = { ...synthese(), elements: synthese().elements.map((e) => (e.id === 'texte' ? { ...e, y: 160 } : e)) };
  check('C17 : texte sur le chapeau, erreur', c17Overlaps(placeLayout(layoutSchema.parse(overText), MARGINS, 6)).details.some((d) => d.includes('texte (texte) sur chapeau (chapeau)')));
}

// Rendu de la mise en page de synthèse, et PDF : chaque élément, sans transparence, image à cheval embarquée une fois.
{
  const dataRoot = newData();
  const read = readCollection(dataRoot)!;
  const layout = layoutSchema.parse(synthese());
  const pages = placeLayout(layout, read.style.margins, 6);
  const html = renderHtml(pages, SIX_NINE, read.style, templateContent(layout, read.style.fiche, 'foret', SIX_NINE), read.pictos);
  check('rendu : bandeau, titre dans son cadre', /class="zone bandeau"[^>]*data-zone="bandeau"/.test(html) && html.includes('class="bandeau-texte" data-cadre'));
  check('rendu : capsule, icône du style et en-tête de remplissage', /data-zone="capsule"[^>]*><div class="encadre-corps"><span class="icone"><svg/.test(html) && /data-zone="capsule"[\s\S]*?<\/svg>\s*<\/span><b class="entete">Texte de rempli/.test(html));
  check('rendu : question, en-tête écrit', /data-zone="question"[^>]*><div class="encadre-corps"><b class="entete">Texte de remplissage/.test(html));
  check('rendu : capsule et question centrées en hauteur', /data-zone="capsule"[^>]*style="[^"]*display:flex;flex-direction:column;justify-content:center"/.test(html) && /data-zone="question"[^>]*style="[^"]*justify-content:center"/.test(html));
  check('rendu : étiquette centrée en hauteur, flèche gardée', /data-zone="etiquette"[^>]*style="[^"]*display:flex;flex-direction:column;justify-content:center"><span data-fill>[^<]*<\/span><svg class="fleche"/.test(html));
  check('rendu : titre du bandeau centré en hauteur', /class="bandeau-texte" data-cadre style="[^"]*;align-items:center"/.test(html));
  {
    const withAlign = (a: string | undefined) => {
      const l = synthese() as Dict;
      for (const e of l.elements) if (e.id === 'bandeau' || e.id === 'capsule') (a === undefined ? delete e.alignement : (e.alignement = a));
      const parsed = layoutSchema.parse(l);
      return renderHtml(placeLayout(parsed, read.style.margins, 6), SIX_NINE, read.style, templateContent(parsed, read.style.fiche, 'foret', SIX_NINE), read.pictos);
    };
    const none = withAlign(undefined);
    check('rendu : sans alignement, encadré de GB1 et bandeau calé en bas', /data-zone="capsule"[^>]*style="[^"]*height:[0-9.]+mm"><span class="icone">/.test(none) && /class="bandeau-texte" data-cadre style="[^";]*;[^"]*height:[0-9.]+mm">/.test(none) && !/data-zone="capsule"[^>]*display:flex/.test(none));
    const haut = withAlign('haut');
    const bas = withAlign('bas');
    check('rendu : alignement haut et bas', /data-zone="capsule"[^>]*justify-content:flex-start/.test(haut) && /data-zone="capsule"[^>]*justify-content:flex-end/.test(bas) && /bandeau-texte" data-cadre style="[^"]*align-items:flex-start"/.test(haut));
  }
  check('rendu : étiquette fléchée, un trait et une pointe', /data-zone="etiquette".*?<svg class="fleche"[^>]*>(<line[^>]*\/>)<polygon/.test(html));
  check('rendu : image à cheval sur les deux pages, même source', (html.match(/data-zone="panorama"/g) ?? []).length === 2);
  check('rendu : règles des nouveaux éléments écrites', html.includes('.bandeau .bandeau-texte') && html.includes('.encadre .icone'));
  const twoA = buildEssai(SIX_NINE, read, 'foret', TEMPLATE_2A).html;
  check('rendu : 2A sans règle des nouveaux éléments', !twoA.includes('.bandeau') && !twoA.includes('.icone') && !twoA.includes('fleche'));
  const { pdf, measures } = await renderPdf(html, SIX_NINE);
  const facts = await readPdfFacts(pdf);
  const checks = Object.fromEntries(runChecks({ facts, measures, pages, pack: packFonts() }).map((c) => [c.id, c]));
  for (const id of ['C1', 'C3', 'C4', 'C6', 'C7', 'C8', 'C14']) check(`PDF de synthèse : ${id} vert`, checks[id]!.level === 'ok', checks[id]);
  check('PDF de synthèse : aucun débordement', measures.overflows.length === 0, measures.overflows);
  check('PDF de synthèse : aucune transparence relue', facts.transparency.length === 0);
  check('PDF de synthèse : image à cheval embarquée une seule fois', (await imageObjects(pdf)) === 1 && facts.images.length === 2, facts.images);
  check('PDF de synthèse : flèche mesurée comme un SVG de l’étiquette', measures.boxes.some((b) => b.zone === 'etiquette' && b.kind === 'svg') && measures.lines.some((l) => l.zone === 'etiquette' && l.widthPt >= 0.99));
  check('PDF de synthèse : titre du bandeau mesuré, le bandeau non', measures.boxes.some((b) => b.zone === 'bandeau' && b.kind === 'texte'));
  {
    // Centrage mesuré dans Chromium, sur une capsule haute de 70 mm : au milieu, le texte est à égale distance du haut et du bas ; en haut, non.
    const gaps = async (alignement: string) => {
      const l = synthese() as Dict;
      Object.assign(l.elements.find((e: Dict) => e.id === 'capsule'), { h: 70, alignement });
      const parsed = layoutSchema.parse(l);
      const placed = placeLayout(parsed, read.style.margins, 6);
      const m = await measureHtml(renderHtml(placed, SIX_NINE, read.style, templateContent(parsed, read.style.fiche, 'foret', SIX_NINE), read.pictos));
      const zoneBox = m.boxes.find((bx) => bx.zone === 'capsule' && bx.kind === 'zone')!.rect;
      // Le centrage est celui de la boîte des lignes (ED3 : `texte` est l'encre, asymétrique entre capitales et jambages).
      const texts = m.boxes.filter((bx) => bx.zone === 'capsule' && (bx.kind === 'lignes' || bx.kind === 'svg')).map((bx) => bx.rect);
      return { top: Math.min(...texts.map((r) => r.top)) - zoneBox.top, bottom: zoneBox.bottom - Math.max(...texts.map((r) => r.bottom)) };
    };
    const milieu = await gaps('milieu');
    const haut = await gaps('haut');
    check('mesure : capsule au milieu, même écart en haut et en bas (1 mm près)', Math.abs(milieu.top - milieu.bottom) < 1, milieu);
    check('mesure : capsule en haut, texte collé au haut', haut.top < 4 && haut.bottom > haut.top + 10, haut);
    // Étiquette de la synthèse (10 mm, une ligne) : même écart en haut et en bas.
    const label = measures.boxes.find((bx) => bx.zone === 'etiquette' && bx.kind === 'zone')!.rect;
    const line = measures.boxes.filter((bx) => bx.zone === 'etiquette' && bx.kind === 'lignes').map((bx) => bx.rect);
    const lt = Math.min(...line.map((r) => r.top)) - label.top;
    const lb = label.bottom - Math.max(...line.map((r) => r.bottom));
    check('mesure : étiquette au milieu, même écart en haut et en bas (1 mm près)', Math.abs(lt - lb) < 1, { lt, lb });
  }
  // C3 sur un élément : une étiquette dont la flèche sort de la zone de sécurité.
  const out = layoutSchema.parse({ ...synthese(), elements: synthese().elements.map((e) => (e.id === 'etiquette' ? { ...e, fleche: { x: 148, y: 25 } } : e)) });
  const outPages = placeLayout(out, read.style.margins, 6);
  const m2 = (await renderPdf(renderHtml(outPages, SIX_NINE, read.style, templateContent(out, read.style.fiche, 'foret', SIX_NINE), read.pictos), SIX_NINE)).measures;
  const c3 = runChecks({ facts, measures: m2, pages: outPages, pack: packFonts() }).find((c) => c.id === 'C3')!;
  check('C3 par élément : flèche hors de la zone de sécurité, erreur', c3.level === 'erreur' && c3.details.some((d) => d.includes('etiquette')), c3);
  // C3 par élément : le titre d'un bandeau posé hors de la zone de sécurité est vu ; le bandeau, lui, va au bord sans faute.
  const wide = structuredClone(pages);
  const band = wide[0]!.zones.find((zz) => zz.id === 'bandeau')!;
  band.textRect = { ...band.rect };
  const m3 = (await renderPdf(renderHtml(wide, SIX_NINE, read.style, templateContent(layout, read.style.fiche, 'foret', SIX_NINE), read.pictos), SIX_NINE)).measures;
  const c3b = runChecks({ facts, measures: m3, pages: wide, pack: packFonts() }).find((c) => c.id === 'C3')!;
  check('C3 par élément : titre du bandeau hors de la zone de sécurité, erreur', c3b.level === 'erreur' && c3b.details.some((d) => d.includes('bandeau')), c3b);
  check('C3 par élément : le bandeau lui-même va au bord sans faute', checks.C3!.level === 'ok');
  // C4 par élément : un bandeau sans fond perdu ne le prétend pas ; un élément ordinaire au pli reste refusé.
  const c4Pages = structuredClone(pages);
  const capsule = c4Pages[0]!.zones.find((z) => z.id === 'bandeau')!;
  capsule.bleedEdges = ['outer', 'top'];
  const c4 = runChecks({ facts, measures, pages: c4Pages, pack: packFonts() }).find((c) => c.id === 'C4')!;
  check('C4 par élément : fond perdu annoncé et absent, nommé', c4.level === 'erreur' && c4.details.some((d) => d.includes('bandeau') && d.includes('en haut')), c4);
  // Contrôle d'un modèle de la collection : C17 avec les autres.
  put(dataRoot, 'collection/gabarits/2Y.json', synthese());
  const control = Object.fromEntries((await controlTemplate(templatePreview(dataRoot, BOOK_ID, '2Y', 'foret'))).map((c) => [c.id, c]));
  check('contrôle du modèle 2Y : C3, C4, C6, C7, C8, C12, C17 verts', ['C3', 'C4', 'C6', 'C7', 'C8', 'C12', 'C17'].every((id) => control[id]?.level === 'ok'), control);
}

// Copie dans un sujet (MP-24) : layout.json à la création, avec son origine ; un modèle modifié ne touche plus le sujet ; refus.
{
  const glbRoot = makeGlbi();
  const dataRoot = newData();
  const read = readCollection(dataRoot)!;
  const now = new Date('2026-11-10T09:00:00.000Z');
  const two = createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret'], now);
  const file = path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'layout.json');
  const copy = readSubjectLayout(dataRoot, BOOK_ID, 'alpha')!;
  const sha2A = crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, 'collection', 'gabarits', '2A.json'))).digest('hex');
  check('création : layout.json écrit, version 2, au format du livre', copy !== null && copy.schemaVersion === 2 && copy.trim.widthIn === 6 && two.template === '2A');
  check('création : modele (identifiant, empreinte, date)', copy.modele.id === '2A' && copy.modele.empreinte === sha2A && copy.modele.date === now.toISOString());
  check('création : la copie de 2A est sa conversion', JSON.stringify({ ...copy, modele: undefined }) === JSON.stringify({ ...fromV1(TEMPLATE_2A, SIX_NINE, read.style.margins, 6), modele: undefined }));
  const scenes = [{ rank: 1, id: 'alpha', title: { fr: 'Alpha', en: 'Alpha', es: 'Alpha' }, modelCredits: [], qr: null }];
  const ctx = subjectContext(dataRoot, BOOK_ID, 'alpha', scenes);
  check('sujet : sa copie fait foi', ctx.source === 'layout.json' && ctx.modele?.id === '2A');
  const htmlBefore = subjectHtml(ctx);
  // Le modèle de la collection change : le sujet garde sa copie.
  const changed = structuredClone(TEMPLATE_2A) as Dict;
  changed.sheets[0].zones = changed.sheets[0].zones.filter((zz: Dict) => zz.id !== 'chapeau');
  put(dataRoot, 'collection/gabarits/2A.json', changed);
  check('modèle modifié : le sujet ne bouge pas', subjectHtml(subjectContext(dataRoot, BOOK_ID, 'alpha', scenes)) === htmlBefore && subjectContext(dataRoot, BOOK_ID, 'alpha', scenes).expected.some((b) => b.id === 'chapeau'));
  // Une version 2 est recopiée telle quelle.
  put(dataRoot, 'collection/gabarits/2Y.json', synthese());
  const beta = createSubject(dataRoot, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2Y', theme: 'foret' }, ['alpha', 'beta'], ['foret'], now);
  const betaCopy = readSubjectLayout(dataRoot, BOOK_ID, 'beta')!;
  check('création sur une version 2 : copie égale au modèle', beta.template === '2Y' && JSON.stringify({ ...betaCopy, modele: undefined }) === JSON.stringify({ ...layoutSchema.parse(synthese()), modele: undefined }));
  const betaCtx = subjectContext(dataRoot, BOOK_ID, 'beta', []);
  check('sujet en version 2 : blocs attendus des éléments', betaCtx.expected.map((b) => `${b.id}:${b.type}`).join() === 'chapeau:chapeau,texte:texte,capsule:encadre,etiquette:etiquette,legende:legende,question:encadre');
  check('sujet en version 2 : le bandeau porte le titre de la scène', /data-zone="bandeau".*?<span data-fill>beta fr</.test(subjectHtml(subjectContext(dataRoot, BOOK_ID, 'beta', [{ rank: 2, id: 'beta', title: { fr: 'beta fr', en: 'b', es: 'b' }, modelCredits: [], qr: null }]))));
  check('sujet en version 2 : limite du titre prise au bandeau', zoneLimit(betaCtx.template, 'titre') === 30);
  // Refus.
  put(dataRoot, 'collection/gabarits/2T.json', { ...synthese('2T'), trim: LETTER, elements: [] });
  expectThrows('création : autre format refusé', () => createSubject(dataRoot, BOOK_ID, { sceneId: 'gamma', pages: 2, template: '2T', theme: 'foret' }, ['alpha', 'beta', 'gamma'], ['foret']), SubjectRefused, 'faite pour 8,5 × 11"');
  check('création refusée : rien écrit', !fs.existsSync(path.join(dataRoot, BOOK_ID, 'subjects', 'gamma')));
  // layout.json invalide : étape Mise en page en erreur, le fichier n'est jamais réécrit.
  const facts = () => readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR);
  const sujetStep = (f: ParcoursFacts, sid: string, id: string) => computeParcours(f).subjects.find((s) => s.id === sid)!.steps.find((s) => s.id === id)!;
  let f = facts();
  check('parcours : Mise en page validée sur une copie juste', sujetStep(f, 'alpha', 'sujet-mise-en-page').state === 'validee' && f.subjects[0]!.miseEnPage.source === 'layout.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.replace('"schemaVersion": 2', '"schemaVersion": 2, "inconnu": 1'));
  f = facts();
  check('layout.json invalide : Mise en page en erreur, Recherche verrouillée', sujetStep(f, 'alpha', 'sujet-mise-en-page').state === 'erreur' && sujetStep(f, 'alpha', 'sujet-recherche').state === 'verrouillee' && sujetStep(f, 'alpha', 'sujet-mise-en-page').reasons[0]!.includes('layout.json invalide'));
  check('layout.json invalide : jamais réécrit', fs.readFileSync(file, 'utf8').includes('"inconnu": 1'));
  check('layout.json invalide : Sujets en erreur', STEPS.find((s) => s.id === 'sujets')!.evaluate(f).state === 'erreur');
  // Autre format dans la copie, côté de départ (C16), chevauchement (C17).
  const modele = JSON.parse(good).modele;
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, id: '2A', pages: 2, start: 'gauche', trim: LETTER, elements: [], modele }));
  f = facts();
  check('copie d’un autre format : erreur nommée', sujetStep(f, 'alpha', 'sujet-mise-en-page').reasons.join().includes('faite pour 8,5 × 11"'), sujetStep(f, 'alpha', 'sujet-mise-en-page'));
  fs.writeFileSync(file, good.replace('"start": "gauche"', '"start": "droite"'));
  f = facts();
  check('C16 au départ : copie qui commence à droite en page 6, erreur', sujetStep(f, 'alpha', 'sujet-mise-en-page').reasons.join().includes('C16') && sujetStep(f, 'alpha', 'sujet-mise-en-page').reasons.join().includes('page 6 est une page gauche'), sujetStep(f, 'alpha', 'sujet-mise-en-page'));
  const overlapped = JSON.parse(good);
  overlapped.elements.find((e: Dict) => e.id === 'chapeau').y = 60;
  fs.writeFileSync(file, JSON.stringify(overlapped));
  f = facts();
  check('C17 dans la copie : erreur nommée', sujetStep(f, 'alpha', 'sujet-mise-en-page').reasons.some((r) => r.startsWith('C17, ') && r.includes('chapeau')), sujetStep(f, 'alpha', 'sujet-mise-en-page'));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, id: '4A', pages: 4, start: 'gauche', trim: SIX_NINE, elements: [], modele }));
  f = facts();
  check('copie d’un autre nombre de pages : refusée', sujetStep(f, 'alpha', 'sujet-mise-en-page').reasons.join().includes('4 pages'), sujetStep(f, 'alpha', 'sujet-mise-en-page'));
  fs.writeFileSync(file, good);
  // Un sujet d'avant ED1 (comme le raptor) : sans copie, il garde son gabarit, et rien n'est écrit.
  fs.rmSync(file);
  put(dataRoot, 'collection/gabarits/2A.json', TEMPLATE_2A);
  const before = snapshot(dataRoot);
  f = facts();
  check('sujet d’avant ED1 : gabarit de la collection, Mise en page validée', f.subjects[0]!.miseEnPage.source === 'gabarit' && sujetStep(f, 'alpha', 'sujet-mise-en-page').state === 'validee');
  check('sujet d’avant ED1 : aucune copie écrite à la lecture', !fs.existsSync(file) && subjectContext(dataRoot, BOOK_ID, 'alpha', scenes).source === 'gabarit');
  check('lecture des faits : rien d’écrit dans les données', JSON.stringify(snapshot(dataRoot)) === JSON.stringify(before));
  // Orphelin : seul un sujet d'avant ED1 dépend de son modèle.
  fs.rmSync(path.join(dataRoot, 'collection', 'gabarits', '2Y.json'));
  f = facts();
  check('modèle retiré : un sujet avec sa copie n’est pas orphelin', !f.gabarits.orphans.some((o) => o.startsWith('beta')) && sujetStep(f, 'beta', 'sujet-mise-en-page').state === 'validee');
  // Recherche du sujet en version 2 : importée aux blocs de ses éléments.
  const research = makeResearch();
  research.subjectId = 'beta';
  (research as { schemaVersion: number }).schemaVersion = 2;
  research.blocks = betaCtx.expected.map((b) => ({ zone: b.zone, type: b.type as 'texte', ...(b.heading ? { heading: `Titre ${b.id}` } : {}), text: `Texte ${b.id}`, claims: ['c1'] })) as typeof research.blocks;
  const merged = mergeImport(research, null, betaCtx.subject, betaCtx.expected);
  updateSubject(dataRoot, BOOK_ID, 'beta', () => ({ subject: merged.subject, research: merged.research }));
  f = facts();
  check('recherche sur une version 2 : blocs égaux, Recherche validée', sujetStep(f, 'beta', 'sujet-recherche').state === 'validee', sujetStep(f, 'beta', 'sujet-recherche'));
}

// Étape du livre « Mises en page » : libellé, C17, autre format ni compté ni en erreur.
{
  const glbRoot = makeGlbi();
  const dataRoot = newData();
  const facts = () => readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR);
  const step = (f: ParcoursFacts) => STEPS.find((s) => s.id === 'gabarits')!.evaluate(f);
  check('registre : étape n° 4 « Mises en page », identifiant gardé', STEPS.filter((s) => s.scope === 'livre')[3]!.label === 'Mises en page' && STEPS.filter((s) => s.scope === 'livre')[3]!.id === 'gabarits');
  check('registre : Mise en page, première étape du sujet, Recherche l’exige', STEPS.filter((s) => s.scope === 'sujet')[0]!.id === 'sujet-mise-en-page' && STEPS.find((s) => s.id === 'sujet-recherche')!.requires.join() === 'sujet-mise-en-page');
  check('Mises en page : 2A seul, validée', step(facts()).state === 'validee' && facts().gabarits.valid === 1);
  put(dataRoot, 'collection/gabarits/2T.json', { ...synthese('2T'), trim: LETTER, elements: [] });
  check('autre format : ni compté ni en erreur', step(facts()).state === 'validee' && facts().gabarits.valid === 1);
  const overlapped = synthese('2S') as Dict;
  overlapped.elements.find((e: Dict) => e.id === 'texte').y = 160;
  put(dataRoot, 'collection/gabarits/2S.json', overlapped);
  const f = facts();
  check('C17 sur un modèle : Mises en page en erreur, modèle nommé', step(f).state === 'erreur' && step(f).reasons.some((r) => r.startsWith('2S : C17,')), step(f));
  fs.rmSync(path.join(dataRoot, 'collection', 'gabarits', '2A.json'));
  fs.rmSync(path.join(dataRoot, 'collection', 'gabarits', '2S.json'));
  check('seul un modèle d’un autre format : à faire', step(facts()).state === 'a-faire');
  const codeFacts = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'checks', 'overlaps.ts'), 'utf8');
  check('code : C17 pur, sans Chromium ni fichier', !/playwright|node:fs|readFile/.test(codeFacts));
}

// Routes : état et contrôle de la mise en page d'un sujet, aperçu, liste des modèles avec leur format ; refus.
{
  const glbRoot = makeGlbi();
  const parent = tempDir();
  const dataRoot = path.join(parent, 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  createCollection(dataRoot);
  put(dataRoot, 'collection/gabarits/2Y.json', synthese());
  put(dataRoot, 'collection/gabarits/2T.json', { ...synthese('2T'), trim: LETTER, elements: [] });
  createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2Y', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  createSubject(dataRoot, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2A', theme: 'ocean' }, ['alpha', 'beta'], ['foret', 'ocean']);
  fs.rmSync(path.join(dataRoot, BOOK_ID, 'subjects', 'beta', 'layout.json'));
  put(parent, 'config.local.json', { glbRoot, dataRoot });
  const server = createPrintServer(path.join(parent, 'config.local.json'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  const headers = { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
  const request = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }) =>
    new Promise<{ status: number; body: string; csp: string | undefined }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path, headers: opts.headers ?? headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), csp: res.headers['content-security-policy'] as string | undefined }));
      });
      req.on('error', reject);
      if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      req.end();
    });
  const post = (route: string, body: unknown, h: Record<string, string> = headers) => request({ path: route, headers: h, body });
  const before = snapshot(dataRoot);
  const state = JSON.parse((await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'alpha' })).body);
  check('route : état d’un sujet en version 2, copie et éléments', state.source === 'layout.json' && state.modele.id === '2Y' && state.version === 2 && state.elements.length === 11 && state.layout.length === 2 && state.errors.length === 0, state);
  const old = JSON.parse((await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'beta' })).body);
  check('route : sujet d’avant ED1, gabarit de la collection, coordonnées de la conversion', old.source === 'gabarit' && old.version === 1 && old.file === 'collection/gabarits/2A.json' && old.elements[0].x === 0 && old.elements[0].w === 152.4, old);
  const page = await request({ method: 'GET', path: `/apercu-mise-en-page?dir=${BOOK_DIR}&subject=alpha` });
  check('route : aperçu, HTML du PDF, CSP des aperçus', page.status === 200 && page.body.includes('data-zone="bandeau"') && page.body.includes('Texte de remplissage') && page.csp?.includes('default-src \'none\'') === true);
  const control = await post('/api/mise-en-page/controle', { dir: BOOK_DIR, subjectId: 'alpha' });
  const checks = JSON.parse(control.body).checks;
  check('route : contrôle, C17 compris, tout vert', control.status === 200 && checks.map((c: Dict) => c.id).join() === 'C3,C4,C6,C7,C8,C12,C17' && checks.every((c: Dict) => c.level === 'ok'), checks.filter((c: Dict) => c.level !== 'ok'));
  check('route : sujet inconnu, 409', (await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'zeta' })).status === 409);
  check('route : corps invalide, 400', (await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: '../alpha' })).status === 400);
  check('route : sans en-tête, 403', (await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'alpha' }, { ...headers, 'x-book-print': '0' })).status === 403);
  check('route : GET d’une action, 405', (await request({ method: 'GET', path: '/api/mise-en-page/state' })).status === 405);
  check('route : POST de l’aperçu, 405', (await request({ method: 'POST', path: `/apercu-mise-en-page?dir=${BOOK_DIR}&subject=alpha` })).status === 405);
  const list = JSON.parse((await post('/api/gabarits/state', { bookId: BOOK_ID })).body);
  const t = (id: string) => list.templates.find((x: Dict) => x.id === id);
  check('route : liste des modèles, version et format', t('2A').version === 1 && t('2A').format === null && t('2A').otherFormat === false && t('2Y').version === 2 && t('2Y').format === '6 × 9"' && t('2T').otherFormat === true && t('2T').error === null, list.templates);
  const sujets = JSON.parse((await post('/api/sujets/state', { dir: BOOK_DIR })).body);
  check('route : création, seules les mises en page du livre proposées', sujets.templates.some((x: Dict) => x.id === '2Y') && !sujets.templates.some((x: Dict) => x.id === '2T'));
  check('route : aperçu d’un modèle d’un autre format, 409', (await post('/api/gabarits/apercu', { bookId: BOOK_ID, id: '2T' })).status === 409);
  // Côté de départ faux : l'état le dit, l'aperçu et le contrôle refusent.
  const file = path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'layout.json');
  const good = fs.readFileSync(file, 'utf8');
  check('lecture par les routes : rien d’écrit', JSON.stringify(snapshot(dataRoot)) === JSON.stringify(before));
  const wrong = JSON.parse(good);
  wrong.start = 'droite';
  wrong.elements = wrong.elements.filter((e: Dict) => !e.double && e.id !== 'legende');
  fs.writeFileSync(file, JSON.stringify(wrong));
  const bad = JSON.parse((await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'alpha' })).body);
  check('route : C16 dans l’état, sans aperçu', bad.errors.some((e: string) => e.startsWith('C16')) && bad.layout === null, bad);
  check('route : contrôle refusé sur un côté faux, 409', (await post('/api/mise-en-page/controle', { dir: BOOK_DIR, subjectId: 'alpha' })).status === 409);
  fs.writeFileSync(file, good);
  server.close();
  server.closeAllConnections();
}

// Le reste du livre lit la même mise en page : prompt et import par les blocs des éléments, essai sur un 2A en version 2.
{
  const dataRoot = newData();
  const read = readCollection(dataRoot)!;
  put(dataRoot, 'collection/gabarits/2A.json', fromV1(TEMPLATE_2A, SIX_NINE, read.style.margins, 6));
  const found = templateOf(readTemplates(dataRoot, read.style), '2A');
  check('essai : 2A en version 2 dans la collection, même HTML', 'template' in found && 'schemaVersion' in found.template && buildEssai(SIX_NINE, read, 'foret', found.template).html === buildEssai(SIX_NINE, read, 'foret', TEMPLATE_2A).html);
  check('éléments : vue commune aux deux versions', elementsOf(TEMPLATE_2A).map((e) => `${e.id}:${e.page}`).join() === elementsOf(fromV1(TEMPLATE_2A, SIX_NINE, read.style.margins, 6)).map((e) => `${e.id}:${e.page}`).join());
  check('copie : modèle version 2 recopié, origine notée', copyModel(layoutSchema.parse(synthese()), 'a'.repeat(64), SIX_NINE, MARGINS, 6, new Date(0)).modele.empreinte === 'a'.repeat(64));
}

finish('mises en page');
