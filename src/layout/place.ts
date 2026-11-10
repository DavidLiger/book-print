// src/layout/place.ts — d'une mise en page version 2, du format et du numéro réel de sa première page, les `LayoutPage` du rendu (ED1).
// Pur. Le décalage du fond perdu de la page gauche vient de `pageFrame`, comme en GB1. Un élément à cheval est posé sur sa page et sur la page
// qui lui fait face, décalé d'une largeur rognée : le même HTML se coupe au bord de chaque page. Le rendu reste celui de `render/html.ts`.
import { BLEED_MM, GeometryRefused, MM_PER_IN, pageFrame, sideOfPage, type BleedEdge, type LayoutPage, type LayoutZone, type Margins, type PageFrame, type Rect } from '../templates/geometry';
import { touchedEdges, type Layout, type LayoutElement } from './schema';

/** C16 au départ : le sujet commence sur le côté de sa mise en page. Le message nomme la page et les deux côtés. */
export function startFault(layout: Pick<Layout, 'id' | 'start'>, firstPage: number): string | null {
  const side = sideOfPage(firstPage);
  return side === layout.start ? null : `La mise en page ${layout.id} commence sur une page ${layout.start} : la page ${firstPage} est une page ${side}.`;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

function placeElement(e: LayoutElement, layout: Layout, frame: PageFrame, part: 'debut' | 'fin' | null): LayoutZone {
  const W = layout.trim.widthIn * MM_PER_IN;
  const touched = touchedEdges(e, layout);
  const asked = e.fondPerdu ?? [];
  const edges: BleedEdge[] = [];
  // Abscisses dans la page rognée (dans la double page pour un élément à cheval), étendues au fond perdu extérieur demandé.
  let left = e.x;
  let right = e.x + e.w;
  if (asked.includes('exterieur') && touched.includes('exterieur')) {
    const span = part ? 2 * W : W;
    const atLeft = Math.abs(e.x) <= 1e-6;
    const atRight = Math.abs(e.x + e.w - span) <= 1e-6;
    // Un élément seul ne touche que le bord extérieur de sa page ; un élément à cheval peut toucher les deux bords extérieurs.
    if (part || frame.side === 'gauche') {
      if (atLeft) left = -BLEED_MM;
    }
    if (part || frame.side === 'droite') {
      if (atRight) right = span + BLEED_MM;
    }
    // Le bord extérieur de cette page-ci.
    if ((frame.side === 'gauche' && atLeft && (part !== 'fin')) || (frame.side === 'droite' && atRight && part !== 'debut')) edges.push('outer');
  }
  const shift = part === 'fin' ? -W : 0;
  const rect: Rect = { left: frame.trim.left + e.x + shift, top: frame.trim.top + e.y, right: frame.trim.left + e.x + e.w + shift, bottom: frame.trim.top + e.y + e.h };
  const out: Rect = { ...rect, left: frame.trim.left + left + shift, right: frame.trim.left + right + shift };
  if (asked.includes('haut')) {
    edges.push('top');
    out.top = 0;
  }
  if (asked.includes('bas')) {
    edges.push('bottom');
    out.bottom = frame.heightMm;
  }
  const constraints = Object.fromEntries((['maxChars', 'ratio', 'maxPictos', 'itemMaxChars', 'qrSideMm'] as const).flatMap((k) => (e[k] === undefined ? [] : [[k, e[k]]])));
  const own = {
    encadre: e.encadre,
    heading: e.heading,
    picto: e.picto,
    sizePt: e.sizePt,
    icone: e.icone,
    sorte: e.sorte,
    alignement: e.alignement,
    headingMaxChars: e.headingMaxChars,
    image: e.image,
    consigne: e.consigne,
    fleche: e.fleche && { x: frame.trim.left + e.fleche.x, y: frame.trim.top + e.fleche.y },
  };
  const extra: Partial<LayoutZone> = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined));
  if (e.type === 'bandeau') {
    // Le titre se pose dans la partie du bandeau qui est dans la zone de sécurité ; sur la page gauche seulement s'il est à cheval (décision de David).
    if (part === 'fin') extra.textRect = null;
    else {
      const text = intersect(rect, frame.safe);
      if (!text) throw new GeometryRefused(`${layout.id}, ${e.id} : bandeau hors de la zone de sécurité, aucune place pour le titre.`);
      extra.textRect = text;
    }
  }
  if (part) extra.double = part;
  return { id: e.id, type: e.type, rect: out, bleedEdges: edges, constraints: Object.keys(constraints).length ? constraints : undefined, ...extra };
}

export function placeLayout(layout: Layout, margins: Margins, firstPage: number): LayoutPage[] {
  const fault = startFault(layout, firstPage);
  if (fault) throw new GeometryRefused(fault);
  return Array.from({ length: layout.pages }, (_, index) => {
    const number = firstPage + index;
    const frame = pageFrame(layout.trim, margins, number);
    const zones = layout.elements.flatMap((e) => {
      if (e.page === index) return [placeElement(e, layout, frame, e.double ? 'debut' : null)];
      if (e.double && e.page + 1 === index) return [placeElement(e, layout, frame, 'fin')];
      return [];
    });
    return { number, ...frame, zones };
  });
}
