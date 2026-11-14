// src/images/contour.ts — contour d'une image détourée (ED2, spec §24.6). Pur : il reçoit l'alpha brut (un octet par pixel, lu par sharp) et
// rend un polygone en pixels de l'image. Seuil à 50 % ; plus grande partie opaque (8-connexité) ; retrait d'un pixel vers l'intérieur
// (érosion), contre le liseré que l'aplatissement sur blanc laisse dans les pixels du bord ; contour extérieur suivi sur les arêtes des
// pixels, les trous ignorés ; simplification de Douglas-Peucker à 0,5 px. Les autres parties opaques sont rendues, pour l'alerte.
// Aussi : la place d'une image entière dans sa boîte et le contour ramené à la page (rendu, habillage, C17), et deux tests de géométrie.
import type { Outline, Rect } from '../templates/geometry';

export class ContourRefused extends Error {}

/** 50 % d'alpha : un pixel est opaque à partir de 128. */
export const ALPHA_THRESHOLD = 128;
export const SIMPLIFY_PX = 0.5;
/** Un trou compte à partir de 0,5 % de la surface de l'image : en dessous, le polygone le comble (ED5). */
export const HOLE_MIN_RATIO = 0.005;

export interface Part {
  pixels: number;
  gauche: number;
  haut: number;
  droite: number;
  bas: number;
}
export interface Contour {
  width: number;
  height: number;
  seuil: number;
  /** Sommets du polygone, en pixels depuis le coin haut gauche de l'image (bords des pixels). */
  points: [number, number][];
  /** Parties opaques détachées de la plus grande, de la plus grande à la plus petite : découpées par le contour. */
  autresParties: Part[];
  /** Trous de la plus grande partie (ED5), mêmes unités que `points` : découpés en règle pair-impair. Vide pour un détouré déposé sans trou. */
  trous: [number, number][][];
}

/** Parties opaques, en 8-connexité. `mark` reçoit l'étiquette de chaque pixel (1, 2…), 0 pour un pixel transparent. */
function label(mask: Uint8Array, width: number, height: number): { mark: Int32Array; parts: Part[] } {
  const mark = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  const parts: Part[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || mark[start]) continue;
    const id = parts.length + 1;
    const part: Part = { pixels: 0, gauche: width, haut: height, droite: 0, bas: 0 };
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    mark[start] = id;
    while (head < tail) {
      const at = queue[head++]!;
      const x = at % width;
      const y = (at - x) / width;
      part.pixels++;
      if (x < part.gauche) part.gauche = x;
      if (y < part.haut) part.haut = y;
      if (x + 1 > part.droite) part.droite = x + 1;
      if (y + 1 > part.bas) part.bas = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const n = ny * width + nx;
          if (mask[n] && !mark[n]) {
            mark[n] = id;
            queue[tail++] = n;
          }
        }
      }
    }
    parts.push(part);
  }
  return { mark, parts };
}

/** Érosion d'un pixel : un pixel reste s'il est dans la partie, comme ses quatre voisins. */
function erode(inside: (x: number, y: number) => boolean, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inside(x, y) && inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1)) out[y * width + x] = 1;
    }
  }
  return out;
}

/** Directions dans l'ordre horaire (y vers le bas) : droite, bas, gauche, haut. */
const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * Contour extérieur d'une partie, sur les arêtes des pixels, la partie à droite du sens de marche. À chaque sommet, on essaie de tourner à
 * gauche, puis tout droit, puis à droite : deux pixels qui ne se touchent que par un coin restent ensemble (8-connexité).
 */
function trace(mask: Uint8Array, width: number, height: number, startIndex: number): [number, number][] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  // Pixel à droite et à gauche de l'arête qui part du sommet (x, y) dans la direction d.
  const sides = (x: number, y: number, d: number): [boolean, boolean] => {
    switch (d) {
      case 0: return [inside(x, y), inside(x, y - 1)];
      case 1: return [inside(x - 1, y), inside(x, y)];
      case 2: return [inside(x - 1, y - 1), inside(x - 1, y)];
      default: return [inside(x, y - 1), inside(x - 1, y - 1)];
    }
  };
  const sx = startIndex % width;
  const sy = (startIndex - sx) / width;
  const points: [number, number][] = [[sx, sy]];
  let x = sx;
  let y = sy;
  let d = 0;
  const limit = 4 * (width + 1) * (height + 1);
  for (let step = 0; step < limit; step++) {
    x += DIRS[d]![0];
    y += DIRS[d]![1];
    let next = -1;
    for (const turn of [3, 0, 1]) {
      const c = (d + turn) % 4;
      const [right, left] = sides(x, y, c);
      if (right && !left) {
        next = c;
        break;
      }
    }
    if (next < 0) throw new ContourRefused('Contour impossible à suivre.');
    if (x === sx && y === sy && next === 0) return points;
    if (next !== d) points.push([x, y]);
    d = next;
  }
  throw new ContourRefused('Contour impossible à suivre.');
}

function distance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Douglas-Peucker sur une suite ouverte : garde les extrémités. */
function simplifyOpen(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let best = epsilon;
    for (let i = a + 1; i < b; i++) {
      const dist = distance(points[i]!, points[a]!, points[b]!);
      if (dist > best) {
        best = dist;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas-Peucker sur un polygone fermé : coupé au premier sommet et au sommet le plus éloigné de lui. */
export function simplify(points: [number, number][], epsilon = SIMPLIFY_PX): [number, number][] {
  if (points.length <= 4) return points.slice();
  let far = 0;
  let best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]![0] - points[0]![0], points[i]![1] - points[0]![1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const first = simplifyOpen(points.slice(0, far + 1), epsilon);
  const second = simplifyOpen([...points.slice(far), points[0]!], epsilon);
  return [...first, ...second.slice(1, -1)];
}

/** Le contour d'un alpha brut. Refus : rien d'opaque, ou rien de transparent (« rien à détourer »). */
export function contourOf(alpha: Uint8Array, width: number, height: number, epsilon = SIMPLIFY_PX): Contour {
  if (alpha.length !== width * height) throw new ContourRefused('Alpha illisible : taille inattendue.');
  const mask = new Uint8Array(width * height);
  let opaque = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]! >= ALPHA_THRESHOLD) {
      mask[i] = 1;
      opaque++;
    }
  }
  if (opaque === 0) throw new ContourRefused('PNG transparent partout : rien à détourer.');
  if (opaque === alpha.length) throw new ContourRefused('PNG opaque partout : rien à détourer.');
  const { mark, parts } = label(mask, width, height);
  const order = parts.map((p, i) => ({ p, id: i + 1 })).sort((a, b) => b.p.pixels - a.p.pixels);
  const main = order[0]!.id;
  const eroded = erode((x, y) => x >= 0 && y >= 0 && x < width && y < height && mark[y * width + x] === main, width, height);
  // L'érosion peut couper la partie : on garde le plus grand morceau.
  const pieces = label(eroded, width, height);
  if (pieces.parts.length === 0) throw new ContourRefused('Partie opaque trop fine pour un contour : rien à détourer.');
  let biggest = 0;
  pieces.parts.forEach((p, i) => {
    if (p.pixels > pieces.parts[biggest]!.pixels) biggest = i;
  });
  const keep = new Uint8Array(width * height);
  let first = -1;
  for (let i = 0; i < keep.length; i++) {
    if (pieces.mark[i] === biggest + 1) {
      keep[i] = 1;
      if (first < 0) first = i;
    }
  }
  const traced = trace(keep, width, height, first);
  const points = epsilon > 0 ? simplify(traced, epsilon) : traced;
  // Une partie dans un trou de la plus grande reste dans le contour : elle n'est pas découpée, rien à signaler.
  const cut = order.slice(1).map((o) => o.p).filter((p) => !insidePolygon((p.gauche + p.droite) / 2, (p.haut + p.bas) / 2, traced));
  // Trous (ED5) : régions du fond cernées par la partie gardée, d'au moins HOLE_MIN_RATIO de l'image. Les îlots dans un trou sont perdus.
  const hollow = new Uint8Array(width * height);
  for (let i = 0; i < hollow.length; i++) hollow[i] = keep[i] ? 0 : 1;
  const holeParts = label(hollow, width, height);
  const trous: [number, number][][] = [];
  const touching = new Set<number>();
  for (let x = 0; x < width; x++) {
    touching.add(holeParts.mark[x]!);
    touching.add(holeParts.mark[(height - 1) * width + x]!);
  }
  for (let y = 0; y < height; y++) {
    touching.add(holeParts.mark[y * width]!);
    touching.add(holeParts.mark[y * width + width - 1]!);
  }
  const wanted = new Set<number>();
  holeParts.parts.forEach((p, i) => {
    if (!touching.has(i + 1) && p.pixels >= HOLE_MIN_RATIO * width * height) wanted.add(i + 1);
  });
  for (const id of wanted) {
    const m = new Uint8Array(width * height);
    let start = -1;
    for (let i = 0; i < m.length; i++) {
      if (holeParts.mark[i] === id) {
        m[i] = 1;
        if (start < 0) start = i;
      }
    }
    const t = trace(m, width, height, start);
    trous.push(epsilon > 0 ? simplify(t, epsilon) : t);
  }
  return { width, height, seuil: ALPHA_THRESHOLD, points, autresParties: cut, trous };
}

/** Place de l'image entière, centrée dans sa boîte, à la plus grande taille qui y tient (décision de David, ED2). */
export function containRect(box: Rect, image: { width: number; height: number }): Rect {
  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  const scale = Math.min(bw / image.width, bh / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const left = box.left + (bw - w) / 2;
  const top = box.top + (bh - h) / 2;
  return { left, top, right: left + w, bottom: top + h };
}

/** Le contour ramené sur la page : l'image entière dans sa boîte, ses sommets en mm et en pourcentage de l'image. */
export function outlineIn(box: Rect, contour: Pick<Contour, 'width' | 'height' | 'points'> & { trous?: [number, number][][] }): Outline {
  const image = containRect(box, contour);
  const sx = (image.right - image.left) / contour.width;
  const sy = (image.bottom - image.top) / contour.height;
  return {
    image,
    points: contour.points.map(([x, y]) => [image.left + x * sx, image.top + y * sy]),
    percent: contour.points.map(([x, y]) => [(x / contour.width) * 100, (y / contour.height) * 100]),
    ...(contour.trous && contour.trous.length > 0 ? { trous: contour.trous.map((t) => t.map(([x, y]): [number, number] => [(x / contour.width) * 100, (y / contour.height) * 100])) } : {}),
  };
}

/** Un point dans un polygone (règle pair-impair). */
export function insidePolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const orient = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export const rectPolygon = (r: Rect): [number, number][] => [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];

/** Deux polygones qui se recouvrent : une arête qui en croise une autre, ou un sommet de l'un dans l'autre. Des bords qui se touchent ne comptent pas. */
export function polygonsOverlap(a: [number, number][], b: [number, number][]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
    }
  }
  return a.some(([x, y]) => insidePolygon(x, y, b)) || b.some(([x, y]) => insidePolygon(x, y, a));
}
