// src/templates/index.ts — pose d'un gabarit dans le livre. Les gabarits eux-mêmes sont des fichiers de `collection/gabarits/` (GB1,
// `files.ts`) : un gabarit ajouté par David apparaît sans patch ni redémarrage.
import { sideOfPage } from './geometry';
import type { MiseEnPage } from '../layout/model';
import { sideOf } from './model';

/** Un gabarit se pose sur une page si son côté de départ le permet (§5.2). L'écran et le serveur passent par ici. */
export function templateFits(template: MiseEnPage, firstPage: number): boolean {
  const wanted = sideOf(template.start, 0);
  return wanted === null || wanted === sideOfPage(firstPage);
}
