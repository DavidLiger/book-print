// src/comfy/size.ts — tailles de la chaîne d'IL1 (spec §13.2), fonctions pures. Le rendu Blender a une taille native de SDXL, propre au format
// et au type de zone. L'image finale est au rapport exact de la zone, à la taille cible plus une marge de cadrage : sans elle, une image à la
// taille exacte n'a aucune marge (MP4 : zoom 1,01, 297 ppp, C5 rouge). Aucune taille finale n'est écrite en dur : tout part de la zone.
import { TARGET_PPI, type Size, type ZoneSizeMm } from '../images/crop';
import { MM_PER_IN, pageSize, type Trim } from '../templates/geometry';

/** Marge de cadrage : 300 ppp × 1,15 = 345 ppp à zoom 1, et le zoom reste possible jusqu'à 1,15 sans passer sous 300 ppp. */
export const OUTPUT_MARGIN = 1.15;

export type ZoneKind = 'page' | 'double' | 'libre';
export const ZONE_KIND_LABELS: Record<ZoneKind, string> = { page: 'page pleine', double: 'double page', libre: 'taille libre' };

/** Tailles natives de SDXL (multiples de 64, environ un mégapixel) : la taille libre retient celle dont le rapport est le plus proche de la zone. */
export const SDXL_SIZES: Size[] = [
  { width: 1024, height: 1024 },
  { width: 1152, height: 896 },
  { width: 896, height: 1152 },
  { width: 1216, height: 832 },
  { width: 832, height: 1216 },
  { width: 1344, height: 768 },
  { width: 768, height: 1344 },
  { width: 1536, height: 640 },
  { width: 640, height: 1536 },
];

/** Tailles de rendu du §13.2 : rendu natif, sans recadrage. Un autre format n'a pas de taille retenue : la génération y est indisponible. */
const RENDER_SIZES: { trim: Trim; page: Size; double: Size }[] = [
  { trim: { widthIn: 6, heightIn: 9 }, page: { width: 832, height: 1216 }, double: { width: 1152, height: 896 } },
  { trim: { widthIn: 8.5, heightIn: 11 }, page: { width: 896, height: 1152 }, double: { width: 1216, height: 832 } },
];

/** Tolérance sur la taille d'une zone, en mm : la géométrie calcule au millionième. */
const ZONE_TOLERANCE_MM = 0.5;

export function renderSize(trim: Trim, kind: 'page' | 'double'): Size | null {
  const row = RENDER_SIZES.find((r) => r.trim.widthIn === trim.widthIn && r.trim.heightIn === trim.heightIn);
  return row ? row[kind] : null;
}

/** Taille de rendu d'une zone libre : la taille native de SDXL au rapport le plus proche (écart des logarithmes), la première en cas d'égalité. */
export function libreSize(zone: ZoneSizeMm): Size {
  const target = Math.log(zone.widthMm / zone.heightMm);
  let best = SDXL_SIZES[0]!;
  let gap = Infinity;
  for (const s of SDXL_SIZES) {
    const g = Math.abs(Math.log(s.width / s.height) - target);
    if (g < gap - 1e-12) {
      best = s;
      gap = g;
    }
  }
  return best;
}

/** Taille de rendu d'une zone selon son type : table du §13.2 (`null` hors formats retenus) ou taille libre. */
export function zoneRenderSize(zone: ZoneSizeMm, trim: Trim): Size | null {
  const kind = zoneKind(zone, trim);
  return kind === 'libre' ? libreSize(zone) : renderSize(trim, kind);
}

/** Page pleine : la zone couvre la page avec son fond perdu. Double page : deux pages côte à côte, à cheval sur le pli. Sinon, taille libre. */
export function zoneKind(zone: ZoneSizeMm, trim: Trim): ZoneKind {
  const page = pageSize(trim);
  const w = page.widthIn * MM_PER_IN;
  const h = page.heightIn * MM_PER_IN;
  const near = (a: number, b: number) => Math.abs(a - b) <= ZONE_TOLERANCE_MM;
  if (near(zone.heightMm, h) && near(zone.widthMm, w)) return 'page';
  if (near(zone.heightMm, h) && near(zone.widthMm, 2 * w)) return 'double';
  return 'libre';
}

/** Taille de l'image finale : celle de la zone à 300 ppp × `OUTPUT_MARGIN`, au pixel supérieur, comme `targetPixels`. */
export function outputPixels(zone: ZoneSizeMm): Size {
  const ppi = TARGET_PPI * OUTPUT_MARGIN;
  const px = (mm: number) => Math.ceil(Math.round((mm / MM_PER_IN) * ppi * 1e6) / 1e6);
  return { width: px(zone.widthMm), height: px(zone.heightMm) };
}

export const sizeText = (s: Size) => `${s.width} × ${s.height} px`;
