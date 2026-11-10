// src/checks/overlaps.ts — C17, chevauchements interdits (ED1, spec §24.10). Pur, sans Chromium : il lit la géométrie posée d'une mise en
// page, page par page. « Au-dessus » veut dire plus loin dans la liste des éléments. Les cas interdits sont exactement ceux de la spec ; tout
// autre chevauchement est permis. Un folio sous le QR est permis (décision de David, ED1) : le QR est un cartouche opaque, le numéro est centré.
import type { LayoutPage, LayoutZone, Rect } from '../templates/geometry';
import type { CheckResult } from './rules';

/** Recouvrement admis sans faute : l'arrondi des boîtes, comme C3 et C4. */
export const OVERLAP_TOLERANCE_MM = 0.05;

/** Éléments à texte de la règle « texte sur texte ». */
export const TEXT_TYPES = ['titre', 'bandeau', 'chapeau', 'texte', 'encadre', 'fiche', 'chiffre-cle', 'legende', 'etiquette', 'folio'];
/** Ce qui peut être sous le QR. */
const UNDER_QR = ['fond', 'bandeau', 'illustration', 'folio'];

function overlap(a: Rect, b: Rect): boolean {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > OVERLAP_TOLERANCE_MM && h > OVERLAP_TOLERANCE_MM;
}

/** Faute d'un chevauchement, `below` sous `above` ; `null` s'il est permis. */
export function overlapFault(below: LayoutZone, above: LayoutZone): string | null {
  const name = `${above.id} (${above.type}) sur ${below.id} (${below.type})`;
  if (below.type === 'qr') return `${name} : rien au-dessus du QR`;
  if (above.type === 'qr') return UNDER_QR.includes(below.type) ? null : `${name} : sous le QR, seulement un fond, un bandeau, une illustration ou un folio`;
  if (TEXT_TYPES.includes(below.type) && TEXT_TYPES.includes(above.type)) {
    // Un texte sur un bandeau est permis : le bandeau est le fond du titre.
    if (below.type === 'bandeau') return null;
    return above.type === 'encadre' && below.type === 'texte' ? `${name} : un encadré sur un cadre de texte` : `${name} : deux éléments à texte se chevauchent`;
  }
  if (above.type === 'illustration' && TEXT_TYPES.includes(below.type)) return `${name} : une illustration sur un élément à texte`;
  return null;
}

/** Chevauchements interdits d'une mise en page posée. Un élément à cheval est vu sur ses deux pages : une faute n'est dite qu'une fois. */
export function overlapFaults(pages: LayoutPage[]): string[] {
  const out = new Set<string>();
  for (const page of pages) {
    page.zones.forEach((above, j) => {
      for (const below of page.zones.slice(0, j)) {
        if (!overlap(below.rect, above.rect)) continue;
        const fault = overlapFault(below, above);
        if (fault) out.add(fault);
      }
    });
  }
  return [...out];
}

export function c17Overlaps(pages: LayoutPage[]): CheckResult {
  const details = overlapFaults(pages);
  return { id: 'C17', label: 'Aucun chevauchement interdit', level: details.length ? 'erreur' : 'ok', details };
}
