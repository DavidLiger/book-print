// src/images/clean.ts — nettoyage d'une illustration déposée (spec §5.2, étape 6) : toute profondeur et tout mode en entrée, en sortie un PNG
// RVB 8 bits sans alpha, sRGB, sans métadonnée. Les dimensions se lisent en pixels : toute valeur de ppp du fichier est ignorée.
// sharp reçoit un tampon et non un chemin : sous Windows, il garderait le fichier ouvert et le temporaire ne s'effacerait pas.
// Filtre adaptatif, comme ComfyUI : sans lui, un PNG réel de 11,9 Mo en faisait 18,9 (batterie de MP4). L'image va telle quelle dans le PDF (C15).
import { contourOf, ContourRefused, type Contour } from './contour';
import { COLOR_RGB, isPng, keepImageChunks, readPngHeader } from './png';

export class ImageRefused extends Error {}

/** 5175 × 3375 × 3 tient dedans : la double page de 8,5 × 11" (§6.4). */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Contre une image piégée : au-delà, le décodage demanderait des Go. */
export const MAX_INPUT_PIXELS = 64_000_000;

export interface CleanedPng {
  png: Buffer;
  width: number;
  height: number;
}

function checkHeader(input: Buffer): void {
  if (!isPng(input)) throw new ImageRefused('Ce fichier n\'est pas un PNG.');
  const header = readPngHeader(input);
  if (!header || header.width === 0 || header.height === 0) throw new ImageRefused('PNG illisible : en-tête invalide.');
  const pixels = header.width * header.height;
  if (pixels > MAX_INPUT_PIXELS) throw new ImageRefused(`Image trop grande : ${header.width} × ${header.height} px, ${MAX_INPUT_PIXELS / 1_000_000} Mpx au plus.`);
}

export async function cleanPng(input: Buffer): Promise<CleanedPng> {
  checkHeader(input);
  // Chargé ici : le reste de l'outil démarre sans sharp.
  const { default: sharp } = await import('sharp');
  let output: Buffer;
  try {
    output = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb').png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  } catch (e) {
    throw new ImageRefused(`PNG illisible : ${(e as Error).message}.`);
  }
  const png = keepImageChunks(output);
  const clean = readPngHeader(png);
  if (!clean || clean.bitDepth !== 8 || clean.colorType !== COLOR_RGB) throw new ImageRefused('Nettoyage impossible : sortie autre que RVB 8 bits.');
  return { png, width: clean.width, height: clean.height };
}

export interface CleanedDetoure {
  image: CleanedPng;
  contour: Contour;
}

/**
 * Dépôt d'une image détourée (ED2, spec §24.6) : un PNG avec alpha, exigé. Le contour vient de l'alpha d'origine ; l'image gardée est ensuite
 * nettoyée comme toute illustration (RVB 8 bits, alpha aplati sur blanc, `IHDR IDAT IEND`). Rien n'est écrit ici.
 */
export async function cleanDetoure(input: Buffer): Promise<CleanedDetoure> {
  checkHeader(input);
  const { default: sharp } = await import('sharp');
  let alpha: { data: Buffer; info: { width: number; height: number } };
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!meta.hasAlpha) throw new ImageRefused('PNG sans transparence : rien à détourer.');
    alpha = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).ensureAlpha().extractChannel(3).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  } catch (e) {
    if (e instanceof ImageRefused) throw e;
    throw new ImageRefused(`PNG illisible : ${(e as Error).message}.`);
  }
  let contour: Contour;
  try {
    contour = contourOf(new Uint8Array(alpha.data.buffer, alpha.data.byteOffset, alpha.data.length), alpha.info.width, alpha.info.height);
  } catch (e) {
    if (e instanceof ContourRefused) throw new ImageRefused(e.message);
    throw e;
  }
  const image = await cleanPng(input);
  if (image.width !== contour.width || image.height !== contour.height) throw new ImageRefused('Nettoyage impossible : taille différente de l\'alpha.');
  return { image, contour };
}
