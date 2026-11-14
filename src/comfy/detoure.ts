// src/comfy/detoure.ts — détouré généré (ED5, spec §32) : le rendu Blender est un PNG RVBA ; ComfyUI reçoit un RVB aplati sur un gris réglable
// (`fondDetoure` du style), et l'alpha du rendu suit la chaîne de la taille : ×2 en lanczos3, recadrage centré comme `common_upscale` de ComfyUI,
// puis lanczos3 à la taille de sortie. Fonctions pures sur des tampons ; sharp n'est chargé qu'à l'appel.
import { createHash } from 'node:crypto';
import type { Size } from '../images/crop';

/** Type de couleur PNG « RVBA » : le rendu d'une zone détourée doit l'être. */
export const COLOR_RGBA = 6;

/** `round` de Python (arrondi au pair le plus proche), comme ComfyUI. */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}

/** Recadrage centré de `common_upscale` (crop = center) : fenêtre {x, y, width, height} de l'image `from` au rapport de `to`. */
export function centerCrop(from: Size, to: Size): { x: number; y: number; width: number; height: number } {
  const oldAspect = from.width / from.height;
  const newAspect = to.width / to.height;
  let x = 0;
  let y = 0;
  if (oldAspect > newAspect) x = pyRound((from.width - from.width * (newAspect / oldAspect)) / 2);
  else if (oldAspect < newAspect) y = pyRound((from.height - from.height * (oldAspect / newAspect)) / 2);
  return { x, y, width: from.width - 2 * x, height: from.height - 2 * y };
}

/** Rendu RVBA aplati sur un gris uni (0 à 255) : RVB 8 bits sans alpha, à la taille du rendu. */
export async function flattenOnGray(rgba: Buffer, gray: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp(rgba).flatten({ background: { r: gray, g: gray, b: gray } }).removeAlpha().toColourspace('srgb').png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
}

/** Alpha du rendu à la taille de sortie : ×2 lanczos3, recadrage centré au rapport de la sortie, lanczos3 à la sortie. Un octet par pixel. */
export async function alphaForOutput(rgba: Buffer, render: Size, output: Size): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const raw = await sharp(rgba).ensureAlpha().extractChannel(3).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (raw.info.width !== render.width || raw.info.height !== render.height) throw new Error(`Rendu RVBA en ${raw.info.width} × ${raw.info.height} px, ${render.width} × ${render.height} attendus.`);
  const big: Size = { width: render.width * 2, height: render.height * 2 };
  const enlarged = await sharp(raw.data, { raw: { width: render.width, height: render.height, channels: 1 } }).resize(big.width, big.height, { kernel: 'lanczos3', fit: 'fill' }).extractChannel(0).raw().toBuffer();
  const c = centerCrop(big, output);
  return sharp(enlarged, { raw: { width: big.width, height: big.height, channels: 1 } })
    .extract({ left: c.x, top: c.y, width: c.width, height: c.height })
    .resize(output.width, output.height, { kernel: 'lanczos3', fit: 'fill' })
    .extractChannel(0)
    .raw()
    .toBuffer();
}

/** Niveaux de gris distincts d'une Mist sous lesquels elle n'a pas de dégradé (ED5, question 6) : celle, ratée, de DT0 en avait 2. */
export const MIST_MIN_LEVELS = 16;

/** Nombre de niveaux distincts du premier canal d'une passe Mist. */
export async function mistLevels(png: Buffer): Promise<number> {
  const { default: sharp } = await import('sharp');
  const raw = await sharp(png).removeAlpha().extractChannel(0).raw({ depth: 'uchar' }).toBuffer();
  const seen = new Uint8Array(256);
  for (const v of raw) seen[v] = 1;
  return seen.reduce((n, v) => n + v, 0);
}

/** Mêmes refus que le dépôt d'un détouré (ED2) : rendu sans alpha, opaque partout ou transparent partout. Rend `null` si le rendu convient. */
export async function renderAlphaFault(rgba: Buffer): Promise<string | null> {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(rgba).metadata();
  if (!meta.hasAlpha) return 'Rendu sans transparence : une zone détourée demande un PNG RVBA.';
  const alpha = await sharp(rgba).ensureAlpha().extractChannel(3).raw({ depth: 'uchar' }).toBuffer();
  let opaque = 0;
  for (const v of alpha) if (v >= 128) opaque++;
  if (opaque === 0) return 'Rendu transparent partout : rien à détourer.';
  if (opaque === alpha.length) return 'Rendu opaque partout : rien à détourer.';
  return null;
}

export const fingerprint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
