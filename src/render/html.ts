// src/render/html.ts — HTML des pages d'un sujet. Le même texte sert à l'aperçu et au PDF : une feuille `@media screen` pose
// seulement les deux pages côte à côte. Les repères ne sont jamais ici : la page locale les dessine par-dessus (`src/ui/`).
// Les pages sont des blocs de taille fixe, sans moteur de pagination (MP-5). Aucune taille en dur : tout vient de la géométrie.
import type { Placement } from '../images/crop';
import type { PrintBook } from '../schema/print-book';
import type { Style } from '../schema/style';
import { pageSize, type LayoutPage, type LayoutZone, type Rect, type Trim } from '../templates/geometry';
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

function zoneMarkup(zone: LayoutZone, page: LayoutPage, style: Style, content: RenderContent, pictos: Record<string, string>): string {
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
    case 'texte':
      return `<p ${attrs}><span data-fill>${text()}</span></p>`;
    case 'fiche':
      return `<div ${attrs}>${ficheMarkup(zone, style, content, pictos)}</div>`;
    case 'illustration': {
      const src = content.images[zone.id];
      if (!src) throw new RenderRefused(`Zone ${zone.id} sans image.`);
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
      const heading = zone.heading ? `<b class="entete">${esc(zone.heading[content.lang])}</b>` : '';
      return `<div class="zone encadre encadre-${zone.encadre}" data-zone="${zone.id}" data-type="${zone.type}" style="${boxStyle(zone.rect)}">${heading}<span data-fill>${text()}</span></div>`;
    }
    case 'chiffre-cle': {
      const size = zone.sizePt === undefined ? '' : `;font-size:${zone.sizePt}pt`;
      return `<p class="zone chiffre-cle" data-zone="${zone.id}" data-type="${zone.type}" style="${boxStyle(zone.rect)}${size}"><span data-fill>${text()}</span></p>`;
    }
    case 'legende':
    case 'etiquette':
      return `<p ${attrs}><span data-fill>${text()}</span></p>`;
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
  const sections = pages.map(
    (p) => `<section class="page ${p.side}" data-page="${p.number}" data-side="${p.side}">${p.zones.map((z) => zoneMarkup(z, p, style, content, pictos)).join('')}</section>`,
  );
  return `<!doctype html><html lang="${content.lang}"><head><meta charset="utf-8"><title>${esc(content.title)}</title><style>${css(style, trim, theme, pages)}</style></head><body>${sections.join('\n')}</body></html>`;
}
