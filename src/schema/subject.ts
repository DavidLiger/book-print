// src/schema/subject.ts — `<bookId>/subjects/<sujetId>/subject.json` (spec §3.3).
// `blocks` et `illustrations` n'acceptent pour l'instant que la liste vide : leurs schémas complets viennent en MP3 et MP4.
import { z } from 'zod';
import { glbiIdSchema, schemaVersionSchema, slugSchema, templatePages, TEMPLATE_ID_PATTERN } from './common';

const titleText = z.string().trim().min(1, 'titre vide');

export const SUBJECT_STATUS = ['brouillon', 'relu', 'prêt'] as const;

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
    blocks: z.array(z.unknown()).max(0, 'blocs : schéma complet au lot MP3, liste vide en attendant'),
    illustrations: z.array(z.unknown()).max(0, 'illustrations : schéma complet au lot MP4, liste vide en attendant'),
    status: z.enum(SUBJECT_STATUS),
  })
  .superRefine((s, ctx) => {
    if (templatePages(s.template) !== s.pages) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: `gabarit ${s.template} incompatible avec ${s.pages} pages` });
    }
    if (!s.sceneId && Object.keys(s.title).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'sujet sans scène : au moins un titre attendu' });
    }
  });
export type Subject = z.infer<typeof subjectSchema>;
