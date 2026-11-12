// scripts/test-gabarits.ts — gabarits en fichiers (GB1) : lecture et refus, copie sans écrasement, identité du HTML de 2A avec la base,
// rendu et mesures des cinq types, sujets sous un gabarit modifié, absent ou invalide, étape Gabarits, routes. Tout est synthétique.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { readPdfFacts } from '../src/checks/pdf-facts';
import { runChecks } from '../src/checks/rules';
import { createCollection, readCollection, CollectionRefused } from '../src/data/collection';
import { createBookFolder, CreateRefused } from '../src/data/create-book';
import { cleanPng, storeIllustration } from '../src/data/illustration-store';
import { createSubject, SubjectRefused, updateSubject } from '../src/data/subject-file';
import { readFacts } from '../src/parcours/facts';
import { computeParcours, STEPS, type ParcoursFacts } from '../src/parcours/steps';
import { buildEssai, packFonts } from './fixtures/essai-2a';
import { controlTemplate, fillerText, templatePreview } from '../src/render/gabarit';
import { RenderRefused, renderHtml } from '../src/render/html';
import { measureHtml, renderPdf } from '../src/render/pdf';
import { subjectContext, subjectHtml } from '../src/render/subject';
import { blocksGap, expectedBlocks } from '../src/research/blocks';
import { mergeImport } from '../src/research/import';
import type { ResearchImport } from '../src/schema/research';
import { createPrintServer } from '../src/server/app';
import { addDeliveredTemplates, deliveredNames, readTemplates, templateOf, templateStyleFaults, validTemplates } from '../src/templates/files';
import { layoutTemplate } from '../src/templates/geometry';
import { templateSchema, type Template } from '../src/templates/model';
import { fiveTypes, TEMPLATE_2A } from './fixtures/gabarits';
import { BOOK_DIR, BOOK_ID, dirLink, fileLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng } from './fixtures/make-png';
import { makeResearch } from './fixtures/recherche';
import { check, finish } from './test-lib';

type Dict = Record<string, any>;
const SIX_NINE = { widthIn: 6, heightIn: 9 };
const DELIVERED = path.join(import.meta.dirname, '..', 'src', 'templates', 'defaults', 'gabarits');
const expectThrows = (name: string, fn: () => unknown, kind: new (...a: never[]) => Error, text: string) => {
  try {
    fn();
    check(name, false);
  } catch (e) {
    check(name, e instanceof kind && e.message.includes(text), (e as Error).message);
  }
};
const newData = () => {
  const dataRoot = path.join(tempDir(), 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  return dataRoot;
};
const gabarit = (dataRoot: string, name: string) => path.join(dataRoot, 'collection', 'gabarits', name);

// Gabarits livrés et copie sans écrasement
{
  check('livrés : 2A seul, valide au schéma', deliveredNames().join() === '2A.json' && templateSchema.safeParse(JSON.parse(fs.readFileSync(path.join(DELIVERED, '2A.json'), 'utf8'))).success);
  check('2A livré : l’ancien fichier du code a disparu', !fs.existsSync(path.join(import.meta.dirname, '..', 'src', 'templates', '2A.ts')));
  const dataRoot = newData();
  check('sans collection : aucun gabarit, rien de refusé', (() => {
    const l = readTemplates(dataRoot, null);
    return !l.present && l.error === null && l.entries.length === 0;
  })());
  expectThrows('Ajouter les gabarits livrés : collection/ exigé', () => addDeliveredTemplates(dataRoot), CollectionRefused, 'collection/ absent');
  const first = createCollection(dataRoot);
  const delivered = fs.readFileSync(path.join(DELIVERED, '2A.json'));
  check('création de la collection : 2A copié octet pour octet', first.created.includes('collection/gabarits/2A.json') && fs.readFileSync(gabarit(dataRoot, '2A.json')).equals(delivered), first);
  fs.writeFileSync(gabarit(dataRoot, '2A.json'), '{ "modifié": true }');
  const second = createCollection(dataRoot);
  check('création relancée : 2A modifié conservé', second.kept.includes('collection/gabarits/2A.json') && fs.readFileSync(gabarit(dataRoot, '2A.json'), 'utf8') === '{ "modifié": true }');
  const added = addDeliveredTemplates(dataRoot);
  check('Ajouter : un fichier présent, même invalide, n’est jamais écrasé', added.created.length === 0 && added.kept.includes('collection/gabarits/2A.json') && fs.readFileSync(gabarit(dataRoot, '2A.json'), 'utf8') === '{ "modifié": true }', added);
  fs.rmSync(gabarit(dataRoot, '2A.json'));
  const again = addDeliveredTemplates(dataRoot);
  check('Ajouter : un fichier absent est écrit', again.created.join() === 'collection/gabarits/2A.json' && fs.readFileSync(gabarit(dataRoot, '2A.json')).equals(delivered), again);
  const before = fs.statSync(gabarit(dataRoot, '2A.json')).mtimeMs;
  const third = addDeliveredTemplates(dataRoot);
  check('Ajouter une seconde fois : rien d’écrit', third.created.length === 0 && fs.statSync(gabarit(dataRoot, '2A.json')).mtimeMs === before);
  fs.rmSync(path.join(dataRoot, 'collection', 'gabarits'), { recursive: true });
  dirLink(tempDir(), path.join(dataRoot, 'collection', 'gabarits'));
  expectThrows('Ajouter : collection/gabarits/ en lien, refusé', () => addDeliveredTemplates(dataRoot), CreateRefused, 'dossier réel');
  const linked = readTemplates(dataRoot, null);
  check('lecture : collection/gabarits/ en lien, refusé sans rien lire', linked.error !== null && linked.error.includes('dossier réel') && linked.entries.length === 0, linked);
  check('lecture : le refus du dossier devient l’erreur du gabarit', 'error' in templateOf(linked, '2A'));
}

// Lecture et refus
{
  const dataRoot = newData();
  createCollection(dataRoot);
  const style = readCollection(dataRoot)!.style;
  const write = (name: string, value: unknown) => put(dataRoot, `collection/gabarits/${name}`, value as Dict);
  const twoB = { ...structuredClone(TEMPLATE_2A), id: '2B' };
  write('2B.json', twoB);
  write('12A.json', { ...structuredClone(TEMPLATE_2A), id: '12A', pages: 12, sheets: Array.from({ length: 12 }, (_, i) => (i === 11 ? TEMPLATE_2A.sheets[1] : { zones: [] })) });
  write('4A.json', '{');
  write('2C.json', { ...twoB, id: '2C', start: 'milieu' });
  write('2D.json', { ...twoB, id: '2E' });
  // Casse : un nom sans conflit avec 2A.json, qu'un système de fichiers insensible à la casse (Windows) confondrait.
  write('2k.json', { ...twoB, id: '2K' });
  write('notes.txt', 'à ignorer');
  write('2F.json', fiveTypes('2F'));
  const badStyle = fiveTypes('2G');
  badStyle.sheets[0]!.zones[3] = { ...badStyle.sheets[0]!.zones[3], picto: 'inconnu' } as never;
  (badStyle.sheets[0]!.zones[4] as Dict).encadre = 'pas-de-couleur';
  write('2G.json', badStyle);
  const linkedOk = fileLink(gabarit(dataRoot, '2B.json'), gabarit(dataRoot, '2H.json'));
  const before = Object.fromEntries(fs.readdirSync(path.join(dataRoot, 'collection', 'gabarits')).map((n) => [n, fs.readFileSync(gabarit(dataRoot, n), 'utf8')]));
  const lib = readTemplates(dataRoot, style);
  const entry = (id: string) => lib.entries.find((e) => e.id === id);
  check('lecture : ordre par pages puis par lettre', lib.entries.map((e) => e.id).filter((id) => ['2A', '2B', '4A', '12A'].includes(id)).join() === '2A,2B,4A,12A', lib.entries.map((e) => e.id));
  check('lecture : fichier autre que .json ignoré', !lib.entries.some((e) => e.id.startsWith('notes')));
  check('lecture : 2A, 2B, 12A et le gabarit aux cinq types valides', ['2A', '2B', '12A', '2F'].every((id) => entry(id)?.template && entry(id)?.error === null), lib.entries);
  check('refus : JSON invalide', entry('4A')?.template === null && entry('4A')!.error!.includes('JSON invalide'));
  check('refus : schéma, champ nommé', entry('2C')!.error!.includes('start'), entry('2C'));
  check('refus : identifiant différent du nom', entry('2D')?.error?.includes('2E.json') === true, entry('2D'));
  check('refus : casse du nom différente de l’identifiant', entry('2k')?.error?.includes('2K.json') === true, entry('2k'));
  check('refus : pictogramme et couleur d’encadré inconnus du style, nommés', entry('2G')?.error?.includes('inconnu') === true && entry('2G')?.error?.includes('pas-de-couleur') === true, entry('2G'));
  if (linkedOk) check('refus : gabarit en lien de fichier', entry('2H')!.error === 'n\'est pas un fichier réel', entry('2H'));
  check('gabarits valides seuls', Object.keys(validTemplates(lib)).sort().join() === ['12A', '2A', '2B', '2F'].sort().join());
  check('gabarit invalide : jamais réécrit', fs.readdirSync(path.join(dataRoot, 'collection', 'gabarits')).every((n) => fs.readFileSync(gabarit(dataRoot, n), 'utf8') === before[n]));
  const absent = templateOf(lib, '6A');
  const invalid = templateOf(lib, '4A');
  check('gabarit d’un sujet : absent, nommé', 'error' in absent && absent.error.includes('Gabarit 6A absent'));
  check('gabarit d’un sujet : invalide, nommé avec son erreur', 'error' in invalid && invalid.error.includes('Gabarit 4A invalide') && invalid.error.includes('JSON'));
  check('sans style : seul le schéma est vérifié', readTemplates(dataRoot, null).entries.find((e) => e.id === '2G')?.template !== null);
  check('BOM accepté', (() => {
    write('2J.json', `﻿${JSON.stringify({ ...twoB, id: '2J' })}`);
    return readTemplates(dataRoot, style).entries.find((e) => e.id === '2J')?.error === null;
  })());
}

// Schéma : champs propres aux cinq types et refus ajoutés par GB1
{
  const base = () => fiveTypes('2F') as Dict;
  const zoneOf = (t: Dict, id: string) => t.sheets.flatMap((s: Dict) => s.zones).find((z: Dict) => z.id === id);
  const refused = (name: string, change: (t: Dict) => void, text: string) => {
    const t = base();
    change(t);
    const r = templateSchema.safeParse(t);
    check(`schéma refusé : ${name}`, !r.success && r.error.issues.some((i) => i.message.includes(text)), r.success ? t : r.error.issues);
  };
  check('schéma : gabarit aux cinq types admis', templateSchema.safeParse(base()).success, templateSchema.safeParse(base()).error?.issues);
  refused('encadré sans couleur', (t) => { delete zoneOf(t, 'savais-tu').encadre; }, 'encadre attendu');
  refused('pictogramme sans nom', (t) => { delete zoneOf(t, 'picto').picto; }, 'picto attendu');
  refused('couleur d’encadré sur une zone texte', (t) => { zoneOf(t, 'titre').encadre = 'fiche'; }, 'encadre réservé aux zones encadre');
  refused('titre d’encadré sur une autre zone', (t) => { zoneOf(t, 'legende').heading = { fr: 'a', en: 'a', es: 'a' }; }, 'heading réservé aux zones encadre');
  refused('pictogramme sur une autre zone', (t) => { zoneOf(t, 'etiquette').picto = 'taille'; }, 'picto réservé aux zones picto');
  refused('corps sur une autre zone que le chiffre-clé', (t) => { zoneOf(t, 'titre').sizePt = 20; }, 'sizePt réservé aux zones chiffre-cle');
  refused('corps du chiffre-clé sous 7 pt', (t) => { zoneOf(t, 'chiffre').sizePt = 6; }, '7 pt au moins');
  refused('titre d’encadré vide', (t) => { zoneOf(t, 'savais-tu').heading.es = ' '; }, 'titre de l\'encadré vide');
  refused('titre d’encadré sans une langue', (t) => { delete zoneOf(t, 'savais-tu').heading.en; }, '');
  refused('couleur d’encadré au mauvais format', (t) => { zoneOf(t, 'savais-tu').encadre = 'Savais Tu'; }, 'identifiant');
  for (const id of ['titre', 'chiffre', 'savais-tu', 'legende', 'etiquette']) refused(`${zoneOf(base(), id).type} sans maxChars`, (t) => { delete zoneOf(t, id).constraints; }, 'constraints.maxChars attendu');
  for (const type of ['chapeau', 'texte']) refused(`${type} sans maxChars`, (t) => { Object.assign(zoneOf(t, 'legende'), { type }); delete zoneOf(t, 'legende').constraints; }, 'constraints.maxChars attendu');
  check('schéma : le folio, le fond, l’illustration, le picto se passent de maxChars', templateSchema.safeParse(base()).success && ['bandeau', 'illustration', 'picto', 'folio-g'].every((id) => zoneOf(base(), id).constraints === undefined));
  check('2A garde ses limites', TEMPLATE_2A.sheets.flatMap((s) => s.zones).filter((z) => ['titre', 'chapeau', 'texte'].includes(z.type)).every((z) => z.constraints?.maxChars !== undefined));
  const style = { palette: { boxes: { fiche: '#ffffff', 'savais-tu': '#ffffff' } }, pictos: { taille: { file: 'taille.svg', rights: 'x' } } } as never;
  check('style : un gabarit connu du style n’a aucune faute', templateStyleFaults(templateSchema.parse(base()), style).length === 0);
  const unknown = base();
  zoneOf(unknown, 'picto').picto = 'constructor';
  zoneOf(unknown, 'savais-tu').encadre = 'constructor';
  check('style : un nom de prototype n’est pas une clé du style', templateStyleFaults(templateSchema.parse(unknown), style).length === 2);
}

// Identité de 2A : HTML de la base (9a240a2), relevé avant le lot, à l’octet près. Les images sont comparées par leurs pixels, filtres PNG
// retirés : un autre zlib ou un autre choix de filtres (autre processeur, autre système) ne change pas l’image. Les fins de ligne sont
// ramenées à LF (Git sous Windows).
function pngPixels(buf: Buffer): Buffer {
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let depth = 8;
  let color = 2;
  for (let o = 8; o + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (type === 'IHDR') [width, height, depth, color] = [buf.readUInt32BE(o + 8), buf.readUInt32BE(o + 12), buf[o + 16]!, buf[o + 17]!];
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const bpp = Math.max(1, (channels * depth) / 8);
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = up ? up[x]! : 0;
      const c = up && x >= bpp ? up[x - bpp]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
      row[x] = (src[x]! + pred) & 255;
    }
  }
  return Buffer.concat([Buffer.from(`${width}x${height}x${depth}x${color}:`), out]);
}
{
  const BASE: Record<string, string> = {
    'essai-6x9-foret': '4dfc904daf9f0c0172e8f223bdf4c662f63a9307271f4ca269b8d1f7bc0c694a',
    'essai-6x9-ocean': 'e6ca3be98ed6618d14d31fa90a90ba3421989a918ebbfbec17284a718852b890',
    'essai-6x9-volcan': 'e72fa5b4d65feed5ec8e894ffb3112cc92515674f6644682d80030e5bf8a4278',
    'essai-6x9-savane': '3dce7d76babe3048fb6278d54aed9f1def144a10b469b2ad6450a8dd98270057',
    'essai-6x9-crepuscule': '285083e6096d439e316558af5497e493c4d315400474aea20e04fd7f9319b9ba',
    'essai-8.5x11-foret': '9a0d0ea60fe31ac91bb60124e2b52795486a423ab6cabab7f22becf5011f05a6',
    'sujet-sans-image': 'd7946f6f8e7e239d276a8c8e343f113233c94d62fdc3f87863064f05ec2ae006',
    'sujet-avec-image': 'dc7a24b0c2c64b9d09fc4a360ac1251535ff552b43bb895b58f993666d8297b0',
  };
  const stable = (html: string) => html.replace(/\r\n/g, '\n').replace(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g, (_m, b64: string) => `png:${crypto.createHash('sha256').update(pngPixels(Buffer.from(b64, 'base64'))).digest('hex')}`);
  const hash = (html: string) => crypto.createHash('sha256').update(stable(html)).digest('hex');
  const dataRoot = newData();
  createCollection(dataRoot);
  const read = readCollection(dataRoot)!;
  const found = templateOf(readTemplates(dataRoot, read.style), '2A');
  const two = 'template' in found ? found.template : TEMPLATE_2A;
  const got: Record<string, string> = {};
  for (const theme of Object.keys(read.style.palette.themes)) got[`essai-6x9-${theme}`] = hash(buildEssai(SIX_NINE, read, theme, two).html);
  got['essai-8.5x11-foret'] = hash(buildEssai({ widthIn: 8.5, heightIn: 11 }, read, 'foret', two).html);
  const scenes = [{ rank: 1, id: 'alpha', title: { fr: 'Alpha fr', en: 'Alpha en', es: 'Alpha es' }, modelCredits: [], qr: null }];
  const subject = createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha'], ['foret']);
  const merged = mergeImport(makeResearch(), null, subject, expectedBlocks(two, read.style.fiche, 'fr'));
  updateSubject(dataRoot, BOOK_ID, 'alpha', () => ({ subject: merged.subject, research: merged.research }));
  // ED6 : le tampon du faux QR dit « QR absent » au lieu de « FACTICE » ; le reste du HTML est celui de la base, octet pour octet.
  const asBase = (html: string) => html.replace('>QR absent<', '>FACTICE<');
  got['sujet-sans-image'] = hash(asBase(subjectHtml(subjectContext(dataRoot, BOOK_ID, 'alpha', scenes))));
  storeIllustration(dataRoot, BOOK_ID, 'alpha', 'illustration', await cleanPng(makePng(420, 640, 3, (x, y) => [(x * 3) % 256, (y * 5) % 256, (x + y) % 256])));
  updateSubject(dataRoot, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, illustrations: d.subject.illustrations.map((i) => ({ ...i, framing: { focusX: 0.3, focusY: 0.6, zoom: 1.4 } })) } }));
  got['sujet-avec-image'] = hash(asBase(subjectHtml(subjectContext(dataRoot, BOOK_ID, 'alpha', scenes))));
  for (const [name, want] of Object.entries(BASE)) check(`identité de 2A : ${name}, HTML de la base`, got[name] === want, got[name]);
  check('identité de 2A : 2A de la collection égal au 2A livré', JSON.stringify(two) === JSON.stringify(TEMPLATE_2A));
  const html = buildEssai(SIX_NINE, read, 'foret', two).html;
  check('identité de 2A : aucune règle des cinq types écrite', !/\.encadre|\.chiffre-cle|\.legende|\.picto|\.etiquette/.test(html));
}

// Rendu et mesures des cinq types
{
  const dataRoot = newData();
  createCollection(dataRoot);
  put(dataRoot, 'collection/gabarits/2Z.json', fiveTypes());
  const preview = templatePreview(dataRoot, BOOK_ID, '2Z');
  const { html } = preview;
  const read = readCollection(dataRoot)!;
  check('encadré : couleur de palette.boxes, titre dans la langue', html.includes('class="zone encadre encadre-savais-tu"') && html.includes(`.encadre-savais-tu { background: ${read.style.palette.boxes['savais-tu']}; }`) && html.includes('<b class="entete">Le savais-tu ?</b>'));
  check('encadré : seule la couleur utilisée est écrite', !html.includes('.encadre-a-cote-de-toi') && !html.includes('.encadre-fiche'));
  check('chiffre-clé : corps de la zone', html.includes('data-zone="chiffre" data-type="chiffre-cle"') && html.includes(';font-size:40pt"'));
  check('pictogramme : SVG de la collection inséré tel quel', html.includes('data-zone="picto"') && html.includes(read.pictos.taille!.trim().slice(0, 40)));
  check('légende et étiquette : texte de remplissage à la longueur maximale', html.includes(`<span data-fill>${fillerText(90)}</span>`) && html.includes(`<span data-fill>${fillerText(20)}</span>`));
  check('remplissage : longueur exacte, sans espace finale', fillerText(53).length === 53 && !fillerText(53).endsWith(' ') && fillerText(5) === 'Texte');
  const { pdf, measures } = await renderPdf(html, SIX_NINE);
  const facts = await readPdfFacts(pdf);
  const checks = Object.fromEntries(runChecks({ facts, measures, pages: preview.layout, pack: packFonts() }).map((c) => [c.id, c]));
  check('cinq types : C3, C4, C6, C7, C8 verts', ['C3', 'C4', 'C6', 'C7', 'C8'].every((id) => checks[id]!.level === 'ok'), checks);
  check('cinq types : aucun débordement à la longueur maximale', measures.overflows.length === 0, measures.overflows);
  check('cinq types : textes mesurés dans chaque zone', ['savais-tu', 'chiffre', 'legende', 'etiquette'].every((z) => measures.texts.some((t) => t.zone === z)));
  check('chiffre-clé : 40 pt mesurés', measures.texts.filter((t) => t.zone === 'chiffre').every((t) => Math.abs(t.sizePt - 40) < 0.05));
  check('pictogramme : boîte SVG mesurée pour C3', measures.boxes.some((b) => b.zone === 'picto' && b.kind === 'svg'));
  const control = Object.fromEntries((await controlTemplate(preview)).map((c) => [c.id, c]));
  check('contrôle d’un gabarit : C3, C4, C6, C7, C8, C12, C17, tous verts', Object.keys(control).join() === 'C3,C4,C6,C7,C8,C12,C17' && Object.values(control).every((c) => c.level === 'ok'), control);
  // Refus mesurés
  const t = fiveTypes() as Dict;
  t.sheets[0].zones[4].constraints.maxChars = 2000;
  put(dataRoot, 'collection/gabarits/2Z.json', t);
  const long = await controlTemplate(templatePreview(dataRoot, BOOK_ID, '2Z'));
  check('C12 : encadré trop long pour sa zone, débordement mesuré', long.find((c) => c.id === 'C12')!.details.some((d) => d.includes('savais-tu : déborde')), long);
  const out = fiveTypes() as Dict;
  out.sheets[0].zones[3].box = { inner: { from: 'rogne', mm: 2 }, widthMm: 24, top: { from: 'securite', mm: 28 }, heightMm: 24 };
  out.sheets[1].zones[1].box = { outer: { from: 'rogne', mm: 2 }, widthMm: 60, top: { from: 'securite', mm: 6 }, heightMm: 11 };
  put(dataRoot, 'collection/gabarits/2Z.json', out);
  const c3 = (await controlTemplate(templatePreview(dataRoot, BOOK_ID, '2Z'))).find((c) => c.id === 'C3')!;
  check('C3 : pictogramme au pli et étiquette au bord rogné, hors zone de sécurité', c3.level === 'erreur' && c3.details.some((d) => d.includes('picto')) && c3.details.some((d) => d.includes('etiquette')), c3);
  const small = fiveTypes() as Dict;
  small.sheets[0].zones[2].sizePt = 7;
  put(dataRoot, 'collection/gabarits/2Z.json', small);
  const small7 = await measureHtml(templatePreview(dataRoot, BOOK_ID, '2Z').html);
  check('C8 : corps du chiffre-clé relu dans le rendu', small7.texts.filter((x) => x.zone === 'chiffre').every((x) => Math.abs(x.sizePt - 7) < 0.05));
  // Le rendu refuse ce que le style ne connaît pas, même passé à la main.
  const layout = layoutTemplate(templateSchema.parse(fiveTypes()), SIX_NINE, read.style.margins, 6);
  const content = { title: 'x', lang: 'fr' as const, theme: 'foret', texts: Object.fromEntries(layout.flatMap((p) => p.zones).map((z) => [z.id, 'x'])), fiche: {}, ficheMissing: '', images: { illustration: 'data:,' }, qrSvg: '<svg viewBox="0 0 1 1"></svg>', qrLegend: 'x' };
  const badBox = layout.map((p) => ({ ...p, zones: p.zones.map((z) => (z.type === 'encadre' ? { ...z, encadre: 'nuit' } : z)) }));
  expectThrows('rendu : couleur d’encadré inconnue refusée', () => renderHtml(badBox, SIX_NINE, read.style, content, read.pictos), RenderRefused, 'couleur d\'encadré inconnue');
  const badPicto = layout.map((p) => ({ ...p, zones: p.zones.map((z) => (z.type === 'picto' ? { ...z, picto: 'constructor' } : z)) }));
  expectThrows('rendu : pictogramme inconnu refusé', () => renderHtml(badPicto, SIX_NINE, read.style, content, read.pictos), RenderRefused, 'pictogramme inconnu');
  expectThrows('rendu : zone de texte sans texte refusée', () => renderHtml(layout, SIX_NINE, read.style, { ...content, texts: {} }, read.pictos), RenderRefused, 'sans texte');
  check('rendu : texte échappé dans un encadré et une étiquette', renderHtml(layout, SIX_NINE, read.style, { ...content, texts: { ...content.texts, 'savais-tu': '<i>', etiquette: '"&' } }, read.pictos).includes('&lt;i&gt;') && renderHtml(layout, SIX_NINE, read.style, { ...content, texts: { ...content.texts, etiquette: '"&' } }, read.pictos).includes('&quot;&amp;'));
  check('rendu : un encadré sans titre n’en écrit pas', !renderHtml(layout.map((p) => ({ ...p, zones: p.zones.map((z) => ({ ...z, heading: undefined })) })), SIX_NINE, read.style, content, read.pictos).includes('class="entete"'));
  expectThrows('aperçu : gabarit invalide refusé, nommé', () => {
    put(dataRoot, 'collection/gabarits/2Z.json', '{');
    templatePreview(dataRoot, BOOK_ID, '2Z');
  }, RenderRefused, 'Gabarit 2Z invalide');
  expectThrows('aperçu : gabarit absent refusé, nommé', () => templatePreview(dataRoot, BOOK_ID, '6A'), RenderRefused, 'Gabarit 6A absent');
  expectThrows('aperçu : thème inconnu refusé', () => templatePreview(dataRoot, BOOK_ID, '2A', 'nuit'), RenderRefused, 'Thème inconnu');
  const droite = { ...structuredClone(TEMPLATE_2A), id: '2D', start: 'droite' };
  put(dataRoot, 'collection/gabarits/2D.json', droite);
  check('aperçu : un gabarit qui commence à droite est posé en page impaire', templatePreview(dataRoot, BOOK_ID, '2D').layout[0]!.number === 7);
}

// Sujets : blocs attendus après un changement de gabarit ; gabarit absent ou invalide.
{
  const glbRoot = makeGlbi();
  const parent = tempDir();
  const dataRoot = path.join(parent, 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  createCollection(dataRoot);
  const read = readCollection(dataRoot)!;
  const subject = createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  const merged = mergeImport(makeResearch(), null, subject, expectedBlocks(TEMPLATE_2A, read.style.fiche, 'fr'));
  updateSubject(dataRoot, BOOK_ID, 'alpha', () => ({ subject: merged.subject, research: merged.research }));
  storeIllustration(dataRoot, BOOK_ID, 'alpha', 'illustration', await cleanPng(makePng(60, 90, 3, () => [10, 20, 30])));
  // Sujet d'avant ED1, comme le raptor : sans sa copie, il suit le gabarit de la collection (GB1). Un sujet créé depuis ED1 a sa copie (MP-24).
  fs.rmSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'layout.json'));
  const facts = () => readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR);
  const subjectOf = (f: ParcoursFacts) => f.subjects[0]!;
  const sujetStep = (f: ParcoursFacts, id: string) => computeParcours(f).subjects[0]!.steps.find((s) => s.id === id)!;
  const bookStep = (f: ParcoursFacts, id: string) => STEPS.find((s) => s.id === id)!.evaluate(f);
  let f = facts();
  check('sujet sur 2A : aucun écart, Recherche validée', subjectOf(f).templateError === null && subjectOf(f).blocksGap.missing.length === 0 && subjectOf(f).blocksGap.extra.length === 0 && sujetStep(f, 'sujet-recherche').state === 'validee');
  check('Gabarits : 2A valide, aucun sujet orphelin, validé', bookStep(f, 'gabarits').state === 'validee' && f.gabarits.valid === 1);

  // 2A modifié : le chapeau devient un encadré, l'illustration disparaît.
  const saved = fs.readFileSync(gabarit(dataRoot, '2A.json'));
  const changed = JSON.parse(saved.toString('utf8'));
  const chapeau = changed.sheets[0].zones.find((z: Dict) => z.id === 'chapeau');
  Object.assign(chapeau, { id: 'savais-tu', type: 'encadre', encadre: 'savais-tu' });
  changed.sheets[1].zones = changed.sheets[1].zones.filter((z: Dict) => z.type !== 'illustration');
  put(dataRoot, 'collection/gabarits/2A.json', changed);
  f = facts();
  check('gabarit modifié : blocs manquants et en trop, nommés', subjectOf(f).blocksGap.missing.join() === 'savais-tu (encadre)' && subjectOf(f).blocksGap.extra.join() === 'chapeau (chapeau)', subjectOf(f).blocksGap);
  const recherche = sujetStep(f, 'sujet-recherche');
  check('gabarit modifié : Recherche du sujet en erreur, second import proposé', recherche.state === 'erreur' && recherche.reasons[0]!.includes('Gabarit 2A modifié') && recherche.reasons[0]!.includes('second import'), recherche);
  check('gabarit modifié : Sujets en erreur, sujet nommé', bookStep(f, 'sujets').state === 'erreur' && bookStep(f, 'sujets').reasons[0]!.startsWith('alpha : Gabarit 2A modifié'));
  check('gabarit modifié : image sur une zone disparue, Illustrations en erreur', subjectOf(f).illustrations.errors.some((e) => e.includes('illustration : image rattachée à une zone d\'illustration absente du gabarit 2A')), subjectOf(f).illustrations);
  const onDisk = fs.readFileSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'subject.json'), 'utf8');
  check('gabarit modifié : rien n’est réécrit dans le sujet', onDisk.includes('"chapeau"') && onDisk.includes('"illustration"'));
  // Second import aux blocs du gabarit modifié : l'écart se règle.
  const ctx = subjectContext(dataRoot, BOOK_ID, 'alpha', []);
  const file: ResearchImport = { ...makeResearch(), blocks: ctx.expected.map((b) => ({ zone: b.zone, type: b.type as 'texte', ...(b.item ? { item: b.item } : {}), text: `Texte ${b.id}`, claims: ['c1'] })) };
  const second = mergeImport(file, merged.research, ctx.subject, ctx.expected);
  updateSubject(dataRoot, BOOK_ID, 'alpha', () => ({ subject: second.subject, research: second.research }));
  f = facts();
  check('second import : l’écart est réglé, Recherche validée', subjectOf(f).blocksGap.missing.length + subjectOf(f).blocksGap.extra.length === 0 && sujetStep(f, 'sujet-recherche').state === 'validee', subjectOf(f).blocksGap);
  check('écart : calcul pur, type compté des deux côtés', JSON.stringify(blocksGap([{ id: 'a', type: 'texte' }], [{ id: 'a', zone: 'a', type: 'encadre', label: 'a', maxChars: 1, kind: 'capsule', heading: null }])) === JSON.stringify({ missing: ['a (encadre)'], extra: ['a (texte)'] }));

  // Gabarit invalide, puis absent.
  fs.writeFileSync(gabarit(dataRoot, '2A.json'), '{ "id": "2A" }');
  f = facts();
  check('gabarit invalide : le sujet en erreur, gabarit nommé', subjectOf(f).templateError!.includes('Gabarit 2A invalide') && sujetStep(f, 'sujet-mise-en-page').state === 'erreur' && sujetStep(f, 'sujet-recherche').state === 'verrouillee');
  check('gabarit invalide : Gabarits en erreur, fichier nommé', bookStep(f, 'gabarits').state === 'erreur' && bookStep(f, 'gabarits').reasons[0]!.startsWith('collection/gabarits/2A.json'));
  check('gabarit invalide : Sujets en erreur', bookStep(f, 'sujets').state === 'erreur' && bookStep(f, 'sujets').reasons[0]!.includes('Gabarit 2A invalide'));
  fs.rmSync(gabarit(dataRoot, '2A.json'));
  put(dataRoot, 'collection/gabarits/2Z.json', fiveTypes());
  f = facts();
  check('gabarit absent : sujet orphelin, Gabarits en erreur', bookStep(f, 'gabarits').state === 'erreur' && bookStep(f, 'gabarits').reasons.join().includes('alpha : gabarit 2A absent'), bookStep(f, 'gabarits'));
  check('gabarit absent : le sujet en erreur, gabarit nommé', subjectOf(f).templateError!.includes('Gabarit 2A absent'));
  expectThrows('création d’un sujet : gabarit absent refusé', () => createSubject(dataRoot, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']), SubjectRefused, 'Gabarit 2A absent');
  check('création d’un sujet : un gabarit ajouté par fichier sert aussitôt', createSubject(dataRoot, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2Z', theme: 'foret' }, ['alpha', 'beta'], ['foret']).template === '2Z');
  fs.writeFileSync(gabarit(dataRoot, '2A.json'), saved);
  f = facts();
  const beta = f.subjects.find((s) => s.id === 'beta')!;
  check('sujet sur le gabarit aux cinq types : blocs attendus du gabarit', beta.templateError === null && subjectContext(dataRoot, BOOK_ID, 'beta', []).expected.map((b) => `${b.id}:${b.type}`).join() === 'chiffre:chiffre-cle,savais-tu:encadre,etiquette:etiquette,legende:legende');
  const code = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'templates', 'files.ts'), 'utf8').split('export function addDeliveredTemplates')[0]!.split('\n').filter((l) => !l.startsWith('import')).join('\n');
  check('code : la lecture des gabarits n’écrit rien', !/writeFile|writeNew|appendFile|renameSync|mkdirSync|rmSync|ensureDir\(/.test(code));
}

// Étape Gabarits, verrou de Sujets
{
  const facts = (): ParcoursFacts => ({
    configError: null,
    book: { bookId: 'dino', errors: [], alerts: [] },
    folder: { exists: true, error: null, printBook: 'ok', printBookError: null },
    pricing: { error: null, retained: true, retainedErrors: [], deviation: [], bookAlert: null },
    collection: { exists: true, error: null },
    gabarits: { error: null, valid: 2, invalid: [], orphans: [], overlaps: [] },
    droits: { error: null, missing: 0, faults: [], toCheck: [] },
    workflows: { error: null, todo: [], faults: [] },
    styles: { error: null, count: 1, faults: [], todo: [], alerts: [] },
    subjects: [],
  });
  const run = (change: (f: ParcoursFacts) => void = () => {}) => {
    const f = facts();
    change(f);
    return computeParcours(f).steps;
  };
  const at = (steps: ReturnType<typeof run>, id: string) => steps.find((s) => s.id === id)!;
  check('registre : Gabarits après Collection, l’exige', STEPS.findIndex((s) => s.id === 'gabarits') === STEPS.findIndex((s) => s.id === 'collection') + 1 && STEPS.find((s) => s.id === 'gabarits')!.requires.join() === 'collection');
  check('registre : Sujets exige Gabarits, et il n’y a plus d’étape Essai', !STEPS.some((s) => s.id === 'essai') && STEPS.find((s) => s.id === 'sujets')!.requires.join() === 'gabarits');
  check('Gabarits : validée', at(run(), 'gabarits').state === 'validee');
  const none = run((f) => { f.gabarits.valid = 0; });
  check('Gabarits : aucun gabarit, à faire, motif', at(none, 'gabarits').state === 'a-faire' && at(none, 'gabarits').reasons[0]!.includes('Ajouter les gabarits livrés'));
  check('Gabarits à faire : Sujets verrouillé, renvoi à Mises en page', ['sujets'].every((id) => at(none, id).state === 'verrouillee' && at(none, id).reasons[0] === 'Valider d\'abord « Mises en page ».'));
  check('Gabarits à faire : Droits reste ouvert', at(none, 'droits').state === 'validee');
  const invalid = run((f) => { f.gabarits.invalid = ['collection/gabarits/4A.json : JSON invalide']; });
  check('Gabarits : un fichier invalide, erreur, fichier nommé', at(invalid, 'gabarits').state === 'erreur' && at(invalid, 'gabarits').reasons[0]!.includes('4A.json') && at(invalid, 'sujets').state === 'verrouillee');
  const orphan = run((f) => { f.gabarits.orphans = ['alpha : gabarit 4B absent de collection/gabarits/.']; });
  check('Gabarits : sujet sur un gabarit absent, erreur', at(orphan, 'gabarits').state === 'erreur' && at(orphan, 'gabarits').reasons[0]!.startsWith('alpha'));
  const folder = run((f) => { f.gabarits.error = 'collection/gabarits/ n\'est pas un dossier réel'; });
  check('Gabarits : dossier refusé, erreur', at(folder, 'gabarits').state === 'erreur');
  const locked = run((f) => { f.collection.exists = false; });
  check('Gabarits verrouillé tant que Collection n’est pas validée', at(locked, 'gabarits').state === 'verrouillee');
}

// Routes
{
  const glbRoot = makeGlbi();
  const parent = tempDir();
  const dataRoot = path.join(parent, 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
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
  check('route : état sans collection, 409', (await post('/api/gabarits/state', { bookId: BOOK_ID })).status === 409);
  check('route : ajouter sans collection, 409', (await post('/api/gabarits/ajouter', {})).status === 409);
  createCollection(dataRoot);
  fs.rmSync(gabarit(dataRoot, '2A.json'));
  const empty = JSON.parse((await post('/api/gabarits/state', { bookId: BOOK_ID })).body);
  check('route : état, aucun gabarit', empty.templates.length === 0 && empty.present === true && empty.themes.includes('foret'), empty);
  const added = await post('/api/gabarits/ajouter', {});
  check('route : ajouter, 2A créé', added.status === 200 && JSON.parse(added.body).result.created.join() === 'collection/gabarits/2A.json', added.body);
  const again = JSON.parse((await post('/api/gabarits/ajouter', {})).body);
  check('route : ajouter une seconde fois, conservé', again.result.created.length === 0 && again.result.kept.includes('collection/gabarits/2A.json'));
  createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha'], ['foret']);
  put(dataRoot, 'collection/gabarits/4A.json', '{');
  const listed = JSON.parse((await post('/api/gabarits/state', { bookId: BOOK_ID })).body);
  const two = listed.templates.find((t: Dict) => t.id === '2A');
  const bad = listed.templates.find((t: Dict) => t.id === '4A');
  check('route : liste, pages, départ, état, sujets', two.pages === 2 && two.start === 'gauche' && two.error === null && two.subjects.join() === 'alpha' && bad.error.includes('JSON invalide') && bad.pages === null, listed);
  const preview = JSON.parse((await post('/api/gabarits/apercu', { bookId: BOOK_ID, id: '2A', theme: 'ocean' })).body);
  check('route : aperçu, géométrie pour les repères', preview.layout.length === 2 && preview.layout[0].zones.length === 6);
  check('route : aperçu d’un gabarit invalide, 409', (await post('/api/gabarits/apercu', { bookId: BOOK_ID, id: '4A' })).status === 409);
  check('route : identifiant hors motif, 400', (await post('/api/gabarits/apercu', { bookId: BOOK_ID, id: '../2A' })).status === 400);
  check('route : clé inconnue, 400', (await post('/api/gabarits/apercu', { bookId: BOOK_ID, id: '2A', autre: 1 })).status === 400);
  check('route : livre absent, 409', (await post('/api/gabarits/apercu', { bookId: 'autre-livre', id: '2A' })).status === 409);
  const page = await request({ method: 'GET', path: `/apercu-gabarit?${new URLSearchParams({ bookId: BOOK_ID, id: '2A', theme: 'ocean' })}`, headers: { Host: host } });
  check('GET /apercu-gabarit : HTML du gabarit, CSP de l’aperçu', page.status === 200 && page.body.includes('<title>Gabarit</title>') && page.csp?.includes('default-src \'none\'') === true && page.body.includes(fillerText(600)));
  check('GET /apercu-gabarit : POST refusé, 405', (await request({ path: '/apercu-gabarit', headers })).status === 405);
  check('GET /apercu-gabarit : Host refusé, 403', (await request({ method: 'GET', path: `/apercu-gabarit?bookId=${BOOK_ID}&id=2A`, headers: { Host: 'attaque.example' } })).status === 403);
  check('GET /apercu-gabarit : gabarit invalide, 409', (await request({ method: 'GET', path: `/apercu-gabarit?bookId=${BOOK_ID}&id=4A`, headers: { Host: host } })).status === 409);
  const { 'x-book-print': _h, ...noHeader } = headers;
  check('route : sans en-tête, 403', (await post('/api/gabarits/state', { bookId: BOOK_ID }, noHeader)).status === 403);
  const { Origin: _o, ...noOrigin } = headers;
  check('route : sans Origin, 403', (await post('/api/gabarits/ajouter', {}, noOrigin)).status === 403);
  check('route : GET d’une action, 405', (await request({ method: 'GET', path: '/api/gabarits/state' })).status === 405);
  const control = await post('/api/gabarits/controle', { bookId: BOOK_ID, id: '2A' });
  const ids = JSON.parse(control.body).checks?.map((c: Dict) => c.id).join();
  check('route : contrôle, sept contrôles, rien écrit', control.status === 200 && ids === 'C3,C4,C6,C7,C8,C12,C17' && fs.readdirSync(path.join(dataRoot, BOOK_ID, 'export')).length === 0, control.body.slice(0, 300));
  check('aucune écriture dans GLBInterpreter', !fs.readdirSync(glbRoot, { recursive: true, encoding: 'utf8' }).some((n) => n.includes('gabarit')));
  await new Promise((resolve) => server.close(resolve));
}

finish('gabarits');
