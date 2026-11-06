// src/templates/index.ts — liste des gabarits livrés. Chacun est validé au chargement : un gabarit invalide ne démarre pas.
import { TEMPLATE_2A } from './2A';
import { sideOfPage } from './geometry';
import { sideOf, templateSchema, type Template } from './model';

export const TEMPLATES: Record<string, Template> = Object.fromEntries([TEMPLATE_2A].map((t) => [t.id, templateSchema.parse(t)]));

/** Les sujets commencent en p. 6 dans le plan du §5.1 : le plan réel viendra avec le lot qui assemble le livre. */
export const FIRST_SUBJECT_PAGE = 6;

/** Un gabarit se pose sur une page si son côté de départ le permet (§5.2). L'écran passe par ici : un gabarit ajouté apparaît sans autre changement. */
export function templateFits(template: Template, firstPage: number): boolean {
  const wanted = sideOf(template.start, 0);
  return wanted === null || wanted === sideOfPage(firstPage);
}
