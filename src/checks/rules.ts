// src/checks/rules.ts — contrôles livrés en MP2 : C1, C3, C4, C6, C7, C8, C14, C15 (spec §7). Fonctions pures : elles reçoivent
// des faits (relus dans le PDF, mesurés dans Chromium, calculés par la géométrie) et rendent un verdict, sans rien lire.
import type { MeasuredBox, Measures } from '../render/measure';
import { BODY_MIN_PT } from '../schema/style';
import { BLEED_MM, type LayoutPage } from '../templates/geometry';
import type { PdfFacts } from './pdf-facts';

export type Level = 'ok' | 'alerte' | 'erreur';
export interface CheckResult {
  id: string;
  label: string;
  level: Level;
  details: string[];
}

/** Chromium arrondit la largeur : 440,88 pt pour 441 en 6 × 9", 621,12 pt pour 621 en 8,5 × 11" (§12.1). */
export const PAGE_TOLERANCE_PT = 0.15;
export const KDP_MIN_TEXT_PT = 7;
export const KDP_MIN_LINE_PT = 0.75;
export const KDP_MAX_BYTES = 650 * 1000 * 1000;
/** Règle maison : bande de 15 mm autour du pli (§4.1). */
export const FOLD_BAND_MM = 15;
/** Marge d'arrondi des boîtes rendues, sans effet sur une vraie faute. */
const TOLERANCE_MM = 0.05;
/** Le navigateur rend 13 pt en 17,33 px : la conversion inverse donne 12,9999 pt. */
const SIZE_ROUNDING_PT = 0.01;
/** Types soumis à la zone de sécurité (C3). `illustration` et `fond` vont au bord. */
const SAFE_TYPES = ['titre', 'chapeau', 'texte', 'encadre', 'fiche', 'chiffre-cle', 'legende', 'picto', 'qr', 'etiquette', 'folio'];

const result = (id: string, label: string, details: string[], fail: Level = 'erreur'): CheckResult => ({ id, label, level: details.length ? fail : 'ok', details });
const fmt = (n: number) => n.toFixed(2).replace('.', ',');
const unique = (list: string[]) => [...new Set(list)];

export function c1PageSize(facts: PdfFacts, pages: LayoutPage[]): CheckResult {
  const details: string[] = [];
  if (facts.pages.length !== pages.length) details.push(`${facts.pages.length} pages dans le PDF, ${pages.length} attendues`);
  facts.pages.forEach((p, i) => {
    const want = pages[i];
    if (!want) return;
    const w = (want.widthMm / 25.4) * 72;
    const h = (want.heightMm / 25.4) * 72;
    if (Math.abs(p.widthPt - w) > PAGE_TOLERANCE_PT || Math.abs(p.heightPt - h) > PAGE_TOLERANCE_PT) {
      details.push(`page ${want.number} : ${fmt(p.widthPt)} × ${fmt(p.heightPt)} pt, ${fmt(w)} × ${fmt(h)} attendus à ± ${fmt(PAGE_TOLERANCE_PT)} pt`);
    }
  });
  return result('C1', 'Taille de page relue dans le PDF', details);
}

function outside(box: MeasuredBox, page: LayoutPage): string | null {
  const { rect: r } = box;
  const { safe } = page;
  const t = TOLERANCE_MM;
  const label = `page ${page.number}, ${box.zone}`;
  if (r.left < safe.left - t || r.right > safe.right + t || r.top < safe.top - t || r.bottom > safe.bottom + t) return `${label} : hors de la zone de sécurité`;
  const toFold = page.side === 'gauche' ? page.foldMm - r.right : r.left - page.foldMm;
  if (toFold < FOLD_BAND_MM - t) return `${label} : à ${fmt(toFold)} mm du pli, ${FOLD_BAND_MM} mm au moins`;
  return null;
}

export function c3Safety(measures: Measures, pages: LayoutPage[]): CheckResult {
  const details: string[] = [];
  for (const box of measures.boxes) {
    // Un bandeau va au bord comme un fond : seul son titre est soumis à la zone de sécurité (ED1). D'un texte, seule l'encre compte (ED3) :
    // la boîte des lignes dépasse l'encre d'une police à grands jambages, KDP ne coupe que l'encre.
    if (box.kind === 'lignes') continue;
    const kept = SAFE_TYPES.includes(box.type) || (box.type === 'bandeau' && box.kind === 'texte');
    if (!kept) continue;
    const page = pages.find((p) => p.number === box.page);
    if (!page) continue;
    const fault = outside(box, page);
    if (fault) details.push(fault);
  }
  return result('C3', 'Texte, QR et pictogrammes dans la zone de sécurité, hors de la bande du pli', unique(details));
}

export function c4Bleed(measures: Measures, pages: LayoutPage[]): CheckResult {
  const details: string[] = [];
  const t = TOLERANCE_MM;
  for (const page of pages) {
    for (const zone of page.zones) {
      if (zone.bleedEdges.length === 0) continue;
      const box = measures.boxes.find((b) => b.page === page.number && b.zone === zone.id && b.kind === 'zone');
      const label = `page ${page.number}, ${zone.id}`;
      if (!box) {
        details.push(`${label} : zone absente du rendu`);
        continue;
      }
      const { rect: r } = box;
      const left = page.side === 'gauche';
      const short = (edge: string, gap: number) => {
        if (gap < BLEED_MM - t) details.push(`${label} : ${fmt(gap)} mm de fond perdu ${edge}, ${fmt(BLEED_MM)} attendus`);
      };
      if (zone.bleedEdges.includes('top')) short('en haut', page.trim.top - r.top);
      if (zone.bleedEdges.includes('bottom')) short('en bas', r.bottom - page.trim.bottom);
      if (zone.bleedEdges.includes('outer')) short('à l\'extérieur', left ? page.trim.left - r.left : r.right - page.trim.right);
      // Un élément à cheval traverse le pli par construction (ED1).
      const overFold = left ? r.right - page.foldMm : page.foldMm - r.left;
      if (!zone.double && overFold > t) details.push(`${label} : déborde de ${fmt(overFold)} mm côté pli`);
    }
  }
  return result('C4', 'Fond perdu à l\'extérieur, en haut et en bas, rien côté pli sauf un élément à cheval', details);
}

export function c6Transparency(facts: PdfFacts, measures: Measures): CheckResult {
  const details = [
    ...measures.faults.filter((f) => f.kind !== 'invisible').map((f) => `page ${f.page}, ${f.zone} : ${f.kind} ${f.value}`),
    ...facts.transparency.map((t) => `PDF, page ${t.page} : ${t.kind}`),
  ];
  return result('C6', 'Aucune transparence, dans le rendu et dans le PDF', unique(details));
}

/** `AAAAAA+Baloo-2-Bold` → `baloo2bold`. */
const pdfFontKey = (name: string) => name.replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function c7Fonts(facts: PdfFacts, measures: Measures, pack: { family: string; pdfName: string }[]): CheckResult {
  const details: string[] = [];
  if (!measures.fontsLoaded) details.push('une police du pack n\'a pas été chargée');
  for (const f of facts.fonts) {
    if (!pack.some((p) => pdfFontKey(f.name).startsWith(p.pdfName))) details.push(`${f.name} : hors du pack`);
    if (!f.embedded) details.push(`${f.name} : non embarquée`);
  }
  const families = pack.map((p) => p.family);
  for (const t of measures.texts) {
    const first = t.family.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
    if (!families.includes(first)) details.push(`page ${t.page}, ${t.zone} : police ${first} hors du pack`);
  }
  return result('C7', 'Polices du pack, toutes embarquées', unique(details));
}

/** Corps et filets sous le minimum de KDP : erreur. Texte courant sous la règle maison : alerte. */
export function c8Sizes(measures: Measures): CheckResult {
  const errors: string[] = [];
  const alerts: string[] = [];
  for (const t of measures.texts) {
    if (t.sizePt < KDP_MIN_TEXT_PT - SIZE_ROUNDING_PT) errors.push(`page ${t.page}, ${t.zone} : corps de ${fmt(t.sizePt)} pt, ${KDP_MIN_TEXT_PT} au moins`);
    else if (t.type === 'texte' && t.sizePt < BODY_MIN_PT - SIZE_ROUNDING_PT) alerts.push(`page ${t.page}, ${t.zone} : texte courant de ${fmt(t.sizePt)} pt, ${BODY_MIN_PT} attendus`);
  }
  for (const l of measures.lines) {
    if (l.widthPt < KDP_MIN_LINE_PT - SIZE_ROUNDING_PT) errors.push(`page ${l.page}, ${l.zone} : filet de ${fmt(l.widthPt)} pt, ${fmt(KDP_MIN_LINE_PT)} au moins`);
  }
  if (errors.length) return result('C8', 'Corps et filets', unique([...errors, ...alerts]));
  return result('C8', 'Corps et filets', unique(alerts), 'alerte');
}

/** Le dictionnaire d'information de Chromium est toléré (§12) : `facts.info` n'entre pas dans le verdict. */
export function c14Clean(facts: PdfFacts, measures: Measures): CheckResult {
  const details: string[] = [];
  if (facts.outlines) details.push('signets présents');
  if (facts.annotations.length) details.push(`annotations, page ${facts.annotations.join(', ')}`);
  if (facts.xmp) details.push('métadonnées XMP présentes');
  if (facts.optionalContent) details.push('calques (objets invisibles) présents');
  for (const f of measures.faults) if (f.kind === 'invisible') details.push(`page ${f.page}, ${f.zone} : objet invisible`);
  return result('C14', 'Sans signets, annotations, objets invisibles ni XMP', unique(details));
}

export function c15FileSize(facts: PdfFacts): CheckResult {
  const details = facts.sizeBytes > KDP_MAX_BYTES ? [`${(facts.sizeBytes / 1e6).toFixed(0)} Mo, 650 au plus`] : [];
  return result('C15', 'Taille du fichier', details);
}

export interface CheckInput {
  facts: PdfFacts;
  measures: Measures;
  pages: LayoutPage[];
  pack: { family: string; pdfName: string }[];
}

export function runChecks({ facts, measures, pages, pack }: CheckInput): CheckResult[] {
  return [
    c1PageSize(facts, pages),
    c3Safety(measures, pages),
    c4Bleed(measures, pages),
    c6Transparency(facts, measures),
    c7Fonts(facts, measures, pack),
    c8Sizes(measures),
    c14Clean(facts, measures),
    c15FileSize(facts),
  ];
}
