// src/comfy/colors.ts — décodage et encodage autour de la correction Lab (`lab.ts`), par sharp, chargé à la demande comme dans `images/clean.ts`.
// Le décodage suit `Image.open(...).convert("RGB")` d'`il1-fin.py` : l'alpha est retiré, sans aplatissement. La sortie est un PNG RVB 8 bits,
// niveau 6 avec filtre adaptatif, sans autre fragment qu'`IHDR`, `IDAT` et `IEND`.
import { keepImageChunks } from '../images/png';
import { MAX_INPUT_PIXELS } from '../images/clean';
import { transferColors, type RgbImage } from './lab';

export async function decodeRgb(png: Buffer): Promise<RgbImage> {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(png, { limitInputPixels: MAX_INPUT_PIXELS }).removeAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`décodage en ${info.channels} canaux, 3 attendus`);
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

export async function encodePng(image: RgbImage): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const out = await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), { raw: { width: image.width, height: image.height, channels: 3 } })
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();
  return keepImageChunks(out);
}

/** L'illustration générée, corrigée par les couleurs du rendu 3D, à la taille de génération : avant l'agrandissement (§13.2). */
export async function correctColors(generated: Buffer, render: Buffer, dosage?: number): Promise<Buffer> {
  return encodePng(transferColors(await decodeRgb(generated), await decodeRgb(render), dosage));
}
