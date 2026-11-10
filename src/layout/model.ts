// src/layout/model.ts — une mise en page, de version 1 (gabarit de GB1) ou 2 (ED1), vue par le reste de l'outil. Une version 1 n'a pas de
// `schemaVersion` : c'est ce qui les distingue. Le prompt, l'import, l'aperçu, les contrôles et le parcours passent par ici, sans savoir
// laquelle des deux ils lisent ; la version 1 garde le chemin de GB1 (`layoutTemplate`), à l'octet près.
import { GeometryRefused, layoutTemplate, type LayoutPage, type Margins, type Trim } from '../templates/geometry';
import { sideOf, type StartSide, type Template } from '../templates/model';
import { placeLayout } from './place';
import type { ElementType, Layout, LayoutElement } from './schema';

export type MiseEnPage = Template | Layout;

export const isLayout = (m: MiseEnPage): m is Layout => (m as Layout).schemaVersion === 2;
export const versionOf = (m: MiseEnPage): 1 | 2 => (isLayout(m) ? 2 : 1);

/** Ce que les éléments ont en commun, quelle que soit la version. */
export interface ElementInfo extends Partial<Omit<LayoutElement, 'id' | 'type' | 'page'>> {
  id: string;
  type: ElementType;
  page: number;
}

export function elementsOf(m: MiseEnPage): ElementInfo[] {
  if (isLayout(m)) return m.elements;
  return m.sheets.flatMap((sheet, page) =>
    sheet.zones.map((z) => ({ id: z.id, type: z.type, page, ...z.constraints, encadre: z.encadre, heading: z.heading, picto: z.picto, sizePt: z.sizePt })),
  );
}

/** Format d'une version 2 ; une version 1 n'en a pas : elle vaut pour tout format, comme en GB1. */
export const formatOf = (m: MiseEnPage): Trim | null => (isLayout(m) ? m.trim : null);

export function sameFormat(m: MiseEnPage, trim: Trim): boolean {
  const f = formatOf(m);
  return f === null || (f.widthIn === trim.widthIn && f.heightIn === trim.heightIn);
}

export const formatLabel = (t: Trim) => `${String(t.widthIn).replace('.', ',')} × ${String(t.heightIn).replace('.', ',')}"`;

/** Côté de la première page : `null` pour un gabarit `libre` de la version 1. */
export const startSide = (m: MiseEnPage): 'gauche' | 'droite' | null => sideOf(m.start as StartSide, 0);

/** Première page d'un aperçu sans livre assemblé : 6, ou 7 pour une mise en page qui commence à droite (GB1). */
export const previewFirstPage = (m: MiseEnPage) => (m.start === 'droite' ? 7 : 6);

/** Géométrie d'une mise en page posée à partir de `firstPage`. Une version 2 d'un autre format que le livre est refusée, sans mise à l'échelle. */
export function placeMiseEnPage(m: MiseEnPage, trim: Trim, margins: Margins, firstPage: number): LayoutPage[] {
  if (!isLayout(m)) return layoutTemplate(m, trim, margins, firstPage);
  if (!sameFormat(m, trim)) throw new GeometryRefused(`Mise en page ${m.id} faite pour ${formatLabel(m.trim)} : le livre est en ${formatLabel(trim)}.`);
  return placeLayout(m, margins, firstPage);
}
