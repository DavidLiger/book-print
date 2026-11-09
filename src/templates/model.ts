// src/templates/model.ts — modèle de gabarit (spec §3.4). Un gabarit est une donnée : `pages`, `start` et `sheets`, la suite
// ordonnée des pages. Il n'y a pas de niveau « double page » : deux pages consécutives se font face selon `start`.
import { z } from 'zod';
import { slugSchema, templatePages, TEMPLATE_ID_PATTERN, uniqueList } from '../schema/common';

export const START_SIDES = ['gauche', 'droite', 'libre'] as const;
export type StartSide = (typeof START_SIDES)[number];
export type Side = 'gauche' | 'droite';

/** Types du §3.4, plus `fond` (aplat de couleur, §4.1) et `folio` (numéro de page, décision de David du 05/11/2026). */
export const ZONE_TYPES = ['titre', 'chapeau', 'texte', 'encadre', 'fiche', 'chiffre-cle', 'illustration', 'legende', 'picto', 'qr', 'etiquette', 'fond', 'folio'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

/** Seuls les fonds et les illustrations vont au bord (§3.4). */
const BLEED_TYPES: readonly ZoneType[] = ['illustration', 'fond'];

/** Côté de 25 mm au moins, marge de silence comprise (§4.1). */
export const QR_MIN_SIDE_MM = 25;

/**
 * Distance vers l'intérieur de la page, depuis le bord rogné ou depuis la zone de sécurité. Rien n'est écrit à gauche ou à
 * droite : le même gabarit se pose sur les deux côtés, `outer` et `inner` sont résolus par `geometry.ts`.
 */
const edgeSchema = z.strictObject({ from: z.enum(['rogne', 'securite']), mm: z.number().nonnegative('distance positive ou nulle') });
const sizeSchema = z.number().positive('taille positive');

const boxSchema = z
  .strictObject({
    outer: edgeSchema.optional(),
    inner: edgeSchema.optional(),
    widthMm: sizeSchema.optional(),
    top: edgeSchema.optional(),
    bottom: edgeSchema.optional(),
    heightMm: sizeSchema.optional(),
  })
  .superRefine((b, ctx) => {
    const count = (...values: unknown[]) => values.filter((v) => v !== undefined).length;
    if (count(b.outer, b.inner, b.widthMm) !== 2) ctx.addIssue({ code: 'custom', message: 'en largeur : exactement deux valeurs parmi outer, inner et widthMm' });
    if (count(b.top, b.bottom, b.heightMm) !== 2) ctx.addIssue({ code: 'custom', message: 'en hauteur : exactement deux valeurs parmi top, bottom et heightMm' });
  });
export type ZoneBox = z.infer<typeof boxSchema>;

/** Contraintes du §3.4 : longueur maximale, rapport de l'image, nombre de pictogrammes, côté du QR. */
const constraintsSchema = z.strictObject({
  maxChars: z.number().int().positive().optional(),
  ratio: z.number().positive().optional(),
  maxPictos: z.number().int().positive().optional(),
  /** Longueur d'une information de fiche : `maxChars` vaut pour une zone à un seul texte. */
  itemMaxChars: z.number().int().positive().optional(),
  qrSideMm: z.number().min(QR_MIN_SIDE_MM, `QR : côté de ${QR_MIN_SIDE_MM} mm au moins`).optional(),
});

/** Zones qui portent un texte : leur longueur maximale est obligatoire (GB1). Le prompt, l'aperçu d'un gabarit et C12 en ont besoin. */
export const TEXT_ZONE_TYPES: readonly ZoneType[] = ['titre', 'chapeau', 'texte', 'encadre', 'chiffre-cle', 'legende', 'etiquette'];

/** Corps minimum de KDP (C8) : un chiffre-clé ne peut pas descendre plus bas. */
const KDP_MIN_PT = 7;

const headingText = z.string().trim().min(1, 'titre de l\'encadré vide');

const zoneSchema = z.strictObject({
  id: slugSchema,
  type: z.enum(ZONE_TYPES),
  box: boxSchema,
  bleed: z.boolean(),
  /** Élément à cheval : il continue sur la page suivante, qui doit lui faire face. */
  spread: z.boolean().optional(),
  constraints: constraintsSchema.optional(),
  /** `encadre` (GB1) : la couleur, une clé de `palette.boxes` du style. */
  encadre: slugSchema.optional(),
  /** `encadre` (GB1), facultatif : le titre imprimé en tête, dans chaque langue. */
  heading: z.strictObject({ fr: headingText, en: headingText, es: headingText }).optional(),
  /** `picto` (GB1) : un pictogramme de `style.pictos`. */
  picto: slugSchema.optional(),
  /** `chiffre-cle` (GB1), facultatif : le corps du chiffre ; sans lui, celui du titre. */
  sizePt: z.number().min(KDP_MIN_PT, `corps : ${KDP_MIN_PT} pt au moins (KDP)`).optional(),
});
export type Zone = z.infer<typeof zoneSchema>;

/** Champs propres à un type : refusés sur les autres (GB1). */
const OWN_FIELDS: { field: 'encadre' | 'heading' | 'picto' | 'sizePt'; type: ZoneType }[] = [
  { field: 'encadre', type: 'encadre' },
  { field: 'heading', type: 'encadre' },
  { field: 'picto', type: 'picto' },
  { field: 'sizePt', type: 'chiffre-cle' },
];

const onTrim = (e: z.infer<typeof edgeSchema> | undefined) => e?.from === 'rogne' && e.mm === 0;

const sheetSchema = z.strictObject({ zones: z.array(zoneSchema) });

/** Côté de la page d'indice `index` : `null` pour un gabarit `libre`, qui se pose des deux côtés. */
export function sideOf(start: StartSide, index: number): Side | null {
  if (start === 'libre') return null;
  const other: Side = start === 'gauche' ? 'droite' : 'gauche';
  return index % 2 === 0 ? start : other;
}

export const templateSchema = z
  .strictObject({
    id: z.string().regex(TEMPLATE_ID_PATTERN, 'gabarit : par exemple 4B ou 12A'),
    pages: z.number().int().min(2, 'pages : 2 au moins'),
    start: z.enum(START_SIDES),
    sheets: z.array(sheetSchema),
  })
  .superRefine((t, ctx) => {
    const issue = (message: string, path: PropertyKey[] = []) => ctx.addIssue({ code: 'custom', path, message });
    if (templatePages(t.id) !== t.pages) issue(`gabarit ${t.id} incompatible avec ${t.pages} pages`, ['id']);
    if (t.sheets.length !== t.pages) issue(`${t.sheets.length} pages décrites pour ${t.pages} annoncées`, ['sheets']);

    const ids = t.sheets.flatMap((s) => s.zones.map((z) => z.id));
    const unique = uniqueList(slugSchema, 'zone').safeParse(ids);
    if (!unique.success) issue(unique.error.issues[0]!.message, ['sheets']);

    t.sheets.forEach((sheet, index) => {
      const path = ['sheets', index];
      for (const zone of sheet.zones) {
        if (zone.bleed && !BLEED_TYPES.includes(zone.type)) issue(`${zone.id} : seuls les fonds et les illustrations vont au bord`, path);
        if (zone.bleed && !(onTrim(zone.box.outer) || onTrim(zone.box.top) || onTrim(zone.box.bottom))) {
          issue(`${zone.id} : bleed sans bord rogné à l'extérieur, en haut ou en bas`, path);
        }
        for (const { field, type } of OWN_FIELDS) {
          if (zone[field] !== undefined && zone.type !== type) issue(`${zone.id} : ${field} réservé aux zones ${type}`, path);
        }
        if (zone.type === 'encadre' && zone.encadre === undefined) issue(`${zone.id} : encadre attendu, une couleur de palette.boxes`, path);
        if (zone.type === 'picto' && zone.picto === undefined) issue(`${zone.id} : picto attendu, un pictogramme de style.pictos`, path);
        if (TEXT_ZONE_TYPES.includes(zone.type) && zone.constraints?.maxChars === undefined) issue(`${zone.id} : constraints.maxChars attendu pour une zone ${zone.type}`, path);
        if (zone.type === 'qr') {
          if (index !== t.sheets.length - 1) issue(`${zone.id} : le QR est sur la dernière page du sujet`, path);
          if (zone.constraints?.qrSideMm === undefined) issue(`${zone.id} : côté du QR attendu`, path);
        }
        if (zone.spread) {
          // « Face à face » suppose un côté connu : un gabarit `libre` ne peut rien poser à cheval.
          if (t.start === 'libre') issue(`${zone.id} : élément à cheval dans un gabarit libre, start gauche ou droite attendu`, path);
          else if (sideOf(t.start, index) !== 'gauche') issue(`${zone.id} : élément à cheval sur une page droite, les deux pages ne se font pas face`, path);
          if (index + 1 >= t.sheets.length) issue(`${zone.id} : élément à cheval sur la dernière page`, path);
        }
      }
    });
    if (t.sheets.flatMap((s) => s.zones).filter((z) => z.type === 'qr').length > 1) issue('un seul QR par gabarit', ['sheets']);
  });
export type Template = z.infer<typeof templateSchema>;
