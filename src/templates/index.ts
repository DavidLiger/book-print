// src/templates/index.ts — pose d'un gabarit dans le livre. Les gabarits eux-mêmes sont des fichiers de `collection/gabarits/` (GB1,
// `files.ts`) : un gabarit ajouté par David apparaît sans patch ni redémarrage.
import { sideOfPage } from './geometry';
import { sideOf, type Template } from './model';

/** Les sujets commencent en p. 6 dans le plan du §5.1 : le plan réel viendra avec le lot qui assemble le livre. */
export const FIRST_SUBJECT_PAGE = 6;

/** Un gabarit se pose sur une page si son côté de départ le permet (§5.2). L'écran et le serveur passent par ici. */
export function templateFits(template: Template, firstPage: number): boolean {
  const wanted = sideOf(template.start, 0);
  return wanted === null || wanted === sideOfPage(firstPage);
}
