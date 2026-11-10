// src/layout/schema.ts — mise en page version 2 (ED1, spec §24.3 et §24.4). Éléments libres en mm, depuis le coin haut gauche de la page
// rognée d'indice `page`, `x` vers la droite, `y` vers le bas. L'ordre de `elements` est l'ordre de superposition : le premier est dessous.
// Un fichier sans `schemaVersion` est un gabarit de GB1 (version 1, `templates/model.ts`), lu par son propre schéma.
import { z } from 'zod';
import { slugSchema, templatePages, TEMPLATE_ID_PATTERN, uniqueList } from '../schema/common';
import { MM_PER_IN } from '../templates/geometry';
import { QR_MIN_SIDE_MM, TEXT_ZONE_TYPES, type ZoneType } from '../templates/model';

export const LAYOUT_VERSION = 2 as const;

/** Types de la version 1, plus `bandeau` (§24.4). `sommaire` viendra avec MP6. */
export const ELEMENT_TYPES = ['fond', 'bandeau', 'titre', 'chapeau', 'texte', 'encadre', 'illustration', 'legende', 'chiffre-cle', 'fiche', 'picto', 'etiquette', 'qr', 'folio'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const BLEED_SIDES = ['haut', 'bas', 'exterieur'] as const;
export type BleedSide = (typeof BLEED_SIDES)[number];

/** Seuls les fonds, les bandeaux et les illustrations vont au bord, et peuvent être à cheval (décision de David, ED1). */
export const EDGE_TYPES: readonly ElementType[] = ['fond', 'bandeau', 'illustration'];
/** Éléments à texte : leur longueur est obligatoire. Le bandeau porte le titre de la scène. */
export const TEXT_ELEMENT_TYPES: readonly ElementType[] = [...(TEXT_ZONE_TYPES as readonly ElementType[]), 'bandeau'];

export const ENCADRE_SORTS = ['capsule', 'question'] as const;
/** Alignement vertical du contenu d'un bandeau, d'un encadré ou d'une étiquette (décision de David, ED1). Absent : bandeau calé en bas, encadré et étiquette en haut. */
export const ALIGNEMENTS = ['haut', 'milieu', 'bas'] as const;
export type Alignement = (typeof ALIGNEMENTS)[number];
/** Consigne de David pour le prompt (ED4) : jamais imprimée, donc sans langue (décision de David, ED1). */
export const CONSIGNE_MAX = 300;
const KDP_MIN_PT = 7;
/** Tolérance de comparaison des coordonnées : un nombre écrit à la main ou converti n'est jamais exact au milliardième. */
export const EDGE_TOLERANCE_MM = 1e-6;

const mmSchema = z.number().finite();
const headingText = z.string().trim().min(1, 'titre de l\'encadré vide');
/** Ce qui vient en ED2 est refusé avec un message clair (décision de David, ED1). */
const ed2 = (what: string) => z.unknown().refine(() => false, `${what} : prévu en ED2`).optional();

const elementShape = {
  id: slugSchema,
  type: z.enum(ELEMENT_TYPES),
  page: z.number().int().nonnegative('page : 0 ou plus'),
  x: mmSchema,
  y: mmSchema,
  w: z.number().positive('w : largeur positive'),
  h: z.number().positive('h : hauteur positive'),
  double: z.boolean().optional(),
  fondPerdu: uniqueList(z.enum(BLEED_SIDES), 'bord').optional(),
  maxChars: z.number().int().positive().optional(),
  itemMaxChars: z.number().int().positive().optional(),
  maxPictos: z.number().int().positive().optional(),
  ratio: z.number().positive().optional(),
  qrSideMm: z.number().min(QR_MIN_SIDE_MM, `QR : côté de ${QR_MIN_SIDE_MM} mm au moins`).optional(),
  encadre: slugSchema.optional(),
  heading: z.strictObject({ fr: headingText, en: headingText, es: headingText }).optional(),
  headingMaxChars: z.number().int().positive().optional(),
  icone: slugSchema.optional(),
  sorte: z.enum(ENCADRE_SORTS).optional(),
  alignement: z.enum(ALIGNEMENTS).optional(),
  picto: slugSchema.optional(),
  sizePt: z.number().min(KDP_MIN_PT, `corps : ${KDP_MIN_PT} pt au moins (KDP)`).optional(),
  image: slugSchema.optional(),
  consigne: z.string().trim().min(1, 'consigne vide').max(CONSIGNE_MAX, `consigne : ${CONSIGNE_MAX} caractères au plus`).optional(),
  fleche: z.strictObject({ x: mmSchema, y: mmSchema }).optional(),
  chaine: ed2('chaine'),
  colonnes: ed2('colonnes'),
  gouttiereMm: ed2('gouttiereMm'),
  detoure: ed2('detoure'),
  habillage: ed2('habillage'),
};
export const elementSchema = z.strictObject(elementShape);
export type LayoutElement = z.infer<typeof elementSchema>;

/** Champs propres à un type : refusés sur les autres, comme en GB1. */
const OWN_FIELDS: { field: keyof LayoutElement; types: ElementType[] }[] = [
  { field: 'encadre', types: ['encadre'] },
  { field: 'heading', types: ['encadre'] },
  { field: 'headingMaxChars', types: ['encadre'] },
  { field: 'icone', types: ['encadre'] },
  { field: 'sorte', types: ['encadre'] },
  { field: 'alignement', types: ['bandeau', 'encadre', 'etiquette'] },
  { field: 'picto', types: ['picto'] },
  { field: 'sizePt', types: ['chiffre-cle'] },
  { field: 'image', types: ['legende'] },
  { field: 'consigne', types: ['legende', 'etiquette'] },
  { field: 'fleche', types: ['etiquette'] },
];

const trimSchema = z.strictObject({ widthIn: z.number().positive(), heightIn: z.number().positive() });
export const modeleSchema = z.strictObject({ id: z.string().regex(TEMPLATE_ID_PATTERN), empreinte: z.string().regex(/^[0-9a-f]{64}$/, 'empreinte : SHA-256 en hexadécimal'), date: z.iso.datetime() });

const layoutShape = {
  schemaVersion: z.literal(LAYOUT_VERSION, { error: `schemaVersion : ${LAYOUT_VERSION} attendu` }),
  id: z.string().regex(TEMPLATE_ID_PATTERN, 'mise en page : par exemple 4B ou 12A'),
  pages: z.number().int().min(2, 'pages : 2 au moins'),
  start: z.enum(['gauche', 'droite'], { error: 'start : gauche ou droite' }),
  trim: trimSchema,
  chaines: ed2('chaines'),
  elements: z.array(elementSchema),
};

const near = (a: number, b: number) => Math.abs(a - b) <= EDGE_TOLERANCE_MM;
export const pageSide = (start: 'gauche' | 'droite', index: number): 'gauche' | 'droite' => (index % 2 === 0 ? start : start === 'gauche' ? 'droite' : 'gauche');

interface LayoutLike {
  id: string;
  pages: number;
  start: 'gauche' | 'droite';
  trim: { widthIn: number; heightIn: number };
  elements: LayoutElement[];
}

/** Bords d'un élément qui touchent la page rognée : `exterieur` selon le côté (pour un élément à cheval, l'un ou l'autre bord extérieur). */
export function touchedEdges(e: LayoutElement, layout: Pick<LayoutLike, 'start' | 'trim'>): BleedSide[] {
  const W = layout.trim.widthIn * MM_PER_IN;
  const H = layout.trim.heightIn * MM_PER_IN;
  const out: BleedSide[] = [];
  if (near(e.y, 0)) out.push('haut');
  if (near(e.y + e.h, H)) out.push('bas');
  const side = pageSide(layout.start, e.page);
  const outer = e.double ? near(e.x, 0) || near(e.x + e.w, 2 * W) : side === 'gauche' ? near(e.x, 0) : near(e.x + e.w, W);
  if (outer) out.push('exterieur');
  return out;
}

function refineLayout(l: LayoutLike, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: PropertyKey[] = []) => ctx.addIssue({ code: 'custom', path, message });
  if (templatePages(l.id) !== l.pages) issue(`mise en page ${l.id} incompatible avec ${l.pages} pages`, ['id']);
  const unique = uniqueList(slugSchema, 'élément').safeParse(l.elements.map((e) => e.id));
  if (!unique.success) issue(unique.error.issues[0]!.message, ['elements']);
  const W = l.trim.widthIn * MM_PER_IN;
  const H = l.trim.heightIn * MM_PER_IN;
  const byId = new Map(l.elements.map((e) => [e.id, e]));
  const qrs = l.elements.filter((e) => e.type === 'qr');
  if (qrs.length > 1) issue('un seul QR par mise en page', ['elements']);
  l.elements.forEach((e, index) => {
    const path = ['elements', index];
    const name = e.id;
    if (e.page >= l.pages) issue(`${name} : page ${e.page}, la mise en page a ${l.pages} pages (0 à ${l.pages - 1})`, path);
    const width = e.double ? 2 * W : W;
    if (e.x < -EDGE_TOLERANCE_MM || e.y < -EDGE_TOLERANCE_MM || e.x + e.w > width + EDGE_TOLERANCE_MM || e.y + e.h > H + EDGE_TOLERANCE_MM) {
      issue(`${name} : hors de la page rognée (${e.double ? 'double page de ' : ''}${+width.toFixed(3)} × ${+H.toFixed(3)} mm)`, path);
    }
    for (const { field, types } of OWN_FIELDS) {
      if (e[field] !== undefined && !types.includes(e.type)) issue(`${name} : ${String(field)} réservé aux éléments ${types.join(' ou ')}`, path);
    }
    if (e.type === 'encadre' && e.encadre === undefined) issue(`${name} : encadre attendu, une couleur de palette.boxes`, path);
    if (e.type === 'picto' && e.picto === undefined) issue(`${name} : picto attendu, un pictogramme de style.pictos`, path);
    if (TEXT_ELEMENT_TYPES.includes(e.type) && e.maxChars === undefined) issue(`${name} : maxChars attendu pour un élément ${e.type}`, path);
    if (e.heading !== undefined && e.headingMaxChars !== undefined) issue(`${name} : heading fixe ou headingMaxChars, pas les deux`, path);
    if (e.type === 'encadre' && e.sorte === 'question' && e.heading === undefined && e.headingMaxChars === undefined) issue(`${name} : question sans heading fixe, headingMaxChars attendu`, path);
    if (e.image !== undefined && byId.get(e.image)?.type !== 'illustration') issue(`${name} : image ${e.image}, aucune illustration de ce nom`, path);
    if (e.fleche !== undefined) {
      const { x, y } = e.fleche;
      if (x < 0 || y < 0 || x > W || y > H) issue(`${name} : point de la flèche hors de la page rognée`, path);
      if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) issue(`${name} : point de la flèche dans l'étiquette`, path);
    }
    if (e.type === 'qr') {
      if (e.page !== l.pages - 1) issue(`${name} : le QR est sur la dernière page`, path);
      if (e.qrSideMm === undefined) issue(`${name} : côté du QR attendu (qrSideMm)`, path);
    }
    if (e.double) {
      if (!EDGE_TYPES.includes(e.type)) issue(`${name} : seuls les fonds, les bandeaux et les illustrations sont à cheval`, path);
      if (e.page < l.pages && pageSide(l.start, e.page) !== 'gauche') issue(`${name} : élément à cheval sur une page droite, les deux pages ne se font pas face`, path);
      if (e.page + 1 >= l.pages) issue(`${name} : élément à cheval sur la dernière page`, path);
    }
    if (e.fondPerdu !== undefined) {
      if (!EDGE_TYPES.includes(e.type)) issue(`${name} : seuls les fonds, les bandeaux et les illustrations vont au bord`, path);
      const touched = touchedEdges(e, l);
      for (const side of e.fondPerdu) if (!touched.includes(side)) issue(`${name} : fond perdu ${side} sans toucher ce bord de la page rognée`, path);
    }
  });
}

export const layoutSchema = z.strictObject(layoutShape).superRefine(refineLayout);
export type Layout = z.infer<typeof layoutSchema>;

/** `layout.json` d'un sujet : la copie d'une mise en page modèle, avec son origine (MP-24). */
export const subjectLayoutSchema = z.strictObject({ ...layoutShape, modele: modeleSchema }).superRefine(refineLayout);
export type SubjectLayout = z.infer<typeof subjectLayoutSchema>;

export const isElementType = (t: string): t is ElementType => (ELEMENT_TYPES as readonly string[]).includes(t);
export type { ZoneType };
