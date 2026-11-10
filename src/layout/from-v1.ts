// src/layout/from-v1.ts — conversion d'un gabarit de GB1 (version 1) en mise en page version 2 (ED1, MP-25). Pure. Elle demande le format
// du livre, les marges du style et le numéro de la première page, qui fixe le côté : elle n'est faite qu'à l'écriture (création d'un sujet,
// et en ED3 le premier enregistrement par l'éditeur), jamais à la lecture. Critère : la mise en page convertie rend le même HTML, à l'octet.
import { bleedEdges, GeometryRefused, layoutTemplate, MM_PER_IN, pageFrame, sideOfPage, zoneRect, type Margins, type Trim } from '../templates/geometry';
import type { Template } from '../templates/model';
import { LAYOUT_VERSION, layoutSchema, type BleedSide, type Layout } from './schema';

/** Coordonnées écrites au millionième de mm : assez pour retrouver le HTML de la version 1, sans bruit de virgule flottante dans le fichier. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const SIDES: Record<string, BleedSide> = { outer: 'exterieur', top: 'haut', bottom: 'bas' };

export function fromV1(template: Template, trim: Trim, margins: Margins, firstPage: number): Layout {
  // Les refus de la version 1 (côté, zone qui ne tient pas, élément à cheval non rendu) passent d'abord, avec leur message.
  layoutTemplate(template, trim, margins, firstPage);
  const start = template.start === 'libre' ? sideOfPage(firstPage) : template.start;
  const elements = template.sheets.flatMap((sheet, page) => {
    const frame = pageFrame(trim, margins, firstPage + page);
    return sheet.zones.map((zone) => {
      const r = zoneRect(frame, margins, zone.box, `${template.id}, zone ${zone.id}`);
      const element: Record<string, unknown> = {
        id: zone.id,
        type: zone.type,
        page,
        x: round(r.left - frame.trim.left),
        y: round(r.top - frame.trim.top),
        w: round(r.right - r.left),
        h: round(r.bottom - r.top),
      };
      if (zone.bleed) element.fondPerdu = (['top', 'bottom', 'outer'] as const).filter((e) => bleedEdges(zone.box).includes(e)).map((e) => SIDES[e]);
      const c = zone.constraints ?? {};
      for (const key of ['maxChars', 'itemMaxChars', 'maxPictos', 'ratio', 'qrSideMm'] as const) if (c[key] !== undefined) element[key] = c[key];
      for (const key of ['encadre', 'heading', 'picto', 'sizePt'] as const) if (zone[key] !== undefined) element[key] = zone[key];
      return element;
    });
  });
  const parsed = layoutSchema.safeParse({ schemaVersion: LAYOUT_VERSION, id: template.id, pages: template.pages, start, trim: { widthIn: trim.widthIn, heightIn: trim.heightIn }, elements });
  if (!parsed.success) throw new GeometryRefused(`${template.id} : conversion refusée, ${parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ')}`);
  return parsed.data;
}

/** Largeur rognée en mm : sert aux tests et à l'éditeur. */
export const trimWidthMm = (trim: Trim) => trim.widthIn * MM_PER_IN;
