// src/images/crop.ts — cadrage d'une image dans sa zone, fonctions pures. Le rendu et C5 partent de ce seul calcul : la résolution contrôlée
// est celle de ce qui est imprimé. On raisonne sur le fichier source : Chromium n'embarque pas forcément toute l'image (spec §16.6).
import { MM_PER_IN } from '../templates/geometry';

export const TARGET_PPI = 300;
export const MAX_PPI = 600;

export interface Framing {
  /** Point à garder au centre, en fraction de l'image source : 0 à gauche ou en haut, 1 à droite ou en bas. */
  focusX: number;
  focusY: number;
  /** 1 : l'image remplit la zone au plus juste. Le zoom réduit la résolution effective. */
  zoom: number;
}
export const DEFAULT_FRAMING: Framing = { focusX: 0.5, focusY: 0.5, zoom: 1 };

export interface Size {
  width: number;
  height: number;
}
export interface ZoneSizeMm {
  widthMm: number;
  heightMm: number;
}
/** Partie visible de l'image, en pixels du fichier. */
export interface Crop {
  left: number;
  top: number;
  width: number;
  height: number;
}
/** Place de l'image entière, en mm, depuis le coin haut gauche de sa zone : tout ce qui dépasse est coupé. */
export interface Placement {
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function visibleCrop(image: Size, zone: ZoneSizeMm, framing: Framing): Crop {
  // Comme `object-fit: cover`, puis le zoom : la partie visible a toujours le rapport de la zone, aucune transparence n'est possible.
  const fit = Math.min(image.width / zone.widthMm, image.height / zone.heightMm);
  const width = (zone.widthMm * fit) / framing.zoom;
  const height = (zone.heightMm * fit) / framing.zoom;
  return {
    left: clamp(framing.focusX * image.width - width / 2, 0, image.width - width),
    top: clamp(framing.focusY * image.height - height / 2, 0, image.height - height),
    width,
    height,
  };
}

/** Le rapport étant celui de la zone, la résolution est la même sur les deux axes. Arrondie au centième : 300 ne doit pas devenir 299,9999. */
export function effectivePpi(crop: Crop, zone: ZoneSizeMm): number {
  return Math.round(((crop.width * MM_PER_IN) / zone.widthMm) * 100) / 100;
}

/** Image entière dans sa boîte (détouré, ED2) : la plus grande taille qui tient, même résolution sur les deux axes, arrondie au centième. */
export function containPpi(image: Size, zone: ZoneSizeMm): number {
  const scale = Math.min(zone.widthMm / image.width, zone.heightMm / image.height);
  return Math.round((MM_PER_IN / scale) * 100) / 100;
}

export function placement(image: Size, zone: ZoneSizeMm, crop: Crop): Placement {
  const scale = zone.widthMm / crop.width;
  return { leftMm: -crop.left * scale, topMm: -crop.top * scale, widthMm: image.width * scale, heightMm: image.height * scale };
}

/** Taille à fournir pour 300 ppp, calculée depuis la zone, au pixel supérieur : 6,125" donne 1838 px (§6.4). */
export function targetPixels(zone: ZoneSizeMm): Size {
  const px = (mm: number) => Math.ceil(Math.round((mm / MM_PER_IN) * TARGET_PPI * 1e6) / 1e6);
  return { width: px(zone.widthMm), height: px(zone.heightMm) };
}
