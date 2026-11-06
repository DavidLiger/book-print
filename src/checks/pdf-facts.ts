// src/checks/pdf-facts.ts — relecture du PDF produit par pdf-lib (reprise de `inspect-pdf.ts` de PDF0). Ne juge rien : donne des
// faits aux contrôles, qui restent des fonctions pures testables sur des faits construits à la main.
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFStream } from 'pdf-lib';

export interface PdfFont {
  name: string;
  subtype: string;
  /** Vrai pour un fichier de police, et pour une Type 3, dont les glyphes sont dans le PDF, sans `FontFile` (§12.1). */
  embedded: boolean;
  how: string;
  page: number;
}
export interface PdfTransparency {
  kind: string;
  page: number;
}
export interface PdfImage {
  widthPx: number;
  heightPx: number;
  filter: string;
  page: number;
}
export interface PdfFacts {
  sizeBytes: number;
  pages: { number: number; widthPt: number; heightPt: number }[];
  fonts: PdfFont[];
  transparency: PdfTransparency[];
  images: PdfImage[];
  outlines: boolean;
  annotations: number[];
  xmp: boolean;
  optionalContent: boolean;
  /** Clés du dictionnaire d'information : tolérées (§12). */
  info: string[];
}

const nom = (s: string) => PDFName.of(s);

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o === undefined ? undefined : ctx.lookup(o);
  if (v instanceof PDFStream) return v.dict;
  return v instanceof PDFDict ? v : undefined;
}

function numberOf(ctx: PDFContext, o: PDFObject | undefined): number | undefined {
  const v = o === undefined ? undefined : ctx.lookup(o);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

const nameOf = (o: PDFObject | undefined) => String(o ?? '').replace(/^\//, '');

function fontFact(ctx: PDFContext, f: PDFDict, page: number): PdfFont {
  const subtype = nameOf(f.get(nom('Subtype')));
  if (subtype === 'Type3') {
    const name = dictOf(ctx, f.get(nom('FontDescriptor')))?.get(nom('FontName'));
    return { name: nameOf(name) || '(sans nom)', subtype, embedded: true, how: 'Type 3, glyphes dans le PDF', page };
  }
  const name = nameOf(f.get(nom('BaseFont')));
  let holder = f;
  if (subtype === 'Type0') {
    const descendants = ctx.lookup(f.get(nom('DescendantFonts')));
    const first = descendants instanceof PDFArray ? dictOf(ctx, descendants.get(0)) : undefined;
    if (first) holder = first;
  }
  const descriptor = dictOf(ctx, holder.get(nom('FontDescriptor')));
  const file = ['FontFile', 'FontFile2', 'FontFile3'].find((k) => descriptor?.has(nom(k)));
  return { name, subtype, embedded: file !== undefined, how: file ?? 'sans fichier de police', page };
}

function walk(ctx: PDFContext, res: PDFDict | undefined, page: number, seen: Set<PDFDict>, facts: PdfFacts): void {
  if (!res || seen.has(res)) return;
  seen.add(res);

  const fonts = dictOf(ctx, res.get(nom('Font')));
  for (const key of fonts?.keys() ?? []) {
    const f = dictOf(ctx, fonts!.get(key));
    if (!f) continue;
    facts.fonts.push(fontFact(ctx, f, page));
    if (nameOf(f.get(nom('Subtype'))) === 'Type3') walk(ctx, dictOf(ctx, f.get(nom('Resources'))), page, seen, facts);
  }

  const states = dictOf(ctx, res.get(nom('ExtGState')));
  for (const key of states?.keys() ?? []) {
    const d = dictOf(ctx, states!.get(key));
    if (!d) continue;
    for (const k of ['ca', 'CA']) {
      const v = numberOf(ctx, d.get(nom(k)));
      if (v !== undefined && v < 1) facts.transparency.push({ kind: `/${k} ${v}`, page });
    }
    const mask = d.get(nom('SMask'));
    if (mask && String(ctx.lookup(mask)) !== '/None') facts.transparency.push({ kind: '/SMask dans un ExtGState', page });
    const blend = d.get(nom('BM'));
    if (blend && !['/Normal', '/Compatible'].includes(String(ctx.lookup(blend)))) facts.transparency.push({ kind: `/BM ${String(ctx.lookup(blend))}`, page });
  }

  const objects = dictOf(ctx, res.get(nom('XObject')));
  for (const key of objects?.keys() ?? []) {
    const d = dictOf(ctx, objects!.get(key));
    if (!d) continue;
    const subtype = String(d.get(nom('Subtype')));
    if (subtype === '/Image') {
      if (d.has(nom('SMask'))) facts.transparency.push({ kind: '/SMask sur une image', page });
      if (d.has(nom('Mask'))) facts.transparency.push({ kind: '/Mask sur une image', page });
      const filter = d.get(nom('Filter'));
      facts.images.push({ widthPx: numberOf(ctx, d.get(nom('Width'))) ?? 0, heightPx: numberOf(ctx, d.get(nom('Height'))) ?? 0, filter: filter ? String(ctx.lookup(filter)) : 'aucun', page });
    } else if (subtype === '/Form') {
      const group = dictOf(ctx, d.get(nom('Group')));
      if (group && String(group.get(nom('S'))) === '/Transparency') facts.transparency.push({ kind: 'groupe /S /Transparency (Form XObject)', page });
      walk(ctx, dictOf(ctx, d.get(nom('Resources'))), page, seen, facts);
    }
  }

  const patterns = dictOf(ctx, res.get(nom('Pattern')));
  for (const key of patterns?.keys() ?? []) {
    const d = dictOf(ctx, patterns!.get(key));
    walk(ctx, d ? dictOf(ctx, d.get(nom('Resources'))) : undefined, page, seen, facts);
  }
}

export async function readPdfFacts(bytes: Uint8Array): Promise<PdfFacts> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const facts: PdfFacts = { sizeBytes: bytes.length, pages: [], fonts: [], transparency: [], images: [], outlines: false, annotations: [], xmp: false, optionalContent: false, info: [] };
  doc.getPages().forEach((p, i) => {
    const number = i + 1;
    const box = p.getMediaBox();
    facts.pages.push({ number, widthPt: box.width, heightPt: box.height });
    const group = dictOf(ctx, p.node.get(nom('Group')));
    if (group && String(group.get(nom('S'))) === '/Transparency') facts.transparency.push({ kind: 'groupe /S /Transparency (page)', page: number });
    if (p.node.has(nom('Annots'))) facts.annotations.push(number);
    walk(ctx, p.node.Resources(), number, new Set(), facts);
  });
  const catalog = doc.catalog;
  facts.outlines = catalog.has(nom('Outlines'));
  facts.xmp = catalog.has(nom('Metadata'));
  facts.optionalContent = catalog.has(nom('OCProperties'));
  facts.info = (dictOf(ctx, ctx.trailerInfo.Info)?.keys() ?? []).map((k) => nameOf(k));
  return facts;
}
