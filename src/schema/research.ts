// src/schema/research.ts — fichier de recherche d'un sujet (spec §3.7). `researchImportSchema` est le fichier produit par la conversation
// Claude : il est publié dans `schema/research.schema.json` et inclus dans le prompt. `storedResearchSchema` est `research.json` dans le
// dossier de données : le même fichier, plus ce que l'outil ajoute à chaque affirmation.
import { z } from 'zod';
import { BLOCK_TYPES } from './block';
import { claimSchema, dateTextSchema, storedClaimSchema } from './claim';
import { langSchema, schemaVersionSchema, slugSchema } from './common';

export const researchBlockSchema = z.strictObject({
  zone: slugSchema,
  type: z.enum(BLOCK_TYPES),
  /** Information de la fiche : seulement pour un bloc `fiche`. */
  item: slugSchema.optional(),
  text: z.string().regex(/\S/, 'texte vide'),
  claims: z.array(slugSchema).min(1, 'une affirmation au moins'),
});
export type ResearchBlock = z.infer<typeof researchBlockSchema>;

const base = {
  schemaVersion: schemaVersionSchema,
  subjectId: slugSchema,
  lang: langSchema,
  generatedAt: dateTextSchema,
  blocks: z.array(researchBlockSchema).min(1, 'un bloc au moins'),
};

function crossChecks(file: { claims: { id: string }[]; blocks: { claims: string[] }[] }, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  file.claims.forEach((c, i) => {
    if (ids.has(c.id)) ctx.addIssue({ code: 'custom', path: ['claims', i, 'id'], message: `affirmation en double : ${c.id}` });
    ids.add(c.id);
  });
  file.blocks.forEach((b, i) => {
    if (new Set(b.claims).size !== b.claims.length) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'claims'], message: 'affirmation citée deux fois' });
    b.claims.forEach((id, j) => {
      if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'claims', j], message: `affirmation inconnue : ${id}` });
    });
  });
}

export const researchImportSchema = z.strictObject({ ...base, claims: z.array(claimSchema).min(1, 'une affirmation au moins') }).superRefine(crossChecks);
export type ResearchImport = z.infer<typeof researchImportSchema>;

export const storedResearchSchema = z.strictObject({ ...base, claims: z.array(storedClaimSchema).min(1, 'une affirmation au moins') }).superRefine(crossChecks);
export type StoredResearch = z.infer<typeof storedResearchSchema>;

/** Schéma publié : généré depuis zod, jamais écrit à la main. */
export const researchJsonSchema = () => z.toJSONSchema(researchImportSchema);
