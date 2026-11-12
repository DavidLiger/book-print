// scripts/fixtures/qr-encode.ts — QR minimal pour les tests : mode octets, niveau L, versions 1 à 5 (un seul bloc), masque 0. Il produit de vrais
// QR, que `jsqr` relit : c'est ce qui permet de tester C9 sans toucher à GLBInterpreter ni à un vrai QR.
const DATA_CODEWORDS = [0, 19, 34, 55, 80, 108];
const EC_CODEWORDS = [0, 7, 10, 15, 20, 26];

const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function reedSolomon(data: number[], degree: number): number[] {
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    gen.forEach((g, j) => {
      next[j] ^= g;
      next[j + 1] ^= mul(g, EXP[i]!);
    });
    gen = next;
  }
  const rest = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest.shift()!;
    rest.push(0);
    gen.slice(1).forEach((g, i) => {
      rest[i] ^= mul(g, factor);
    });
  }
  return rest;
}

function codewords(text: string, version: number): number[] {
  const bytes = [...Buffer.from(text, 'utf8')];
  const capacity = DATA_CODEWORDS[version]!;
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  return [...data, ...reedSolomon(data, EC_CODEWORDS[version]!)];
}

/** Matrice du QR : `true` pour un module noir. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Buffer.byteLength(text, 'utf8');
  const version = [1, 2, 3, 4, 5].find((v) => 4 + 8 + bytes * 8 <= DATA_CODEWORDS[v]! * 8);
  if (!version) throw new Error(`QR de test : ${bytes} octets, 106 au plus`);
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Format : niveau L (01), masque 0 (000).
  const data = (0b01 << 3) | 0;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((format >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
  const all = codewords(text, version);
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && n < all.length * 8) {
          modules[y]![x] = ((all[n >>> 3]! >>> (7 - (n & 7))) & 1) !== 0;
          n++;
        }
      }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y]![x] && (x + y) % 2 === 0) modules[y]![x] = !modules[y]![x];
  return modules;
}

/** SVG d'un vrai QR, fond blanc et marge de 4 modules, comme ceux de `dist/qr/`. `scale` : taille de la marge, 4 par défaut. */
export function qrSvg(text: string, quiet = 4): string {
  const matrix = qrMatrix(text);
  const n = matrix.length;
  const total = n + 2 * quiet;
  const cells: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => dark && cells.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h${total}v${total}H0z"/><path fill="#000000" d="${cells.join('')}"/></svg>`;
}
