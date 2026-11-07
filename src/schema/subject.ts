// src/schema/subject.ts — `<bookId>/subjects/<sujetId>/subject.json` (spec §3.3).
import { z } from 'zod';
import { blockSchema } from './block';
import { glbiIdSchema, schemaVersionSchema, slugSchema, templatePages, TEMPLATE_ID_PATTERN } from './common';

const titleText = z.string().trim().min(1, 'titre vide');

export const MAX_ZOOM = 4;

/** Point focal et zoom : voir `src/images/crop.ts`. */
export const framingSchema = z.strictObject({
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  zoom: z.number().min(1, 'zoom : 1 au moins').max(MAX_ZOOM, `zoom : ${MAX_ZOOM} au plus`),
});

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 attendue');
const workflowTraceSchema = z.strictObject({ file: z.string(), date: z.iso.datetime(), sha256: sha256Schema });
const fieldsTraceSchema = z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()])));

/** Traçabilité d'une image produite par l'outil (IC1, question 7) : de quoi la refaire. Un dépôt manuel l'efface. */
export const generationSchema = z.strictObject({
  date: z.iso.datetime(),
  comfyuiVersion: z.string(),
  seed: z.number().int().nonnegative(),
  prompt: z.string(),
  dosage: z.number().min(0).max(1),
  workflows: z.strictObject({ generation: workflowTraceSchema, agrandissement: workflowTraceSchema }),
  /** Chaque champ écrit par l'outil, par graphe, nœud et champ. */
  fields: z.strictObject({ generation: fieldsTraceSchema, agrandissement: fieldsTraceSchema }),
  inputs: z.strictObject({
    rendu: sha256Schema,
    mist: sha256Schema,
    reference: z.strictObject({ name: z.string(), sha256: sha256Schema }),
    /** Image générée, puis corrigée, déposée pour l'agrandissement. */
    generated: sha256Schema,
    corrected: sha256Schema,
  }),
});
export type Generation = z.infer<typeof generationSchema>;

/** L'image d'une zone : le fichier est hors git, ses droits sont dans `<bookId>/rights.json` (spec §3.8). */
export const illustrationSchema = z.strictObject({
  zone: slugSchema,
  file: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  framing: framingSchema,
  generation: generationSchema.optional(),
});
export type Illustration = z.infer<typeof illustrationSchema>;
export const illustrationFileName = (subjectId: string, zone: string) => `illustrations/${subjectId}/${zone}.png`;

export const SUBJECT_STATUS = ['brouillon', 'relu', 'prêt'] as const;
export const GENERATION_PROMPT_MAX = 2000;

export const subjectSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: slugSchema,
    /** Scène de GLBInterpreter (QR et titre) ; absente pour un sujet documentaire sans QR. */
    sceneId: glbiIdSchema.optional(),
    /** Surcharge du titre pour l'impression, par langue : sans elle, le titre est lu dans la scène (`scene.name`). */
    title: z.strictObject({ fr: titleText.optional(), en: titleText.optional(), es: titleText.optional() }),
    /** Nombre de pages choisi par David (MP-14) : libre, égal à celui du gabarit. */
    pages: z.number({ error: 'pages : entier attendu' }).int('pages : entier attendu').min(2, 'pages : 2 au moins'),
    template: z.string().regex(TEMPLATE_ID_PATTERN, 'gabarit : par exemple 4B ou 12A'),
    variant: z.strictObject({ mirror: z.boolean(), theme: slugSchema }),
    blocks: z.array(blockSchema),
    /** Légende du QR, par langue : un texte du sujet, sans fait ni affirmation. Absente d'un sujet créé avant MP3. */
    qrLegend: z.strictObject({ fr: titleText.optional(), en: titleText.optional(), es: titleText.optional() }).optional(),
    illustrations: z.array(illustrationSchema),
    /** Prompt positif de la génération, par zone (IC1) : sans lui, celui du workflow. Le changer ne touche pas `status`. */
    generationPrompts: z.record(slugSchema, z.string().max(GENERATION_PROMPT_MAX, `prompt : ${GENERATION_PROMPT_MAX} caractères au plus`)).optional(),
    status: z.enum(SUBJECT_STATUS),
  })
  .superRefine((s, ctx) => {
    if (templatePages(s.template) !== s.pages) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: `gabarit ${s.template} incompatible avec ${s.pages} pages` });
    }
    if (!s.sceneId && Object.keys(s.title).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'sujet sans scène : au moins un titre attendu' });
    }
    const ids = new Set<string>();
    s.blocks.forEach((b, i) => {
      if (ids.has(b.id)) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'id'], message: `bloc en double : ${b.id}` });
      ids.add(b.id);
    });
    const zones = new Set<string>();
    s.illustrations.forEach((image, i) => {
      if (zones.has(image.zone)) ctx.addIssue({ code: 'custom', path: ['illustrations', i, 'zone'], message: `zone en double : ${image.zone}` });
      zones.add(image.zone);
      if (image.file !== illustrationFileName(s.id, image.zone)) ctx.addIssue({ code: 'custom', path: ['illustrations', i, 'file'], message: `fichier attendu : ${illustrationFileName(s.id, image.zone)}` });
    });
  });
export type Subject = z.infer<typeof subjectSchema>;
