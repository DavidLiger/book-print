// src/render/html.ts — HTML des pages d'un sujet. Le même texte sert à l'aperçu et au PDF : une feuille `@media screen` pose
// seulement les deux pages côte à côte. Les repères ne sont jamais ici : la page locale les dessine par-dessus (`src/ui/`).
// Les pages sont des blocs de taille fixe, sans moteur de pagination (MP-5). Aucune taille en dur : tout vient de la géométrie.
import type { Placement } from '../images/crop';
import type { PrintBook } from '../schema/print-book';
import type { Style } from '../schema/style';
import { pageSize, type LayoutPage, type LayoutZone, type Rect, type Trim } from '../templates/geometry';
import { rectPolygon } from '../images/contour';
import { boxMarkup, type ChainText } from './flow';
import { FONT_PACK, fontFaces } from './fonts';

export class RenderRefused extends Error {}

export interface RenderContent {
  /** Devient le Title du PDF : neutre. */
  title: string;
  lang: 'fr' | 'en' | 'es';
  theme: string;
  /** Texte par identifiant de zone. */
  texts: Record<string, string>;
  /** Valeur par information de la fiche (`style.fiche[].id`). */
  fiche: Record<string, string>;
  /** Texte d'une information sans valeur : une valeur factice pour l'essai, rien pour un vrai sujet (C13 la refuse). */
  ficheMissing: string;
  /** Source `data:` par identifiant de zone. */
  images: Record<string, string>;
  /** Cadrage par zone. Sans lui, l'image remplit sa zone : c'est le cas de l'aplat « à venir » et de l'image d'essai. */
  placements?: Record<string, Placement>;
  /** SVG inséré tel quel, seul le prologue XML est retiré. */
  qrSvg: string;
  qrLegend: string;
  /** En-tête d'un encadré écrit par la recherche (`headingMaxChars`, ED1 ; rempli par ED4). Vide ou absent : pas d'en-tête. */
  headings?: Record<string, string>;
  /** Texte de chaque chaîne (ED2), par identifiant de chaîne. */
  chains?: Record<string, ChainText>;
  /** Coupures de la première passe (`render/flow.ts`) : fin de la tranche de chaque boîte. Absentes, les boîtes restent vides (première passe). */
  cuts?: Record<string, number[]>;
}

/** Fiche d'un livre (P-30) : celle de `print-book.json` si elle existe, avec les mêmes contrôles que celle du style. */
export function applyBookFiche(style: Style, book: Pick<PrintBook, 'fiche'>): Style {
  if (!book.fiche) return style;
  for (const item of book.fiche) if (!(item.picto in style.pictos)) throw new RenderRefused(`Fiche de print-book.json : pictogramme inconnu, ${item.picto}.`);
  return { ...style, fiche: book.fiche };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mm = (n: number) => `${Math.round(n * 1e4) / 1e4}mm`;

function boxStyle(r: Rect): string {
  return `left:${mm(r.left)};top:${mm(r.top)};width:${mm(r.right - r.left)};height:${mm(r.bottom - r.top)}`;
}

/**
 * Règles des cinq types rendus depuis GB1 : écrites seulement pour les types présents dans les pages. Un gabarit qui n'en a pas, comme 2A,
 * garde exactement le HTML d'avant GB1. Les couleurs d'encadré ne sont écrites que pour les clés utilisées.
 */
function extraCss(style: Style, theme: string, pages: LayoutPage[], font: (f: Style['fonts']['body']) => string): string {
  const zones = pages.flatMap((p) => p.zones);
  const types = new Set(zones.map((z) => z.type));
  const { fonts, palette } = style;
  const rules: string[] = [];
  if (types.has('encadre')) {
    rules.push(`.encadre { padding: 2.5mm 3mm; border: 1pt solid ${theme}; ${font(fonts.body)}; }`);
    rules.push(`.encadre .entete { display: block; margin-bottom: 1mm; ${font(fonts.lead)}; font-weight: 700; color: ${theme}; }`);
    for (const key of [...new Set(zones.flatMap((z) => (z.encadre ? [z.encadre] : [])))].sort()) rules.push(`.encadre-${key} { background: ${palette.boxes[key]}; }`);
  }
  if (types.has('chiffre-cle')) rules.push(`.chiffre-cle { display: flex; align-items: center; justify-content: center; text-align: center; font-family: '${FONT_PACK[fonts.title.pack].family}'; font-size: ${fonts.title.sizePt}pt; line-height: 1.05; font-weight: 700; color: ${theme}; }`);
  if (types.has('legende')) rules.push(`.legende { ${font(fonts.label)}; }`);
  if (types.has('picto')) rules.push(`.picto { display: flex; align-items: center; justify-content: center; color: ${theme}; }`, '.picto svg { display: block; width: 100%; height: 100%; }');
  if (types.has('etiquette')) rules.push(`.etiquette { padding: 1mm 2mm; background: ${palette.paper}; ${font(fonts.label)}; font-weight: 700; }`);
  // Version 2 (ED1) : écrites seulement si les pages portent ces types ou ces champs, comme en GB1.
  if (types.has('bandeau')) {
    rules.push(`.bandeau { background: ${theme}; }`);
    rules.push(`.bandeau .bandeau-texte { position: absolute; display: flex; align-items: flex-end; margin: 0; ${font(fonts.title)}; font-weight: 700; color: ${palette.paper}; }`);
  }
  // ED2 : écrites seulement si les pages portent une chaîne, comme en GB1.
  if (zones.some((z) => z.chaine !== undefined)) {
    rules.push('.chaine .colonne { position: absolute; }');
    rules.push('.chaine .flux { display: block; min-width: 0; overflow-wrap: break-word; }');
    rules.push('.chaine p { margin: 0; }');
    rules.push('.chaine p.retrait { text-indent: 1em; }');
    rules.push(`.chaine .intertitre { margin: 2mm 0 0; ${font(fonts.lead)}; font-weight: 700; color: ${theme}; }`);
    rules.push('.chaine .intertitre.tete { margin-top: 0; }');
    rules.push(`.chaine p.lettrine::first-letter { initial-letter: 3; margin-right: 1mm; font-family: '${FONT_PACK[fonts.title.pack].family}'; font-weight: 700; color: ${theme}; }`);
  }
  if (zones.some((z) => z.icone !== undefined)) rules.push(`.encadre .icone { float: left; width: 8mm; height: 8mm; margin: 0 2mm 1mm 0; color: ${theme}; }`, '.encadre .icone svg { display: block; width: 100%; height: 100%; }');
  return rules.map((r) => `${r}\n`).join('');
}

function css(style: Style, trim: Trim, theme: string, pages: LayoutPage[]): string {
  const { fonts, palette, folio } = style;
  const size = pageSize(trim);
  const font = (f: Style['fonts']['body']) => `font-family:'${FONT_PACK[f.pack].family}';font-size:${f.sizePt}pt;line-height:${f.lineHeight}`;
  const fiche = palette.boxes.fiche;
  return `
${fontFaces()}
@page { size: ${size.widthIn}in ${size.heightIn}in; margin: 0 }
html, body { margin: 0; padding: 0; background: ${palette.paper}; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; display: block; overflow: hidden; width: ${size.widthIn}in; height: ${size.heightIn}in; break-after: page; background: ${palette.paper}; color: ${palette.text}; ${font(fonts.body)}; }
.page:last-child { break-after: auto; }
.zone { position: absolute; margin: 0; }
.zone > span[data-fill] { display: block; min-width: 0; overflow-wrap: break-word; }
.fond { background: ${theme}; }
.titre { ${font(fonts.title)}; font-weight: 700; color: ${palette.paper}; display: flex; align-items: flex-end; }
.chapeau { ${font(fonts.lead)}; font-weight: 600; color: ${theme}; }
.illustration { display: block; object-fit: cover; overflow: hidden; }
.illustration img { position: absolute; display: block; max-width: none; }
.fiche { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; gap: 1mm 3mm; padding: 1.5mm 3mm; background: ${fiche}; border: 1pt solid ${theme}; ${font(fonts.label)}; }
.info { display: flex; align-items: center; gap: 2mm; min-width: 0; }
.info svg { flex: none; width: 8mm; height: 8mm; color: ${theme}; }
.info b { display: block; font-weight: 700; }
.folio { display: flex; align-items: center; justify-content: center; font-family: '${FONT_PACK[fonts.label.pack].family}'; font-size: ${folio.sizePt}pt; line-height: 1; }
.folio span { padding: 1mm 3mm; background: ${palette.paper}; }
.qr { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 2mm; background: ${palette.paper}; border: 1pt solid ${palette.text}; text-align: center; ${font(fonts.label)}; font-size: 9pt; }
.qr svg { display: block; flex: none; }
.qr p { margin: 1mm 0 0; }
${extraCss(style, theme, pages, font)}@media screen { body { display: flex; width: max-content; } .page { flex: none; } }
`;
}

function qrMarkup(zone: LayoutZone, content: RenderContent): string {
  const svg = content.qrSvg.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, '');
  if (!/\bviewBox=/.test(svg)) throw new RenderRefused('QR sans viewBox : le côté du gabarit ne serait pas respecté.');
  const side = mm(zone.constraints!.qrSideMm!);
  return svg.replace(/^<svg\b/, `<svg style="width:${side};height:${side}" data-qr="1"`);
}

function ficheMarkup(zone: LayoutZone, style: Style, content: RenderContent, pictos: Record<string, string>): string {
  const max = zone.constraints?.maxPictos;
  if (max !== undefined && style.fiche.length > max) throw new RenderRefused(`La fiche a ${style.fiche.length} informations : le gabarit en pose ${max} au plus.`);
  return style.fiche
    .map((item) => {
      const value = content.fiche[item.id] ?? content.ficheMissing;
      return `<div class="info" data-item="${esc(item.id)}">${pictos[item.picto]}<span data-fill><b>${esc(item.label[content.lang])}</b>${esc(value)}</span></div>`;
    })
    .join('');
}

const num = (n: number) => Math.round(n * 1e4) / 1e4;
/** Alignement vertical en flexbox. Absent : aucun style ajouté, le HTML de GB1 ne change pas. */
const FLEX_ALIGN = { haut: 'flex-start', milieu: 'center', bas: 'flex-end' } as const;
/** Pointe de la flèche : 2 mm de long, 2 mm de large ; trait de 1 pt (C8 : 0,75 pt au moins). Décision de David (ED1). */
const HEAD_MM = 2;
const STROKE_MM = 25.4 / 72;

/**
 * Flèche d'une étiquette (ED1) : du bord de l'étiquette le plus proche du point visé, jusqu'au point. Un SVG posé dans l'étiquette, à la taille
 * exacte du trait et de sa pointe : C3 le mesure comme un SVG de l'étiquette.
 */
function arrowMarkup(zone: LayoutZone, color: string): string {
  const target = zone.fleche!;
  const r = zone.rect;
  const sx = Math.min(Math.max(target.x, r.left), r.right);
  const sy = Math.min(Math.max(target.y, r.top), r.bottom);
  const dx = target.x - sx;
  const dy = target.y - sy;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.min(HEAD_MM, len);
  const bx = target.x - ux * head;
  const by = target.y - uy * head;
  const half = HEAD_MM / 2;
  const corners = [[target.x, target.y], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]] as const;
  const pad = STROKE_MM / 2;
  const xs = [sx, ...corners.map((c) => c[0])];
  const ys = [sy, ...corners.map((c) => c[1])];
  const left = Math.min(...xs) - pad;
  const top = Math.min(...ys) - pad;
  const width = Math.max(...xs) + pad - left;
  const height = Math.max(...ys) + pad - top;
  const at = (x: number, y: number) => `${num(x - left)},${num(y - top)}`;
  const line = len > HEAD_MM ? `<line x1="${num(sx - left)}" y1="${num(sy - top)}" x2="${num(bx - left)}" y2="${num(by - top)}" stroke="${color}" stroke-width="${num(STROKE_MM)}"/>` : '';
  return `<svg class="fleche" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" style="position:absolute;left:${mm(left - r.left)};top:${mm(top - r.top)};width:${mm(width)};height:${mm(height)};overflow:visible" aria-hidden="true">${line}<polygon points="${corners.map(([x, y]) => at(x, y)).join(' ')}" fill="${color}"/></svg>`;
}

/** Marge entre le texte et le contour d'un détouré (spec §24.6). */
export const SHAPE_MARGIN_MM = 2;

/** Un détouré qui habille : le côté où passe le texte, son contour (sa boîte sans image) et l'étendue de ce contour, en mm sur la page. */
interface Shape {
  side: 'gauche' | 'droite';
  points: [number, number][];
  bounds: Rect;
}

function shapesOf(page: LayoutPage): Shape[] {
  return page.zones.flatMap((z) => {
    if (z.type !== 'illustration' || !z.detoure || (z.habillage !== 'gauche' && z.habillage !== 'droite')) return [];
    const points = z.outline?.points ?? rectPolygon(z.rect);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [{ side: z.habillage, points, bounds: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } }];
  });
}

const pt = (n: number) => `${Math.round(n * 100) / 100}mm`;

/**
 * Habillage d'une boîte de texte (cadre seul ou colonne) par les détourés qui la croisent (spec §24.6). Pour chaque détouré, un flottant vide
 * en tête de la boîte, du côté opposé au texte, de la hauteur qui va du haut de la boîte (ou du flottant précédent du même côté) au bas du
 * contour, avec `shape-outside: polygon(…)` (le contour ramené au flottant) et `shape-margin` : au-dessus du contour, le texte passe sur
 * toute la largeur. Un seul côté par détouré : Chromium n'a pas d'exclusions CSS. Aucun flottant sans détouré : le HTML ne change pas.
 */
export function wrapFloats(box: Rect, shapes: Shape[]): string {
  const m = SHAPE_MARGIN_MM;
  const cursor = { gauche: 0, droite: 0 };
  const items: { top: number; html: string }[] = [];
  for (const shape of [...shapes].sort((a, b) => a.bounds.top - b.bounds.top)) {
    const bottom = Math.min(shape.bounds.bottom + m, box.bottom) - box.top;
    const reach = Math.max(shape.bounds.top - m, box.top) - box.top;
    // Le texte passe à gauche : le flottant est à droite, du bord gauche du contour au bord droit de la boîte ; et inversement.
    const float = shape.side === 'gauche' ? 'right' : 'left';
    const left = shape.side === 'gauche' ? Math.max(shape.bounds.left - m, box.left) : box.left;
    const right = shape.side === 'gauche' ? box.right : Math.min(shape.bounds.right + m, box.right);
    const top = cursor[shape.side];
    if (bottom <= reach || bottom <= top || right <= left) continue;
    cursor[shape.side] = bottom;
    const origin = { x: left, y: box.top + top };
    const polygon = shape.points.map(([x, y]) => `${pt(x - origin.x)} ${pt(y - origin.y)}`).join(',');
    items.push({ top, html: `<span class="habillage" style="float:${float};clear:${float};width:${mm(right - left)};height:${mm(bottom - top)};shape-outside:polygon(${polygon});shape-margin:${SHAPE_MARGIN_MM}mm"></span>` });
  }
  return items.sort((a, b) => a.top - b.top).map((i) => i.html).join('');
}

/** Rang de la première boîte de chaque cadre dans sa chaîne : cadres dans l'ordre de la chaîne, colonnes de gauche à droite. */
function boxRanks(pages: LayoutPage[], content: RenderContent): Map<string, number> {
  const columns = new Map(pages.flatMap((p) => p.zones).map((z) => [z.id, z.colonnes ?? 1]));
  const out = new Map<string, number>();
  for (const chain of Object.values(content.chains ?? {})) {
    let rank = 0;
    for (const cadre of chain.cadres) {
      out.set(cadre, rank);
      rank += columns.get(cadre) ?? 1;
    }
  }
  return out;
}

/** Un cadre de chaîne : une boîte par colonne, chacune avec ses flottants d'habillage et sa tranche de la chaîne (vide en première passe). */
function chainMarkup(zone: LayoutZone, page: LayoutPage, content: RenderContent, rank: number | undefined): string {
  const id = zone.chaine!;
  const chain = content.chains?.[id];
  if (!chain || rank === undefined) throw new RenderRefused(`${zone.id} : chaîne ${id} sans texte.`);
  const n = zone.colonnes ?? 1;
  const gap = zone.gouttiereMm ?? 0;
  const width = zone.rect.right - zone.rect.left;
  const col = (width - (n - 1) * gap) / n;
  const height = zone.rect.bottom - zone.rect.top;
  const cuts = content.cuts?.[id];
  const shapes = shapesOf(page);
  const boxes = Array.from({ length: n }, (_, c) => {
    const at = rank + c;
    const left = c * (col + gap);
    const box: Rect = { left: zone.rect.left + left, right: zone.rect.left + left + col, top: zone.rect.top, bottom: zone.rect.bottom };
    const text = cuts ? boxMarkup(chain, at === 0 ? 0 : cuts[at - 1]!, cuts[at]!) : '';
    return `<div class="colonne" data-cadre data-chaine="${esc(id)}" data-boite="${at}" style="left:${mm(left)};top:0;width:${mm(col)};height:${mm(height)}"><div class="flux" data-fill>${wrapFloats(box, shapes)}${text}</div></div>`;
  });
  return `<div class="zone texte chaine" data-zone="${zone.id}" data-type="${zone.type}" style="${boxStyle(zone.rect)}">${boxes.join('')}</div>`;
}

/** Détouré (ED2, spec §24.6) : l'image RVB entière, centrée dans sa boîte, découpée par son contour. Sans contour, l'aplat remplit la boîte. */
function detoureMarkup(zone: LayoutZone, attrs: string, src: string): string {
  const o = zone.outline;
  if (!o) return `<img ${attrs} src="${src}" alt="">`;
  const r = zone.rect;
  const polygon = o.percent.map(([x, y]) => `${Math.round(x * 1e4) / 1e4}% ${Math.round(y * 1e4) / 1e4}%`).join(',');
  return `<div ${attrs}><img src="${src}" alt="" style="left:${mm(o.image.left - r.left)};top:${mm(o.image.top - r.top)};width:${mm(o.image.right - o.image.left)};height:${mm(o.image.bottom - o.image.top)};clip-path:polygon(${polygon})"></div>`;
}

function zoneMarkup(zone: LayoutZone, page: LayoutPage, style: Style, content: RenderContent, pictos: Record<string, string>, ranks: Map<string, number>): string {
  const attrs = `class="zone ${zone.type}" data-zone="${zone.id}" data-type="${zone.type}" style="${boxStyle(zone.rect)}"`;
  const text = () => {
    const t = content.texts[zone.id];
    if (t === undefined) throw new RenderRefused(`Zone ${zone.id} sans texte.`);
    return esc(t);
  };
  switch (zone.type) {
    case 'fond':
      return `<div ${attrs}></div>`;
    case 'titre':
      return `<h1 ${attrs}><span data-fill>${text()}</span></h1>`;
    case 'chapeau':
      return `<p ${attrs}><span data-fill>${text()}</span></p>`;
    case 'texte': {
      if (zone.chaine !== undefined) return chainMarkup(zone, page, content, ranks.get(zone.id));
      // Un cadre seul est habillé comme une colonne (ED2) ; sans détouré qui le croise, rien n'est ajouté.
      return `<p ${attrs}><span data-fill>${wrapFloats(zone.rect, shapesOf(page))}${text()}</span></p>`;
    }
    case 'fiche':
      return `<div ${attrs}>${ficheMarkup(zone, style, content, pictos)}</div>`;
    case 'illustration': {
      const src = content.images[zone.id];
      if (!src) throw new RenderRefused(`Zone ${zone.id} sans image.`);
      if (zone.detoure) return detoureMarkup(zone, attrs, src);
      const place = content.placements?.[zone.id];
      if (!place) return `<img ${attrs} src="${src}" alt="">`;
      // Une boîte qui coupe : aucune transformation, rien qui puisse créer de la transparence (C6).
      return `<div ${attrs}><img src="${src}" alt="" style="left:${mm(place.leftMm)};top:${mm(place.topMm)};width:${mm(place.widthMm)};height:${mm(place.heightMm)}"></div>`;
    }
    case 'folio':
      return style.folio.show ? `<div ${attrs}><span>${page.number}</span></div>` : '';
    case 'qr':
      return `<div ${attrs}>${qrMarkup(zone, content)}<p data-fill>${esc(content.qrLegend)}</p></div>`;
    case 'encadre': {
      // La couleur et le pictogramme sont vérifiés à la lecture du gabarit ; le rendu refuse quand même ce que le style ne connaît pas.
      if (!zone.encadre || !Object.hasOwn(style.palette.boxes, zone.encadre)) throw new RenderRefused(`${zone.id} : couleur d'encadré inconnue, ${zone.encadre}.`);
      const written = content.headings?.[zone.id];
      const heading = zone.heading ? `<b class="entete">${esc(zone.heading[content.lang])}</b>` : written ? `<b class="entete">${esc(written)}</b>` : '';
      let icone = '';
      if (zone.icone !== undefined) {
        if (!Object.hasOwn(pictos, zone.icone)) throw new RenderRefused(`${zone.id} : icône inconnue, ${zone.icone}.`);
        icone = `<span class="icone">${pictos[zone.icone]}</span>`;
      }
      const body = `${icone}${heading}<span data-fill>${text()}</span>`;
      const box = `class="zone encadre encadre-${zone.encadre}" data-zone="${zone.id}" data-type="${zone.type}"`;
      if (!zone.alignement) return `<div ${box} style="${boxStyle(zone.rect)}">${body}</div>`;
      // Le contenu reste un bloc (l'icône y flotte) ; c'est ce bloc qui est placé en hauteur dans l'encadré.
      return `<div ${box} style="${boxStyle(zone.rect)};display:flex;flex-direction:column;justify-content:${FLEX_ALIGN[zone.alignement]}"><div class="encadre-corps">${body}</div></div>`;
    }
    case 'chiffre-cle': {
      const size = zone.sizePt === undefined ? '' : `;font-size:${zone.sizePt}pt`;
      return `<p class="zone chiffre-cle" data-zone="${zone.id}" data-type="${zone.type}" style="${boxStyle(zone.rect)}${size}"><span data-fill>${text()}</span></p>`;
    }
    case 'legende':
      return `<p ${attrs}><span data-fill>${text()}</span></p>`;
    case 'etiquette':
      // La flèche est en position absolue : elle reste hors du placement en hauteur du texte.
      const align = zone.alignement ? `;display:flex;flex-direction:column;justify-content:${FLEX_ALIGN[zone.alignement]}` : '';
      const label = `class="zone ${zone.type}" data-zone="${zone.id}" data-type="${zone.type}" style="${boxStyle(zone.rect)}${align}"`;
      return `<p ${label}><span data-fill>${text()}</span>${zone.fleche ? arrowMarkup(zone, style.palette.text) : ''}</p>`;
    case 'bandeau': {
      // Le titre est posé dans la partie du bandeau qui est dans la zone de sécurité (C3) ; la seconde page d'un bandeau à cheval n'en porte pas.
      const t = zone.textRect;
      if (!t) return `<div ${attrs}></div>`;
      const inner = { left: t.left - zone.rect.left, top: t.top - zone.rect.top, right: t.right - zone.rect.left, bottom: t.bottom - zone.rect.top };
      const align = zone.alignement ? `;align-items:${FLEX_ALIGN[zone.alignement]}` : '';
      return `<div ${attrs}><h1 class="bandeau-texte" data-cadre style="${boxStyle(inner)}${align}"><span data-fill>${text()}</span></h1></div>`;
    }
    case 'picto': {
      const svg = zone.picto !== undefined && Object.hasOwn(pictos, zone.picto) ? pictos[zone.picto] : undefined;
      if (svg === undefined) throw new RenderRefused(`${zone.id} : pictogramme inconnu, ${zone.picto}.`);
      return `<div ${attrs}>${svg}</div>`;
    }
    default: {
      const never: never = zone.type;
      throw new RenderRefused(`Zone de type ${String(never)} : non rendue.`);
    }
  }
}

/** HTML complet : polices et images en `data:`, aucune ressource externe. */
export function renderHtml(pages: LayoutPage[], trim: Trim, style: Style, content: RenderContent, pictos: Record<string, string>): string {
  const theme = style.palette.themes[content.theme];
  if (!theme) throw new RenderRefused(`Thème inconnu : ${content.theme}.`);
  const ranks = boxRanks(pages, content);
  const sections = pages.map(
    (p) => `<section class="page ${p.side}" data-page="${p.number}" data-side="${p.side}">${p.zones.map((z) => zoneMarkup(z, p, style, content, pictos, ranks)).join('')}</section>`,
  );
  return `<!doctype html><html lang="${content.lang}"><head><meta charset="utf-8"><title>${esc(content.title)}</title><style>${css(style, trim, theme, pages)}</style></head><body>${sections.join('\n')}</body></html>`;
}
