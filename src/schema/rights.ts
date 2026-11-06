// src/schema/rights.ts — registre des droits (spec §3.8), juste ce que `collection/rights.json` demande ici : les entrées.
// Le contrôle des crédits (C11) et les illustrations viennent avec le lot du registre.
import { z } from 'zod';
import { schemaVersionSchema, slugSchema } from './common';

export const RIGHTS_KINDS = ['modele-3d', 'police', 'picto', 'modele-ia', 'lora', 'controlnet', 'image-reference', 'upscaler'] as const;

export const rightsEntrySchema = z.strictObject({
  id: slugSchema,
  kind: z.enum(RIGHTS_KINDS),
  name: z.string().trim().min(1),
  author: z.string().trim().min(1),
  license: z.string().trim().min(1),
  url: z.string().optional(),
  credit: z.string().trim().min(1),
  commercialOk: z.enum(['oui', 'non', 'a-verifier']),
});

export const rightsFileSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  entries: z.array(rightsEntrySchema),
  illustrations: z.array(z.unknown()),
});
export type RightsFile = z.infer<typeof rightsFileSchema>;
