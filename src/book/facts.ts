// src/book/facts.ts — faits de l'étape « Livre complet » (MP6a), en lecture seule : le plan et ses vrais numéros, la page de notes de
// parité, C2, C16 du livre, l'état de chaque page du livre (C16, C17, texte fixe, QR du jeu), un seul sommaire et un seul QR de jeu.
import { overlapFaults } from '../checks/overlaps';
import { CollectionRefused, readCollection } from '../data/collection';
import { BookPageRefused } from '../data/book-pages';
import { readPrintBook, readPricing } from '../data/pricing-file';
import { readPlan, readSubject, SubjectRefused } from '../data/subject-file';
import type { BookReading } from '../glbi/read';
import { resolvePages } from '../pricing/calc';
import { loadRates } from '../pricing/rates';
import { bookPageContext, bookPageFaults } from '../render/book-page';
import { RenderRefused } from '../render/html';
import type { PrintBook } from '../schema/print-book';
import { readTemplates, templateOf } from '../templates/files';
import { GeometryRefused } from '../templates/geometry';
import { c2Pages, NOTES_MODEL, sideFault, type PlanPart } from './plan';

export interface LivrePart {
  kind: PlanPart['kind'];
  id: string;
  place: PlanPart['place'];
  firstPage: number | null;
  pages: number | null;
  /** Côté de la première page, ou `null` si inconnu. */
  side: 'gauche' | 'droite' | null;
  start: PlanPart['start'];
  /** Sujet : son statut ; page du livre : `null`. */
  status: string | null;
  /** Fautes de la partie : illisible, C16, fautes de la page du livre. */
  errors: string[];
}

export interface LivreFacts {
  parts: LivrePart[];
  total: number | null;
  notes: boolean;
  errors: string[];
  alerts: string[];
}

/** Barème de pages du format et de l'encre du livre, en broché (PX1). */
export function pageRange(book: Pick<PrintBook, 'edition'>): [number, number] | null {
  const { trim, ink } = book.edition;
  const found = loadRates().trims.paperback.find((t) => t.widthIn === trim.widthIn && t.heightIn === trim.heightIn);
  return (found?.pages[ink] as [number, number] | undefined) ?? null;
}

function retainedPages(dataRoot: string, bookId: string): number | null {
  try {
    const file = readPricing(dataRoot, bookId);
    const retained = file?.scenarios.find((s) => s.id === file.retainedId);
    return retained ? resolvePages(retained.pages).pages : null;
  } catch {
    return null;
  }
}

const known = (e: unknown) => e instanceof RenderRefused || e instanceof GeometryRefused || e instanceof SubjectRefused || e instanceof BookPageRefused || e instanceof CollectionRefused;

export function livreFacts(dataRoot: string, bookId: string, reading: Pick<BookReading, 'scenes' | 'title' | 'origin' | 'gameQr'>, glbRoot: string | null): LivreFacts {
  const { book, error } = readPrintBook(dataRoot, bookId);
  if (!book) return { parts: [], total: null, notes: false, errors: [error ?? 'print-book.json absent.'], alerts: [] };
  const plan = readPlan(dataRoot, book, true);
  const errors: string[] = [];
  const alerts: string[] = [];
  let sommaires = 0;
  let gameQrs = 0;
  const parts = plan.parts.map((p): LivrePart => {
    const own: string[] = [];
    if (p.error) own.push(p.error);
    const side = sideFault(p);
    if (side) own.push(`C16, ${side} Proposer « Miroir » sur sa copie, ou « Changer de modèle ».`);
    let status: string | null = null;
    if (p.kind === 'sujet' && !p.error) {
      try {
        status = readSubject(dataRoot, book.bookId, p.id).status;
      } catch (e) {
        if (!known(e)) throw e;
      }
    }
    if (p.kind === 'page' && !p.error && !side) {
      try {
        const ctx = bookPageContext(dataRoot, book.bookId, p.id, reading, glbRoot);
        own.push(...overlapFaults(ctx.pages).map((d) => `C17, ${d}`), ...bookPageFaults(ctx));
        sommaires += ctx.layout.elements.filter((e) => e.type === 'sommaire').length;
        gameQrs += ctx.layout.elements.filter((e) => e.type === 'qr').length;
      } catch (e) {
        if (!known(e)) throw e;
        own.push((e as Error).message);
      }
    }
    const pageSide = p.firstPage === null ? null : p.firstPage % 2 === 0 ? 'gauche' : 'droite';
    return { kind: p.kind, id: p.id, place: p.place, firstPage: p.firstPage, pages: p.pages, side: pageSide, start: p.start, status, errors: own };
  });
  if (sommaires > 1) errors.push(`Sommaire : ${sommaires} dans le livre, un seul attendu.`);
  if (gameQrs > 1) errors.push(`QR du mini-jeu : ${gameQrs} dans le livre, un seul attendu.`);
  if (plan.notes) {
    try {
      const collection = readCollection(dataRoot);
      const found = templateOf(readTemplates(dataRoot, collection?.style ?? null), NOTES_MODEL);
      if ('error' in found) errors.push(`Page de notes : ${found.error} « Ajouter les gabarits livrés » dans Mises en page.`);
    } catch (e) {
      if (!known(e)) throw e;
      errors.push((e as Error).message);
    }
  }
  const c2 = c2Pages(plan.total, pageRange(book), book.pageBudget, retainedPages(dataRoot, book.bookId));
  errors.push(...c2.errors);
  alerts.push(...c2.alerts);
  const notReady = parts.filter((p) => p.kind === 'sujet' && p.status !== null && p.status !== 'prêt').map((p) => p.id);
  if (notReady.length > 0) alerts.push(`Sujets pas encore prêts : ${notReady.join(', ')}.`);
  return { parts, total: plan.total, notes: plan.notes, errors, alerts };
}
