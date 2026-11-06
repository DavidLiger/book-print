// src/render/essai.ts — aperçu et PDF d'essai du gabarit 2A (spec §5.2, étape 7). Le contenu est synthétique jusqu'à MP3 et MP4.
// Le fichier d'essai porte un nom distinct : il ne prend jamais la place du PDF final. Son résultat est conservé à côté de lui :
// c'est le seul fait du parcours que les données ne donnent pas (spec §5.3).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { essaiContent, essaiSubject, ESSAI_FIRST_PAGE } from '../../scripts/fixtures/sujet-essai';
import { readPdfFacts } from '../checks/pdf-facts';
import { runChecks, type CheckResult } from '../checks/rules';
import { readCollection, type Collection } from '../data/collection';
import { bookFolder, readPrintBook } from '../data/pricing-file';
import { TEMPLATES } from '../templates';
import { layoutTemplate, pageSize, type LayoutPage, type Trim } from '../templates/geometry';
import { FONT_PACK } from './fonts';
import { renderHtml, RenderRefused } from './html';
import { renderPdf } from './pdf';

export const ESSAI_FILE = 'essai-2A.pdf';
export const ESSAI_CONTROL_FILE = 'essai-2A.controle.json';

const checkSchema = z.strictObject({ id: z.string(), label: z.string(), level: z.enum(['ok', 'alerte', 'erreur']), details: z.array(z.string()) });
export const essaiControlSchema = z.strictObject({ schemaVersion: z.literal(1), date: z.iso.datetime(), bookId: z.string(), theme: z.string(), checks: z.array(checkSchema) });
export type EssaiControl = z.infer<typeof essaiControlSchema>;

export interface Essai {
  html: string;
  layout: LayoutPage[];
  trim: Trim;
  theme: string;
}

export function buildEssai(trim: Trim, collection: Collection, theme: string): Essai {
  const subject = essaiSubject(theme);
  if (subject.variant.mirror) throw new RenderRefused('Miroir : pas encore rendu, il viendra avec les gabarits suivants.');
  const template = TEMPLATES[subject.template]!;
  const layout = layoutTemplate(template, trim, collection.style.margins, ESSAI_FIRST_PAGE);
  return { html: renderHtml(layout, trim, collection.style, essaiContent(theme, trim), collection.pictos), layout, trim, theme };
}

/** Ce que le PDF et l'aperçu partagent : le livre fixe le format, la collection le style. */
export function essaiFor(dataRoot: string, bookId: string, theme?: string): Essai {
  const { book, error } = readPrintBook(dataRoot, bookId);
  if (!book) throw new RenderRefused(error ?? `Dossier du livre absent : ${bookId}/. Le créer d'abord dans la page.`);
  const collection = readCollection(dataRoot);
  if (!collection) throw new RenderRefused('collection/ absent : le créer d\'abord dans la page.');
  return buildEssai(book.edition.trim, collection, theme ?? collection.style.variants.rotation[0]!);
}

export const packFonts = () => Object.values(FONT_PACK).map(({ family, pdfName }) => ({ family, pdfName }));

export interface EssaiResult {
  checks: CheckResult[];
  pageSizeIn: { widthIn: number; heightIn: number };
  pages: { number: number; widthPt: number; heightPt: number }[];
  fonts: { name: string; how: string }[];
  sizeBytes: number;
  chromium: string;
}

/** Produit le PDF d'essai et ses contrôles, sans rien écrire. */
export async function renderEssai(essai: Essai): Promise<EssaiResult & { pdf: Buffer }> {
  const { pdf, measures, chromium } = await renderPdf(essai.html, essai.trim);
  const facts = await readPdfFacts(pdf);
  const fonts = [...new Map(facts.fonts.map((f) => [f.name, { name: f.name, how: f.how }])).values()];
  return {
    pdf,
    checks: runChecks({ facts, measures, pages: essai.layout, pack: packFonts() }),
    pageSizeIn: pageSize(essai.trim),
    pages: facts.pages.map((p, i) => ({ ...p, number: essai.layout[i]?.number ?? p.number })),
    fonts,
    sizeBytes: facts.sizeBytes,
    chromium,
  };
}

/** Fichier temporaire puis renommage : un export coupé ne laisse pas de PDF à moitié écrit. */
function writeExport(dir: string, name: string, content: Buffer | string): string {
  const file = path.join(dir, name);
  const tmp = path.join(dir, `${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, file);
    return file;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new RenderRefused(`${name} est ouvert dans un autre programme : le fermer, puis relancer l'export.`);
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function realExportDir(dataRoot: string, bookId: string): string | null {
  const dir = bookFolder(dataRoot, bookId);
  if (!dir) return null;
  const exportDir = path.join(dir, 'export');
  return fs.lstatSync(exportDir, { throwIfNoEntry: false })?.isDirectory() ? exportDir : null;
}

/** Résultat du dernier export. Un fichier abîmé ne bloque rien : l'essai est simplement à refaire. */
export function readEssaiControl(dataRoot: string, bookId: string): { control: EssaiControl | null; error: string | null } {
  const dir = realExportDir(dataRoot, bookId);
  if (!dir) return { control: null, error: null };
  const file = path.join(dir, ESSAI_CONTROL_FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { control: null, error: null };
  const refused = { control: null, error: `${ESSAI_CONTROL_FILE} illisible.` };
  if (!stat.isFile()) return refused;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return refused;
  }
  const parsed = essaiControlSchema.safeParse(value);
  if (!parsed.success || parsed.data.bookId !== bookId) return refused;
  return { control: parsed.data, error: null };
}

/**
 * Le PDF d'essai est écrit même si un contrôle est rouge : il sert à voir la faute. L'export final, lui, sera bloqué (§5.2).
 * La date est prise avant de lire le style : un fichier modifié pendant l'export rend l'essai à refaire. Si l'export échoue,
 * l'ancien PDF et l'ancien résultat restent en place, ensemble.
 */
export async function exportEssai(dataRoot: string, bookId: string, theme: string): Promise<EssaiResult & { file: string }> {
  const date = new Date().toISOString();
  const essai = essaiFor(dataRoot, bookId, theme);
  if (!bookFolder(dataRoot, bookId)) throw new RenderRefused(`Dossier du livre absent : ${bookId}/.`);
  const exportDir = realExportDir(dataRoot, bookId);
  if (!exportDir) throw new RenderRefused(`${bookId}/export/ n'est pas un dossier réel : rien n'est écrit.`);
  const { pdf, ...rest } = await renderEssai(essai);
  const file = writeExport(exportDir, ESSAI_FILE, pdf);
  const control: EssaiControl = { schemaVersion: 1, date, bookId, theme, checks: rest.checks };
  writeExport(exportDir, ESSAI_CONTROL_FILE, `${JSON.stringify(control, null, 2)}\n`);
  return { ...rest, file };
}
