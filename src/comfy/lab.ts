// src/comfy/lab.ts — correction de couleurs, réglage (e) d'IL1 (spec §13.2) : luminance de l'illustration, chrominance du rendu 3D floutée,
// en Lab. Portage pur de `couleurs_3d` d'`il1-fin.py`, sans dépendance : même matrice sRGB vers XYZ, même blanc D65, même flou (boîte de
// rayon 4, trois passes par axe, lignes puis colonnes, bords répétés), même arrondi (`× 255 + 0,5`, puis troncature). Calcul en double précision.

/** Dosage du style du livre 1 (IL1, décision du 05/11/2026) : 100 %. IC2 le portera par style ; un repli à 50 % est une décision de David. */
export const COLOR_DOSAGE = 1;
export const BLUR_RADIUS = 4;

export interface RgbImage {
  width: number;
  height: number;
  /** RVB 8 bits entrelacé, sans alpha : `width × height × 3` octets. */
  data: Uint8Array;
}

const M = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
] as const;
const WHITE = [0.95047, 1.0, 1.08883] as const;

/** Inverse de `M` par les cofacteurs : NumPy passe par une décomposition LU, l'écart est de l'ordre de 1e-16. */
function invert(m: readonly (readonly number[])[]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m as number[][];
  const det = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
  return [
    [(e! * i! - f! * h!) / det, (c! * h! - b! * i!) / det, (b! * f! - c! * e!) / det],
    [(f! * g! - d! * i!) / det, (a! * i! - c! * g!) / det, (c! * d! - a! * f!) / det],
    [(d! * h! - e! * g!) / det, (b! * g! - a! * h!) / det, (a! * e! - b! * d!) / det],
  ];
}
const M_INV = invert(M);

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fLab = (x: number) => (x > 216 / 24389 ? Math.cbrt(x) : (841 / 108) * x + 4 / 29);
const fInv = (f: number) => (f > 6 / 29 ? f ** 3 : (108 / 841) * (f - 4 / 29));
const clip = (v: number) => Math.min(1, Math.max(0, v));
const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** Un pixel RVB (0 à 1) en Lab, comme `rgb_lab`. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const x = (lr * M[0][0] + lg * M[0][1] + lb * M[0][2]) / WHITE[0];
  const y = (lr * M[1][0] + lg * M[1][1] + lb * M[1][2]) / WHITE[1];
  const z = (lr * M[2][0] + lg * M[2][1] + lb * M[2][2]) / WHITE[2];
  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Un pixel Lab en RVB (0 à 1), comme `lab_rgb` : bornage avant et après la courbe sRGB. */
export function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const x = fInv(fy + a / 500) * WHITE[0];
  const y = fInv(fy) * WHITE[1];
  const z = fInv(fy - b / 200) * WHITE[2];
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = clip(gamma(clip(x * M_INV[k]![0]! + y * M_INV[k]![1]! + z * M_INV[k]![2]!)));
  return out;
}

/**
 * Flou de `flou` : une boîte de `2r + 1`, trois fois sur les lignes (axe 0), puis trois fois sur les colonnes (axe 1), bords répétés. Chaque
 * passe garde l'ordre des opérations de NumPy : somme cumulée sur la ligne complétée, puis différence et division.
 */
export function boxBlur(channel: Float64Array, width: number, height: number, radius: number): Float64Array {
  let c = Float64Array.from(channel);
  const size = 2 * radius + 1;
  const pass = (length: number, count: number, at: (line: number, k: number) => number) => {
    const out = new Float64Array(c.length);
    const sums = new Float64Array(length + size);
    for (let line = 0; line < count; line++) {
      // Complétée de `r + 1` valeurs avant et `r` après : la somme cumulée a `length + 2r + 1` termes.
      let sum = 0;
      for (let p = 0; p < length + size; p++) {
        const k = Math.min(length - 1, Math.max(0, p - radius - 1));
        sum += c[at(line, k)]!;
        sums[p] = sum;
      }
      for (let k = 0; k < length; k++) out[at(line, k)] = (sums[k + size]! - sums[k]!) / size;
    }
    c = out;
  };
  // Axe 0 de NumPy : le long de la hauteur, pour chaque colonne.
  for (let i = 0; i < 3; i++) pass(height, width, (column, k) => k * width + column);
  // Axe 1 : le long de la largeur, pour chaque ligne.
  for (let i = 0; i < 3; i++) pass(width, height, (row, k) => row * width + k);
  return c;
}

/** `couleurs_3d` : l'illustration garde sa luminance, sa chrominance devient celle du rendu floutée, au `dosage` près. Même taille exigée. */
export function transferColors(illustration: RgbImage, render: RgbImage, dosage = COLOR_DOSAGE, radius = BLUR_RADIUS): RgbImage {
  const { width, height } = illustration;
  if (render.width !== width || render.height !== height) throw new Error(`rendu en ${render.width} × ${render.height}, illustration en ${width} × ${height} : tailles différentes`);
  const n = width * height;
  const L = new Float64Array(n);
  const A = new Float64Array(n);
  const B = new Float64Array(n);
  const RA = new Float64Array(n);
  const RB = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const [l, a, b] = rgbToLab(illustration.data[3 * p]! / 255, illustration.data[3 * p + 1]! / 255, illustration.data[3 * p + 2]! / 255);
    L[p] = l;
    A[p] = a;
    B[p] = b;
    const [, ra, rb] = rgbToLab(render.data[3 * p]! / 255, render.data[3 * p + 1]! / 255, render.data[3 * p + 2]! / 255);
    RA[p] = ra;
    RB[p] = rb;
  }
  const blurA = boxBlur(RA, width, height, radius);
  const blurB = boxBlur(RB, width, height, radius);
  const data = new Uint8Array(3 * n);
  for (let p = 0; p < n; p++) {
    const a = (1 - dosage) * A[p]! + dosage * blurA[p]!;
    const b = (1 - dosage) * B[p]! + dosage * blurB[p]!;
    const rgb = labToRgb(L[p]!, a, b);
    // `(x * 255 + 0.5).astype(np.uint8)` : troncature, sur une valeur déjà bornée à [0, 1].
    for (let k = 0; k < 3; k++) data[3 * p + k] = Math.trunc(rgb[k]! * 255 + 0.5);
  }
  return { width, height, data };
}
