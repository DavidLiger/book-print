// src/layout/pages.ts — « Ajouter une page » et « Retirer une page » d'une copie (MP6a, P-53), purs. Dans un sujet, la page s'ajoute avant
// la dernière (le QR y reste) ; dans une page du livre, à la fin. Seule une page vide se retire. L'identifiant de la copie est recalculé
// (nouveau nombre, même lettre) ; `modele` est gardé par l'appelant. Aucun élément ne change de nature : aucun écart de blocs.
import { templatePages } from '../schema/common';
import { layoutSchema, type Layout } from './schema';

export class PageChangeRefused extends Error {}

const issues = (r: { error: { issues: { message: string }[] } }) => r.error.issues.map((i) => i.message).join(' ; ');

/** Identifiant au nouveau nombre de pages, même lettre : `2A` et 3 pages donnent `3A`. */
export const idWithPages = (id: string, pages: number) => `${pages}${id.slice(String(templatePages(id)).length)}`;

/**
 * Une page de plus : `at` est l'indice de la nouvelle page ; les éléments posés à partir de `at` descendent d'une page. Une page du livre
 * qui porte un QR (le mini-jeu) la reçoit, comme un sujet, avant sa dernière page : le QR reste sur la dernière (§24.4).
 */
export function addPage(layout: Layout, kind: 'sujet' | 'page'): Layout {
  const before = kind === 'sujet' || layout.elements.some((e) => e.type === 'qr');
  const at = before ? layout.pages - 1 : layout.pages;
  // Un élément à cheval sur la page d'avant et celle de l'insertion serait coupé de sa seconde page : refusé, nommé.
  const split = layout.elements.filter((e) => e.double === true && e.page + 1 === at);
  if (split.length > 0) throw new PageChangeRefused(`Page non ajoutée : ${split.map((e) => e.id).join(', ')} est à cheval sur les pages ${at} et ${at + 1}.`);
  const pages = layout.pages + 1;
  const next = {
    ...structuredClone(layout),
    id: idWithPages(layout.id, pages),
    pages,
    elements: layout.elements.map((e) => (e.page >= at ? { ...e, page: e.page + 1 } : e)),
  };
  const parsed = layoutSchema.safeParse(next);
  if (!parsed.success) throw new PageChangeRefused(`Page non ajoutée : ${issues(parsed)}.`);
  return parsed.data;
}

/** Une page de moins : seulement une page vide (aucun élément posé, ni la fin d'un élément à cheval). Un sujet garde 2 pages au moins. */
export function removePage(layout: Layout, index: number, kind: 'sujet' | 'page'): Layout {
  const min = kind === 'sujet' ? 2 : 1;
  if (layout.pages <= min) throw new PageChangeRefused(`${kind === 'sujet' ? 'Un sujet' : 'Une page du livre'} garde ${min} page${min > 1 ? 's' : ''} au moins.`);
  if (!Number.isInteger(index) || index < 0 || index >= layout.pages) throw new PageChangeRefused(`Page ${index + 1} : la mise en page en a ${layout.pages}.`);
  const on = layout.elements.filter((e) => e.page === index || (e.double === true && e.page + 1 === index));
  if (on.length > 0) throw new PageChangeRefused(`La page ${index + 1} n'est pas vide : ${on.map((e) => e.id).join(', ')}.`);
  const pages = layout.pages - 1;
  const next = {
    ...structuredClone(layout),
    id: idWithPages(layout.id, pages),
    pages,
    elements: layout.elements.map((e) => (e.page > index ? { ...e, page: e.page - 1 } : e)),
  };
  const parsed = layoutSchema.safeParse(next);
  if (!parsed.success) throw new PageChangeRefused(`Page non retirée : ${issues(parsed)}.`);
  return parsed.data;
}
