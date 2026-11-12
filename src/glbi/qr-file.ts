// src/glbi/qr-file.ts — lit le SVG d'un QR réel dans `dist/qr/<bookId>/` de GLBInterpreter (ED6). Lecture seule, par `resolveUnder` : le dossier
// d'essai est refusé, un lien ne fait pas sortir. Le SVG est ensuite collé tel quel dans le HTML : il ne porte ni script, ni image, ni lien.
import fs from 'node:fs';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
import { resolveUnder } from './paths';

export const QR_MAX_BYTES = 512 * 1024;

/** Ce qu'un QR ne doit pas contenir pour être collé tel quel dans la page. */
const FORBIDDEN = /<script|<foreignObject|<image\b|<a\b|\son[a-z]+\s*=|href\s*=|<!ENTITY/i;

export type QrSvg = { svg: string } | { error: string };

export function readQrSvg(glbRoot: string, bookId: string, file: string): QrSvg {
  let text: string;
  try {
    const real = resolveUnder(glbRoot, `dist/qr/${bookId}/${file}`);
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { error: `${file} n'est pas un fichier.` };
    if (stat.size > QR_MAX_BYTES) return { error: `${file} pèse ${stat.size} octets, ${QR_MAX_BYTES} au plus.` };
    text = fs.readFileSync(real, 'utf8');
  } catch (e) {
    return { error: message(e) };
  }
  const body = text.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*\?>\s*/, '').replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  if (!/^\s*<svg\b/i.test(body)) return { error: `${file} n'est pas un SVG.` };
  if (!/\bviewBox\s*=/.test(body.slice(0, body.indexOf('>') + 1))) return { error: `${file} n'a pas de viewBox : sa taille imprimée ne serait pas contrôlable.` };
  if (FORBIDDEN.test(body)) return { error: `${file} contient un élément refusé (script, image ou lien).` };
  return { svg: body.trim() };
}
