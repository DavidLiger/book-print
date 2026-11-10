// src/layout/files.ts — la copie d'une mise en page modèle dans un sujet (ED1, MP-24) : `subjects/<sujetId>/layout.json`. Un modèle de la
// version 1 y est converti (seule écriture qui convertit en ED1) ; un modèle de la version 2 y est recopié. `modele` garde son origine :
// identifiant, empreinte des octets du fichier modèle lu, date. Un modèle modifié ensuite ne touche plus le sujet. La lecture et l'écriture
// du fichier passent par `data/subject-file.ts`, avec les refus de chemin des sujets.
import type { Margins, Trim } from '../templates/geometry';
import { fromV1 } from './from-v1';
import { isLayout, type MiseEnPage } from './model';
import { subjectLayoutSchema, type Layout, type SubjectLayout } from './schema';

export const LAYOUT_FILE = 'layout.json';

/** La copie d'un modèle pour un sujet qui commence en `firstPage`. Le format et le côté sont contrôlés avant, par la création du sujet. */
export function copyModel(model: MiseEnPage, sha256: string, trim: Trim, margins: Margins, firstPage: number, now: Date): SubjectLayout {
  const layout: Layout = isLayout(model) ? model : fromV1(model, trim, margins, firstPage);
  return subjectLayoutSchema.parse({ ...structuredClone(layout), modele: { id: model.id, empreinte: sha256, date: now.toISOString() } });
}

/** La mise en page d'un `layout.json`, sans son origine. */
export function layoutOf(file: SubjectLayout): Layout {
  const { modele: _modele, ...layout } = file;
  return layout;
}
