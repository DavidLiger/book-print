// scripts/test-texte-detoure.ts — ED2 : texte qui coule (chaînes, colonnes en boîtes, coupure au mot en deux passes, intertitre jamais seul
// en bas d'une boîte, lettrine, C12 sur la chaîne, C13 avant ED4) et images détourées (dépôt d'un PNG avec alpha, contour, PNG gardé en RVB,
// `contour.json` et son empreinte, découpe par `clip-path`, habillage, C5, C17, aucune transparence dans le PDF) ; droit `image-externe` ;
// parcours ; routes. Tout est synthétique : mise en page `2X`, PNG fabriqués par sharp.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { c13Filler, chainFaults } from '../src/checks/content';
import { c5Resolution } from '../src/checks/images';
import { overlapFault, overlapFaults } from '../src/checks/overlaps';
import { readPdfFacts } from '../src/checks/pdf-facts';
import { createCollection, readCollection } from '../src/data/collection';
import { contourFile, contourName, readContour, sha256, subjectContour, writeContour } from '../src/data/contour-file';
import { createBookFolder } from '../src/data/create-book';
import { storeIllustration } from '../src/data/illustration-store';
import { createSubject } from '../src/data/subject-file';
import { cleanDetoure, cleanPng, ImageRefused } from '../src/images/clean';
import { ALPHA_THRESHOLD, containRect, contourOf, ContourRefused, insidePolygon, outlineIn, polygonsOverlap, rectPolygon, simplify } from '../src/images/contour';
import { containPpi } from '../src/images/crop';
import { pngChunks, readPngHeader } from '../src/images/png';
import { chainsOf, elementsOf } from '../src/layout/model';
import { placeLayout } from '../src/layout/place';
import { layoutSchema, type Layout } from '../src/layout/schema';
import { readFacts } from '../src/parcours/facts';
import { computeParcours, STEPS } from '../src/parcours/steps';
import { boxMarkup, chainTokens, type ChainText } from '../src/render/flow';
import { controlTemplate, fillerChains, fillerText, flowedPreview, templatePreview } from '../src/render/gabarit';
import { SHAPE_MARGIN_MM, wrapFloats } from '../src/render/html';
import { flowHtml, measureHtml, renderFlowedPdf, renderPdf } from '../src/render/pdf';
import { controlSubject, subjectBuilder, subjectContext, subjectHtml, subjectPage, zoneImages } from '../src/render/subject';
import { expectedBlocks } from '../src/research/blocks';
import { ILLUSTRATION_KINDS, RIGHTS_KINDS, rightsEntrySchema } from '../src/schema/rights';
import { createPrintServer } from '../src/server/app';
import type { LayoutPage, LayoutZone } from '../src/templates/geometry';
import { BOOK_DIR, BOOK_ID, fileLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { detourePng, opaquePngs, syntheseEd2 } from './fixtures/texte-detoure';
import { check, finish } from './test-lib';

type Dict = Record<string, any>;
const SIX_NINE = { widthIn: 6, heightIn: 9 };
const MARGINS = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 15 };
const SCENES = [
  { rank: 1, id: 'alpha', title: { fr: 'Alpha', en: 'Alpha', es: 'Alpha' }, modelCredits: [], qr: null },
  { rank: 2, id: 'beta', title: { fr: 'Beta', en: 'Beta', es: 'Beta' }, modelCredits: [], qr: null },
] as never[];

const newData = () => {
  const dataRoot = path.join(tempDir(), 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  createCollection(dataRoot);
  return dataRoot;
};
const margins = (dataRoot: string) => readCollection(dataRoot)!.style.margins;
const writeModel = (dataRoot: string, id = '2X', options = {}) => put(dataRoot, `collection/gabarits/${id}.json`, syntheseEd2(id, SIX_NINE, margins(dataRoot), options));
const parsed = (options = {}) => layoutSchema.parse(syntheseEd2('2X', SIX_NINE, MARGINS, options));

/** Le texte de chaque boîte d'une chaîne, dans l'ordre des boîtes, relu dans le HTML final. */
function boxTexts(html: string, chain = 'corps'): { words: string[]; paras: string[]; lastIsHeading: boolean; firstIsTete: boolean }[] {
  const out: { at: number; words: string[]; paras: string[]; lastIsHeading: boolean; firstIsTete: boolean }[] = [];
  const re = new RegExp(`<div class="colonne" data-cadre data-chaine="${chain}" data-boite="(\\d+)"[^>]*><div class="flux" data-fill>(.*?)</div></div>`, 'g');
  for (const m of html.matchAll(re)) {
    const inner = m[2]!.replace(/<span class="habillage"[^>]*><\/span>/g, '');
    const parts = [...inner.matchAll(/<(p|h3)\b[^>]*>(.*?)<\/\1>/g)];
    const words = parts.filter((p) => p[1] === 'p').flatMap((p) => p[2]!.split(' ').filter(Boolean));
    out.push({ at: Number(m[1]), words, paras: parts.map((p) => p[1]!), lastIsHeading: parts.at(-1)?.[1] === 'h3', firstIsTete: /^<h3 class="intertitre tete"/.test(inner) });
  }
  return out.sort((a, b) => a.at - b.at);
}
const chainWordsOf = (chain: ChainText) => chain.paragraphs.flatMap((p) => p.text.split(/[ \t\r\n]+/).filter(Boolean));

/** Rectangles des lignes de texte (fragments de chaque nœud), en mm sur la page, mesurés dans le HTML final. */
const LINES_SCRIPT = `(() => {
  const MM = 25.4 / 96;
  const out = [];
  for (const section of document.querySelectorAll('section.page')) {
    const base = section.getBoundingClientRect();
    for (const zone of section.querySelectorAll('[data-type="texte"]')) {
      const walker = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) out.push({ page: Number(section.dataset.page), left: (r.left - base.left) * MM, top: (r.top - base.top) * MM, right: (r.right - base.left) * MM, bottom: (r.bottom - base.top) * MM });
      }
    }
  }
  return out;
})()`;
async function lineRects(html: string): Promise<{ page: number; left: number; top: number; right: number; bottom: number }[]> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready');
    return (await page.evaluate(LINES_SCRIPT)) as never;
  } finally {
    await browser.close();
  }
}
/** Lignes qui touchent le contour : la ligne réduite d'un dixième de mm, contre le polygone. */
const linesInShape = (lines: Awaited<ReturnType<typeof lineRects>>, page: number, points: [number, number][]) =>
  lines.filter((l) => l.page === page && polygonsOverlap(rectPolygon({ left: l.left + 0.1, top: l.top + 0.1, right: l.right - 0.1, bottom: l.bottom - 0.1 }), points));

/** Objets image du PDF et leur masque doux : un `/SMask` est de la transparence. */
async function pdfImages(pdf: Uint8Array): Promise<{ count: number; smask: number }> {
  const doc = await PDFDocument.load(pdf);
  let count = 0;
  let smask = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
      count++;
      if (obj.dict.get(PDFName.of('SMask')) || obj.dict.get(PDFName.of('Mask'))) smask++;
    }
    if (obj instanceof PDFDict && obj.get(PDFName.of('SMask')) && String(obj.get(PDFName.of('Type'))) === '/ExtGState') smask++;
  }
  return { count, smask };
}

// 1. Schéma : la synthèse admise, puis chaque refus des champs d'ED2.
{
  const ok = layoutSchema.safeParse(syntheseEd2());
  check('schéma : mise en page de synthèse d’ED2 admise (chaîne, colonnes, détouré, habillage)', ok.success, ok.error?.issues);
  const refused = (name: string, change: (l: Dict) => void, text: string) => {
    const l = structuredClone(syntheseEd2()) as Dict;
    change(l);
    const r = layoutSchema.safeParse(l);
    check(`schéma refusé : ${name}`, !r.success && r.error.issues.some((i) => i.message.includes(text)), r.success ? 'admis' : r.error.issues.map((i) => i.message));
  };
  const el = (l: Dict, id: string) => l.elements.find((e: Dict) => e.id === id);
  const chain = (l: Dict) => l.chaines[0];
  refused('chaine sur un autre type', (l) => (el(l, 'chapeau').chaine = 'corps'), 'chaine réservé');
  refused('colonnes sur un autre type', (l) => (el(l, 'chapeau').colonnes = 2), 'colonnes réservé');
  refused('gouttiereMm sur un autre type', (l) => (el(l, 'chapeau').gouttiereMm = 5), 'gouttiereMm réservé');
  refused('detoure sur un autre type', (l) => (el(l, 'chapeau').detoure = true), 'detoure réservé');
  refused('habillage sur un autre type', (l) => (el(l, 'chapeau').habillage = 'gauche'), 'habillage réservé');
  refused('colonnes à 0', (l) => (el(l, 'texte-g').colonnes = 0), 'colonnes : 1 à 4');
  refused('colonnes à 5', (l) => (el(l, 'texte-g').colonnes = 5), 'colonnes : 1 à 4');
  refused('colonnes sans chaîne', (l) => Object.assign(el(l, 'chapeau'), { type: 'texte', colonnes: 2, gouttiereMm: 5 }), 'seulement sur un cadre de chaîne');
  refused('gouttière sans chaîne', (l) => Object.assign(el(l, 'chapeau'), { type: 'texte', gouttiereMm: 5 }), 'seulement sur un cadre de chaîne');
  refused('deux colonnes sans gouttière', (l) => delete el(l, 'texte-g').gouttiereMm, 'gouttiereMm attendue');
  refused('gouttière pour une colonne', (l) => (el(l, 'texte-d').gouttiereMm = 5), 'à partir de 2 colonnes');
  refused('colonnes qui ne tiennent pas', (l) => Object.assign(el(l, 'texte-g'), { colonnes: 4, gouttiereMm: 50 }), 'ne tiennent pas');
  refused('maxChars sur un cadre de chaîne', (l) => (el(l, 'texte-g').maxChars = 300), 'maxChars refusé sur un cadre de chaîne');
  refused('texte seul sans maxChars (inchangé)', (l) => Object.assign(el(l, 'chapeau'), { type: 'texte', maxChars: undefined }), 'maxChars attendu');
  refused('cadre vers une chaîne absente', (l) => (el(l, 'texte-g').chaine = 'autre'), 'absente de chaines');
  refused('cadre absent des cadres de sa chaîne', (l) => (chain(l).cadres = ['texte-d']), 'absent des cadres');
  refused('cadre de chaîne absent des éléments', (l) => chain(l).cadres.push('absent'), 'absent des éléments');
  refused('cadre de chaîne qui n’est pas un texte', (l) => chain(l).cadres.push('chapeau'), 'n\'est pas un élément texte');
  refused('cadre qui porte une autre chaîne', (l) => l.chaines.push({ id: 'autre', cadres: ['texte-d'], paragraphes: [{ id: 'q1', intertitre: false, maxChars: 10 }] }), 'porte la chaîne corps');
  refused('cadre en double dans une chaîne', (l) => chain(l).cadres.push('texte-d'), 'déjà dans cette chaîne');
  refused('deux chaînes du même nom', (l) => l.chaines.push(structuredClone(chain(l))), 'en double');
  refused('chaîne sans cadre', (l) => (chain(l).cadres = []), 'cadres : au moins un');
  refused('chaîne sans paragraphe', (l) => (chain(l).paragraphes = []), 'paragraphes : au moins un');
  refused('paragraphe en double', (l) => chain(l).paragraphes.push({ id: 'p1', intertitre: false, maxChars: 10 }), 'en double');
  refused('intertitre sans headingMaxChars', (l) => delete chain(l).paragraphes[1].headingMaxChars, 'headingMaxChars attendu pour un intertitre');
  refused('headingMaxChars sans intertitre', (l) => (chain(l).paragraphes[0].headingMaxChars = 20), 'seulement avec un intertitre');
  refused('paragraphe sans maxChars', (l) => delete chain(l).paragraphes[0].maxChars, 'nombre attendu');
  refused('champ inconnu dans une chaîne', (l) => (chain(l).couleur = 'rouge'), 'couleur');
  refused('détouré sans habillage', (l) => delete el(l, 'animal').habillage, 'habillage attendu');
  refused('habillage sans détouré', (l) => delete el(l, 'animal').detoure, 'seulement pour un détouré');
  refused('habillage inconnu', (l) => (el(l, 'animal').habillage = 'haut'), 'gauche, droite ou aucun');
  refused('détouré avec fond perdu', (l) => Object.assign(el(l, 'animal'), { x: 0, y: 0, fondPerdu: ['haut'] }), 'pas de fond perdu');
  refused('détouré à cheval', (l) => Object.assign(el(l, 'animal'), { page: 0, double: true }), 'pas à cheval');
  check('schéma : chaîne sans lettrine admise', layoutSchema.safeParse({ ...syntheseEd2(), chaines: [{ ...syntheseEd2().chaines[0], lettrine: undefined }] }).success);
  check('schéma : habillage aucun admis', layoutSchema.safeParse(syntheseEd2('2X', SIX_NINE, MARGINS, { habillage: 'aucun' })).success);
}

// 2. Pose et blocs : les champs passent à la zone posée ; un cadre de chaîne n'attend aucun bloc avant ED4.
{
  const layout = parsed();
  const pages = placeLayout(layout, MARGINS, 6);
  const zone = (id: string) => pages.flatMap((p) => p.zones).find((z) => z.id === id)!;
  check('pose : chaîne, colonnes et gouttière sur la zone', zone('texte-g').chaine === 'corps' && zone('texte-g').colonnes === 2 && zone('texte-g').gouttiereMm === 5);
  check('pose : détouré et habillage sur la zone', zone('animal').detoure === true && zone('animal').habillage === 'gauche');
  check('pose : zone sans champ d’ED2, rien d’ajouté', !('chaine' in zone('chapeau')) && !('detoure' in zone('chapeau')));
  const fiche = readCollection(newData())!.style.fiche;
  const blocks = expectedBlocks(layout, fiche, 'fr');
  check('blocs attendus : aucun pour un cadre de chaîne (avant ED4)', !blocks.some((b) => b.zone === 'texte-g' || b.zone === 'texte-d') && blocks.some((b) => b.zone === 'chapeau'), blocks);
  const solo = layoutSchema.parse({ ...syntheseEd2(), chaines: undefined, elements: [{ id: 'texte', type: 'texte', page: 0, x: 20, y: 20, w: 80, h: 40, maxChars: 200 }] });
  check('blocs attendus : un texte seul garde son bloc', expectedBlocks(solo, fiche, 'fr').some((b) => b.zone === 'texte' && b.type === 'texte' && b.maxChars === 200));
  check('chaînes d’une version 2, aucune pour une version 1', chainsOf(layout).length === 1 && chainsOf({ id: '2A', pages: 2, start: 'gauche', sheets: [] } as never).length === 0);
  check('éléments d’une version 2 : les cadres portent leur chaîne', elementsOf(layout).filter((e) => e.chaine === 'corps').length === 2);
}

// 3. Contour : seuil, plus grande partie, retrait d'un pixel, suivi de bord, simplification, parties détachées, refus.
{
  const W = 30;
  const H = 20;
  const square = (x0: number, y0: number, x1: number, y1: number, a = 255, base?: Uint8Array) => {
    const out = base ?? new Uint8Array(W * H);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * W + x] = a;
    return out;
  };
  const sq = contourOf(square(5, 4, 15, 14), W, H);
  const xs = sq.points.map((p) => p[0]);
  const ys = sq.points.map((p) => p[1]);
  check('contour : un carré donne 4 sommets', sq.points.length === 4, sq.points);
  check('contour : retrait d’un pixel vers l’intérieur', Math.min(...xs) === 6 && Math.max(...xs) === 14 && Math.min(...ys) === 5 && Math.max(...ys) === 13, sq.points);
  check('contour : seuil à 50 % (127 transparent, 128 opaque)', contourOf(square(0, 0, 30, 10, 128, square(0, 10, 30, 20, 127)), W, H).points.every((p) => p[1] <= 9));
  check('contour : seuil', ALPHA_THRESHOLD === 128);
  const two = square(20, 2, 26, 8, 255, square(2, 2, 14, 18));
  const parted = contourOf(two, W, H);
  check('contour : la plus grande partie', Math.max(...parted.points.map((p) => p[0])) <= 13, parted.points);
  check('contour : la partie détachée signalée, avec sa taille et sa place', parted.autresParties.length === 1 && parted.autresParties[0]!.pixels === 36 && parted.autresParties[0]!.gauche === 20 && parted.autresParties[0]!.bas === 8, parted.autresParties);
  // Un anneau et un point dans son trou : le point n'est pas découpé, rien à signaler.
  const ring = square(10, 8, 11, 9, 255, square(7, 5, 14, 12, 0, square(4, 2, 17, 15)));
  check('contour : une partie dans un trou n’est pas signalée', contourOf(ring, W, H).autresParties.length === 0);
  // Deux blocs qui, après le retrait d'un pixel, ne se touchent plus que par un coin : le contour les entoure tous les deux (8-connexité).
  const diag = square(8, 8, 15, 15, 255, square(2, 2, 9, 9));
  const joined = contourOf(diag, W, H, 0);
  check('contour : deux blocs joints par un coin, un seul contour qui les entoure', joined.autresParties.length === 0 && Math.max(...joined.points.map((p) => p[0])) === 14 && Math.min(...joined.points.map((p) => p[0])) === 3 && insidePolygon(4.5, 4.5, joined.points) && insidePolygon(12.5, 12.5, joined.points), joined.points);
  for (const [name, alpha, text] of [
    ['transparent partout', new Uint8Array(W * H), 'transparent partout'],
    ['opaque partout', new Uint8Array(W * H).fill(255), 'opaque partout'],
    ['partie trop fine pour le retrait', square(5, 5, 25, 6), 'trop fine'],
  ] as const) {
    try {
      contourOf(alpha, W, H);
      check(`contour refusé : ${name}`, false);
    } catch (e) {
      check(`contour refusé : ${name}`, e instanceof ContourRefused && e.message.includes(text), (e as Error).message);
    }
  }
  // Propriété : sur des formes au hasard, chaque pixel gardé (plus grande partie, retrait d'un pixel) a son centre dans le polygone non simplifié.
  let bad = 0;
  for (let k = 0; k < 60; k++) {
    const a = new Uint8Array(W * H);
    for (let n = 0; n < 4; n++) {
      const cx = 5 + ((k * 7 + n * 11) % 20);
      const cy = 4 + ((k * 5 + n * 3) % 12);
      const r = 2 + ((k + n) % 6);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) a[y * W + x] = 255;
    }
    let c;
    try {
      c = contourOf(a, W, H, 0);
    } catch {
      continue;
    }
    // La plus grande partie (8-connexité), le retrait d'un pixel, puis le plus grand morceau qui en reste.
    const largest = (inside: (i: number) => boolean) => {
      const seen = new Set<number>();
      let best: Set<number> = new Set();
      for (let i = 0; i < W * H; i++) {
        if (!inside(i) || seen.has(i)) continue;
        const part = new Set<number>([i]);
        const stack = [i];
        seen.add(i);
        while (stack.length) {
          const at = stack.pop()!;
          const ax = at % W;
          const ay = (at - ax) / W;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = ax + dx;
            const ny = ay + dy;
            const n = ny * W + nx;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && inside(n) && !seen.has(n)) {
              seen.add(n);
              part.add(n);
              stack.push(n);
            }
          }
        }
        if (part.size > best.size) best = part;
      }
      return best;
    };
    const main = largest((i) => a[i]! >= 128);
    const op = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && main.has(y * W + x);
    const piece = largest((i) => {
      const x = i % W;
      const y = (i - x) / W;
      return op(x, y) && op(x - 1, y) && op(x + 1, y) && op(x, y - 1) && op(x, y + 1);
    });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!piece.has(y * W + x)) continue;
        if (!insidePolygon(x + 0.5, y + 0.5, c.points)) bad++;
      }
    }
  }
  check('contour : formes au hasard, aucun pixel gardé hors du polygone', bad === 0, bad);
  const stairs: [number, number][] = [];
  for (let i = 0; i < 20; i++) stairs.push([i, i], [i + 1, i]);
  stairs.push([20, 20], [0, 20]);
  check('contour : Douglas-Peucker à 0,5 px garde un escalier d’un pixel', simplify(stairs).length > 4);
  check('contour : Douglas-Peucker à 1 px simplifie l’escalier', simplify(stairs, 1).length <= 4, simplify(stairs, 1).length);
  // Place de l'image entière dans une boîte d'un autre rapport : centrée, la plus grande taille qui tient.
  const box = { left: 10, top: 20, right: 110, bottom: 70 };
  const r = containRect(box, { width: 200, height: 200 });
  check('détouré : image entière centrée dans une boîte plus large', r.left === 35 && r.right === 85 && r.top === 20 && r.bottom === 70, r);
  const o = outlineIn(box, { width: 200, height: 200, points: [[0, 0], [200, 0], [100, 200]] });
  check('détouré : contour ramené à la page et en pourcentage', o.points[1]![0] === 85 && o.points[2]![1] === 70 && o.percent[2]![0] === 50 && o.percent[2]![1] === 100, o);
  check('détouré : résolution de l’image entière (C5)', containPpi({ width: 1000, height: 500 }, { widthMm: 25.4, heightMm: 25.4 }) === 1000);
}

// 4. Dépôt d'un détouré : PNG avec alpha exigé, contour, PNG gardé en RVB `IHDR IDAT IEND`, contour.json et son empreinte.
{
  const synth = await detourePng(400, 450);
  const d = await cleanDetoure(synth);
  check('dépôt détouré : PNG gardé en RVB 8 bits', readPngHeader(d.image.png)?.colorType === 2 && readPngHeader(d.image.png)?.bitDepth === 8);
  check('dépôt détouré : PNG gardé en IHDR IDAT IEND', pngChunks(d.image.png).every((c) => ['IHDR', 'IDAT', 'IEND'].includes(c)) && pngChunks(d.image.png)[0] === 'IHDR');
  check('dépôt détouré : contour et image de même taille', d.contour.width === d.image.width && d.contour.height === d.image.height && d.contour.width === 400);
  check('dépôt détouré : contour simplifié, la queue détachée signalée', d.contour.points.length > 10 && d.contour.autresParties.length === 1, d.contour.autresParties);
  const { default: sharp } = await import('sharp');
  const flat = await sharp(d.image.png).raw().toBuffer();
  check('dépôt détouré : alpha aplati sur blanc', flat[0] === 255 && flat[1] === 255 && flat[2] === 255);
  const { rgb, rgbaOpaque, rgbaTransparent } = await opaquePngs();
  for (const [name, bytes, text] of [
    ['PNG sans alpha', rgb, 'sans transparence'],
    ['PNG opaque partout', rgbaOpaque, 'opaque partout'],
    ['PNG transparent partout', rgbaTransparent, 'transparent partout'],
    ['pas un PNG', Buffer.from('pas un png'), 'pas un PNG'],
  ] as const) {
    try {
      await cleanDetoure(bytes);
      check(`dépôt détouré refusé : ${name}`, false);
    } catch (e) {
      check(`dépôt détouré refusé : ${name}`, e instanceof ImageRefused && e.message.includes(text), (e as Error).message);
    }
  }
  check('dépôt rectangulaire : PNG avec alpha toujours admis, aplati (MP4 inchangé)', readPngHeader((await cleanPng(synth)).png)?.colorType === 2);

  const folder = path.join(tempDir(), 'illustrations');
  fs.mkdirSync(folder);
  const png = path.join(folder, 'animal.png');
  fs.writeFileSync(png, d.image.png);
  writeContour(folder, 'animal', contourFile(d.contour, d.image.png));
  const written = JSON.parse(fs.readFileSync(path.join(folder, contourName('animal')), 'utf8'));
  check('contour.json : version, taille, seuil, points, empreinte du PNG gardé', written.schemaVersion === 1 && written.image.width === 400 && written.seuil === 128 && written.points.length === d.contour.points.length && written.empreinte === sha256(d.image.png) && written.autresParties.length === 1);
  check('contour.json relu', readContour(folder, 'animal', png).state === 'ok');
  const other = (await sharp({ create: { width: 400, height: 450, channels: 3, background: '#ffffff' } }).png().toBuffer());
  fs.writeFileSync(png, other);
  const changed = readContour(folder, 'animal', png);
  check('contour.json : PNG remplacé, empreinte différente, redéposer', changed.state === 'refuse' && changed.message.includes('ne correspond plus'), changed);
  fs.writeFileSync(png, d.image.png);
  fs.writeFileSync(path.join(folder, contourName('animal')), '{');
  const broken = readContour(folder, 'animal', png);
  check('contour.json illisible : redéposer', broken.state === 'refuse' && broken.message.includes('illisible'));
  fs.writeFileSync(path.join(folder, contourName('animal')), JSON.stringify({ ...written, points: [[0, 0], [1, 1]] }));
  const few = readContour(folder, 'animal', png);
  check('contour.json invalide : refusé', few.state === 'refuse' && few.message.includes('3 points'));
  fs.writeFileSync(path.join(folder, contourName('animal')), JSON.stringify({ ...written, image: { width: 401, height: 450 } }));
  const size = readContour(folder, 'animal', png);
  check('contour.json d’une autre taille : refusé', size.state === 'refuse', size);
  fs.rmSync(path.join(folder, contourName('animal')));
  check('contour.json absent', readContour(folder, 'animal', png).state === 'absent');
  const target = path.join(folder, 'ailleurs.json');
  fs.writeFileSync(target, JSON.stringify(written));
  if (fileLink(target, path.join(folder, contourName('animal')))) {
    const link = readContour(folder, 'animal', png);
    check('contour.json en lien : refusé', link.state === 'refuse' && link.message.includes('pas un fichier réel'));
  }
}

// 5. Flux : jetons, balisage d'une tranche (lettrine, retrait, intertitre en tête), mots entiers, espaces insécables.
{
  const chain: ChainText = {
    cadres: ['a'],
    lettrine: true,
    paragraphs: [
      { id: 'p1', heading: null, text: 'Un deux trois' },
      { id: 'p2', heading: 'Titre', text: 'quatre cinq' },
      { id: 'p3', heading: null, text: 'six «\u00a0sept\u00a0» 12\u202fkg' },
    ],
  };
  const tokens = chainTokens(chain);
  check('flux : un jeton par intertitre et par mot', tokens.length === 3 + 1 + 2 + 3 && tokens[3]!.k === 'h', tokens);
  check('flux : une espace insécable garde ses voisins', tokens.some((t) => t.t === '«\u00a0sept\u00a0»') && tokens.some((t) => t.t === '12\u202fkg'));
  const all = boxMarkup(chain, 0, tokens.length);
  check('flux : lettrine sur le premier paragraphe', /^<p class="lettrine" data-para="p1">Un deux trois<\/p>/.test(all), all);
  check('flux : intertitre puis son texte, sans retrait', all.includes('<h3 class="intertitre" data-para="p2">Titre</h3><p data-para="p2">quatre cinq</p>'), all);
  check('flux : retrait d’un paragraphe sans intertitre', all.includes('<p class="retrait" data-para="p3">'), all);
  const next = boxMarkup(chain, 3, tokens.length);
  check('flux : intertitre en tête de boîte, sans espace au-dessus', next.startsWith('<h3 class="intertitre tete"'), next);
  const cont = boxMarkup(chain, 1, 3);
  check('flux : suite d’un paragraphe coupé, sans retrait ni lettrine', cont === '<p data-para="p1">deux trois</p>', cont);
  check('flux : texte échappé', boxMarkup({ ...chain, paragraphs: [{ id: 'p1', heading: '<b>', text: 'a<b' }] }, 0, 2).includes('&lt;b&gt;</h3><p') && boxMarkup({ ...chain, paragraphs: [{ id: 'p1', heading: null, text: 'a<b' }] }, 0, 1).includes('a&lt;b'));
  check('flux : remplissage à la longueur de chaque paragraphe et intertitre', Object.values(fillerChains(parsed())).every((c) => c.paragraphs.every((p, i) => p.text.length === 380 && (p.heading === null) === ![1, 3].includes(i) && (p.heading === null || p.heading.length === 24))));
}

// 6. Rendu en deux passes : la synthèse coupée dans Chromium, aucun mot perdu ni répété, colonnes, lettrine, intertitres, reste et C12.
{
  const dataRoot = newData();
  writeModel(dataRoot);
  const preview = templatePreview(dataRoot, BOOK_ID, '2X');
  const chain = preview.chains.corps!;
  check('aperçu : première passe sans texte dans les boîtes', !preview.html.includes('data-para=') && (preview.html.match(/class="colonne"/g) ?? []).length === 3);
  const flowed = await flowedPreview(preview);
  const boxes = boxTexts(flowed.html);
  check('rendu : trois boîtes (deux colonnes, puis une)', boxes.length === 3 && flowed.flow.corps!.ends.length === 3);
  const words = boxes.flatMap((b) => b.words);
  check('rendu : aucun mot perdu ni répété sur la chaîne', JSON.stringify(words) === JSON.stringify(chainWordsOf(chain)), { got: words.length, want: chainWordsOf(chain).length });
  check('rendu : tout tient, aucun reste', flowed.flow.corps!.rest === 0 && flowed.flow.corps!.words === words.length);
  check('rendu : chaque boîte remplie', boxes.every((b) => b.words.length > 0));
  check('rendu : aucun intertitre seul en bas d’une boîte', boxes.every((b) => !b.lastIsHeading));
  check('rendu : lettrine dans le HTML final', /<p class="lettrine" data-para="p1">/.test(flowed.html));
  check('rendu : règle de la lettrine (initial-letter: 3, police du titre, couleur du thème)', /\.chaine p\.lettrine::first-letter \{ initial-letter: 3;[^}]*font-family: 'Baloo 2'; font-weight: 700; color: #/.test(flowed.html));
  const style = readCollection(dataRoot)!.style;
  const col = (152.4 - 2 * 2 - 12 - 15 - 5) / 2;
  check('rendu : colonnes de la largeur (w − gouttière) / n', flowed.html.includes(`width:${Math.round(col * 1e4) / 1e4}mm`), col);
  check('rendu : intertitre en police lead, gras, couleur du thème', new RegExp(`\\.chaine \\.intertitre \\{ margin: 2mm 0 0; font-family:'${style.fonts.lead.pack === 'baloo-2' ? 'Baloo 2' : 'Andika'}';font-size:${style.fonts.lead.sizePt}pt;line-height:[0-9.]+; font-weight: 700; color: ${Object.values(style.palette.themes)[0]}; \\}`).test(flowed.html));
  const same = await flowedPreview(templatePreview(dataRoot, BOOK_ID, '2X'));
  check('rendu : deux passes, même HTML à chaque fois', same.html === flowed.html);
  const r = await renderFlowedPdf(preview.build, preview.chains, preview.trim);
  check('rendu : le PDF et l’aperçu ont le même HTML', r.html === flowed.html);
  check('rendu : aucun débordement mesuré', r.measures.overflows.length === 0, r.measures.overflows);
  // La lettrine est bien grande dans le rendu : sa boîte fait près de trois lignes.
  const big = r.measures.boxes.find((b) => b.zone === 'texte-g' && b.kind === 'texte');
  check('rendu : lettrine sur trois lignes (première boîte de texte haute)', big !== undefined && big.rect.bottom - big.rect.top > 10, big);
  const checks = await controlTemplate(preview);
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  check('contrôle de la synthèse : C3, C4, C6, C7, C8, C12, C17 verts', ['C3', 'C4', 'C6', 'C7', 'C8', 'C12', 'C17'].every((id) => by[id]?.level === 'ok'), checks.filter((c) => c.level !== 'ok'));
  check('rendu : PDF sans transparence', (await readPdfFacts(r.pdf)).transparency.length === 0);

  // Trop de texte : le reste après la dernière boîte est compté et C12 le dit.
  writeModel(dataRoot, '2X', { paragraphChars: 700 });
  const long = templatePreview(dataRoot, BOOK_ID, '2X');
  const lf = await flowedPreview(long);
  const lb = boxTexts(lf.html);
  const kept = lb.flatMap((b) => b.words);
  const all = chainWordsOf(long.chains.corps!);
  check('reste : les mots coupés sont le début exact de la chaîne', JSON.stringify(kept) === JSON.stringify(all.slice(0, kept.length)));
  check('reste : compté', lf.flow.corps!.rest === all.length - kept.length && lf.flow.corps!.rest > 0, lf.flow.corps);
  const lc = Object.fromEntries((await controlTemplate(long)).map((c) => [c.id, c]));
  check('C12 : reste après la dernière boîte, avec le nombre de mots', lc.C12?.level === 'erreur' && lc.C12.details.some((d) => d === `chaîne corps : ${lf.flow.corps!.rest} mots en trop après la dernière boîte`), lc.C12);

  // Intertitre jamais seul en bas : sur des hauteurs de boîte au hasard, aucune boîte ne finit sur un intertitre, et l'intertitre repoussé
  // ouvre la boîte suivante.
  let pushed = 0;
  let last = 0;
  for (let h = 30; h <= 70; h += 2) {
    const l = syntheseEd2('2X', SIX_NINE, margins(dataRoot), { paragraphChars: 260 }) as Dict;
    l.elements.find((e: Dict) => e.id === 'texte-g').h = h;
    l.elements.find((e: Dict) => e.id === 'texte-g').colonnes = 1;
    delete l.elements.find((e: Dict) => e.id === 'texte-g').gouttiereMm;
    put(dataRoot, 'collection/gabarits/2X.json', l);
    const b = boxTexts((await flowedPreview(templatePreview(dataRoot, BOOK_ID, '2X'))).html);
    if (b.some((x) => x.lastIsHeading)) last++;
    if (b.slice(1).some((x) => x.firstIsTete)) pushed++;
  }
  check('intertitre : jamais la dernière ligne d’une boîte', last === 0, last);
  check('intertitre : repoussé dans la boîte suivante, en tête', pushed > 0, pushed);

  // C12 sur la chaîne : un paragraphe ou un intertitre trop long, en dehors du reste.
  const defs = chainsOf(parsed());
  const texts = { corps: { cadres: ['texte-g'], lettrine: false, paragraphs: [{ id: 'p1', heading: null, text: fillerText(421) }, { id: 'p2', heading: fillerText(25), text: 'court' }] } };
  texts.corps.paragraphs[0]!.text = fillerText(381);
  const faults = chainFaults({ corps: { ends: [], rest: 0, words: 0 } }, texts, defs);
  check('C12 : paragraphe plus long que sa limite', faults.includes('chaîne corps, p1 : 381 caractères, 380 au plus'), faults);
  check('C12 : intertitre plus long que sa limite', faults.includes('chaîne corps, intertitre de p2 : 25 caractères, 24 au plus'), faults);
  check('C12 : une boîte vide n’est pas une faute', chainFaults({ corps: { ends: [0, 0, 0], rest: 0, words: 0 } }, {}, defs).length === 0);
  check('C13 : chaîne au texte de remplissage refusée jusqu’à ED4', c13Filler({ blocks: [], expected: [], lang: 'fr', title: 't', legend: 'l', essaiPhrases: [], essaiValues: [], fillerChains: ['corps'] }).details.includes('chaîne corps : texte de remplissage jusqu\'à ED4'));

  // Débordement d'une boîte mesuré comme aujourd'hui (`data-fill`, limite de la colonne) : toute la chaîne forcée dans la première boîte.
  writeModel(dataRoot);
  const forced = templatePreview(dataRoot, BOOK_ID, '2X');
  const n = chainTokens(forced.chains.corps!).length;
  const fm = await measureHtml(forced.build({ corps: [n, n, n] }));
  check('C12 : débordement d’une boîte mesuré à sa colonne', fm.overflows.some((o) => o.zone === 'texte-g' && o.overMm > 50), fm.overflows);

  // Sans chaîne, aucun Chromium pour l'aperçu et le HTML de toujours.
  const plain = await flowHtml(() => '<p>x</p>', {});
  check('sans chaîne : HTML tel quel, sans coupure', plain.html === '<p>x</p>' && Object.keys(plain.flow).length === 0);
}

// 7. Détouré dans un sujet : contour posé, découpe par clip-path, habillage, aucune transparence, C5, C17, Illustrations et Aperçu.
{
  const dataRoot = newData();
  writeModel(dataRoot);
  createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2X', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  const ctx0 = subjectContext(dataRoot, BOOK_ID, 'alpha', SCENES);
  check('sujet sans image : détouré sans contour, aplat dans sa boîte', !ctx0.layout[1]!.zones.find((z) => z.id === 'animal')!.outline && /<img class="zone illustration" data-zone="animal"/.test(subjectHtml(ctx0)));
  const synth = await detourePng(800, 900);
  const d = await cleanDetoure(synth);
  storeIllustration(dataRoot, BOOK_ID, 'alpha', 'animal', d.image, { contour: d.contour });
  check('rangement : contour.json à côté du PNG', fs.existsSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.contour.json')));
  const ctx = subjectContext(dataRoot, BOOK_ID, 'alpha', SCENES);
  const animal = ctx.layout[1]!.zones.find((z) => z.id === 'animal')!;
  check('sujet : contour posé sur la zone, image entière dans sa boîte', animal.outline !== undefined && animal.outline.image.top >= animal.rect.top - 1e-9 && animal.outline.image.bottom <= animal.rect.bottom + 1e-9);
  const { build, content } = subjectBuilder(ctx);
  const r = await renderFlowedPdf(build, content.chains!, ctx.trim);
  check('rendu : image découpée par clip-path: polygon', /data-zone="animal"[^>]*><img src="data:image\/png;base64,[^"]+" alt="" style="[^"]*clip-path:polygon\(/.test(r.html));
  check('rendu : ni masque ni opacité sur le détouré', !/mask|opacity/.test(r.html.slice(r.html.indexOf('data-zone="animal"'), r.html.indexOf('data-zone="animal"') + 400)));
  const facts = await readPdfFacts(r.pdf);
  check('PDF : aucune transparence (relecture par pdf-lib)', facts.transparency.length === 0, facts.transparency);
  const imgs = await pdfImages(r.pdf);
  check('PDF : l’image du détouré, sans masque doux', imgs.count >= 1 && imgs.smask === 0, imgs);
  check('C6 : aucune faute mesurée (clip-path n’en est pas une)', r.measures.faults.length === 0, r.measures.faults);
  // Témoin : le même PNG avec alpha posé tel quel donne un /SMask, ce que C6 refuse.
  const witness = `<!doctype html><html><head><style>@page { size: 6.125in 9.25in; margin: 0 }</style></head><body><img src="data:image/png;base64,${synth.toString('base64')}" style="width:80mm"></body></html>`;
  const wr = await renderPdf(witness, { widthIn: 6, heightIn: 9 });
  check('témoin : PNG avec alpha posé tel quel, transparence relevée', (await readPdfFacts(wr.pdf)).transparency.length > 0 || (await pdfImages(wr.pdf)).smask > 0);
  // Lignes de texte hors du contour : aucune ligne de la colonne ne touche la silhouette.
  const lines = await lineRects(r.html);
  const inShape = linesInShape(lines, ctx.layout[1]!.number, animal.outline!.points);
  check('habillage : aucune ligne de texte sur le contour', inShape.length === 0, inShape.slice(0, 3));
  const near = lines.filter((l) => l.page === ctx.layout[1]!.number && l.bottom > animal.outline!.image.top + 5 && l.top < animal.outline!.image.bottom - 5);
  check('habillage : du texte passe à côté de la silhouette', near.length > 3, near.length);
  check('habillage : flottant avec shape-outside et shape-margin de 2 mm', /<span class="habillage" style="float:right;clear:right;[^"]*shape-outside:polygon\([^"]+\);shape-margin:2mm"><\/span>/.test(r.html) && SHAPE_MARGIN_MM === 2);
  check('habillage : seulement dans la boîte croisée', (r.html.match(/class="habillage"/g) ?? []).length === 1);
  const sb = boxTexts(r.html);
  check('sujet : aucun mot perdu ni répété avec l’habillage', JSON.stringify(sb.flatMap((b) => b.words)) === JSON.stringify(chainWordsOf(content.chains!.corps!)) || r.html.includes('data-boite="2"'));
  // Habillage à droite : le texte passe à droite, le flottant est à gauche.
  const leftFloat = wrapFloats({ left: 0, top: 0, right: 100, bottom: 100 }, [{ side: 'droite', points: [[10, 20], [30, 20], [30, 40]], bounds: { left: 10, top: 20, right: 30, bottom: 40 } }] as never);
  check('habillage droite : flottant à gauche, du bord gauche de la boîte au contour plus la marge', leftFloat.includes('float:left;clear:left;width:32mm;height:42mm'), leftFloat);
  check('habillage : rien sans détouré qui croise la boîte', wrapFloats({ left: 0, top: 0, right: 100, bottom: 100 }, [{ side: 'gauche', points: [[110, 20], [130, 20], [130, 40]], bounds: { left: 110, top: 20, right: 130, bottom: 40 } }] as never) === '');
  // Sujet : C5, Illustrations, Aperçu.
  const zones = zoneImages(ctx);
  const z = zones.find((x) => x.zone === 'animal')!;
  check('C5 : image entière dans sa boîte (contain)', z.detoure && z.ppi === containPpi({ width: 800, height: 900 }, z.size) && z.crop === null, z);
  check('C5 : sous 300 ppp, erreur', c5Resolution([{ zone: 'animal', image: { width: 400, height: 450 }, size: z.size, framing: { focusX: 0.5, focusY: 0.5, zoom: 1 }, contain: true }]).level === 'erreur');
  // Une image trois fois plus large que haute dans une boîte carrée de 3" : entière, 300 ppp ; cadrée comme un rectangle, 100 ppp.
  const wide = { zone: 'animal', image: { width: 900, height: 300 }, size: { widthMm: 76.2, heightMm: 76.2 }, framing: { focusX: 0.5, focusY: 0.5, zoom: 1 } };
  check('C5 : détouré mesuré sur l’image entière, pas sur un cadrage', c5Resolution([{ ...wide, contain: true }]).level === 'ok' && c5Resolution([wide]).level === 'erreur');
  const control = await controlSubject(ctx, null);
  const c = Object.fromEntries(control.map((x) => [x.id, x]));
  check('sujet : C13 refuse la chaîne au texte de remplissage', c.C13?.level === 'erreur' && c.C13.details.includes('chaîne corps : texte de remplissage jusqu\'à ED4'), c.C13);
  check('sujet : C12 de la chaîne vert au remplissage maximal', c.C12?.level === 'ok' || !c.C12?.details.some((x) => x.startsWith('chaîne')), c.C12);
  const page = await subjectPage(ctx);
  check('sujet : aperçu coupé, même HTML que le PDF', page.html === r.html);
}

// 8. C17 : détouré avec habillage sur un cadre de texte permis ; contour plutôt que boîte ; habillage aucun refusé.
{
  const zone = (id: string, type: string, rect: [number, number, number, number], extra: Partial<LayoutZone> = {}): LayoutZone => ({ id, type: type as never, rect: { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }, bleedEdges: [], constraints: undefined, ...extra });
  const texte = zone('texte', 'texte', [0, 0, 100, 100]);
  const chapeau = zone('chapeau', 'chapeau', [0, 0, 100, 100]);
  const det = (habillage: 'gauche' | 'droite' | 'aucun', outline?: LayoutZone['outline']) => zone('animal', 'illustration', [50, 20, 90, 60], { detoure: true, habillage, outline });
  check('C17 : détouré avec habillage sur un cadre de texte, permis', overlapFault(texte, det('gauche')) === null && overlapFault(texte, det('droite')) === null);
  check('C17 : détouré sans habillage sur un cadre de texte, interdit', overlapFault(texte, det('aucun'))?.includes('une illustration sur un élément à texte') === true);
  check('C17 : détouré avec habillage sur un autre élément à texte, interdit', overlapFault(chapeau, det('gauche'))?.includes('une illustration sur un élément à texte') === true);
  const tri = { image: { left: 50, top: 20, right: 90, bottom: 60 }, points: [[50, 20], [60, 20], [50, 30]] as [number, number][], percent: [] };
  const page = (zones: LayoutZone[]): LayoutPage[] => [{ number: 7, side: 'droite', widthMm: 155, heightMm: 235, trim: { left: 0, top: 0, right: 152, bottom: 229 }, safe: { left: 15, top: 15, right: 140, bottom: 217 }, foldMm: 0, zones }];
  const encadre = zone('capsule', 'encadre', [75, 45, 95, 65], { encadre: 'savais-tu' });
  check('C17 : contour qui ne touche pas l’encadré, permis (sous lui)', overlapFaults(page([det('aucun', tri), encadre])).length === 0);
  check('C17 : sans contour, la boîte du détouré compte', overlapFaults(page([encadre, det('aucun')])).length === 1);
  check('C17 : contour qui couvre l’encadré, interdit', overlapFaults(page([encadre, det('aucun', { ...tri, points: [[50, 20], [90, 20], [90, 60], [50, 60]] })])).length === 1);
  check('C17 : contour qui ne fait que toucher, permis', overlapFaults(page([zone('capsule', 'encadre', [60, 20, 95, 65], { encadre: 'savais-tu' }), det('aucun', { ...tri, points: [[50, 20], [60, 20], [60, 30], [50, 30]] })])).length === 0);
}

// 9. Droit image-externe.
{
  check('droits : image-externe est un type du registre', (RIGHTS_KINDS as readonly string[]).includes('image-externe'));
  check('droits : image-externe se rattache à une illustration', ILLUSTRATION_KINDS.includes('image-externe'));
  check('droits : entrée image-externe valide (auteur, licence, URL, crédit, usage commercial)', rightsEntrySchema.safeParse({ id: 'carte-pangee', kind: 'image-externe', name: 'Carte', author: 'Auteur', license: 'CC BY 4.0', url: 'https://exemple.org/carte', credit: 'Carte : Auteur, CC BY 4.0', commercialOk: 'oui' }).success);
}

// 10. Routes et parcours : dépôt d'un détouré (refus, contour.json), image-externe rattachée, C11 inchangé, Illustrations, aperçus coupés.
{
  const glbRoot = makeGlbi();
  const parent = tempDir();
  const dataRoot = path.join(parent, 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  createCollection(dataRoot);
  writeModel(dataRoot);
  createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2X', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  put(parent, 'config.local.json', { glbRoot, dataRoot });
  const server = createPrintServer(path.join(parent, 'config.local.json'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  const json = { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
  const request = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path, headers: opts.headers ?? json }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (opts.body !== undefined) req.write(Buffer.isBuffer(opts.body) ? opts.body : JSON.stringify(opts.body));
      req.end();
    });
  const deposit = (zone: string, bytes: Buffer, confirm = false) =>
    request({ path: `/api/sujet/illustration?dir=${BOOK_DIR}&subject=alpha&zone=${zone}${confirm ? '&confirm=1' : ''}`, headers: { ...json, 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) }, body: bytes });
  const steps = () => {
    const p = computeParcours(readFacts({ ok: true, config: { glbRoot, dataRoot } } as never, BOOK_DIR) as never, STEPS);
    return p.subjects.find((s: Dict) => s.id === 'alpha')!.steps as Dict[];
  };
  void steps;
  const { rgb } = await opaquePngs();
  const refused = await deposit('animal', rgb);
  check('route : dépôt d’un PNG sans alpha sur un détouré, refusé', refused.status === 409 && refused.body.includes('rien à détourer'), refused);
  check('route : rien d’écrit après un refus', !fs.existsSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.png')));
  const ok = await deposit('animal', await detourePng(800, 900));
  const body = JSON.parse(ok.body);
  check('route : dépôt d’un détouré, PNG et contour.json écrits', ok.status === 200 && body.deposited && fs.existsSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.contour.json')), ok.status);
  const az = body.zones.find((x: Dict) => x.zone === 'animal');
  check('route : la zone dit détouré, sans cadrage, avec la partie détachée', az.detoure === true && az.crop === null && az.parts.length === 1, az);
  const stored = fs.readFileSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.png'));
  check('route : PNG gardé en IHDR IDAT IEND, empreinte dans contour.json', pngChunks(stored).every((c) => ['IHDR', 'IDAT', 'IEND'].includes(c)) && JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.contour.json'), 'utf8')).empreinte === sha256(stored));
  // Parcours, étape Illustrations du sujet : alerte pour la partie détachée.
  const facts = readFacts({ ok: true, config: { glbRoot, dataRoot } } as never, BOOK_DIR) as Dict;
  const subjectFacts = facts.subjects?.find((s: Dict) => s.id === 'alpha') ?? facts.sujets?.find?.((s: Dict) => s.id === 'alpha');
  check('parcours : partie détachée en alerte dans Illustrations', JSON.stringify(subjectFacts?.illustrations?.alerts ?? []).includes('animal : partie détachée de'), subjectFacts?.illustrations);
  // PNG remplacé à la main : erreur, redéposer.
  const copy = Buffer.from(stored);
  fs.writeFileSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.png'), (await cleanPng(await detourePng(800, 901))).png);
  const changed = readFacts({ ok: true, config: { glbRoot, dataRoot } } as never, BOOK_DIR) as Dict;
  const cf = changed.subjects?.find((s: Dict) => s.id === 'alpha');
  check('parcours : contour qui ne correspond plus, Illustrations en erreur', JSON.stringify(cf?.illustrations?.errors ?? []).includes('ne correspond plus'), cf?.illustrations);
  fs.writeFileSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.png'), copy);
  fs.rmSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'animal.contour.json'));
  const gone = readFacts({ ok: true, config: { glbRoot, dataRoot } } as never, BOOK_DIR) as Dict;
  check('parcours : contour absent, Illustrations en erreur', JSON.stringify(gone.subjects?.find((s: Dict) => s.id === 'alpha')?.illustrations?.errors ?? []).includes('contour absent'));
  check('sujet : sans contour valide, l’aplat (pas le fond blanc)', !subjectContour(dataRoot, BOOK_ID, 'alpha', 'animal') || subjectHtml(subjectContext(dataRoot, BOOK_ID, 'alpha', SCENES)).includes('image/svg+xml'));
  await deposit('animal', await detourePng(800, 900), true);
  // image-externe : ajoutée au registre du livre, rattachée à l'illustration ; C11 inchangé (modèle d'IA toujours exigé).
  const reg = path.join(dataRoot, BOOK_ID, 'rights.json');
  const rights = JSON.parse(fs.readFileSync(reg, 'utf8'));
  rights.entries.push({ id: 'carte-test', kind: 'image-externe', name: 'Carte de test', author: 'Auteur', license: 'CC BY 4.0', url: 'https://exemple.org', credit: 'Carte : Auteur', commercialOk: 'oui' });
  fs.writeFileSync(reg, JSON.stringify(rights, null, 2));
  const linked = await request({ path: '/api/sujet/droits-image', body: { dir: BOOK_DIR, subjectId: 'alpha', zone: 'animal', rights: ['carte-test'] } });
  const lb = JSON.parse(linked.body);
  check('route : image-externe proposée et rattachée à l’illustration', linked.status === 200 && lb.entries.some((e: Dict) => e.id === 'carte-test') && lb.zones.find((x: Dict) => x.zone === 'animal').rights.includes('carte-test'), linked.status);
  const c11 = lb.checks.find((c: Dict) => c.id === 'C11');
  check('C11 inchangé : image-externe seule, modèle d’IA toujours exigé', c11.level === 'erreur' && c11.details.some((d: string) => d.includes('aucun modèle d\'IA')), c11);
  // Aperçus coupés par les routes.
  const ap = await request({ method: 'GET', path: `/apercu-gabarit?bookId=${BOOK_ID}&id=2X` });
  check('route : aperçu d’un modèle à chaîne, texte coupé', ap.status === 200 && ap.body.includes('data-para="p1"') && ap.body.includes('class="lettrine"'));
  const ms = await request({ method: 'GET', path: `/apercu-mise-en-page?dir=${BOOK_DIR}&subject=alpha` });
  check('route : aperçu de la mise en page du sujet, texte coupé', ms.status === 200 && ms.body.includes('data-para="p1"'));
  const sj = await request({ method: 'GET', path: `/apercu-sujet?dir=${BOOK_DIR}&subject=alpha` });
  check('route : aperçu du sujet, texte coupé et image découpée', sj.status === 200 && sj.body.includes('data-para="p1"') && sj.body.includes('clip-path:polygon('));
  const ctl = JSON.parse((await request({ path: '/api/gabarits/controle', body: { bookId: BOOK_ID, id: '2X' } })).body);
  check('route : contrôle du modèle à chaîne', ctl.checks?.find((c: Dict) => c.id === 'C12')?.level === 'ok', ctl);
  const mark = JSON.parse((await request({ path: '/api/sujet/check', body: { dir: BOOK_DIR, subjectId: 'alpha', mark: true } })).body);
  check('Aperçu : sujet à chaîne non marqué relu avant ED4 (C13)', mark.marked === false && String(mark.reason).includes('C13'), mark.reason);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

finish('texte et détourés');
