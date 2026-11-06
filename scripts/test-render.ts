// scripts/test-render.ts — géométrie, HTML et chaîne réelle : Chromium, puis relecture du PDF par pdf-lib, à deux formats pour prouver
// qu'aucune taille n'est en dur. C6 prouve ici qu'un PNG RVB sans alpha ne produit pas de `/SMask` (spec §12.4).
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { readPdfFacts } from '../src/checks/pdf-facts';
import { runChecks, type CheckResult } from '../src/checks/rules';
import { createCollection, readCollection, type Collection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { buildEssai, ESSAI_FILE, packFonts, renderEssai, type Essai } from '../src/render/essai';
import { renderHtml, RenderRefused } from '../src/render/html';
import { renderPdf } from '../src/render/pdf';
import { createPrintServer } from '../src/server/app';
import { BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng, pngDataUri } from './fixtures/make-png';
import { essaiContent, essaiSubject, ESSAI_FIRST_PAGE } from './fixtures/sujet-essai';
import { TEMPLATE_2A } from '../src/templates/2A';
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
  const a = buildEssai(SIX_NINE, collection, 'foret').html;
  const b = buildEssai(LETTER, collection, 'foret').html;
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
  check('numéros de page retirés par le style', !buildEssai(SIX_NINE, noFolio, 'foret').html.includes('data-type="folio"'));
  check('thème : couleur venue du style', buildEssai(SIX_NINE, collection, 'volcan').html.includes(collection.style.palette.themes.volcan!));
  expectThrows('thème inconnu refusé', () => buildEssai(SIX_NINE, collection, 'nuit'), RenderRefused, 'Thème inconnu');
  const six: Collection = structuredClone(collection);
  six.style.fiche.push({ id: 'vitesse', picto: 'taille', label: { fr: 'Vitesse', en: 'Speed', es: 'Velocidad' } });
  const sixHtml = buildEssai(SIX_NINE, six, 'foret').html;
  check('fiche : information ajoutée dans le style, rendue sans toucher au code', sixHtml.includes('Vitesse') && sixHtml.includes('valeur d\'essai'));
  six.style.fiche.push({ id: 'autre', picto: 'taille', label: { fr: 'Autre', en: 'Other', es: 'Otro' } });
  expectThrows('fiche au-delà de ce que pose le gabarit', () => buildEssai(SIX_NINE, six, 'foret'), RenderRefused, '6 au plus');
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
  const r = await renderEssai(buildEssai(trim, collection, 'foret'));
  check(`${name} : deux pages`, r.pages.length === 2, r.pages);
  check(`${name} : largeur relue dans le PDF`, r.pages.every((p) => Math.abs(p.widthPt - wantW) <= 0.15 && Math.abs(p.heightPt - wantH) <= 0.15), r.pages);
  for (const c of r.checks) check(`${name} : ${c.id} vert`, c.level === 'ok', c);
  check(`${name} : Andika et Baloo 2 seulement`, r.fonts.every((f) => /Andika|Baloo/.test(f.name)) && r.fonts.some((f) => /Andika/.test(f.name)) && r.fonts.some((f) => /Baloo/.test(f.name)), r.fonts);
  const doc = await PDFDocument.load(r.pdf, { updateMetadata: false });
  check(`${name} : Title neutre`, doc.getTitle() === 'Essai', doc.getTitle());
}

// Côté de la page, mesuré dans le rendu
{
  const essai = buildEssai(SIX_NINE, collection, 'foret');
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
    const essai = buildEssai(SIX_NINE, collection, 'foret');
    return { ...essai, html: renderHtml(essai.layout, SIX_NINE, collection.style, { ...essaiContent('foret', SIX_NINE), images: { illustration: uri } }, collection.pictos) };
  };
  const clean = await renderPdf(swap(rgb).html, SIX_NINE);
  const cleanFacts = await readPdfFacts(clean.pdf);
  // `object-fit: cover` : Chromium n'embarque que la partie visible (134 px sur 600), sans changer sa résolution. Le PNG reste en Flate.
  check('PNG RVB sans alpha : présent dans le PDF, non recompressé en JPEG', cleanFacts.images.some((i) => i.heightPx === 200 && i.filter === '/FlateDecode'), cleanFacts.images);
  check('PNG RVB sans alpha : aucun /SMask', !cleanFacts.transparency.some((t) => t.kind.includes('SMask')), cleanFacts.transparency);
  check('PNG RVB sans alpha : C6 vert', level(runChecks({ facts: cleanFacts, measures: clean.measures, pages: swap(rgb).layout, pack: packFonts() }), 'C6') === 'ok');
  const full = await readPdfFacts((await renderPdf(buildEssai(SIX_NINE, collection, 'foret').html, SIX_NINE)).pdf);
  check('PNG pleine page du sujet d’essai : 1838 × 2775 px, sans /SMask', full.images.some((i) => i.widthPx === 1838 && i.heightPx === 2775 && i.filter === '/FlateDecode') && full.transparency.length === 0, full);
  const dirty = await readPdfFacts((await renderPdf(swap(rgba).html, SIX_NINE)).pdf);
  check('PNG avec alpha : /SMask relu, C6 rouge', dirty.transparency.some((t) => t.kind === '/SMask sur une image'), dirty.transparency);
}

// Fautes réelles : le contrôle voit ce que Chromium a produit
{
  const base = buildEssai(SIX_NINE, collection, 'foret');
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

// Export par la route, nom du fichier d'essai, écriture limitée
{
  const parent = tempDir();
  const glbRoot = makeGlbi();
  const data = path.join(parent, 'donnees');
  fs.mkdirSync(data);
  put(parent, 'config.local.json', { glbRoot, dataRoot: data });
  createBookFolder(data, BOOK_ID);
  createCollection(data);
  const server = createPrintServer(path.join(parent, 'config.local.json'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const exportNow = (body: unknown) =>
    new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => {
      const text = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/essai/export', headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'x-book-print': '1' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.write(text);
      req.end();
    });
  const glbBefore = fs.readdirSync(glbRoot, { recursive: true, encoding: 'utf8' }).sort().join();
  const first = await exportNow({ bookId: BOOK_ID, theme: 'ocean' });
  const file = path.join(data, BOOK_ID, 'export', ESSAI_FILE);
  check('export : PDF écrit sous export/', first.status === 200 && first.json.file === file && fs.statSync(file).size > 1000, first.json.error);
  check('export : nom d’essai, jamais celui du PDF final', ESSAI_FILE === 'essai-2A.pdf');
  check('export : tous les contrôles verts', first.json.checks?.every((c: CheckResult) => c.level === 'ok'), first.json.checks);
  check('export : dimensions et polices rendues à la page', first.json.pages?.length === 2 && first.json.fonts?.length >= 2 && first.json.pageSizeIn?.widthIn === 6.125, first.json);
  const second = await exportNow({ bookId: BOOK_ID, theme: 'volcan' });
  check('export : le fichier d’essai se remplace, sans temporaire laissé', second.status === 200 && fs.readdirSync(path.join(data, BOOK_ID, 'export')).join() === ESSAI_FILE, fs.readdirSync(path.join(data, BOOK_ID, 'export')));
  const book = JSON.parse(fs.readFileSync(path.join(data, BOOK_ID, 'print-book.json'), 'utf8'));
  put(data, `${BOOK_ID}/print-book.json`, { ...book, edition: { ...book.edition, trim: LETTER } });
  const letter = await exportNow({ bookId: BOOK_ID, theme: 'savane' });
  check('export : le format vient de print-book.json', letter.status === 200 && letter.json.pageSizeIn.widthIn === 8.625 && Math.abs(letter.json.pages[0].widthPt - 621) <= 0.15, letter.json.pages);
  check('export : rien dans GLBInterpreter', fs.readdirSync(glbRoot, { recursive: true, encoding: 'utf8' }).sort().join() === glbBefore);
  await new Promise((resolve) => server.close(resolve));
}

finish('rendu');
