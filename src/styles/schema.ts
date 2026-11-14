// src/styles/schema.ts — un style de la bibliothèque (IC2, spec §11.2) : `collection/styles/<styleId>/style.json`, versionné dans le repo privé,
// avec sa référence à côté (`reference.png` ou `reference.jpg`). Ce sont des données : David crée et règle ses styles dans la page, sans patch.
// Les valeurs portent sur les champs déclarés du graphe (`src/comfy/workflow.ts`) ; rien d'autre du graphe ne dépend d'un style.
import { z } from 'zod';
import { schemaVersionSchema, slugSchema } from '../schema/common';

export const STYLE_FILE = 'style.json';
/** Le style d'IL1, repris des workflows : celui des images d'IC1, qui n'ont pas de style tracé. */
export const BASE_STYLE_ID = 'base';
/** Dossier du rendu d'essai fixe (question 8) : son nom commence par `_`, aucun identifiant de style ne peut le prendre. */
export const ESSAI_DIR = '_essai';
export const REFERENCE_FILES = ['reference.png', 'reference.jpg'] as const;
export type ReferenceFile = (typeof REFERENCE_FILES)[number];
export const REFERENCE_TYPES = ['aucune', 'dessin', 'externe'] as const;
export const REFERENCE_LABELS: Record<(typeof REFERENCE_TYPES)[number], string> = { aucune: 'aucune, style par le prompt seul', dessin: 'dessin de David', externe: 'image externe' };
export const STYLE_PROMPT_MAX = 1000;
export const STYLE_TEXT_MAX = 2000;
/** Une trentaine de styles visés (question 10) : la limite laisse de la marge, sans laisser grossir la page sans fin. */
export const MAX_STYLES = 200;

export const styleIdSchema = slugSchema.max(40, 'identifiant : 40 caractères au plus');

const unit = (label: string) => z.number({ error: `${label} : nombre attendu` }).min(0, `${label} : 0 au moins`).max(1, `${label} : 1 au plus`);
const strength = (label: string) => z.number({ error: `${label} : nombre attendu` }).min(0, `${label} : 0 au moins`).max(2, `${label} : 2 au plus`);
const text = (label: string, max: number) => z.string().max(max, `${label} : ${max} caractères au plus`);

const withFile = {
  /** Entrée `image-reference` du registre commun ou du livre (C11). */
  rights: slugSchema,
  /** `null` : la référence reste à déposer, l'étape Styles est en erreur. */
  file: z.enum(REFERENCE_FILES).nullable(),
  /** Copie en niveaux de gris envoyée à ComfyUI, l'original reste dans le style (test (d) d'IL1). */
  grayscale: z.boolean(),
};

export const referenceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('aucune') }),
  z.strictObject({ type: z.literal('dessin'), ...withFile }),
  z.strictObject({ type: z.literal('externe'), ...withFile }),
]);
export type StyleReference = z.infer<typeof referenceSchema>;

export const styleSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    name: z.string().trim().min(1, 'nom vide').max(80, 'nom : 80 caractères au plus'),
    description: text('description', 500),
    /** Ajouté au prompt de la zone, après `, ` (question 3). Vide pour le style de base. Sans couleur (§13.2). */
    prompt: text('prompt de style', STYLE_PROMPT_MAX),
    negative: text('négatif', STYLE_TEXT_MAX),
    /** Débruitage du KSampler (nœud 3, question 13). */
    denoise: z.number({ error: 'débruitage : nombre attendu' }).gt(0, 'débruitage : plus de 0').max(1, 'débruitage : 1 au plus'),
    /** Poids de l'IP-Adapter (nœud 24). Sans effet pour un style sans référence : le nœud ne tourne pas. */
    ipAdapterWeight: strength('poids de l\'IP-Adapter'),
    controlnet: z.strictObject({
      depth: z.strictObject({ strength: strength('profondeur') }),
      canny: z.strictObject({ strength: strength('Canny') }),
      tile: z.strictObject({ strength: strength('tile'), start: unit('début du tile'), end: unit('fin du tile') }),
    }),
    /** Correction de couleurs du §13.2 : 1 pour le livre 1, 0 sans correction. */
    colorDosage: unit('dosage des couleurs'),
    /** Gris (0 à 255) sur lequel un rendu détouré RVBA est aplati avant l'envoi à ComfyUI (ED5). Réglable par style : 128 par défaut. */
    fondDetoure: z.number({ error: 'fond du détouré : nombre attendu' }).int('fond du détouré : entier attendu').min(0, 'fond du détouré : 0 au moins').max(255, 'fond du détouré : 255 au plus').default(128),
    reference: referenceSchema,
    /** Prompts de l'agrandissement (nœuds 6 et 7 du second graphe, question 12) : Ultimate SD Upscale garde son propre style. */
    upscale: z.strictObject({ prompt: text('prompt de l\'agrandissement', STYLE_TEXT_MAX), negative: text('négatif de l\'agrandissement', STYLE_TEXT_MAX) }),
  })
  .superRefine((s, ctx) => {
    if (s.controlnet.tile.start > s.controlnet.tile.end) ctx.addIssue({ code: 'custom', path: ['controlnet', 'tile'], message: 'tile : le début doit précéder la fin' });
  });
export type Style = z.infer<typeof styleSchema>;

/** Entrée du registre créée pour un dessin de David (question 5) : son identifiant vient du style. */
export const drawingRightsId = (styleId: string) => `dessin-${styleId}`;
export const DRAWING_AUTHOR = 'David Liger';
