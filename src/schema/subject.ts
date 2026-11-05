// src/schema/subject.ts — `<bookId>/subjects/<sujetId>/subject.json` (spec §3.3).
// `blocks` et `illustrations` n'acceptent pour l'instant que la liste vide : leurs schémas complets viennent en MP3 et MP4.
import { z } from 'zod';
import { glbiIdSchema, schemaVersionSchema, slugSchema } from './common';

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
    pages: z.union([z.literal(2), z.literal(4), z.literal(6)], { error: 'pages : 2, 4 ou 6' }),
    template: z.string().regex(/^[246][A-Z]$/, 'gabarit : par exemple 4B'),
    variant: z.strictObject({ mirror: z.boolean(), theme: slugSchema }),
    blocks: z.array(z.unknown()).max(0, 'blocs : schéma complet au lot MP3, liste vide en attendant'),
    illustrations: z.array(z.unknown()).max(0, 'illustrations : schéma complet au lot MP4, liste vide en attendant'),
    status: z.enum(SUBJECT_STATUS),
  })
  .superRefine((s, ctx) => {
    if (s.template[0] !== String(s.pages)) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: `gabarit ${s.template} incompatible avec ${s.pages} pages` });
    }
    if (!s.sceneId && Object.keys(s.title).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'sujet sans scène : au moins un titre attendu' });
    }
  });
export type Subject = z.infer<typeof subjectSchema>;
