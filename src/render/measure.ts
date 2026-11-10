// src/render/measure.ts — mesures faites dans la page Chromium, avant l'impression (architecture §5). C3, C4, C6, C7 et C8 les
// lisent. Le script est un texte : `page.evaluate` d'une fonction casserait sous tsx, qui ajoute des aides absentes de la page.

export interface MeasuredRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface MeasuredBox {
  page: number;
  zone: string;
  type: string;
  /**
   * `texte` : l'encre des lignes, les bornes réelles des glyphes (ED3), que C3 contrôle ; `lignes` : la boîte des lignes d'un texte, telle que la
   * mise en page la pose (alignement, centrage) ; `svg` : un pictogramme ou le QR ; `zone` : la zone entière.
   */
  kind: 'texte' | 'lignes' | 'svg' | 'zone';
  rect: MeasuredRect;
}
export interface MeasuredText {
  page: number;
  zone: string;
  type: string;
  sizePt: number;
  family: string;
}
export interface MeasuredLine {
  page: number;
  zone: string;
  widthPt: number;
}
export interface MeasuredFault {
  page: number;
  zone: string;
  /** `opacity`, `filter`, `couleur à alpha`, `invisible`… */
  kind: string;
  value: string;
}
/** Texte plus grand que sa zone ou que sa case de fiche (C12). `item` : l'information de la fiche, `null` pour une zone entière. */
export interface MeasuredOverflow {
  page: number;
  zone: string;
  item: string | null;
  overMm: number;
}
export interface Measures {
  fontsLoaded: boolean;
  pages: { number: number; side: string; widthMm: number; heightMm: number }[];
  boxes: MeasuredBox[];
  texts: MeasuredText[];
  lines: MeasuredLine[];
  faults: MeasuredFault[];
  overflows: MeasuredOverflow[];
}

export const MEASURE_SCRIPT = `(() => {
  const MM = 25.4 / 96;
  const PT = 0.75;
  const out = { fontsLoaded: true, pages: [], boxes: [], texts: [], lines: [], faults: [], overflows: [] };
  for (const f of document.fonts) if (f.status !== 'loaded') out.fontsLoaded = false;
  const alpha = (c) => {
    const m = /^rgba?\\((.*)\\)$/.exec(c);
    if (!m) return /^color\\(/.test(c) && /\\/\\s*[0-9.]+/.test(c) ? Number(/\\/\\s*([0-9.]+)/.exec(c)[1]) : 1;
    const parts = m[1].split(/[\\s,\\/]+/).filter(Boolean);
    return parts.length > 3 ? Number(parts[3]) : 1;
  };
  // Boîtes du texte mis en page : la boîte d'un glyphe dépasse sa ligne dans une police à grands jambages (Baloo 2), elle ne dit rien d'un débordement.
  const over = (inner, outer) => Math.max(outer.top - inner.top, inner.bottom - outer.bottom, outer.left - inner.left, inner.right - outer.right);
  const OVER_PX = 0.5;
  // Encre d'un texte (ED3, C3) : les bornes réelles de chaque glyphe, et non la boîte des lignes, qui dépasse l'encre en haut d'une police à
  // grands jambages et à gauche d'une lettre qui a une approche (lettrine). C'est l'encre que KDP coupe. Chaque glyphe garde la boîte que
  // Chromium lui donne (sa place) ; ses bornes viennent de measureText, dans la même police, ramenées à la hauteur de cette boîte (une lettrine
  // d'initial-letter est agrandie par Chromium sans que son corps calculé le dise).
  const canvas = document.createElement('canvas').getContext('2d');
  const metrics = new Map();
  const measureGlyph = (font, glyph) => {
    const key = font + '|' + glyph;
    if (!metrics.has(key)) {
      canvas.font = font;
      metrics.set(key, canvas.measureText(glyph));
    }
    return metrics.get(key);
  };
  const fontOf = (cs) => [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily].join(' ');
  const ink = (node) => {
    const text = node.nodeValue;
    const parent = node.parentElement;
    const cs = getComputedStyle(parent);
    // Première lettre d'un paragraphe à lettrine (ED2) : sa police est celle de ::first-letter.
    const lettrine = parent.closest('.lettrine');
    const firstText = lettrine ? document.createTreeWalker(lettrine, NodeFilter.SHOW_TEXT).nextNode() : null;
    const firstAt = firstText === node ? text.search(/\S/) : -1;
    const range = document.createRange();
    let box = null;
    for (let i = 0; i < text.length; ) {
      const glyph = String.fromCodePoint(text.codePointAt(i));
      const at = i;
      i += glyph.length;
      if (!glyph.trim()) continue;
      range.setStart(node, at);
      range.setEnd(node, i);
      for (const r of range.getClientRects()) {
        if (r.width === 0 && r.height === 0) continue;
        const style = at === firstAt ? getComputedStyle(lettrine, '::first-letter') : cs;
        const m = measureGlyph(fontOf(style), glyph);
        const height = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
        const s = height > 0 ? r.height / height : 1;
        const baseline = r.top + m.fontBoundingBoxAscent * s;
        const g = { left: r.left - m.actualBoundingBoxLeft * s, right: r.left + m.actualBoundingBoxRight * s, top: baseline - m.actualBoundingBoxAscent * s, bottom: baseline + m.actualBoundingBoxDescent * s };
        if (g.right <= g.left || g.bottom <= g.top) continue;
        box = box ? { left: Math.min(box.left, g.left), top: Math.min(box.top, g.top), right: Math.max(box.right, g.right), bottom: Math.max(box.bottom, g.bottom) } : g;
        break;
      }
    }
    return box;
  };
  for (const section of document.querySelectorAll('section.page')) {
    const number = Number(section.dataset.page);
    const base = section.getBoundingClientRect();
    out.pages.push({ number, side: section.dataset.side, widthMm: base.width * MM, heightMm: base.height * MM });
    const rel = (r) => ({ left: (r.left - base.left) * MM, top: (r.top - base.top) * MM, right: (r.right - base.left) * MM, bottom: (r.bottom - base.top) * MM });
    for (const zone of section.querySelectorAll('[data-zone]')) {
      const id = zone.dataset.zone;
      const type = zone.dataset.type;
      out.boxes.push({ page: number, zone: id, type, kind: 'zone', rect: rel(zone.getBoundingClientRect()) });
      for (const svg of zone.querySelectorAll('svg')) out.boxes.push({ page: number, zone: id, type, kind: 'svg', rect: rel(svg.getBoundingClientRect()) });
      const zoneRect = zone.getBoundingClientRect();
      const overflow = (item, px) => { if (px > OVER_PX) out.overflows.push({ page: number, zone: id, item, overMm: px * MM }); };
      for (const fill of zone.querySelectorAll('[data-fill]')) {
        const info = fill.closest('[data-item]');
        const r = fill.getBoundingClientRect();
        // Un cadre de texte plus petit que sa zone (le titre d'un bandeau, ED1) est la vraie limite du texte.
        const holder = fill.closest('[data-cadre]');
        overflow(info ? info.dataset.item : null, Math.max(over(r, holder && zone.contains(holder) ? holder.getBoundingClientRect() : zoneRect), info ? over(r, info.getBoundingClientRect()) : 0, fill.scrollWidth - fill.clientWidth));
      }
      const walker = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        out.boxes.push({ page: number, zone: id, type, kind: 'lignes', rect: rel(range.getBoundingClientRect()) });
        const inked = ink(n);
        if (inked) out.boxes.push({ page: number, zone: id, type, kind: 'texte', rect: rel(inked) });
        const cs = getComputedStyle(n.parentElement);
        out.texts.push({ page: number, zone: id, type, sizePt: parseFloat(cs.fontSize) * PT, family: cs.fontFamily });
      }
      for (const el of [zone, ...zone.querySelectorAll('*')]) {
        const cs = getComputedStyle(el);
        const fault = (kind, value) => out.faults.push({ page: number, zone: id, kind, value: String(value) });
        if (parseFloat(cs.opacity) < 1) fault('opacity', cs.opacity);
        if (cs.filter !== 'none') fault('filter', cs.filter);
        if (cs.backdropFilter && cs.backdropFilter !== 'none') fault('backdrop-filter', cs.backdropFilter);
        if (cs.mixBlendMode !== 'normal') fault('mix-blend-mode', cs.mixBlendMode);
        if (cs.boxShadow !== 'none') fault('box-shadow', cs.boxShadow);
        if (cs.textShadow !== 'none') fault('text-shadow', cs.textShadow);
        if (cs.maskImage && cs.maskImage !== 'none') fault('mask', cs.maskImage);
        if (cs.visibility !== 'visible') fault('invisible', cs.visibility);
        const colors = [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor, cs.fill, cs.stroke];
        for (const c of colors) {
          const a = alpha(c);
          if (a > 0 && a < 1) fault('couleur à alpha', c);
        }
        if (parseFloat(cs.fillOpacity) < 1) fault('fill-opacity', cs.fillOpacity);
        if (parseFloat(cs.strokeOpacity) < 1) fault('stroke-opacity', cs.strokeOpacity);
        for (const b of ['Top', 'Right', 'Bottom', 'Left']) {
          const w = parseFloat(cs['border' + b + 'Width']);
          if (w > 0 && cs['border' + b + 'Style'] !== 'none') out.lines.push({ page: number, zone: id, widthPt: w * PT });
        }
        if (el instanceof SVGGeometryElement && cs.stroke !== 'none') {
          const scale = el.getScreenCTM()?.a ?? 1;
          out.lines.push({ page: number, zone: id, widthPt: parseFloat(cs.strokeWidth) * scale * PT });
        }
      }
    }
  }
  return out;
})()`;
