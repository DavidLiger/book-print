// src/templates/geometry.ts — géométrie d'une page, calculée depuis `edition.trim` et les marges du style. Aucune taille en dur :
// seul le fond perdu de KDP (0,125", §6.2) est une constante. Les coordonnées sont en mm, depuis le coin haut gauche de la page du PDF.
//
// Page gauche : fond perdu à gauche, petit fond à droite, la zone rognée est décalée de la valeur du fond perdu.
// Page droite : petit fond à gauche, fond perdu à droite. Dans les deux cas, aucun fond perdu côté pli.
import { sideOf, type Side, type Template, type Zone, type ZoneBox, type ZoneType } from './model';

export const MM_PER_IN = 25.4;
export const BLEED_IN = 0.125;
export const BLEED_MM = BLEED_IN * MM_PER_IN;

export interface Trim {
  widthIn: number;
  heightIn: number;
}
export interface Margins {
  outerMm: number;
  topMm: number;
  bottomMm: number;
  gutterMm: number;
}
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type BleedEdge = 'outer' | 'top' | 'bottom';

export interface LayoutZone {
  id: string;
  type: ZoneType;
  rect: Rect;
  bleedEdges: BleedEdge[];
  constraints: Zone['constraints'];
}
export interface LayoutPage {
  number: number;
  side: Side;
  widthMm: number;
  heightMm: number;
  trim: Rect;
  safe: Rect;
  /** Abscisse du pli : bord droit de la zone rognée d'une page gauche, bord gauche d'une page droite. */
  foldMm: number;
  zones: LayoutZone[];
}

export class GeometryRefused extends Error {}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Taille de chaque page du PDF : largeur + fond perdu extérieur, hauteur + fond perdu haut et bas (§6.2). */
export function pageSize(trim: Trim): { widthIn: number; heightIn: number } {
  return { widthIn: round(trim.widthIn + BLEED_IN), heightIn: round(trim.heightIn + 2 * BLEED_IN) };
}

/** Une page paire est une page gauche, une page impaire une page droite (§4.1). */
export const sideOfPage = (pageNumber: number): Side => (pageNumber % 2 === 0 ? 'gauche' : 'droite');

function pageFrame(trim: Trim, margins: Margins, number: number) {
  const side = sideOfPage(number);
  const size = pageSize(trim);
  const widthMm = size.widthIn * MM_PER_IN;
  const heightMm = size.heightIn * MM_PER_IN;
  const trimWidth = trim.widthIn * MM_PER_IN;
  const left = side === 'gauche' ? BLEED_MM : 0;
  const rect: Rect = { left, top: BLEED_MM, right: left + trimWidth, bottom: BLEED_MM + trim.heightIn * MM_PER_IN };
  const safe: Rect = {
    left: rect.left + (side === 'gauche' ? margins.outerMm : margins.gutterMm),
    top: rect.top + margins.topMm,
    right: rect.right - (side === 'gauche' ? margins.gutterMm : margins.outerMm),
    bottom: rect.bottom - margins.bottomMm,
  };
  return { side, widthMm, heightMm, trim: rect, safe, foldMm: side === 'gauche' ? rect.right : rect.left };
}

/** Résout un axe : `near` et `far` sont comptés depuis leur bord, le résultat depuis le bord de `near`. */
function axis(extent: number, near: number | undefined, far: number | undefined, size: number | undefined, label: string): [number, number] {
  const start = near ?? extent - far! - size!;
  const end = far !== undefined ? extent - far : start + size!;
  if (end <= start || start < 0 || end > extent) throw new GeometryRefused(`${label} : la zone ne tient pas dans ce format`);
  return [start, end];
}

function zoneRect(frame: ReturnType<typeof pageFrame>, margins: Margins, box: ZoneBox, label: string): Rect {
  const dist = (e: ZoneBox['outer'], margin: number) => (e ? (e.from === 'securite' ? margin : 0) + e.mm : undefined);
  const width = frame.trim.right - frame.trim.left;
  const height = frame.trim.bottom - frame.trim.top;
  const [fromOuter, toInner] = axis(width, dist(box.outer, margins.outerMm), dist(box.inner, margins.gutterMm), box.widthMm, label);
  const [fromTop, toBottom] = axis(height, dist(box.top, margins.topMm), dist(box.bottom, margins.bottomMm), box.heightMm, label);
  const top = frame.trim.top + fromTop;
  const bottom = frame.trim.top + toBottom;
  return frame.side === 'gauche'
    ? { left: frame.trim.left + fromOuter, right: frame.trim.left + toInner, top, bottom }
    : { left: frame.trim.right - toInner, right: frame.trim.right - fromOuter, top, bottom };
}

function bleedEdges(box: ZoneBox): BleedEdge[] {
  const onTrim = (e: ZoneBox['outer']) => e?.from === 'rogne' && e.mm === 0;
  const out: BleedEdge[] = [];
  if (onTrim(box.outer)) out.push('outer');
  if (onTrim(box.top)) out.push('top');
  if (onTrim(box.bottom)) out.push('bottom');
  return out;
}

/** Étend la zone vers le bord du PDF. Côté pli, rien ne bouge (§4.1). */
function extend(rect: Rect, frame: ReturnType<typeof pageFrame>, edges: BleedEdge[]): Rect {
  const out = { ...rect };
  if (edges.includes('top')) out.top = 0;
  if (edges.includes('bottom')) out.bottom = frame.heightMm;
  if (edges.includes('outer')) {
    if (frame.side === 'gauche') out.left = 0;
    else out.right = frame.widthMm;
  }
  return out;
}

/** Géométrie d'un gabarit posé à partir de `firstPage`, le numéro réel de sa première page dans le livre. */
export function layoutTemplate(template: Template, trim: Trim, margins: Margins, firstPage: number): LayoutPage[] {
  const wanted = sideOf(template.start, 0);
  if (wanted && sideOfPage(firstPage) !== wanted) {
    throw new GeometryRefused(`Le gabarit ${template.id} commence sur une page ${wanted} : la page ${firstPage} est une page ${sideOfPage(firstPage)}.`);
  }
  return template.sheets.map((sheet, index) => {
    const number = firstPage + index;
    const frame = pageFrame(trim, margins, number);
    const zones = sheet.zones.map((zone): LayoutZone => {
      if (zone.spread) throw new GeometryRefused(`${zone.id} : élément à cheval, non rendu avant les gabarits qui en ont besoin`);
      const rect = zoneRect(frame, margins, zone.box, `${template.id}, zone ${zone.id}`);
      const edges = zone.bleed ? bleedEdges(zone.box) : [];
      return { id: zone.id, type: zone.type, rect: extend(rect, frame, edges), bleedEdges: edges, constraints: zone.constraints };
    });
    return { number, ...frame, zones };
  });
}
