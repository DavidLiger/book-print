// scripts/test-checks.ts — contrôles C1, C3, C4, C6, C7, C8, C10, C12, C13, C14, C15 : pour chacun un cas vert et un cas rouge, sur des faits construits
// à la main. La chaîne réelle (Chromium, puis relecture par pdf-lib) est dans test-render.ts.
import { c10Sources, c12Texts, c13Filler, charCount, runSubjectChecks, urlIsDead, type C10Claim, type TextInput } from '../src/checks/content';
import { expectedBlocks } from '../src/research/blocks';
import type { Block } from '../src/schema/block';
import { c14Clean, c15FileSize, c1PageSize, c3Safety, c4Bleed, c6Transparency, c7Fonts, c8Sizes, KDP_MAX_BYTES, runChecks, type CheckResult } from '../src/checks/rules';
import type { PdfFacts } from '../src/checks/pdf-facts';
import type { MeasuredBox, Measures } from '../src/render/measure';
import { TEMPLATE_2A } from './fixtures/gabarits';
import { BLEED_MM, layoutTemplate, type LayoutPage, type Rect } from '../src/templates/geometry';
import { c5Resolution, c11Rights, entryFaults } from '../src/checks/images';
import type { RightsEntry } from '../src/schema/rights';
import { check, finish } from './test-lib';

const margins = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 15 };
const layout = (widthIn = 6, heightIn = 9) => layoutTemplate(TEMPLATE_2A, { widthIn, heightIn }, margins, 6);
const pages = layout();
const [left, right] = pages as [LayoutPage, LayoutPage];
const pack = [{ family: 'Andika', pdfName: 'andika' }, { family: 'Baloo 2', pdfName: 'baloo2' }];

const facts = (over: Partial<PdfFacts> = {}): PdfFacts => ({
  sizeBytes: 1000,
  pages: [{ number: 1, widthPt: 440.88, heightPt: 666 }, { number: 2, widthPt: 440.88, heightPt: 666 }],
  fonts: [
    { name: 'BAAAAA+Andika', subtype: 'Type0', embedded: true, how: 'FontFile2', page: 1 },
    { name: 'AAAAAA+Baloo2-Regular', subtype: 'Type3', embedded: true, how: 'Type 3, glyphes dans le PDF', page: 1 },
  ],
  transparency: [],
  images: [],
  outlines: false,
  annotations: [],
  xmp: false,
  optionalContent: false,
  info: ['Title', 'Creator', 'Producer', 'CreationDate', 'ModDate'],
  ...over,
});

const inPlace = (page: LayoutPage): MeasuredBox[] => page.zones.map((z) => ({ page: page.number, zone: z.id, type: z.type, kind: 'zone', rect: { ...z.rect } }));
const measures = (over: Partial<Measures> = {}): Measures => ({
  fontsLoaded: true,
  pages: [],
  boxes: pages.flatMap(inPlace),
  texts: [{ page: 6, zone: 'texte', type: 'texte', sizePt: 13, family: 'Andika' }, { page: 6, zone: 'titre', type: 'titre', sizePt: 30, family: '"Baloo 2"' }],
  lines: [{ page: 6, zone: 'fiche', widthPt: 1 }],
  faults: [],
  overflows: [],
  ...over,
});

const green = (name: string, r: CheckResult) => check(`vert : ${name}`, r.level === 'ok' && r.details.length === 0, r);
const red = (name: string, r: CheckResult, text?: string) => check(`rouge : ${name}`, r.level === 'erreur' && (!text || r.details.some((d) => d.includes(text))), r);
const amber = (name: string, r: CheckResult, text: string) => check(`alerte : ${name}`, r.level === 'alerte' && r.details.some((d) => d.includes(text)), r);

// C1
green('C1, 440,88 pt accepté pour 441', c1PageSize(facts(), pages));
green('C1, 441 pt exact', c1PageSize(facts({ pages: [{ number: 1, widthPt: 441, heightPt: 666 }, { number: 2, widthPt: 441, heightPt: 666 }] }), pages));
green('C1, 621,12 pt accepté pour 621 en 8,5 × 11"', c1PageSize(facts({ pages: [{ number: 1, widthPt: 621.12, heightPt: 810 }, { number: 2, widthPt: 621.12, heightPt: 810 }] }), layout(8.5, 11)));
red('C1, 441,2 pt, hors tolérance', c1PageSize(facts({ pages: [{ number: 1, widthPt: 441.2, heightPt: 666 }, { number: 2, widthPt: 441, heightPt: 666 }] }), pages), 'page 6');
red('C1, sans fond perdu : 432 pt', c1PageSize(facts({ pages: [{ number: 1, widthPt: 432, heightPt: 648 }, { number: 2, widthPt: 432, heightPt: 648 }] }), pages));
red('C1, format d’un autre livre', c1PageSize(facts(), layout(8.5, 11)));
red('C1, page de trop', c1PageSize(facts({ pages: [...facts().pages, { number: 3, widthPt: 441, heightPt: 666 }] }), pages), '3 pages');

// C3
const moved = (zone: string, change: (r: Rect) => void): Measures => {
  const m = measures();
  for (const b of m.boxes) if (b.zone === zone) change(b.rect);
  return m;
};
green('C3, zones en place', c3Safety(measures(), pages));
red('C3, texte à 5 mm du bord rogné extérieur', c3Safety(moved('texte', (r) => (r.left = left.trim.left + 5)), pages), 'zone de sécurité');
red('C3, texte hors du haut', c3Safety(moved('titre', (r) => (r.top = left.safe.top - 1)), pages), 'zone de sécurité');
red('C3, débord en bas', c3Safety(moved('folio-g', (r) => (r.bottom = left.safe.bottom + 1)), pages), 'zone de sécurité');
red('C3, page gauche, trop près du pli', c3Safety(moved('fiche', (r) => (r.right = left.foldMm - 10)), pages));
red('C3, page droite, QR trop près du bord', c3Safety(moved('qr', (r) => (r.right = right.trim.right - 5)), pages), 'zone de sécurité');
red('C3, page droite, numéro trop près du pli', c3Safety(moved('folio-d', (r) => (r.left = right.foldMm + 10)), pages));
{
  // Marges de 12 mm au petit fond interdites par le style : le pli reste contrôlé même si la zone de sécurité l'autorisait.
  const wide = layoutTemplate(TEMPLATE_2A, { widthIn: 6, heightIn: 9 }, margins, 6);
  wide[0]!.safe.right = wide[0]!.foldMm - 5;
  red('C3, bande du pli contrôlée à part de la zone de sécurité', c3Safety(moved('fiche', (r) => (r.right = wide[0]!.foldMm - 10)), wide), 'du pli');
}
green('C3, illustration au bord : hors du contrôle', c3Safety(moved('illustration', (r) => (r.left = 0)), pages));

// C4
green('C4, bandeau de page gauche et illustration de page droite', c4Bleed(measures(), pages));
check('C4, page gauche : fond perdu à gauche, rien à droite', left.zones[0]!.rect.left === 0 && Math.abs(left.zones[0]!.rect.right - left.foldMm) < 1e-9);
check('C4, page droite : rien à gauche, fond perdu à droite', right.zones[0]!.rect.left === 0 && right.foldMm === 0 && Math.abs(right.zones[0]!.rect.right - right.widthMm) < 1e-9);
red('C4, page droite, s’arrête au bord rogné extérieur', c4Bleed(moved('illustration', (r) => (r.right = right.trim.right)), pages), 'extérieur');
red('C4, page droite, manque en haut', c4Bleed(moved('illustration', (r) => (r.top = right.trim.top - 1)), pages), 'en haut');
red('C4, page droite, manque en bas', c4Bleed(moved('illustration', (r) => (r.bottom = right.trim.bottom)), pages), 'en bas');
red('C4, page gauche, manque à l’extérieur', c4Bleed(moved('bandeau', (r) => (r.left = left.trim.left)), pages), 'extérieur');
red('C4, page gauche, déborde côté pli', c4Bleed(moved('bandeau', (r) => (r.right = left.foldMm + BLEED_MM)), pages), 'côté pli');
red('C4, page droite, déborde côté pli', c4Bleed(moved('illustration', (r) => (r.left = -BLEED_MM)), pages), 'côté pli');
red('C4, zone absente du rendu', c4Bleed(measures({ boxes: inPlace(left) }), pages), 'absente');

// C6
green('C6, ni faute de rendu ni transparence', c6Transparency(facts(), measures()));
green('C6, un objet invisible relève de C14', c6Transparency(facts(), measures({ faults: [{ page: 6, zone: 'texte', kind: 'invisible', value: 'hidden' }] })));
for (const kind of ['/ca 0.5', '/CA 0.5', '/SMask sur une image', '/SMask dans un ExtGState', '/Mask sur une image', '/BM /Multiply', 'groupe /S /Transparency (Form XObject)', 'groupe /S /Transparency (page)']) {
  red(`C6, PDF : ${kind}`, c6Transparency(facts({ transparency: [{ kind, page: 2 }] }), measures()), kind);
}
for (const kind of ['opacity', 'couleur à alpha', 'filter', 'mix-blend-mode', 'box-shadow']) {
  red(`C6, rendu : ${kind}`, c6Transparency(facts(), measures({ faults: [{ page: 7, zone: 'qr', kind, value: 'x' }] })), kind);
}

// C7
green('C7, FontFile2 et Type 3 du pack', c7Fonts(facts(), measures(), pack));
const fontFact = { subtype: 'TrueType', embedded: true, how: 'FontFile2', page: 1 };
red('C7, police hors du pack, même embarquée', c7Fonts(facts({ fonts: [{ ...fontFact, name: 'ABCDEF+TimesNewRoman' }] }), measures(), pack), 'hors du pack');
red('C7, police du pack non embarquée', c7Fonts(facts({ fonts: [{ ...fontFact, name: 'Andika', embedded: false, how: 'sans fichier de police' }] }), measures(), pack), 'non embarquée');
red('C7, Type 3 hors du pack', c7Fonts(facts({ fonts: [{ name: 'AAAAAA+Comic', subtype: 'Type3', embedded: true, how: 'Type 3', page: 1 }] }), measures(), pack), 'hors du pack');
red('C7, rendu demandé hors du pack', c7Fonts(facts(), measures({ texts: [{ page: 6, zone: 'texte', type: 'texte', sizePt: 13, family: 'serif' }] }), pack), 'police serif');
red('C7, police du pack non chargée', c7Fonts(facts(), measures({ fontsLoaded: false }), pack), 'chargée');

// C8
const text = (type: string, sizePt: number) => [{ page: 6, zone: 'z', type, sizePt, family: 'Andika' }];
green('C8, 13 pt et filet de 1 pt', c8Sizes(measures()));
green('C8, 12,9999 pt : arrondi du navigateur', c8Sizes(measures({ texts: text('texte', 12.99999) })));
green('C8, légende à 9 pt : pas du texte courant', c8Sizes(measures({ texts: text('legende', 9) })));
green('C8, filet de 0,75 pt', c8Sizes(measures({ lines: [{ page: 6, zone: 'z', widthPt: 0.75 }] })));
red('C8, corps de 6 pt', c8Sizes(measures({ texts: text('legende', 6) })), '6,00 pt');
red('C8, filet de 0,5 pt', c8Sizes(measures({ lines: [{ page: 6, zone: 'z', widthPt: 0.5 }] })), 'filet');
amber('C8, texte courant à 12 pt', c8Sizes(measures({ texts: text('texte', 12) })), 'texte courant');

// C14
green('C14, dictionnaire d’information de Chromium toléré', c14Clean(facts(), measures()));
red('C14, signets', c14Clean(facts({ outlines: true }), measures()), 'signets');
red('C14, annotations', c14Clean(facts({ annotations: [2] }), measures()), 'annotations');
red('C14, XMP', c14Clean(facts({ xmp: true }), measures()), 'XMP');
red('C14, calques', c14Clean(facts({ optionalContent: true }), measures()), 'calques');
red('C14, objet invisible dans le rendu', c14Clean(facts(), measures({ faults: [{ page: 6, zone: 'texte', kind: 'invisible', value: 'hidden' }] })), 'invisible');

// C15
green('C15, petit fichier', c15FileSize(facts()));
green('C15, 650 Mo tout juste', c15FileSize(facts({ sizeBytes: KDP_MAX_BYTES })));
red('C15, au-delà de 650 Mo', c15FileSize(facts({ sizeBytes: KDP_MAX_BYTES + 1 })));

// Ensemble
{
  const all = runChecks({ facts: facts(), measures: measures(), pages, pack });
  check('huit contrôles livrés, dans l’ordre', all.map((c) => c.id).join() === 'C1,C3,C4,C6,C7,C8,C14,C15', all);
  check('tout vert sur un cas propre', all.every((c) => c.level === 'ok'), all);
}

// C10, C12, C13
const fiche = [{ id: 'taille', picto: 'taille', label: { fr: 'Taille', en: 'Size', es: 'Tamaño' } }];
const expected = expectedBlocks(TEMPLATE_2A, fiche, 'fr');
const block = (id: string, text: string, over: Partial<Block> = {}): Block => ({ id, zone: id, type: 'texte', text: { fr: text }, claims: ['c1'], state: 'valide', ...over });
const blocks = (): Block[] => [block('chapeau', 'Un chapeau.', { type: 'chapeau' }), block('texte', 'Un texte réel.'), block('fiche-taille', '2 m', { zone: 'fiche', type: 'fiche', item: 'taille' })];
const claim = (over: Partial<C10Claim> = {}): C10Claim => ({ id: 'c1', status: 'valide', sources: [{ url: 'https://s.example/' }], ...over });
const dead = (code: number | null, error: string | null = null) => ({ date: '2026-11-06T12:00:00.000Z', code, error });
const alerting = (name: string, r: CheckResult, text: string) => check(`alerte : ${name}`, r.level === 'alerte' && r.details.some((d) => d.includes(text)), r);

green('C10, affirmation validée', c10Sources(blocks(), [claim()]));
green('C10, corrigée compte comme validée', c10Sources(blocks(), [claim({ status: 'corrige' })]));
green('C10, affirmation rejetée que rien ne cite', c10Sources(blocks(), [claim(), claim({ id: 'c2', status: 'rejete' })]));
green('C10, URL en ordre', c10Sources(blocks(), [claim({ sources: [{ url: 'https://s.example/', urlCheck: dead(200) }] })]));
red('C10, affirmation proposée citée', c10Sources(blocks(), [claim({ status: 'propose' })]), 'non validée');
red('C10, affirmation rejetée citée', c10Sources(blocks(), [claim({ status: 'rejete' })]), 'non validée');
red('C10, affirmation inconnue', c10Sources(blocks(), []), 'inconnue');
red('C10, affirmation validée sans source', c10Sources(blocks(), [claim({ sources: [] })]), 'aucune source');
alerting('C10, URL sans réponse', c10Sources(blocks(), [claim({ sources: [{ url: 'https://s.example/', urlCheck: dead(null, 'aucune réponse') }] })]), 'ne répond plus');
alerting('C10, URL en 404', c10Sources(blocks(), [claim({ sources: [{ url: 'https://s.example/', urlCheck: dead(404) }] })]), '404');
check('C10 : une erreur passe avant une alerte', c10Sources(blocks(), [claim({ status: 'propose' }), claim({ id: 'c2', sources: [{ url: 'https://s.example/', urlCheck: dead(500) }] })]).level === 'erreur');
check('URL : aucun contrôle, rien à reprocher', !urlIsDead(undefined));
check('URL : 2xx en ordre', !urlIsDead(dead(200)) && !urlIsDead(dead(204)));
check('URL : robots bloqués, sans alerte', [401, 403, 429].every((c) => !urlIsDead(dead(c))));
check('URL : 3xx restant, 404, 410, 500, sans réponse', [304, 404, 410, 500].every((c) => urlIsDead(dead(c))) && urlIsDead(dead(null, 'x')));

const texts = (over: Partial<TextInput> = {}): TextInput => ({ blocks: blocks(), expected, lang: 'fr', title: 'Titre', titleMax: 40, legend: 'Légende', legendMax: 44, ...over });
const noOverflow = { overflows: [] };
green('C12, tout tient', c12Texts(texts(), noOverflow));
red('C12, texte absent dans la langue', c12Texts(texts({ lang: 'en' }), noOverflow), 'aucun texte en en');
red('C12, texte vide', c12Texts(texts({ blocks: [block('texte', '   ')] }), noOverflow), 'aucun texte');
red('C12, limite du bloc', c12Texts(texts({ blocks: [block('chapeau', 'x'.repeat(141), { type: 'chapeau' })] }), noOverflow), '141 caractères, 140 au plus');
red('C12, limite d’une information de fiche', c12Texts(texts({ blocks: [block('fiche-taille', 'x'.repeat(29), { zone: 'fiche', type: 'fiche', item: 'taille' })] }), noOverflow), '29 caractères, 28 au plus');
red('C12, titre trop long', c12Texts(texts({ title: 'x'.repeat(41) }), noOverflow), 'titre');
red('C12, légende trop longue', c12Texts(texts({ legend: 'x'.repeat(45) }), noOverflow), 'légende du QR');
red('C12, débordement mesuré', c12Texts(texts(), { overflows: [{ page: 6, zone: 'texte', item: null, overMm: 4.25 }] }), 'page 6, texte : déborde de 4,3 mm');
red('C12, débordement d’une case de fiche', c12Texts(texts(), { overflows: [{ page: 6, zone: 'fiche', item: 'lieu', overMm: 1 }] }), 'fiche, lieu');
green('C12, limite exacte', c12Texts(texts({ blocks: [block('chapeau', 'x'.repeat(140), { type: 'chapeau' })] }), noOverflow));
check('caractères : lettres accentuées et emoji comptés une fois', charCount('é') === 1 && charCount('🦖') === 1);

const filler = (over: Partial<Parameters<typeof c13Filler>[0]> = {}) => c13Filler({ blocks: blocks(), expected, lang: 'fr', title: 'Titre', legend: 'Légende', essaiPhrases: ['Ceci est une phrase d\'essai bien reconnaissable.'], essaiValues: ['3 cartons'], ...over });
green('C13, vrai texte', filler());
for (const t of ['Lorem ipsum dolor', 'Texte factice ici', 'Texte d’essai', 'À compléter plus tard', 'TODO', 'XXXX', 'Essaisaurus']) red(`C13, remplissage : ${t}`, filler({ blocks: [block('chapeau', t, { type: 'chapeau' }), ...blocks().slice(1)] }), 'remplissage');
red('C13, phrase du sujet d’essai', filler({ blocks: [block('chapeau', 'Voici : ceci est une  phrase d’essai bien reconnaissable.', { type: 'chapeau' }), ...blocks().slice(1)] }), 'sujet d\'essai');
red('C13, valeur de fiche d’essai', filler({ blocks: [...blocks().slice(0, 2), block('fiche-taille', '3 cartons', { zone: 'fiche', type: 'fiche', item: 'taille' })] }), 'sujet d\'essai');
green('C13, une valeur courte n’est pas cherchée dans une phrase', filler({ blocks: [block('chapeau', 'Il pèse 3 cartons de lait.', { type: 'chapeau' }), ...blocks().slice(1)] }));
red('C13, zone sans bloc', filler({ blocks: blocks().slice(1) }), 'zone chapeau vide');
red('C13, information de fiche vide', filler({ blocks: blocks().slice(0, 2) }), 'zone fiche, taille vide');
red('C13, titre vide', filler({ title: ' ' }), 'titre vide');
red('C13, légende vide', filler({ legend: '' }), 'légende du QR vide');
red('C13, titre de remplissage', filler({ title: 'Lorem ipsum' }), 'titre');
{
  const all = runSubjectChecks({ ...texts(), claims: [claim()], measures: noOverflow, essaiPhrases: [], essaiValues: [] });
  check('contrôles du sujet : C10, C12, C13, tous verts', all.map((c) => `${c.id}:${c.level}`).join() === 'C10:ok,C12:ok,C13:ok', all);
}

// C5 : le fichier source et le cadrage (spec §16.6)
{
  const size = { widthMm: 155.575, heightMm: 234.95 };
  const framing = { focusX: 0.5, focusY: 0.5, zoom: 1 };
  const placed = (width: number, height: number, zoom = 1) => ({ zone: 'illustration', image: { width, height }, size, framing: { ...framing, zoom } });
  const c5 = (...items: ReturnType<typeof placed>[]) => c5Resolution(items);
  check('C5 : taille cible, vert', c5(placed(1838, 2775)).level === 'ok', c5(placed(1838, 2775)));
  check('C5 : aucune image, vert', c5().level === 'ok');
  check('C5 : 300 ppp pile, vert', c5(placed(1838, 2775)).details.length === 0);
  check('C5 : sous 300 ppp, rouge, valeur donnée', c5(placed(919, 1388)).level === 'erreur' && c5(placed(919, 1388)).details[0]!.includes('150 ppp'), c5(placed(919, 1388)));
  check('C5 : un pixel de moins, rouge', c5(placed(1837, 2774)).level === 'erreur');
  check('C5 : le zoom réduit la résolution', c5(placed(1838, 2775, 1.01)).level === 'erreur' && c5(placed(1838, 2775, 1.01)).details[0]!.includes('297 ppp'), c5(placed(1838, 2775, 1.01)));
  check('C5 : plus grand que la cible, le zoom reste vert', c5(placed(3676, 5550, 1.5)).level === 'ok', c5(placed(3676, 5550, 1.5)));
  check('C5 : 600 ppp, vert', c5(placed(3676, 5550)).level === 'ok');
  check('C5 : au-dessus de 600 ppp, alerte', c5(placed(4000, 6000)).level === 'alerte' && c5(placed(4000, 6000)).details[0]!.includes('fichier lourd'), c5(placed(4000, 6000)));
  check('C5 : le zoom ramène une image lourde sous 600 ppp', c5(placed(4000, 6000, 1.2)).level === 'ok');
  check('C5 : une erreur passe avant une alerte', c5(placed(4000, 6000), { ...placed(919, 1388), zone: 'autre' }).level === 'erreur');
  check('C5 : chaque zone nommée', c5({ ...placed(919, 1388), zone: 'grande' }).details[0]!.startsWith('grande'));
}

// C11 : un cas vert et un cas rouge par règle
{
  const entry = (id: string, kind: RightsEntry['kind'], over: Partial<RightsEntry> = {}): RightsEntry => ({ id, kind, name: id, author: 'Auteur', license: 'CC BY 4.0', credit: `Crédit ${id}`, commercialOk: 'oui', ...over });
  const registry = (...entries: RightsEntry[]) => new Map([entry('ia', 'modele-ia'), entry('m3d', 'modele-3d'), ...entries].map((e) => [e.id, e]));
  const c11 = (rights: string[] | null, map = registry()) => c11Rights([{ zone: 'illustration', rights }], map);
  check('C11 : modèle d’IA et modèle 3D, vert', c11(['ia', 'm3d']).level === 'ok', c11(['ia', 'm3d']));
  check('C11 : aucune illustration, vert', c11Rights([], registry()).level === 'ok');
  check('C11 : le report à MP6 est dit dans le contrôle', c11(['ia', 'm3d']).label.includes('MP6'));
  check('C11 : image absente du registre, rouge', c11(null).level === 'erreur' && c11(null).details[0]!.includes('absente du registre'));
  check('C11 : aucun droit rattaché, rouge', c11([]).level === 'erreur');
  check('C11 : droit inconnu, rouge', c11(['ia', 'm3d', 'fantome']).level === 'erreur' && c11(['ia', 'm3d', 'fantome']).details.join().includes('fantome'));
  check('C11 : sans modèle d’IA, rouge', c11(['m3d']).level === 'erreur' && c11(['m3d']).details.join().includes('modèle d\'IA'));
  check('C11 : sans modèle 3D, alerte seulement', c11(['ia']).level === 'alerte' && c11(['ia']).details.join().includes('modèle 3D'), c11(['ia']));
  const with3d = (over: Partial<RightsEntry>) => c11(['ia', 'x'], registry(entry('x', 'modele-3d', over)));
  check('C11 : entrée sans licence, rouge', with3d({ license: '' }).level === 'erreur' && with3d({ license: '' }).details[0] === 'x : licence manquante', with3d({ license: '' }));
  check('C11 : entrée avec licence, vert', with3d({ license: 'CC BY 4.0' }).level === 'ok');
  check('C11 : crédit vide, rouge', with3d({ credit: '' }).level === 'erreur' && with3d({ credit: '' }).details[0] === 'x : crédit vide');
  check('C11 : crédit présent, vert', with3d({ credit: 'Texte' }).level === 'ok');
  check('C11 : commercialOk non, rouge', with3d({ commercialOk: 'non' }).level === 'erreur' && with3d({ commercialOk: 'non' }).details[0] === 'x : usage commercial refusé');
  check('C11 : commercialOk oui, vert', with3d({ commercialOk: 'oui' }).level === 'ok');
  check('C11 : à vérifier, alerte', with3d({ commercialOk: 'a-verifier' }).level === 'alerte');
  check('C11 : une erreur passe avant une alerte', c11Rights([{ zone: 'a', rights: ['ia'] }, { zone: 'b', rights: null }], registry()).level === 'erreur');
  const map = registry(entry('x', 'modele-3d', { credit: '' }));
  check('C11 : une entrée fautive n’est citée qu’une fois', c11Rights([{ zone: 'a', rights: ['ia', 'x'] }, { zone: 'b', rights: ['ia', 'x'] }], map).details.length === 1, c11Rights([{ zone: 'a', rights: ['ia', 'x'] }, { zone: 'b', rights: ['ia', 'x'] }], map));
  check('C11 : image non générée, aucun modèle d’IA exigé', c11Rights([{ zone: 'a', rights: ['x'], aiGenerated: false }], registry(entry('x', 'image-externe'))).level !== 'erreur', c11Rights([{ zone: 'a', rights: ['x'], aiGenerated: false }], registry(entry('x', 'image-externe'))));
  check('C11 : image générée, modèle d’IA exigé', c11Rights([{ zone: 'a', rights: ['x'], aiGenerated: true }], registry(entry('x', 'image-externe'))).details.some((d) => d.includes('modèle d\'IA')));
  check('C11 : aiGenerated absent, cas strict', c11Rights([{ zone: 'a', rights: ['x'] }], registry(entry('x', 'image-externe'))).level === 'erreur');
  check('C11 : image non générée sans aucun droit, rouge', c11Rights([{ zone: 'a', rights: [], aiGenerated: false }], registry()).details.join().includes('aucun droit rattaché'));
  check('entrée : complète, aucune faute', entryFaults(entry('x', 'police')).length === 0);
  check('entrée : licence et crédit manquants', entryFaults(entry('x', 'police', { license: '', credit: '' })).join() === 'licence manquante,crédit vide');
}

finish('contrôles');
