// src/schema/rights.ts — registre des droits (spec §3.8) : `collection/rights.json` et `<bookId>/rights.json`, même schéma.
// Auteur, licence et crédit peuvent être vides : une ligne incomplète de `credits.json` entre au registre, et c'est C11 qui la refuse.
import { z } from 'zod';
import { schemaVersionSchema, slugSchema, uniqueList } from './common';

export const RIGHTS_KINDS = ['modele-3d', 'police', 'picto', 'modele-ia', 'lora', 'controlnet', 'image-reference', 'upscaler', 'extension', 'image-externe'] as const;
/**
 * Ce qu'une illustration peut citer. Une extension ne porte que sur du code ; polices et pictogrammes ne sont pas dans l'image.
 * `image-externe` (ED2, spec §24.11) : une image imprimée telle quelle (une carte, par exemple), avec son auteur, sa licence et son crédit.
 */
export const ILLUSTRATION_KINDS: readonly (typeof RIGHTS_KINDS)[number][] = ['modele-3d', 'modele-ia', 'lora', 'controlnet', 'image-reference', 'upscaler', 'image-externe'];
export const COMMERCIAL_OK = ['oui', 'non', 'a-verifier'] as const;

export const rightsEntrySchema = z.strictObject({
  id: slugSchema,
  kind: z.enum(RIGHTS_KINDS),
  name: z.string().trim().min(1),
  author: z.string().trim(),
  license: z.string().trim(),
  url: z.string().optional(),
  credit: z.string().trim(),
  commercialOk: z.enum(COMMERCIAL_OK),
});
export type RightsEntry = z.infer<typeof rightsEntrySchema>;

/** Les droits d'une illustration. Fichier et dimensions sont dans `subject.json` : ici, le lien vers le sujet et ce qui a servi. */
export const illustrationRightsSchema = z.strictObject({
  subject: slugSchema,
  zone: slugSchema,
  file: z.string(),
  rights: uniqueList(slugSchema, 'droit'),
  aiGenerated: z.literal(true),
});
export type IllustrationRights = z.infer<typeof illustrationRightsSchema>;

export const rightsFileSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    entries: z.array(rightsEntrySchema),
    illustrations: z.array(illustrationRightsSchema),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    file.entries.forEach((e, i) => {
      if (ids.has(e.id)) ctx.addIssue({ code: 'custom', path: ['entries', i, 'id'], message: `entrée en double : ${e.id}` });
      ids.add(e.id);
    });
    const zones = new Set<string>();
    file.illustrations.forEach((image, i) => {
      const key = `${image.subject}/${image.zone}`;
      if (zones.has(key)) ctx.addIssue({ code: 'custom', path: ['illustrations', i], message: `illustration en double : ${key}` });
      zones.add(key);
    });
  });
export type RightsFile = z.infer<typeof rightsFileSchema>;
