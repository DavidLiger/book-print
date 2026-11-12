// src/checks/qr.ts — C9 (spec §7, ED6) : le QR du sujet existe, est assez grand, et se lit : il décode l'URL de la scène. Le verdict est pur ;
// la lecture du cartouche (pixels → texte) est `decodeQr`, par `sharp` puis `jsqr`. Une erreur par cause, nommée.
import jsQR from 'jsqr';
import sharp from 'sharp';
import type { CheckResult } from './rules';

/** Côté imprimé minimal d'un QR (spec §7, C9). */
export const QR_MIN_SIDE_MM = 25;

export interface QrInput {
  /** La scène du sujet ; `null` : le sujet n'en a pas, il n'a donc pas de QR à contrôler. */
  sceneId: string | null;
  /** Fichier attendu dans `dist/qr/<bookId>/`, pour nommer l'absence. */
  expectedFile: string;
  /** Le QR lu dans GLBInterpreter ; `null` : absent. */
  qr: { file: string; url: string } | null;
  /** Pourquoi le SVG n'a pas pu être lu, s'il existe mais est refusé. */
  fault: string | null;
  /** URL attendue : `<origin>/s/<sceneId>`. */
  expectedUrl: string | null;
  /** Le cartouche capturé ; `null` : la mise en page n'en pose pas. */
  capture: { sideMm: number } | null;
  /** Le texte lu dans le cartouche ; `null` : rien n'a pu être décodé. */
  decoded: string | null;
}

/** Ce que les données seules disent : le QR existe, se lit comme SVG, porte l'URL de la scène. Sans Chromium : le parcours peut le recalculer. */
export function qrDataFaults({ sceneId, qr, fault, expectedUrl, expectedFile }: Pick<QrInput, 'sceneId' | 'qr' | 'fault' | 'expectedUrl' | 'expectedFile'>): string[] {
  if (sceneId === null) return ['sujet sans scène : pas de QR à poser'];
  if (fault) return [`QR illisible : ${fault}`];
  if (!qr) return [`QR absent : ${expectedFile} introuvable dans dist/qr/ de GLBInterpreter`];
  if (expectedUrl !== null && qr.url !== expectedUrl) return [`urls.txt donne ${qr.url} pour ${qr.file}, ${expectedUrl} attendu`];
  return [];
}

export function c9Qr(input: QrInput): CheckResult {
  const details = qrDataFaults(input);
  const { capture, decoded, expectedUrl } = input;
  if (details.length === 0) {
    if (!capture) details.push('aucun cartouche QR dans la mise en page');
    else {
      if (capture.sideMm < QR_MIN_SIDE_MM - 0.05) details.push(`côté imprimé de ${capture.sideMm.toFixed(1).replace('.', ',')} mm, ${QR_MIN_SIDE_MM} au moins`);
      if (decoded === null) details.push('QR illisible : rien n\'a pu être décodé dans le cartouche');
      else if (expectedUrl !== null && decoded !== expectedUrl) details.push(`le QR décodé donne ${decoded}, ${expectedUrl} attendu`);
    }
  }
  return { id: 'C9', label: 'QR présent, assez grand, lisible', level: details.length ? 'erreur' : 'ok', details };
}

/** Pixels du cartouche → texte du QR, ou `null`. */
export async function decodeQr(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
  return found ? found.data : null;
}
