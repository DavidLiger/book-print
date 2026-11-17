// src/book/plan.ts — plan du livre (MP6a, spec §5.1) : pages liminaires, sujets, pages finales, dans cet ordre ; page 1 = première page
// du livre, à droite. Pur : les fichiers sont lus par `data/subject-file.ts` (`readPlan`). Un total impair reçoit une page de notes, une
// seule, juste avant la dernière partie du livre (la page de secours reste la dernière) : elle est calculée, jamais écrite (décision de David).
import { sideOfPage } from '../templates/geometry';

export type PartKind = 'page' | 'sujet' | 'notes';
export type PartPlace = 'debut' | 'sujets' | 'fin';

/** Une partie lue : une page du livre ou un sujet. `pages: null` : illisible, les numéros s'arrêtent là. */
export interface PartInput {
  kind: 'page' | 'sujet';
  id: string;
  place: PartPlace;
  pages: number | null;
  /** Côté exigé par sa mise en page ; `null` : libre (gabarit de GB1) ou inconnu. */
  start: 'gauche' | 'droite' | null;
  error: string | null;
}

export interface PlanPart extends Omit<PartInput, 'kind'> {
  kind: PartKind;
  /** Vraie première page ; `null` après une partie illisible. */
  firstPage: number | null;
}

export interface BookPlan {
  parts: PlanPart[];
  /** Total des pages, page de notes comprise ; `null` si une partie est illisible. */
  total: number | null;
  /** Une page de notes a été ajoutée pour la parité. */
  notes: boolean;
}

/** Identifiant de la page de notes dans le plan, et modèle livré dont elle est rendue. */
export const NOTES_ID = 'notes';
export const NOTES_MODEL = '1N';

export function computePlan(inputs: PartInput[]): BookPlan {
  const known = inputs.every((p) => p.pages !== null);
  const sum = inputs.reduce((n, p) => n + (p.pages ?? 0), 0);
  const notes = known && inputs.length > 0 && sum % 2 === 1;
  const list: (PartInput | Omit<PartInput, 'kind'> & { kind: 'notes' })[] = [...inputs];
  if (notes) list.splice(list.length - 1, 0, { kind: 'notes', id: NOTES_ID, place: list[list.length - 1]!.place, pages: 1, start: null, error: null });
  let page: number | null = 1;
  const parts = list.map((p): PlanPart => {
    const firstPage = page;
    page = page === null || p.pages === null ? null : page + p.pages;
    return { ...p, firstPage };
  });
  return { parts, total: known ? sum + (notes ? 1 : 0) : null, notes };
}

/** Première page d'une partie du plan ; une partie absente du plan (sujet en création) vient après les sujets, avant les pages finales. */
export function firstPageIn(plan: BookPlan, id: string, kind: 'page' | 'sujet'): number | null {
  const part = plan.parts.find((p) => p.kind === kind && p.id === id);
  if (part) return part.firstPage;
  let page = 1;
  for (const p of plan.parts) {
    if (p.place === 'fin' || p.kind === 'notes') break;
    if (p.pages === null) return null;
    page += p.pages;
  }
  return page;
}

/** C16 du livre : la partie commence sur le côté exigé par sa mise en page. Le message nomme la partie, la page et les deux côtés. */
export function sideFault(part: PlanPart): string | null {
  if (part.start === null || part.firstPage === null || part.kind === 'notes') return null;
  const side = sideOfPage(part.firstPage);
  if (side === part.start) return null;
  const name = part.kind === 'sujet' ? `Sujet ${part.id}` : `Page du livre ${part.id}`;
  return `${name} : sa mise en page commence sur une page ${part.start}, la page ${part.firstPage} est une page ${side}.`;
}

/** C2 (spec §7) : total pair, entre le minimum et le maximum du format et de l'encre ; écart au budget et au scénario retenu : alerte. */
export function c2Pages(total: number | null, range: [number, number] | null, budget: number, retained: number | null): { errors: string[]; alerts: string[] } {
  const errors: string[] = [];
  const alerts: string[] = [];
  if (total === null) return { errors: ['C2, total inconnu : une partie du livre est illisible.'], alerts };
  if (total % 2 !== 0) errors.push(`C2, ${total} pages : un nombre pair est attendu.`);
  if (range === null) errors.push('C2, aucun barème de pages pour ce format et cette encre.');
  else if (total < range[0] || total > range[1]) errors.push(`C2, ${total} pages : entre ${range[0]} et ${range[1]} pour ce format et cette encre.`);
  if (total !== budget) alerts.push(`C2, ${total} pages pour un budget de ${budget} (print-book.json).`);
  if (retained !== null && total !== retained) alerts.push(`C2, ${total} pages pour ${retained} dans le scénario de prix retenu.`);
  return { errors, alerts };
}
