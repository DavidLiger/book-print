// scripts/fixtures/make-png.ts — PNG fabriqués sans sharp (MP4), par node:zlib : RVB sans alpha, ou RVBA pour le cas rouge de C6.
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffers: Buffer[]): number {
  let c = 0xffffffff;
  for (const b of buffers) for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const name = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([name, data]));
  return Buffer.concat([head, name, data, crc]);
}

export type Pixel = (x: number, y: number) => [number, number, number] | [number, number, number, number];

/** `channels` : 3 pour RVB sans alpha, 4 pour RVBA. */
export function makePng(width: number, height: number, channels: 3 | 4, pixel: Pixel): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6;
  const raw = Buffer.alloc((width * channels + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      for (let c = 0; c < channels; c++) raw[at++] = p[c] ?? 255;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export const pngDataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
