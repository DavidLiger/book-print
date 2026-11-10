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

/** Côté où passe le texte autour d'un détouré (spec §24.6) ; `aucun` : pas d'habillage, le détouré ne peut alors couvrir aucun texte (C17). */
export const HABILLAGES = ['gauche', 'droite', 'aucun'] as const;
export type Habillage = (typeof HABILLAGES)[number];
/** Colonnes d'un cadre de chaîne (spec §24.4). */
export const MAX_COLONNES = 4;

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
  // ED2 (spec §24.5 et §24.6) : cadre d'une chaîne et ses colonnes ; image détourée et son habillage.
  chaine: slugSchema.optional(),
  colonnes: z.number().int().min(1, 'colonnes : 1 à 4').max(MAX_COLONNES, `colonnes : 1 à ${MAX_COLONNES}`).optional(),
  gouttiereMm: z.number().positive('gouttiereMm : positive').optional(),
  detoure: z.boolean().optional(),
  habillage: z.enum(HABILLAGES, { error: 'habillage : gauche, droite ou aucun' }).optional(),
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
  { field: 'chaine', types: ['texte'] },
  { field: 'colonnes', types: ['texte'] },
  { field: 'gouttiereMm', types: ['texte'] },
  { field: 'detoure', types: ['illustration'] },
  { field: 'habillage', types: ['illustration'] },
];

/** Un paragraphe d'une chaîne : sa longueur, et celle de son intertitre s'il en a un (spec §24.5). */
export const paragraphSchema = z.strictObject({
  id: slugSchema,
  intertitre: z.boolean(),
  maxChars: z.number().int().positive(),
  headingMaxChars: z.number().int().positive().optional(),
});
/** Une chaîne : ses cadres dans l'ordre de lecture, la lettrine, ses paragraphes (spec §24.5). */
export const chainSchema = z.strictObject({
  id: slugSchema,
  cadres: z.array(slugSchema).min(1, 'cadres : au moins un'),
  lettrine: z.boolean().optional(),
  paragraphes: z.array(paragraphSchema).min(1, 'paragraphes : au moins un'),
});
export type Chain = z.infer<typeof chainSchema>;

const trimSchema = z.strictObject({ widthIn: z.number().positive(), heightIn: z.number().positive() });
export const modeleSchema = z.strictObject({ id: z.string().regex(TEMPLATE_ID_PATTERN), empreinte: z.string().regex(/^[0-9a-f]{64}$/, 'empreinte : SHA-256 en hexadécimal'), date: z.iso.datetime() });

const layoutShape = {
  schemaVersion: z.literal(LAYOUT_VERSION, { error: `schemaVersion : ${LAYOUT_VERSION} attendu` }),
  id: z.string().regex(TEMPLATE_ID_PATTERN, 'mise en page : par exemple 4B ou 12A'),
  pages: z.number().int().min(2, 'pages : 2 au moins'),
  start: z.enum(['gauche', 'droite'], { error: 'start : gauche ou droite' }),
  trim: trimSchema,
  chaines: z.array(chainSchema).optional(),
  elements: z.array(elementSchema),
};

const near = (a: number, b: number) => Math.abs(a - b) <= EDGE_TOLERANCE_MM;
export const pageSide = (start: 'gauche' | 'droite', index: number): 'gauche' | 'droite' => (index % 2 === 0 ? start : start === 'gauche' ? 'droite' : 'gauche');

interface LayoutLike {
  id: string;
  pages: number;
  start: 'gauche' | 'droite';
  trim: { widthIn: number; heightIn: number };
  chaines?: Chain[];
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
    // Un cadre de chaîne n'a pas de longueur : elle est donnée par paragraphe (décision de David, ED2).
    if (e.type === 'texte' && e.chaine !== undefined) {
      if (e.maxChars !== undefined) issue(`${name} : maxChars refusé sur un cadre de chaîne, les longueurs sont par paragraphe`, path);
    } else if (TEXT_ELEMENT_TYPES.includes(e.type) && e.maxChars === undefined) issue(`${name} : maxChars attendu pour un élément ${e.type}`, path);
    if (e.type === 'texte') {
      if (e.chaine === undefined && (e.colonnes !== undefined || e.gouttiereMm !== undefined)) issue(`${name} : colonnes et gouttiereMm seulement sur un cadre de chaîne`, path);
      const n = e.colonnes ?? 1;
      if (n >= 2 && e.gouttiereMm === undefined) issue(`${name} : gouttiereMm attendue pour ${n} colonnes`, path);
      if (n < 2 && e.gouttiereMm !== undefined) issue(`${name} : gouttiereMm seulement à partir de 2 colonnes`, path);
      if (n >= 2 && e.gouttiereMm !== undefined && (e.w - (n - 1) * e.gouttiereMm) / n <= 0) issue(`${name} : ${n} colonnes et ${e.gouttiereMm} mm de gouttière ne tiennent pas dans ${e.w} mm`, path);
      if (e.chaine !== undefined) {
        const chain = (l.chaines ?? []).find((c) => c.id === e.chaine);
        if (!chain) issue(`${name} : chaîne ${e.chaine} absente de chaines`, path);
        else if (!chain.cadres.includes(e.id)) issue(`${name} : absent des cadres de la chaîne ${e.chaine}`, path);
      }
    }
    if (e.type === 'illustration') {
      if (e.detoure === true) {
        if (e.habillage === undefined) issue(`${name} : habillage attendu pour un détouré (gauche, droite ou aucun)`, path);
        // L'image détourée est entière dans sa boîte (décision de David, ED2).
        if (e.double) issue(`${name} : un détouré n'est pas à cheval`, path);
        if (e.fondPerdu !== undefined) issue(`${name} : un détouré n'a pas de fond perdu`, path);
      } else if (e.habillage !== undefined) issue(`${name} : habillage seulement pour un détouré (detoure: true)`, path);
    }
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
  const chains = l.chaines ?? [];
  const chainIds = uniqueList(slugSchema, 'chaîne').safeParse(chains.map((c) => c.id));
  if (!chainIds.success) issue(chainIds.error.issues[0]!.message, ['chaines']);
  const seen = new Map<string, string>();
  chains.forEach((c, index) => {
    const path = ['chaines', index];
    const paras = uniqueList(slugSchema, 'paragraphe').safeParse(c.paragraphes.map((p) => p.id));
    if (!paras.success) issue(`chaîne ${c.id} : ${paras.error.issues[0]!.message}`, path);
    c.paragraphes.forEach((p) => {
      if (p.intertitre && p.headingMaxChars === undefined) issue(`chaîne ${c.id}, ${p.id} : headingMaxChars attendu pour un intertitre`, path);
      if (!p.intertitre && p.headingMaxChars !== undefined) issue(`chaîne ${c.id}, ${p.id} : headingMaxChars seulement avec un intertitre`, path);
    });
    for (const cadre of c.cadres) {
      const e = byId.get(cadre);
      if (!e) issue(`chaîne ${c.id} : cadre ${cadre} absent des éléments`, path);
      else if (e.type !== 'texte') issue(`chaîne ${c.id} : ${cadre} n'est pas un élément texte`, path);
      else if (e.chaine !== c.id) issue(`chaîne ${c.id} : ${cadre} porte ${e.chaine === undefined ? 'aucune chaîne' : `la chaîne ${e.chaine}`}`, path);
      const other = seen.get(cadre);
      if (other !== undefined) issue(`chaîne ${c.id} : cadre ${cadre} déjà dans ${other === c.id ? 'cette chaîne' : `la chaîne ${other}`}`, path);
      seen.set(cadre, c.id);
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
