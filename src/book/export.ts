// src/book/export.ts — export du livre entier (MP6b, spec §5.2 étape 9 et §7) : toutes les parties dans l'ordre du plan, chacune avec le HTML
// de son aperçu, dans un seul Chromium, réunies en un PDF par pdf-lib ; tous les contrôles de chaque sujet et de chaque page du livre (C3 à C13,
// C17, QR décodés), puis C1, C6, C7, C14 et C15 sur le PDF entier, C2 et C16. Une erreur bloque l'écriture du PDF ; le rapport
// (`export/<bookId>-<lang>-controle.md`) et le résultat (`export/<bookId>-<lang>-export.json`, lu par l'étape « Export ») sont écrits dans tous
// les cas. Écriture par fichier temporaire et renommage ; un PDF ouvert ailleurs donne un message clair.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { livreFacts, type LivreFacts } from './facts';
import { isCcBy, creditedEntries } from './generated';
import { NOTES_MODEL } from './plan';
import { chainFaults } from '../checks/content';
import { readPdfFacts, type PdfFacts } from '../checks/pdf-facts';
import { c9Qr, decodeQr } from '../checks/qr';
import { overlapFaults } from '../checks/overlaps';
import { c1PageSize, c6Transparency, c7Fonts, c14Clean, c15FileSize, type CheckResult } from '../checks/rules';
import { readCollection } from '../data/collection';
import { readPrintBook } from '../data/pricing-file';
import { readPlan, readResearch, readSubject, SubjectRefused } from '../data/subject-file';
import { BookPageRefused } from '../data/book-pages';
import type { BookReading } from '../glbi/read';
import { chainsOf, isLayout, placeMiseEnPage } from '../layout/model';
import { bookPageBuilder, bookPageContext, bookPageFaults } from '../render/book-page';
import { templateContent } from '../render/gabarit';
import { applyBookFiche, RenderRefused, renderHtml } from '../render/html';
import type { Measures } from '../render/measure';
import { pdfChecks, packFonts } from '../render/pdf-checks';
import { renderParts, type HtmlBuilder, type PartInput, type PartRender } from '../render/pdf';
import { renderedSubjectChecks, subjectBuilder, subjectContext, zoneImages, type QrSource } from '../render/subject';
import { allEntries, readBookRights, readCollectionRights } from '../rights/registry';
import type { PrintBook } from '../schema/print-book';
import { readTemplates, templateOf } from '../templates/files';
import { GeometryRefused, sideOfPage, type LayoutPage } from '../templates/geometry';

export class ExportRefused extends Error {}

export const exportName = (book: Pick<PrintBook, 'bookId' | 'edition'>, kind: 'interieur.pdf' | 'controle.md' | 'export.json') => `${book.bookId}-${book.edition.lang}-${kind}`;

/** Résultat du dernier export, lu par l'étape « Export » : date (prise avant toute lecture), succès, fichiers. */
export const exportResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  date: z.iso.datetime(),
  ok: z.boolean(),
  pdf: z.string().nullable(),
  report: z.string(),
  pages: z.number().int().nullable(),
  errors: z.number().int(),
  alerts: z.number().int(),
});
export type ExportResult = z.infer<typeof exportResultSchema>;

interface Part {
  kind: 'page' | 'sujet' | 'notes';
  id: string;
  firstPage: number;
  pages: LayoutPage[];
  input: PartInput;
  /** Zones des chaînes générées : la règle maison des 13 pt ne s'y applique pas (question 11). */
  generatedZones: Set<string>;
  /** Sortes des chaînes générées de la partie (sources, credits, glossaire). */
  generated: string[];
  check: (r: PartRender, facts: PdfFacts) => Promise<CheckResult[]>;
  /** Images : générée par IA ou non (question 7), et les fichiers PNG (poids). */
  images: { zone: string; ai: boolean; file: string | null }[];
}

export interface PartReport {
  kind: Part['kind'];
  id: string;
  firstPage: number;
  pages: number;
  checks: CheckResult[];
}

export interface Declaration {
  /** Images générées par IA : partie et zone. */
  aiImages: string[];
  /** Images sans IA (dépôt à la main, sans droit `modele-ia`). */
  otherImages: string[];
  aiText: string[];
  lines: string[];
}

export interface ExportOutcome {
  ok: boolean;
  date: string;
  pdf: string | null;
  report: string;
  pages: number | null;
  errors: string[];
  alerts: string[];
  parts: PartReport[];
  book: CheckResult[];
  declaration: Declaration;
  weight: { pdfBytes: number | null; perPage: { page: number; images: number; bytes: number }[] };
  timing: { seconds: number; nodeMb: number };
  markdown: string;
}

const errorsOf = (list: CheckResult[]) => list.filter((c) => c.level === 'erreur').flatMap((c) => c.details.map((d) => `${c.id}, ${d}`));
const alertsOf = (list: CheckResult[]) => list.filter((c) => c.level === 'alerte').flatMap((c) => c.details.map((d) => `${c.id}, ${d}`));
const result = (id: string, label: string, errors: string[], alerts: string[] = []): CheckResult => ({ id, label, level: errors.length ? 'erreur' : alerts.length ? 'alerte' : 'ok', details: [...errors, ...alerts] });

/** Les mesures d'une partie, aux numéros de page du livre. */
function shifted(m: Measures, offset: number): Measures {
  const at = <T extends { page: number }>(list: T[]) => list.map((x) => ({ ...x, page: x.page + offset }));
  return { fontsLoaded: m.fontsLoaded, pages: m.pages.map((p) => ({ ...p, number: p.number + offset })), boxes: at(m.boxes), texts: at(m.texts), lines: at(m.lines), faults: at(m.faults), overflows: at(m.overflows) };
}

function merge(list: Measures[]): Measures {
  return list.reduce((a, m) => ({ fontsLoaded: a.fontsLoaded && m.fontsLoaded, pages: [...a.pages, ...m.pages], boxes: [...a.boxes, ...m.boxes], texts: [...a.texts, ...m.texts], lines: [...a.lines, ...m.lines], faults: [...a.faults, ...m.faults], overflows: [...a.overflows, ...m.overflows] }), { fontsLoaded: true, pages: [], boxes: [], texts: [], lines: [], faults: [], overflows: [] } as Measures);
}

/** C8 d'une page du livre : la règle maison du texte courant (13 pt) ne vaut pas pour une chaîne générée, le minimum de KDP si (question 11). */
function withoutHouseRule(checks: CheckResult[], zones: Set<string>): CheckResult[] {
  if (zones.size === 0) return checks;
  return checks.map((c) => {
    if (c.id !== 'C8' || c.level !== 'alerte') return c;
    const details = c.details.filter((d) => ![...zones].some((z) => d.includes(`, ${z} : texte courant`)));
    return { ...c, details, level: details.length ? c.level : 'ok' };
  });
}

/**
 * Question 7 : une image est déclarée générée par IA si l'outil l'a générée, ou si un droit `modele-ia` lui est rattaché, même déposée à la
 * main. L'écart d'ED5 (`aiGenerated` faux pour un dépôt à la main) est corrigé dans ce calcul ; `rights.json` n'est pas réécrit.
 */
export function isAiImage(generated: boolean, rights: string[], registry: ReadonlyMap<string, { kind: string }>): boolean {
  return generated || rights.some((id) => registry.get(id)?.kind === 'modele-ia');
}

/** Ce que l'étape « Livre complet » et les sujets doivent valider avant tout rendu (question 6). */
export function exportBlockers(livre: LivreFacts): string[] {
  const out = [...livre.parts.flatMap((p) => p.errors.map((e) => `${p.id} : ${e}`)), ...livre.errors];
  if (livre.parts.length === 0) out.push('Le livre n\'a aucune partie.');
  for (const p of livre.parts) if (p.kind === 'sujet' && p.status !== 'prêt') out.push(`Sujet ${p.id} : pas encore prêt (étape « Prêt » du sujet).`);
  return out;
}

function parts(dataRoot: string, book: PrintBook, reading: BookReading, glbRoot: string): { parts: Part[]; aiText: string[] } {
  const plan = readPlan(dataRoot, book);
  const qr: QrSource = { glbRoot, origin: reading.origin };
  const out: Part[] = [];
  const aiText: string[] = [];
  for (const p of plan.parts) {
    if (p.firstPage === null) throw new ExportRefused(`${p.id} : numéro inconnu, une partie avant elle est illisible.`);
    if (p.kind === 'sujet') {
      const ctx = subjectContext(dataRoot, book.bookId, p.id, reading.scenes, qr);
      const research = readResearch(dataRoot, book.bookId, p.id);
      const { build, content } = subjectBuilder(ctx);
      const subject = readSubject(dataRoot, book.bookId, p.id);
      const own = readBookRights(dataRoot, book.bookId);
      const registry = allEntries(readCollectionRights(dataRoot), own);
      aiText.push(`textes du sujet ${p.id} (recherche par Claude)`);
      out.push({
        kind: 'sujet',
        id: p.id,
        firstPage: p.firstPage,
        pages: ctx.layout,
        input: { build, chains: content.chains ?? {}, qr: ctx.qr !== null },
        generatedZones: new Set(),
        generated: [],
        check: async (r, facts) => {
          const checks = await renderedSubjectChecks(ctx, research, { facts, measures: r.measures, flow: r.flow, capture: r.capture });
          // Une zone d'illustration sans image s'imprimerait avec l'image d'attente : à l'export, c'est une zone vide obligatoire (C13).
          const empty = zoneImages(ctx).filter((z) => !z.illustration).map((z) => `${z.zone} : aucune image, l'image d'attente serait imprimée`);
          if (empty.length === 0) return checks;
          return checks.map((c) => (c.id === 'C13' ? { ...c, level: 'erreur', details: [...c.details, ...empty] } : c));
        },
        images: subject.illustrations.map((i) => {
          const linked = own.illustrations.find((x) => x.subject === p.id && x.zone === i.zone);
          const ai = isAiImage(i.generation !== undefined, linked?.rights ?? [], registry);
          return { zone: i.zone, ai, file: path.join(dataRoot, book.bookId, 'illustrations', p.id, `${i.zone}.png`) };
        }),
      });
    } else if (p.kind === 'page') {
      const ctx = bookPageContext(dataRoot, book.bookId, p.id, reading, glbRoot);
      const { build, content } = bookPageBuilder(ctx);
      const defs = chainsOf(ctx.layout);
      const generatedZones = new Set(defs.filter((c) => c.genere !== undefined).flatMap((c) => c.cadres));
      if (defs.some((c) => c.genere === 'glossaire')) aiText.push('glossaire (définitions écrites par Claude)');
      const game = reading.gameQr;
      out.push({
        kind: 'page',
        id: p.id,
        firstPage: p.firstPage,
        pages: ctx.pages,
        input: { build, chains: content.chains ?? {}, qr: ctx.qr !== null },
        generatedZones,
        generated: defs.flatMap((c) => (c.genere === undefined ? [] : [c.genere])),
        check: async (r, facts) => {
          // Le glossaire non validé n'est une erreur qu'à l'export (question 4) : l'étape « Livre complet » ne le compte pas.
          const fixed = [...bookPageFaults(ctx), ...ctx.generatedFaults];
          const c12 = [...r.measures.overflows.map((o) => `page ${o.page}, ${o.zone} : déborde de ${o.overMm.toFixed(1).replace('.', ',')} mm`), ...chainFaults(r.flow, content.chains ?? {}, defs), ...fixed.filter((f) => f.startsWith('C12, ')).map((f) => f.slice(5))];
          const c13 = fixed.filter((f) => f.startsWith('C13, ')).map((f) => f.slice(5));
          const checks = [result('C12', 'Texte dans les limites, sans débordement', c12), result('C13', 'Aucun texte de remplissage, aucune zone vide obligatoire', c13), ...pdfChecks({ facts, measures: r.measures, pages: ctx.pages }), result('C17', 'Chevauchements interdits', overlapFaults(ctx.pages))];
          if (ctx.layout.elements.some((e) => e.type === 'qr')) {
            const decoded = r.capture ? await decodeQr(r.capture.png) : null;
            checks.push(c9Qr({ sceneId: 'jeu', expectedFile: game?.file ?? 'jeu.svg', qr: ctx.qr ? { file: ctx.qr.file, url: ctx.qr.url } : null, fault: ctx.qrFault, expectedUrl: ctx.qrExpectedUrl, capture: r.capture && { sideMm: r.capture.sideMm }, decoded }));
          }
          return checks;
        },
        images: [],
      });
    } else {
      const collection = readCollection(dataRoot);
      if (!collection) throw new ExportRefused('collection/ absent.');
      const style = applyBookFiche(collection.style, book);
      const found = templateOf(readTemplates(dataRoot, style), NOTES_MODEL);
      if ('error' in found || !isLayout(found.template)) throw new ExportRefused(`Page de notes : ${'error' in found ? found.error : 'version 2 attendue'}`);
      const layout = { ...found.template, start: sideOfPage(p.firstPage) };
      const pages = placeMiseEnPage(layout, book.edition.trim, style.margins, p.firstPage);
      const theme = Object.keys(style.palette.themes)[0]!;
      const filler = templateContent(layout, style.fiche, theme, book.edition.trim);
      const texts = Object.fromEntries(layout.elements.filter((e) => e.type === 'titre').map((e) => [e.id, e.texteFixe?.[book.edition.lang] ?? '']));
      const html = renderHtml(pages, book.edition.trim, style, { ...filler, title: 'Aperçu', lang: book.edition.lang, texts: { ...filler.texts, ...texts } }, collection.pictos);
      const build: HtmlBuilder = () => html;
      out.push({ kind: 'notes', id: p.id, firstPage: p.firstPage, pages, input: { build, chains: {}, qr: false }, generatedZones: new Set(), generated: [], check: async (r, facts) => pdfChecks({ facts, measures: r.measures, pages }), images: [] });
    }
  }
  return { parts: out, aiText };
}

/** C11 du livre (question 3) : tout crédit CC BY d'une entrée rattachée figure dans une chaîne `credits` ; sans elle, une erreur. */
function c11Credits(dataRoot: string, book: PrintBook, list: Part[]): CheckResult {
  const ccBy = creditedEntries(dataRoot, book).filter((e) => isCcBy(e.license));
  const hasCredits = list.some((p) => p.generated.includes('credits'));
  const errors = ccBy.length > 0 && !hasCredits ? [`aucune page de crédits (chaîne genere: credits) : ${ccBy.length} crédit${ccBy.length > 1 ? 's' : ''} CC BY à imprimer (${ccBy.map((e) => e.id).join(', ')})`] : [];
  return result('C11', 'Crédits CC BY dans les pages de crédits', errors);
}

export function declarationOf(list: { id: string; images: { zone: string; ai: boolean }[] }[], aiText: string[]): Declaration {
  const aiImages = list.flatMap((p) => p.images.filter((i) => i.ai).map((i) => `${p.id}/${i.zone}`));
  const otherImages = list.flatMap((p) => p.images.filter((i) => !i.ai).map((i) => `${p.id}/${i.zone}`));
  const out: string[] = [];
  out.push(`Texte : ${aiText.length > 0 ? 'Oui, généré par IA' : 'Non'}${aiText.length ? ` (${aiText.join(' ; ')})` : ''}.`);
  out.push(`Images : ${aiImages.length > 0 ? `Oui, générées par IA (${aiImages.length} sur ${aiImages.length + otherImages.length})` : 'Non'}.`);
  out.push('Traductions : Non (édition d\'origine).');
  return { aiImages, otherImages, aiText, lines: out };
}

const mo = (n: number) => `${(n / 1e6).toFixed(2).replace('.', ',')} Mo`;

function markdownOf(o: Omit<ExportOutcome, 'markdown'>, book: PrintBook): string {
  const icon = (c: CheckResult) => (c.level === 'ok' ? '✓' : c.level === 'alerte' ? '⚠' : '✗');
  const md: string[] = [];
  md.push(`# Contrôle de l'export — ${book.bookId} (${book.edition.lang})`, '');
  md.push(`- Date : ${o.date}`, `- Verdict : ${o.ok ? 'PDF écrit' : 'PDF non écrit (erreurs ci-dessous)'}`, `- Pages : ${o.pages ?? 'inconnu'}`, `- PDF : ${o.pdf ?? '—'}`, `- Durée de l'export : ${o.timing.seconds.toFixed(1).replace('.', ',')} s ; mémoire de Node au plus haut : ${o.timing.nodeMb} Mo`, '');
  if (o.errors.length) md.push('## Erreurs', '', ...o.errors.map((e) => `- ${e}`), '');
  if (o.alerts.length) md.push('## Alertes', '', ...o.alerts.map((e) => `- ${e}`), '');
  if (o.book.length) md.push('## Livre entier', '', ...o.book.map((c) => `- ${icon(c)} ${c.id} ${c.label}${c.details.length ? ` : ${c.details.join(' ; ')}` : ''}`), '');
  if (o.parts.length) {
    md.push('## Parties, dans l\'ordre du plan', '');
    for (const p of o.parts) md.push(`### ${p.kind === 'sujet' ? 'Sujet' : p.kind === 'page' ? 'Page du livre' : 'Page de notes'} ${p.id} — pages ${p.firstPage} à ${p.firstPage + p.pages - 1}`, '', ...p.checks.map((c) => `- ${icon(c)} ${c.id} ${c.label}${c.details.length ? ` : ${c.details.join(' ; ')}` : ''}`), '');
  }
  md.push('## Poids', '', `- PDF : ${o.weight.pdfBytes === null ? '—' : mo(o.weight.pdfBytes)} (650 Mo au plus, C15)`, '', '| Page | Images | Poids des images |', '|---|---|---|', ...o.weight.perPage.map((w) => `| ${w.page} | ${w.images} | ${mo(w.bytes)} |`), '');
  md.push('## Déclaration à KDP (contenu généré par IA)', '', 'À reporter dans KDP, rubrique « AI-generated content » :', '', ...o.declaration.lines.map((l) => `- ${l}`), '');
  if (o.declaration.aiImages.length) md.push(`Images générées : ${o.declaration.aiImages.join(', ')}.`, '');
  if (o.declaration.otherImages.length) md.push(`Images sans IA : ${o.declaration.otherImages.join(', ')}.`, '');
  return md.join('\n');
}

function writeSafe(dir: string, name: string, data: Uint8Array | string): void {
  const tmp = path.join(dir, `${name}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data, { flag: 'wx' });
  try {
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new ExportRefused(`${name} est ouvert dans un autre programme : le fermer, puis exporter à nouveau.`);
    throw e;
  }
}

/** Export du livre entier. `dir` : le dossier du livre dans GLBInterpreter (lecture déjà faite par l'appelant). */
export async function exportBook(dataRoot: string, glbRoot: string, reading: BookReading, now = new Date()): Promise<ExportOutcome> {
  const started = Date.now();
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 200);
  try {
    const { book, error } = readPrintBook(dataRoot, reading.bookId ?? "");
    if (!book) throw new ExportRefused(error ?? `Dossier du livre absent : ${reading.bookId}/.`);
    const exportDir = path.join(dataRoot, book.bookId, 'export');
    fs.mkdirSync(exportDir, { recursive: true });
    const date = now.toISOString();
    const livre = livreFacts(dataRoot, book.bookId, reading, glbRoot);
    const blockers = exportBlockers(livre);
    const base = { date, pages: livre.total, parts: [] as PartReport[], book: [] as CheckResult[], weight: { pdfBytes: null as number | null, perPage: [] as ExportOutcome['weight']['perPage'] } };
    let outcome: Omit<ExportOutcome, 'markdown' | 'timing'>;
    if (blockers.length > 0) {
      outcome = { ...base, ok: false, pdf: null, report: '', errors: blockers, alerts: livre.alerts, declaration: { aiImages: [], otherImages: [], aiText: [], lines: [] } };
    } else {
      const { parts: list, aiText } = parts(dataRoot, book, reading, glbRoot);
      const rendered = await renderParts(list.map((p) => p.input), book.edition.trim);
      const reports: PartReport[] = [];
      const all = await PDFDocument.create({ updateMetadata: false });
      const measures: Measures[] = [];
      for (const [i, p] of list.entries()) {
        const r = rendered[i]!;
        const facts = await readPdfFacts(r.pdf);
        reports.push({ kind: p.kind, id: p.id, firstPage: p.firstPage, pages: p.pages.length, checks: withoutHouseRule(await p.check(r, facts), p.generatedZones) });
        const doc = await PDFDocument.load(r.pdf, { updateMetadata: false });
        for (const page of await all.copyPages(doc, doc.getPageIndices())) all.addPage(page);
        measures.push(shifted(r.measures, p.firstPage - 1));
      }
      const pdf = await all.save({ updateFieldAppearances: false });
      const facts = await readPdfFacts(pdf);
      const merged = merge(measures);
      const pages = list.flatMap((p) => p.pages);
      const bookChecks = [
        c1PageSize(facts, pages),
        c6Transparency(facts, merged),
        c7Fonts(facts, merged, packFonts()),
        c14Clean(facts, merged),
        c15FileSize(facts),
        result('C2', 'Nombre de pages', livre.errors.filter((e) => e.startsWith('C2')), livre.alerts.filter((e) => e.startsWith('C2'))),
        result('C16', 'Chaque partie sur son côté', livre.parts.flatMap((p) => p.errors.filter((e) => e.startsWith('C16')))),
        c11Credits(dataRoot, book, list),
      ];
      const errors = [...reports.flatMap((r) => errorsOf(r.checks).map((e) => `${r.id} : ${e}`)), ...errorsOf(bookChecks)];
      const alerts = [...reports.flatMap((r) => alertsOf(r.checks).map((e) => `${r.id} : ${e}`)), ...alertsOf(bookChecks), ...livre.alerts.filter((a) => !a.startsWith('C2'))];
      const perPage = facts.pages.map((pg) => {
        const imgs = facts.images.filter((im) => im.page === pg.number);
        return { page: pg.number, images: imgs.length, bytes: imgs.reduce((n, im) => n + im.bytes, 0) };
      });
      let pdfName: string | null = null;
      if (errors.length === 0) {
        pdfName = exportName(book, 'interieur.pdf');
        writeSafe(exportDir, pdfName, pdf);
      }
      outcome = { ...base, ok: errors.length === 0, pdf: pdfName && `${book.bookId}/export/${pdfName}`, report: '', errors, alerts, parts: reports, book: bookChecks, pages: facts.pages.length, weight: { pdfBytes: pdf.length, perPage }, declaration: declarationOf(list, aiText) };
    }
    const timing = { seconds: (Date.now() - started) / 1000, nodeMb: Math.round(peak / 1e6) };
    const reportName = exportName(book, 'controle.md');
    const full = { ...outcome, report: `${book.bookId}/export/${reportName}`, timing };
    const markdown = markdownOf(full, book);
    writeSafe(exportDir, reportName, markdown);
    const res: ExportResult = { schemaVersion: 1, date, ok: full.ok, pdf: full.pdf, report: full.report, pages: full.pages, errors: full.errors.length, alerts: full.alerts.length };
    writeSafe(exportDir, exportName(book, 'export.json'), `${JSON.stringify(res, null, 2)}\n`);
    return { ...full, markdown };
  } catch (e) {
    if (e instanceof RenderRefused || e instanceof GeometryRefused || e instanceof SubjectRefused || e instanceof BookPageRefused) throw new ExportRefused(e.message);
    throw e;
  } finally {
    clearInterval(sampler);
  }
}

/** Le dernier export, pour l'étape « Export » : `null` s'il n'y en a pas ; un fichier illisible vaut « à refaire ». */
export function readExportResult(dataRoot: string, book: Pick<PrintBook, 'bookId' | 'edition'>): ExportResult | 'illisible' | null {
  const file = path.join(dataRoot, book.bookId, 'export', exportName(book, 'export.json'));
  if (!fs.existsSync(file)) return null;
  try {
    return exportResultSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return 'illisible';
  }
}

/**
 * Fraîcheur de l'export (question 9) : rien n'a changé depuis sa date. Une seconde de marge : sous Windows, l'heure d'un fichier écrit juste
 * avant l'export peut dépasser de quelques fractions de milliseconde l'heure lue par Node.
 */
export const FRESH_TOLERANCE_MS = 1000;
export const isFresh = (dataRoot: string, bookId: string, date: string) => latestChange(dataRoot, bookId) <= Date.parse(date) + FRESH_TOLERANCE_MS;

/** Dernière modification d'un fichier du livre ou de la collection (sans `export/` ni `.cache/`) : la fraîcheur de l'export (question 9). */
export function latestChange(dataRoot: string, bookId: string): number {
  let latest = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'export' || entry.name === '.cache' || entry.name.startsWith('.git')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
  };
  for (const dir of [path.join(dataRoot, bookId), path.join(dataRoot, 'collection')]) if (fs.existsSync(dir)) walk(dir);
  return latest;
}

