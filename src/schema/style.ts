// src/schema/style.ts — `collection/style.json` (spec §3.1). Tout ce que David règle sans patch est ici : marges, thèmes,
// couleurs d'encadré, polices, jeu de pictogrammes, informations de la fiche, numéros de page.
import { z } from 'zod';
import { schemaVersionSchema, slugSchema } from './common';

/** Polices du pack (C7) : un style ne désigne jamais un fichier. `render/fonts.ts` donne les fichiers de chacune. */
export const FONT_PACKS = ['andika', 'baloo-2'] as const;

/** Minimum KDP avec fond perdu : 0,375" (§6.2). */
export const KDP_MIN_MARGIN_MM = 9.6;
/** Règle maison du pli (§4.1). */
export const GUTTER_MIN_MM = 15;
/** Corps minimum du texte courant, règle maison (§4.1, C8). */
export const BODY_MIN_PT = 13;
/** Contraste minimum d'un texte sur son fond (WCAG AA). */
export const MIN_CONTRAST = 4.5;

/** `#rrggbb` seulement : huit chiffres porteraient une transparence, interdite (C6). */
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'couleur : #rrggbb en minuscules, sans transparence');

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Rapport de contraste WCAG entre deux couleurs. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const labelSchema = z.string().trim().min(1, 'libellé vide');

const fontSchema = z.strictObject({
  pack: z.enum(FONT_PACKS, { error: 'police hors du pack' }),
  sizePt: z.number().positive(),
  lineHeight: z.number().min(1, 'interligne : 1 au moins'),
});

export const styleSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    /** Seul endroit où se règlent les marges (§4.1). */
    margins: z.strictObject({
      outerMm: z.number().min(KDP_MIN_MARGIN_MM, `marge : ${KDP_MIN_MARGIN_MM} mm au moins (KDP)`),
      topMm: z.number().min(KDP_MIN_MARGIN_MM, `marge : ${KDP_MIN_MARGIN_MM} mm au moins (KDP)`),
      bottomMm: z.number().min(KDP_MIN_MARGIN_MM, `marge : ${KDP_MIN_MARGIN_MM} mm au moins (KDP)`),
      gutterMm: z.number().min(GUTTER_MIN_MM, `petit fond : ${GUTTER_MIN_MM} mm au moins (règle du pli)`),
    }),
    palette: z.strictObject({
      text: colorSchema,
      paper: colorSchema,
      /** Couleurs de thème, en nombre libre : le nom est celui de `variant.theme`. */
      themes: z.record(slugSchema, colorSchema).refine((t) => Object.keys(t).length > 0, 'au moins un thème'),
      /** Couleur d'encadré par type (§3.1), en nombre libre : la clé est le type. */
      boxes: z.record(slugSchema, colorSchema).refine((b) => 'fiche' in b, 'couleur d\'encadré `fiche` attendue'),
    }),
    fonts: z.strictObject({ body: fontSchema, title: fontSchema, lead: fontSchema, label: fontSchema }),
    /** Jeu de pictogrammes, en nombre libre : un fichier de `collection/pictos/`, relié au registre des droits. */
    pictos: z.record(slugSchema, z.strictObject({ file: z.string().regex(/^[a-z0-9-]+\.svg$/, 'fichier : nom simple en .svg'), rights: slugSchema })),
    /** Informations de la fiche d'identité, dans l'ordre, en nombre libre. Le gabarit fixe le maximum qu'il peut poser. */
    fiche: z
      .array(z.strictObject({ id: slugSchema, picto: slugSchema, label: z.strictObject({ fr: labelSchema, en: labelSchema, es: labelSchema }) }))
      .min(1, 'fiche : une information au moins'),
    folio: z.strictObject({ show: z.boolean(), sizePt: z.number().min(7, 'numéro de page : 7 pt au moins (KDP)') }),
    /** Règles de variation (§4.4) : rotation des thèmes. Le miroir viendra avec les gabarits suivants. */
    variants: z.strictObject({ rotation: z.array(slugSchema).min(1, 'rotation : un thème au moins') }),
  })
  .superRefine((s, ctx) => {
    const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const needs = (fg: string, bg: string, path: PropertyKey[], what: string) => {
      const ratio = contrast(fg, bg);
      if (ratio < MIN_CONTRAST) issue(path, `${what} : contraste de ${ratio.toFixed(2)}, ${MIN_CONTRAST} au moins`);
    };
    needs(s.palette.text, s.palette.paper, ['palette', 'text'], 'texte sur papier');
    for (const [name, color] of Object.entries(s.palette.themes)) needs(s.palette.paper, color, ['palette', 'themes', name], `titre sur le thème ${name}`);
    for (const [name, color] of Object.entries(s.palette.boxes)) needs(s.palette.text, color, ['palette', 'boxes', name], `texte sur l'encadré ${name}`);
    if (s.fonts.body.sizePt < BODY_MIN_PT) issue(['fonts', 'body', 'sizePt'], `texte courant : ${BODY_MIN_PT} pt au moins`);
    const seen = new Set<string>();
    s.fiche.forEach((item, i) => {
      if (seen.has(item.id)) issue(['fiche', i], `information en double : ${item.id}`);
      seen.add(item.id);
      if (!(item.picto in s.pictos)) issue(['fiche', i], `pictogramme inconnu : ${item.picto}`);
    });
    s.variants.rotation.forEach((name, i) => {
      if (!(name in s.palette.themes)) issue(['variants', 'rotation', i], `thème inconnu : ${name}`);
    });
  });
export type Style = z.infer<typeof styleSchema>;
