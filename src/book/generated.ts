// src/book/generated.ts — textes générés d'une page du livre (MP6b, spec §5.1 et §24.5) : sources, crédits et glossaire. Le texte vient des
// données et coule dans les cadres de la chaîne qui porte `genere`, sans recherche ni relecture par bloc. Lecture seule, sauf le glossaire
// (import et validation, `writeGlossary`, `validateGlossary`). Rien n'est inventé : une source vient de `research.json`, un crédit des
// registres, un mot du glossaire de `glossaire.json`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BookPlan } from './plan';
import { writeAtomic } from '../data/atomic';
import { bookFolder } from '../data/pricing-file';
import { readResearch, readSubject } from '../data/subject-file';
import type { BookReading } from '../glbi/read';
import type { Chain, Genere } from '../layout/schema';
import type { ChainParagraph, ChainText } from '../render/flow';
import { subjectTitle } from '../render/subject';
import { readBookRights, readCollectionRights, allEntries } from '../rights/registry';
import { claimIsValidated } from '../schema/claim';
import { reviewState } from '../schema/block';
import type { PrintBook } from '../schema/print-book';
import type { RightsEntry } from '../schema/rights';

type Lang = PrintBook['edition']['lang'];

export class GlossaryRefused extends Error {}

/** Une ligne par entrée, l'intertitre sur la première du groupe (sujet, sorte de crédit, lettre du glossaire). */
const grouped = (groups: { heading: string; lines: string[] }[], prefix: string): ChainParagraph[] =>
  groups.flatMap((g, gi) => g.lines.map((text, i) => ({ id: `${prefix}${gi + 1}-${i + 1}`, heading: i === 0 ? g.heading : null, text })));

/**
 * Sources (question 2) : par sujet, dans l'ordre du plan, son titre en intertitre, puis chaque source citée par une affirmation validée d'un bloc
 * relu, une seule fois (même URL) : titre, éditeur, date de publication s'il y en a une, URL.
 */
export function sourcesParagraphs(dataRoot: string, book: PrintBook, plan: BookPlan, reading: Pick<BookReading, 'scenes'>): ChainParagraph[] {
  const lang = book.edition.lang;
  const groups: { heading: string; lines: string[] }[] = [];
  for (const part of plan.parts) {
    if (part.kind !== 'sujet' || part.error) continue;
    const subject = readSubject(dataRoot, book.bookId, part.id);
    const research = readResearch(dataRoot, book.bookId, part.id);
    if (!research) continue;
    const cited = new Set(subject.blocks.filter((b) => reviewState(b) === 'valide').flatMap((b) => b.claims));
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const claim of research.claims) {
      if (!cited.has(claim.id) || !claimIsValidated(claim.status ?? 'propose')) continue;
      for (const s of claim.sources) {
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        lines.push([s.title, s.publisher, ...(s.published ? [s.published] : []), s.url].join(', '));
      }
    }
    if (lines.length === 0) continue;
    const title = subjectTitle(subject, reading.scenes.find((s) => s.id === subject.sceneId), lang) || part.id;
    groups.push({ heading: title, lines });
  }
  return grouped(groups, 's');
}

/** Sortes de crédits, dans l'ordre d'impression (question 3). */
export const CREDIT_GROUPS: { label: Record<Lang, string>; kinds: RightsEntry['kind'][] }[] = [
  { label: { fr: 'Modèles 3D', en: '3D models', es: 'Modelos 3D' }, kinds: ['modele-3d'] },
  { label: { fr: 'Images externes', en: 'External images', es: 'Imágenes externas' }, kinds: ['image-externe'] },
  { label: { fr: 'Modèles d\'IA et outils', en: 'AI models and tools', es: 'Modelos de IA y herramientas' }, kinds: ['modele-ia', 'lora', 'controlnet', 'upscaler', 'image-reference'] },
  { label: { fr: 'Polices', en: 'Fonts', es: 'Tipografías' }, kinds: ['police'] },
  { label: { fr: 'Pictogrammes', en: 'Icons', es: 'Pictogramas' }, kinds: ['picto'] },
];

/** Entrées à créditer : celles rattachées à une image du livre (sujets du livre, pages du livre), plus les polices et les pictogrammes. */
export function creditedEntries(dataRoot: string, book: PrintBook): RightsEntry[] {
  const collection = readCollectionRights(dataRoot);
  const own = readBookRights(dataRoot, book.bookId);
  const registry = allEntries(collection, own);
  // Un identifiant de page du livre n'est jamais celui d'un sujet (MP6a) : `subject` nomme l'un ou l'autre.
  const parts = new Set([...book.subjects, ...book.frontMatter, ...book.backMatter]);
  const used = new Set(own.illustrations.filter((i) => parts.has(i.subject)).flatMap((i) => i.rights));
  return [...registry.values()].filter((e) => used.has(e.id) || e.kind === 'police' || e.kind === 'picto');
}

/**
 * Une ligne par entrée : la mention `credit`, texte prévu pour l'impression (spec §3.8), suivie de l'URL si elle n'y figure pas (décision de
 * David à la vérification de MP6b : nom, auteur et licence ne sont pas répétés). Sans mention (C11 la refuse) : nom, auteur, licence, URL.
 */
export const creditLine = (e: RightsEntry) =>
  e.credit
    ? `${e.credit}${e.url && !e.credit.includes(e.url) ? ` ${e.url}` : ''}`
    : [`${e.name}${e.author ? `, ${e.author}` : ''}`, e.license, ...(e.url ? [e.url] : [])].join(' — ');

export function creditsParagraphs(dataRoot: string, book: PrintBook): ChainParagraph[] {
  const entries = creditedEntries(dataRoot, book);
  const lang = book.edition.lang;
  const groups = CREDIT_GROUPS.map((g) => ({ heading: g.label[lang], lines: entries.filter((e) => g.kinds.includes(e.kind)).map(creditLine) })).filter((g) => g.lines.length > 0);
  return grouped(groups, 'c');
}

/** Une licence CC BY (toutes ses graphies et variantes) : C11 exige qu'elle figure dans les pages de crédits. */
export const isCcBy = (license: string) => /\bcc[\s-]*by\b/i.test(license) || /creative\s+commons\s+attribution/i.test(license);

// --- Glossaire (question 4) ----------------------------------------------------------------------------------------------------------------

export const GLOSSARY_FILE = 'glossaire.json';
const termSchema = z.strictObject({ terme: z.string().trim().min(1, 'terme vide').max(60), definition: z.string().trim().min(1, 'définition vide').max(400) });
/** Ce que Claude rend (prompt de « Préparer le glossaire »). */
export const glossaryImportSchema = z.strictObject({ schemaVersion: z.literal(1), lang: z.enum(['fr', 'en', 'es']), termes: z.array(termSchema).min(1, 'au moins un terme') });
/** Le fichier rangé : le même, plus la validation de David (empreinte des termes validés). */
export const glossaryFileSchema = glossaryImportSchema.extend({ valide: z.strictObject({ date: z.iso.datetime(), empreinte: z.string().regex(/^[0-9a-f]{64}$/) }).optional() });
export type GlossaryFile = z.infer<typeof glossaryFileSchema>;

const termsHash = (g: Pick<GlossaryFile, 'lang' | 'termes'>) => crypto.createHash('sha256').update(JSON.stringify([g.lang, g.termes])).digest('hex');

export type GlossaryState = { state: 'absent' } | { state: 'invalide'; error: string } | { state: 'a-valider' | 'valide'; file: GlossaryFile };

function glossaryPath(dataRoot: string, bookId: string): string | null {
  const dir = bookFolder(dataRoot, bookId);
  return dir ? path.join(dir, GLOSSARY_FILE) : null;
}

export function readGlossary(dataRoot: string, bookId: string): GlossaryState {
  const file = glossaryPath(dataRoot, bookId);
  const stat = file ? fs.lstatSync(file, { throwIfNoEntry: false }) : undefined;
  if (!file || !stat) return { state: 'absent' };
  if (!stat.isFile()) return { state: 'invalide', error: `${bookId}/${GLOSSARY_FILE} n'est pas un fichier réel.` };
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { state: 'invalide', error: `${bookId}/${GLOSSARY_FILE} n'est pas un JSON valide : ${(e as Error).message}.` };
  }
  const parsed = glossaryFileSchema.safeParse(value);
  if (!parsed.success) return { state: 'invalide', error: `${bookId}/${GLOSSARY_FILE} invalide : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}.` };
  const valid = parsed.data.valide !== undefined && parsed.data.valide.empreinte === termsHash(parsed.data);
  return { state: valid ? 'valide' : 'a-valider', file: parsed.data };
}

/** Import du fichier de Claude : validé par le schéma, la langue de l'édition exigée, rangé à valider (une validation passée tombe). */
export function writeGlossary(dataRoot: string, book: PrintBook, value: unknown): GlossaryFile {
  const parsed = glossaryImportSchema.safeParse(value);
  if (!parsed.success) throw new GlossaryRefused(`Glossaire refusé : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}.`);
  if (parsed.data.lang !== book.edition.lang) throw new GlossaryRefused(`Glossaire refusé : langue ${parsed.data.lang}, l'édition est en ${book.edition.lang}.`);
  const dir = bookFolder(dataRoot, book.bookId);
  if (!dir) throw new GlossaryRefused(`Dossier du livre absent : ${book.bookId}/.`);
  const sorted = { ...parsed.data, termes: [...parsed.data.termes].sort((a, b) => a.terme.localeCompare(b.terme, parsed.data.lang)) };
  writeAtomic(dir, GLOSSARY_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  return sorted;
}

/** « Valider le glossaire » : l'empreinte des termes lus est notée ; un terme changé ensuite remet le glossaire à valider. */
export function validateGlossary(dataRoot: string, bookId: string, now: Date): GlossaryFile {
  const read = readGlossary(dataRoot, bookId);
  if (read.state === 'absent') throw new GlossaryRefused('Aucun glossaire : l\'importer d\'abord.');
  if (read.state === 'invalide') throw new GlossaryRefused(read.error);
  const next = { ...read.file, valide: { date: now.toISOString(), empreinte: termsHash(read.file) } };
  writeAtomic(bookFolder(dataRoot, bookId)!, GLOSSARY_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Une ligne par terme : « terme : définition », la première lettre en intertitre. */
export function glossaryParagraphs(file: GlossaryFile): ChainParagraph[] {
  const groups = new Map<string, string[]>();
  for (const t of file.termes) {
    const letter = t.terme.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
    groups.set(letter, [...(groups.get(letter) ?? []), `${t.terme} : ${t.definition}`]);
  }
  return grouped([...groups].map(([heading, lines]) => ({ heading, lines })), 'g');
}

/** Prompt de « Préparer le glossaire » : les textes relus du livre, la consigne et le format attendu. */
export function glossaryPrompt(dataRoot: string, book: PrintBook, plan: BookPlan): string {
  const lang = book.edition.lang;
  const texts: string[] = [];
  for (const part of plan.parts) {
    if (part.kind !== 'sujet' || part.error) continue;
    const subject = readSubject(dataRoot, book.bookId, part.id);
    for (const b of subject.blocks) {
      if (reviewState(b) !== 'valide') continue;
      if (b.heading?.[lang]) texts.push(b.heading[lang]!);
      if (b.text[lang]) texts.push(b.text[lang]!);
    }
  }
  return [
    `Voici les textes relus d'un livre documentaire pour enfants de 7 à 10 ans (langue : ${lang}).`,
    'Relève les mots qu\'un enfant de cet âge risque de ne pas comprendre, et écris pour chacun une définition courte, simple et exacte, sans exemple tiré d\'une autre source.',
    'Une définition fait 400 caractères au plus ; un terme, 60. Pas de doublon.',
    'Réponds par un seul fichier JSON, sans texte autour, de cette forme :',
    JSON.stringify({ schemaVersion: 1, lang, termes: [{ terme: '…', definition: '…' }] }),
    '',
    'Textes :',
    ...texts.map((t) => `- ${t}`),
  ].join('\n');
}

// --- Chaînes générées d'une page du livre --------------------------------------------------------------------------------------------------

export interface GeneratedSource {
  dataRoot: string;
  book: PrintBook;
  plan: BookPlan;
  reading: Pick<BookReading, 'scenes'>;
}

/** Texte de chaque chaîne générée d'une page du livre ; un glossaire absent, invalide ou non validé : aucun texte, la faute dans `faults`. */
export function generatedChains(chains: Chain[], src: GeneratedSource): { chains: Record<string, ChainText>; faults: string[] } {
  const out: Record<string, ChainText> = {};
  const faults: string[] = [];
  for (const c of chains) {
    if (c.genere === undefined) continue;
    const paragraphs = paragraphsOf(c.genere, src, faults);
    out[c.id] = { cadres: c.cadres, lettrine: c.lettrine === true, paragraphs, ...(c.corpsPt === undefined ? {} : { corpsPt: c.corpsPt }) };
  }
  return { chains: out, faults };
}

function paragraphsOf(kind: Genere, src: GeneratedSource, faults: string[]): ChainParagraph[] {
  if (kind === 'sources') return sourcesParagraphs(src.dataRoot, src.book, src.plan, src.reading);
  if (kind === 'credits') return creditsParagraphs(src.dataRoot, src.book);
  const g = readGlossary(src.dataRoot, src.book.bookId);
  if (g.state === 'absent') faults.push('C13, glossaire : aucun glossaire importé (« Préparer le glossaire », puis l\'importer).');
  else if (g.state === 'invalide') faults.push(`C13, ${g.error}`);
  else if (g.state === 'a-valider') faults.push('C13, glossaire : pas encore validé (« Valider le glossaire »).');
  return g.state === 'absent' || g.state === 'invalide' ? [] : glossaryParagraphs(g.file);
}
