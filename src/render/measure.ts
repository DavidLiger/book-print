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
  /** `texte` : la boîte réelle des lignes ; `svg` : un pictogramme ou le QR ; `zone` : la zone entière. */
  kind: 'texte' | 'svg' | 'zone';
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
        out.boxes.push({ page: number, zone: id, type, kind: 'texte', rect: rel(range.getBoundingClientRect()) });
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
