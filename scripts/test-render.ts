// scripts/test-render.ts — géométrie, HTML et chaîne réelle : Chromium, puis relecture du PDF par pdf-lib, à deux formats pour prouver
// qu'aucune taille n'est en dur. C6 prouve ici qu'un PNG RVB sans alpha ne produit pas de `/SMask` (spec §12.4).
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { readPdfFacts } from '../src/checks/pdf-facts';
import { runChecks, type CheckResult } from '../src/checks/rules';
import { createCollection, readCollection, type Collection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { buildEssai, packFonts, renderEssai, type Essai } from './fixtures/essai-2a';
import { applyBookFiche, renderHtml, RenderRefused } from '../src/render/html';
import { measureHtml, renderPdf } from '../src/render/pdf';
import { controlSubject, imageChecks, subjectContent, subjectContext, subjectHtml, zoneImages } from '../src/render/subject';
import { createSubject, updateSubject } from '../src/data/subject-file';
import { cleanPng } from '../src/images/clean';
import { pngChunks } from '../src/images/png';
import { ensureIllustrationRights, setIllustrationRights } from '../src/rights/registry';
import { expectedBlocks } from '../src/research/blocks';
import { mergeImport } from '../src/research/import';
import { makeResearch } from './fixtures/recherche';
import { createPrintServer } from '../src/server/app';
import { BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng, pngDataUri } from './fixtures/make-png';
import { essaiContent, essaiSubject, ESSAI_FIRST_PAGE } from './fixtures/sujet-essai';
import { TEMPLATE_2A } from './fixtures/gabarits';
import { BLEED_IN, BLEED_MM, GeometryRefused, layoutTemplate, pageSize, sideOfPage } from '../src/templates/geometry';
import { check, finish } from './test-lib';

const margins = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 15 };
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const SIX_NINE = { widthIn: 6, heightIn: 9 };
const LETTER = { widthIn: 8.5, heightIn: 11 };
const expectThrows = (name: string, fn: () => unknown, kind: new (...a: never[]) => Error, text: string) => {
  try {
    fn();
    check(name, false);
  } catch (e) {
    check(name, e instanceof kind && e.message.includes(text), (e as Error).message);
  }
};

// Géométrie
check('taille de page 6 × 9" : 6,125 × 9,25"', pageSize(SIX_NINE).widthIn === 6.125 && pageSize(SIX_NINE).heightIn === 9.25);
check('taille de page 8,5 × 11" : 8,625 × 11,25"', pageSize(LETTER).widthIn === 8.625 && pageSize(LETTER).heightIn === 11.25);
check('fond perdu de 0,125"', BLEED_IN === 0.125 && near(BLEED_MM, 3.175));
check('page paire : gauche ; page impaire : droite', sideOfPage(6) === 'gauche' && sideOfPage(7) === 'droite');
for (const [name, trim] of [['6 × 9"', SIX_NINE], ['8,5 × 11"', LETTER]] as const) {
  const [g, d] = layoutTemplate(TEMPLATE_2A, trim, margins, 6);
  const trimW = trim.widthIn * 25.4;
  const trimH = trim.heightIn * 25.4;
  check(`${name}, page gauche : zone rognée décalée du fond perdu`, near(g!.trim.left, BLEED_MM) && near(g!.trim.right, BLEED_MM + trimW) && near(g!.trim.right, g!.widthMm));
  check(`${name}, page droite : zone rognée au bord gauche`, g!.side === 'gauche' && d!.side === 'droite' && d!.trim.left === 0 && near(d!.trim.right, trimW) && near(d!.widthMm - d!.trim.right, BLEED_MM));
  check(`${name}, pli : côté petit fond`, near(g!.foldMm, g!.trim.right) && d!.foldMm === d!.trim.left);
  check(`${name}, page gauche : 12 mm à l'extérieur, 15 mm au pli`, near(g!.safe.left - g!.trim.left, 12) && near(g!.trim.right - g!.safe.right, 15));
  check(`${name}, page droite : 15 mm au pli, 12 mm à l'extérieur`, near(d!.safe.left - d!.trim.left, 15) && near(d!.trim.right - d!.safe.right, 12));
  check(`${name}, surface utile`, near(g!.safe.right - g!.safe.left, trimW - 27) && near(g!.safe.bottom - g!.safe.top, trimH - 24));
  check(`${name}, illustration sur trois bords, pas au pli`, near(d!.zones[0]!.rect.right, d!.widthMm) && d!.zones[0]!.rect.left === 0 && d!.zones[0]!.rect.top === 0 && near(d!.zones[0]!.rect.bottom, d!.heightMm));
  check(`${name}, bords du bandeau : extérieur et haut`, g!.zones[0]!.bleedEdges.join() === 'outer,top' && d!.zones[0]!.bleedEdges.join() === 'outer,top,bottom');
  check(`${name}, QR en bas à l'extérieur de la page droite`, (() => {
    const qr = d!.zones.find((z) => z.type === 'qr')!;
    return near(qr.rect.right, d!.safe.right) && near(qr.rect.bottom, d!.safe.bottom);
  })());
}
{
  const [g] = layoutTemplate(TEMPLATE_2A, SIX_NINE, { outerMm: 20, topMm: 12, bottomMm: 12, gutterMm: 18 }, 6);
  check('marges réglables : la géométrie suit', near(g!.safe.left - g!.trim.left, 20) && near(g!.trim.right - g!.safe.right, 18) && near(g!.zones.find((z) => z.id === 'texte')!.rect.left, g!.safe.left));
  const tall = layoutTemplate(TEMPLATE_2A, LETTER, margins, 6)[0]!;
  const short = layoutTemplate(TEMPLATE_2A, SIX_NINE, margins, 6)[0]!;
  const heightOf = (p: typeof short) => { const r = p.zones.find((z) => z.id === 'texte')!.rect; return r.bottom - r.top; };
  check('la zone de texte s’étire sur un format plus haut', near(heightOf(tall) - heightOf(short), (11 - 9) * 25.4));
}
check('format de 5 × 8" : le gabarit tient', layoutTemplate(TEMPLATE_2A, { widthIn: 5, heightIn: 8 }, margins, 6).length === 2);
expectThrows('gabarit start gauche refusé sur une page impaire', () => layoutTemplate(TEMPLATE_2A, SIX_NINE, margins, 7), GeometryRefused, 'page gauche');
expectThrows('format trop petit pour le gabarit', () => layoutTemplate(TEMPLATE_2A, { widthIn: 2, heightIn: 3 }, margins, 6), GeometryRefused, 'ne tient pas');

// Collection d'essai
const dataRoot = tempDir();
createCollection(dataRoot);
const collection = readCollection(dataRoot)!;
const withCss = (e: Essai, css: string): Essai => ({ ...e, html: e.html.replace('</style>', `${css}</style>`) });
const level = (checks: CheckResult[], id: string) => checks.find((c) => c.id === id)!.level;
const detailOf = (checks: CheckResult[], id: string) => checks.find((c) => c.id === id)!.details.join(' | ');

// HTML : aucune taille en dur, repères absents
{
  const a = buildEssai(SIX_NINE, collection, 'foret', TEMPLATE_2A).html;
  const b = buildEssai(LETTER, collection, 'foret', TEMPLATE_2A).html;
  check('HTML : taille de page venue du format', a.includes('@page { size: 6.125in 9.25in; margin: 0 }') && b.includes('@page { size: 8.625in 11.25in; margin: 0 }'));
  check('HTML : sections à la taille du format', a.includes('width: 6.125in; height: 9.25in') && b.includes('width: 8.625in; height: 11.25in'));
  check('HTML : aucun repère imprimé', !/reperes|repère/.test(a));
  check('HTML : polices embarquées', (a.match(/url\(data:font\/woff2/g) ?? []).length === 3);
  check('HTML : aucune ressource externe', !/url\(http|src="http|<link/.test(a));
  check('HTML : titre neutre', a.includes('<title>Essai</title>'));
  check('HTML : texte échappé', renderHtml(layoutTemplate(TEMPLATE_2A, SIX_NINE, margins, 6), SIX_NINE, collection.style, { ...essaiContent('foret', SIX_NINE), texts: { ...essaiContent('foret', SIX_NINE).texts, titre: '<b>x</b>' } }, collection.pictos).includes('&lt;b&gt;x'));
  check('numéro de page réel', a.includes('<span>6</span>') && a.includes('<span>7</span>'));
  const noFolio = structuredClone(collection);
  noFolio.style.folio.show = false;
  check('numéros de page retirés par le style', !buildEssai(SIX_NINE, noFolio, 'foret', TEMPLATE_2A).html.includes('data-type="folio"'));
  check('thème : couleur venue du style', buildEssai(SIX_NINE, collection, 'volcan', TEMPLATE_2A).html.includes(collection.style.palette.themes.volcan!));
  expectThrows('thème inconnu refusé', () => buildEssai(SIX_NINE, collection, 'nuit', TEMPLATE_2A), RenderRefused, 'Thème inconnu');
  const six: Collection = structuredClone(collection);
  six.style.fiche.push({ id: 'vitesse', picto: 'taille', label: { fr: 'Vitesse', en: 'Speed', es: 'Velocidad' } });
  const sixHtml = buildEssai(SIX_NINE, six, 'foret', TEMPLATE_2A).html;
  check('fiche : information ajoutée dans le style, rendue sans toucher au code', sixHtml.includes('Vitesse') && sixHtml.includes('valeur d\'essai'));
  six.style.fiche.push({ id: 'autre', picto: 'taille', label: { fr: 'Autre', en: 'Other', es: 'Otro' } });
  expectThrows('fiche au-delà de ce que pose le gabarit', () => buildEssai(SIX_NINE, six, 'foret', TEMPLATE_2A), RenderRefused, '6 au plus');
  check('sujet d’essai : mirror faux, 2 pages', essaiSubject('foret').pages === 2 && !essaiSubject('foret').variant.mirror);
  check('sujet d’essai : page gauche, plan du §5.1', ESSAI_FIRST_PAGE === 6);
  const texts = essaiContent('foret', SIX_NINE).texts;
  for (const zone of TEMPLATE_2A.sheets[0]!.zones) {
    const max = zone.constraints?.maxChars;
    if (max) check(`essai : ${zone.id} dans sa limite de caractères`, (texts[zone.id] ?? '').length <= max, (texts[zone.id] ?? '').length);
  }
  check('essai : légende du QR dans sa limite', essaiContent('foret', SIX_NINE).qrLegend.length <= 44);
}

// Chaîne réelle, aux deux formats
for (const [name, trim, wantW, wantH] of [['6 × 9"', SIX_NINE, 441, 666], ['8,5 × 11"', LETTER, 621, 810]] as const) {
  const r = await renderEssai(buildEssai(trim, collection, 'foret', TEMPLATE_2A));
  check(`${name} : deux pages`, r.pages.length === 2, r.pages);
  check(`${name} : largeur relue dans le PDF`, r.pages.every((p) => Math.abs(p.widthPt - wantW) <= 0.15 && Math.abs(p.heightPt - wantH) <= 0.15), r.pages);
  for (const c of r.checks) check(`${name} : ${c.id} vert`, c.level === 'ok', c);
  check(`${name} : Andika et Baloo 2 seulement`, r.fonts.every((f) => /Andika|Baloo/.test(f.name)) && r.fonts.some((f) => /Andika/.test(f.name)) && r.fonts.some((f) => /Baloo/.test(f.name)), r.fonts);
  const doc = await PDFDocument.load(r.pdf, { updateMetadata: false });
  check(`${name} : Title neutre`, doc.getTitle() === 'Essai', doc.getTitle());
}

// Côté de la page, mesuré dans le rendu
{
  const essai = buildEssai(SIX_NINE, collection, 'foret', TEMPLATE_2A);
  const { measures } = await renderPdf(essai.html, SIX_NINE);
  const box = (zone: string) => measures.boxes.find((b) => b.zone === zone && b.kind === 'zone')!.rect;
  const pageWidth = pageSize(SIX_NINE).widthIn * 25.4;
  check('rendu : polices chargées', measures.fontsLoaded);
  check('rendu : page mesurée à 155,575 mm', near(measures.pages[0]!.widthMm, pageWidth, 0.02), measures.pages);
  check('rendu : page gauche, bandeau du bord gauche jusqu’au pli', near(box('bandeau').left, 0, 0.02) && near(box('bandeau').right, pageWidth, 0.02), box('bandeau'));
  check('rendu : page gauche, texte à 15 mm du pli', near(pageWidth - box('texte').right, 15, 0.02), box('texte'));
  check('rendu : page droite, illustration pleine page', near(box('illustration').left, 0, 0.02) && near(box('illustration').right, pageWidth, 0.02), box('illustration'));
  check('rendu : page droite, QR à 12 mm du bord rogné', near(pageWidth - BLEED_MM - box('qr').right, 12, 0.02), box('qr'));
  const qrSvg = measures.boxes.find((b) => b.zone === 'qr' && b.kind === 'svg')!.rect;
  check('rendu : QR de 25 mm de côté', near(qrSvg.right - qrSvg.left, 25, 0.02) && near(qrSvg.bottom - qrSvg.top, 25, 0.02), qrSvg);
  check('rendu : cinq pictogrammes', measures.boxes.filter((b) => b.zone === 'fiche' && b.kind === 'svg').length === 5);
  const qrText = measures.boxes.find((b) => b.zone === 'qr' && b.kind === 'texte')!.rect;
  check('rendu : légende dans le cartouche', qrText.bottom <= box('qr').bottom && qrText.top >= qrSvg.bottom, qrText);
}

// C6 sur des PNG réels, fabriqués sans sharp
{
  const gradient = (x: number) => Math.round((x / 600) * 255);
  const rgb = pngDataUri(makePng(600, 200, 3, (x) => [200, gradient(x), 40]));
  const rgba = pngDataUri(makePng(600, 200, 4, (x) => [200, 40, 40, 255 - gradient(x)]));
  const swap = (uri: string) => {
    const essai = buildEssai(SIX_NINE, collection, 'foret', TEMPLATE_2A);
    return { ...essai, html: renderHtml(essai.layout, SIX_NINE, collection.style, { ...essaiContent('foret', SIX_NINE), images: { illustration: uri } }, collection.pictos) };
  };
  const clean = await renderPdf(swap(rgb).html, SIX_NINE);
  const cleanFacts = await readPdfFacts(clean.pdf);
  // `object-fit: cover` : Chromium n'embarque que la partie visible (134 px sur 600), sans changer sa résolution. Le PNG reste en Flate.
  check('PNG RVB sans alpha : présent dans le PDF, non recompressé en JPEG', cleanFacts.images.some((i) => i.heightPx === 200 && i.filter === '/FlateDecode'), cleanFacts.images);
  check('PNG RVB sans alpha : aucun /SMask', !cleanFacts.transparency.some((t) => t.kind.includes('SMask')), cleanFacts.transparency);
  check('PNG RVB sans alpha : C6 vert', level(runChecks({ facts: cleanFacts, measures: clean.measures, pages: swap(rgb).layout, pack: packFonts() }), 'C6') === 'ok');
  const full = await readPdfFacts((await renderPdf(buildEssai(SIX_NINE, collection, 'foret', TEMPLATE_2A).html, SIX_NINE)).pdf);
  check('PNG pleine page du sujet d’essai : 1838 × 2775 px, sans /SMask', full.images.some((i) => i.widthPx === 1838 && i.heightPx === 2775 && i.filter === '/FlateDecode') && full.transparency.length === 0, full);
  const dirty = await readPdfFacts((await renderPdf(swap(rgba).html, SIX_NINE)).pdf);
  check('PNG avec alpha : /SMask relu, C6 rouge', dirty.transparency.some((t) => t.kind === '/SMask sur une image'), dirty.transparency);
}

// Fautes réelles : le contrôle voit ce que Chromium a produit
{
  const base = buildEssai(SIX_NINE, collection, 'foret', TEMPLATE_2A);
  const faults: [string, string, string, string][] = [
    ['opacity sur la fiche', '.fiche { opacity: 0.5 }', 'C6', '/ca'],
    ['couleur à alpha', '.fiche { background: rgba(255, 0, 0, 0.4) }', 'C6', 'couleur à alpha'],
    ['filtre', '.titre { filter: blur(1px) }', 'C6', 'filter'],
    ['mode de fusion', '.fond { mix-blend-mode: multiply }', 'C6', 'mix-blend-mode'],
    ['ombre', '.fiche { box-shadow: 0 0 4px #000000 }', 'C6', 'box-shadow'],
    ['texte à 5 mm du bord', '.texte { left: 8.175mm !important }', 'C3', 'zone de sécurité'],
    ['texte sous le bord de la zone', '.fiche { top: 228mm !important; height: 20mm !important }', 'C3', 'zone de sécurité'],
    ['numéro de page dans la bande du pli', '.gauche .folio { left: 139mm !important }', 'C3', 'folio-g'],
    ['illustration sans fond perdu extérieur', '.illustration { width: 152.4mm !important }', 'C4', 'extérieur'],
    ['bandeau sans fond perdu en haut', '.fond { top: 3.175mm !important }', 'C4', 'en haut'],
    ['police hors du pack', '.texte { font-family: serif !important }', 'C7', 'hors du pack'],
    ['corps de 6 pt', '.texte { font-size: 6pt !important }', 'C8', '6,00 pt'],
    ['filet de 0,2 pt dans un pictogramme', '.info svg * { stroke-width: 0.2 }', 'C8', 'filet'],
    ['objet invisible', '.chapeau { visibility: hidden }', 'C14', 'invisible'],
  ];
  for (const [name, css, id, text] of faults) {
    const r = await renderEssai(withCss(base, css));
    check(`faute réelle, ${name} : ${id} rouge`, level(r.checks, id) === 'erreur' && detailOf(r.checks, id).includes(text), r.checks.find((c) => c.id === id));
  }
  const small = await renderEssai(withCss(base, '.texte { font-size: 12pt !important }'));
  check('faute réelle, texte courant à 12 pt : C8 en alerte', level(small.checks, 'C8') === 'alerte', small.checks);
  const big = await renderEssai(withCss(base, '@page { size: 6in 9in }'));
  check('faute réelle, page sans fond perdu : C1 rouge', level(big.checks, 'C1') === 'erreur', big.pages);
}

// Sujet réel : le texte du sujet, le même HTML, et C12 mesuré dans Chromium
{
  const parent = tempDir();
  const dataRoot = path.join(parent, 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  createCollection(dataRoot);
  const read = readCollection(dataRoot)!;
  const scenes = [{ rank: 1, id: 'alpha', title: { fr: 'Alpha fr', en: 'Alpha en', es: 'Alpha es' }, modelCredits: [], qr: null }];
  const subject = createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha'], ['foret']);
  const expected = expectedBlocks(TEMPLATE_2A, read.style.fiche, 'fr');
  const merged = mergeImport(makeResearch(), null, subject, expected);
  updateSubject(dataRoot, BOOK_ID, 'alpha', () => ({ subject: merged.subject, research: merged.research }));
  const context = () => subjectContext(dataRoot, BOOK_ID, 'alpha', scenes);
  const setText = (id: string, text: string) => updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => {
    d.subject.blocks.find((b) => b.id === id)!.text.fr = text;
    return d;
  });
  const before = subjectHtml(context());
  check('sujet : texte réel dans le HTML', before.includes('Voici le Fictivore') && before.includes('Pages de tests') && before.includes('Alpha fr'));
  check('sujet : aucun texte d’essai', !/Essaisaurus|valeur d'essai/.test(before));
  check('sujet : illustration à venir et faux QR marqué « QR absent » quand la scène n’a pas de QR (ED6)', before.includes('venir') && before.includes('>QR absent<') && !before.includes('FACTICE'));
  check('sujet : pages réelles', context().firstPage === 6 && before.includes('data-page="6"') && before.includes('data-page="7"'));
  check('sujet : Title neutre', before.includes('<title>Aperçu</title>'));
  check('sujet : aucune ressource externe', !/\bsrc="http|url\(http/.test(before));
  const checks = async () => Object.fromEntries((await controlSubject(context(), merged.research)).map((c) => [c.id, c]));
  const measured = await measureHtml(before);
  check('mesure sans PDF : aucun débordement', measured.overflows.length === 0 && measured.fontsLoaded, measured.overflows);
  check('sujet : C12 et C13 verts', (await checks()).C12!.level === 'ok' && (await checks()).C13!.level === 'ok', await checks());

  const long = 'Une phrase un peu longue pour remplir toute la zone de texte de la page. ';
  setText('texte', long.repeat(12));
  let r = await checks();
  check('C12 : texte trop long, limite et débordement', r.C12!.level === 'erreur' && r.C12!.details.some((d) => d.includes('déborde')) && r.C12!.details.some((d) => d.includes('caractères')), r.C12);
  setText('texte', 'MMMMMMMM '.repeat(65).trim());
  r = await checks();
  check('C12 : sous la limite de caractères, mais trop haut, débordement réel', r.C12!.details.some((d) => d.includes('page 6, texte : déborde')) && !r.C12!.details.some((d) => d.includes('caractères')), r.C12);
  setText('texte', 'Texte court.');
  setText('chapeau', 'Un chapeau beaucoup trop long pour sa zone, qui répète la même idée. '.repeat(3));
  r = await checks();
  check('C12 : chapeau trop haut', r.C12!.details.some((d) => d.includes('page 6, chapeau : déborde')), r.C12);
  setText('chapeau', 'Un chapeau.');
  setText('fiche-lieu', 'Unmotbeaucouptroplongpoursacase'.repeat(3));
  r = await checks();
  check('C12 : mot trop long dans une case de fiche', r.C12!.details.some((d) => d.includes('fiche, lieu : déborde')), r.C12);
  setText('fiche-lieu', 'Lieu');
  setText('fiche-taille', '');
  r = await checks();
  check('C13 : information vide, sans valeur factice', r.C13!.details.some((d) => d.includes('fiche, taille vide')) && !subjectHtml(context()).includes('valeur d\'essai'), r.C13);
  setText('fiche-taille', '2 m');
  updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, title: { fr: 'Un titre vraiment très long '.repeat(6) } } }));
  r = await checks();
  check('C12 : titre trop long, le débordement vers le haut est vu', r.C12!.details.some((d) => d.includes('page 6, titre : déborde')), r.C12);
  updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, title: {}, qrLegend: { fr: 'Une légende beaucoup trop longue pour tenir sous le QR, même sur plusieurs lignes, même en tout petit, vraiment beaucoup trop longue' } } }));
  r = await checks();
  check('C12 : légende du QR', r.C12!.details.some((d) => d.includes('qr : déborde')), r.C12);
  updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, qrLegend: { fr: 'Scanne-moi' } } }));
  check('sujet : retour au vert', (await checks()).C12!.level === 'ok', await checks());
  // Les limites du gabarit tiennent, au pire cas de la fiche : six informations et des valeurs de 28 caractères.
  {
    const six = [...read.style.fiche, { id: 'vitesse', picto: 'taille', label: { fr: 'Vitesse', en: 'Speed', es: 'Velocidad' } }];
    const full = subjectContext(dataRoot, BOOK_ID, 'alpha', scenes);
    full.collection = { ...full.collection, style: { ...full.collection.style, fiche: six } };
    const content = subjectContent(full);
    for (const item of six) content.fiche[item.id] = 'Mmmm mmmm mmmm mmmm mmmm mmm';
    const html = renderHtml(full.layout, full.trim, full.collection.style, content, full.collection.pictos);
    const fit = await measureHtml(html);
    check('fiche pleine : 6 informations de 28 caractères sans débordement', fit.overflows.length === 0, fit.overflows);
  }

  // Fiche par livre
  const fiche = [{ id: 'portee', picto: 'taille', label: { fr: 'Portée', en: 'Range', es: 'Alcance' } }];
  check('fiche du livre : remplace celle de la collection', applyBookFiche(read.style, { fiche }).fiche[0]!.id === 'portee' && applyBookFiche(read.style, {}).fiche === read.style.fiche);
  expectThrows('fiche du livre : pictogramme inconnu', () => applyBookFiche(read.style, { fiche: [{ ...fiche[0]!, picto: 'inconnu' }] }), RenderRefused, 'pictogramme inconnu');
  put(dataRoot, `${BOOK_ID}/print-book.json`, { ...JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'print-book.json'), 'utf8')), fiche });
  check('fiche du livre : attendue par les blocs', context().expected.map((b) => b.id).join() === 'chapeau,texte,fiche-portee');
  const miss = await checks();
  check('fiche du livre : bloc absent, C13 rouge', miss.C13!.details.some((d) => d.includes('fiche, portee vide')), miss.C13);
}

// Illustrations réelles, à deux formats : aucune taille n'est en dur, et le cadrage est celui qu'on imprime.
{
  /** Quatre quarts de couleurs franches : la partie visible se lit dans les pixels du rendu. */
  const QUARTERS = { 'haut-gauche': [220, 30, 30], 'haut-droite': [30, 170, 60], 'bas-gauche': [30, 60, 220], 'bas-droite': [240, 200, 20] } as const;
  const quarters = (width: number, height: number, channels: 3 | 4 = 3) =>
    makePng(width, height, channels, (x, y) => {
      const c = QUARTERS[`${y < height / 2 ? 'haut' : 'bas'}-${x < width / 2 ? 'gauche' : 'droite'}`];
      return [c[0], c[1], c[2], ...(channels === 4 ? [255] : [])] as [number, number, number];
    });
  const browser = await chromium.launch();
  /** La couleur au centre de la zone, dans le rendu réel. */
  const centerColor = async (html: string) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('Promise.all(Array.from(document.images).map((i) => i.decode()))');
    const shot = await page.locator('[data-zone="illustration"]').screenshot();
    await page.close();
    const { width, height } = await sharp(shot).metadata();
    return [...(await sharp(shot).extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 }).removeAlpha().raw().toBuffer())];
  };
  const isColor = (found: number[], want: readonly number[]) => found.every((v, i) => Math.abs(v - want[i]!) <= 2);

  for (const [name, trim, target] of [['6 × 9"', SIX_NINE, { width: 1838, height: 2775 }], ['8,5 × 11"', LETTER, { width: 2588, height: 3375 }]] as const) {
    const parent = tempDir();
    const dataRoot = path.join(parent, 'donnees');
    fs.mkdirSync(dataRoot);
    createBookFolder(dataRoot, BOOK_ID);
    createCollection(dataRoot);
    const bookFile = path.join(dataRoot, BOOK_ID, 'print-book.json');
    const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
    put(dataRoot, `${BOOK_ID}/print-book.json`, { ...book, edition: { ...book.edition, trim } });
    const scenes = [{ rank: 1, id: 'alpha', title: { fr: 'Alpha fr', en: 'Alpha en', es: 'Alpha es' }, modelCredits: [], qr: null }];
    createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha'], ['foret']);
    const context = () => subjectContext(dataRoot, BOOK_ID, 'alpha', scenes);
    check(`${name} : taille cible calculée depuis la zone`, JSON.stringify(zoneImages(context())[0]!.target) === JSON.stringify(target), zoneImages(context())[0]);
    const folder = path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha');
    fs.mkdirSync(folder);
    const place = async (input: Buffer, framing = { focusX: 0.5, focusY: 0.5, zoom: 1 }) => {
      const { png, width, height } = await cleanPng(input);
      fs.writeFileSync(path.join(folder, 'illustration.png'), png);
      updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, illustrations: [{ zone: 'illustration', file: 'illustrations/alpha/illustration.png', width, height, framing }] } }));
      return png;
    };
    const frame = (framing: { focusX: number; focusY: number; zoom: number }) => updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, illustrations: d.subject.illustrations.map((i) => ({ ...i, framing })) } }));

    // C6 repassé à taille réelle : un PNG avec canal alpha, nettoyé par sharp, ne laisse aucun /SMask.
    const kept = await place(quarters(target.width, target.height, 4));
    check(`${name} : PNG gardé à la taille cible, sans métadonnées`, [...new Set(pngChunks(kept))].join() === 'IHDR,IDAT,IEND');
    ensureIllustrationRights(dataRoot, BOOK_ID, 'alpha', 'illustration');
    setIllustrationRights(dataRoot, BOOK_ID, 'alpha', 'illustration', ['sdxl-base-1-0']);
    const html = subjectHtml(context());
    check(`${name} : image réelle dans le HTML, sans aplat`, html.includes('data:image/png;base64,') && !html.includes('image/svg+xml'));
    const { pdf, measures } = await renderPdf(html, trim);
    const facts = await readPdfFacts(pdf);
    const results = Object.fromEntries(runChecks({ facts, measures, pages: context().layout, pack: packFonts() }).map((c) => [c.id, c]));
    check(`${name} : C4, l'image reste à fond perdu`, results.C4!.level === 'ok', results.C4);
    check(`${name} : C6, PNG nettoyé à taille réelle, aucune transparence`, results.C6!.level === 'ok' && !facts.transparency.some((t) => t.kind.includes('SMask')), [results.C6, facts.transparency]);
    check(`${name} : image embarquée sans recompression`, facts.images.some((i) => i.filter === '/FlateDecode'), facts.images);
    const [c5, c11] = imageChecks(context()).checks;
    check(`${name} : C5 vert à la taille cible, sur le fichier source`, c5!.level === 'ok', c5);
    check(`${name} : C11 lu sur le registre réel`, c11!.level === 'alerte', c11);
    frame({ focusX: 0.5, focusY: 0.5, zoom: 1.05 });
    check(`${name} : zoom 1,05, C5 rouge`, imageChecks(context()).checks[0]!.level === 'erreur', imageChecks(context()).checks[0]);
    frame({ focusX: 0.5, focusY: 0.5, zoom: 1 });

    // Le cadrage est celui du rendu : à zoom 2, le quart visé remplit la zone.
    for (const [corner, focusX, focusY] of [['haut-gauche', 0.25, 0.25], ['haut-droite', 0.75, 0.25], ['bas-gauche', 0.25, 0.75], ['bas-droite', 0.75, 0.75]] as const) {
      frame({ focusX, focusY, zoom: 2 });
      const color = await centerColor(subjectHtml(context()));
      check(`${name} : point focal ${corner}, quart visé au centre`, isColor(color, QUARTERS[corner]), color);
    }
    frame({ focusX: 0.25, focusY: 0.25, zoom: 2 });
    const zoomed = await renderPdf(subjectHtml(context()), trim);
    const zoomedFacts = await readPdfFacts(zoomed.pdf);
    const zoomedChecks = Object.fromEntries(runChecks({ facts: zoomedFacts, measures: zoomed.measures, pages: context().layout, pack: packFonts() }).map((c) => [c.id, c]));
    check(`${name} : zoomée, l'image coupée ne casse ni C4 ni C6`, zoomedChecks.C4!.level === 'ok' && zoomedChecks.C6!.level === 'ok' && zoomedFacts.transparency.length === 0, [zoomedChecks.C4, zoomedChecks.C6, zoomedFacts.transparency]);
    fs.rmSync(path.join(folder, 'illustration.png'));
    check(`${name} : fichier absent, l'aperçu garde l'aplat`, subjectHtml(context()).includes('image/svg+xml'));
  }
  await browser.close();
}

finish('rendu');
