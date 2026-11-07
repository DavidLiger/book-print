// src/images/png.ts — lecture directe des fragments d'un PNG, sans sharp : signature, en-tête `IHDR`, liste des fragments. Le fichier gardé ne
// porte que `IHDR`, `IDAT` et `IEND` : sharp réécrit toujours un `pHYs` (résolution), et aucune résolution ni métadonnée ne doit rester (spec §5.2).
import fs from 'node:fs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature, puis longueur, nom, données d'`IHDR` et son CRC. */
const HEADER_BYTES = 33;
const KEPT = new Set(['IHDR', 'IDAT', 'IEND']);
/** `colorType` de l'en-tête : RVB, sans alpha ni palette. */
export const COLOR_RGB = 2;

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

export const isPng = (bytes: Buffer) => bytes.length >= SIGNATURE.length && bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE);

/** `null` : pas un PNG, ou premier fragment autre qu'`IHDR`. */
export function readPngHeader(bytes: Buffer): PngHeader | null {
  if (bytes.length < HEADER_BYTES || !isPng(bytes) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bitDepth: bytes[24]!, colorType: bytes[25]! };
}

/** Lit seulement le début du fichier : le contrôle du parcours ne charge pas l'image. */
export function readPngHeaderOfFile(file: string): PngHeader | null {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(HEADER_BYTES);
    return readPngHeader(bytes.subarray(0, fs.readSync(fd, bytes, 0, HEADER_BYTES, 0)));
  } finally {
    fs.closeSync(fd);
  }
}

function eachChunk(bytes: Buffer, visit: (type: string, start: number, end: number) => void): void {
  let at = SIGNATURE.length;
  while (at + 12 <= bytes.length) {
    const end = at + 12 + bytes.readUInt32BE(at);
    if (end > bytes.length) throw new Error('PNG tronqué');
    visit(bytes.toString('latin1', at + 4, at + 8), at, end);
    at = end;
  }
}

/** Noms des fragments, dans l'ordre du fichier. Les tests s'en servent pour ne pas se fier à sharp. */
export function pngChunks(bytes: Buffer): string[] {
  const names: string[] = [];
  eachChunk(bytes, (type) => names.push(type));
  return names;
}

export function keepImageChunks(bytes: Buffer): Buffer {
  const parts = [bytes.subarray(0, SIGNATURE.length)];
  eachChunk(bytes, (type, start, end) => {
    if (KEPT.has(type)) parts.push(bytes.subarray(start, end));
  });
  return Buffer.concat(parts);
}
