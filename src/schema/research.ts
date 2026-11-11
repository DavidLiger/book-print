// src/schema/research.ts — fichier de recherche d'un sujet (spec §3.7, §24.9). `researchImportSchema` est le fichier produit par la conversation
// Claude, en version 2 depuis ED4 : il est publié dans `schema/research.schema.json` et inclus dans le prompt. `researchImportV1Schema` est le
// format d'avant ED4, encore admis à l'import quand la mise en page n'attend ni paragraphe ni en-tête (décision de David, ED4).
// `storedResearchSchema` est `research.json` dans le dossier de données : le fichier importé, de l'une ou l'autre version, plus ce que l'outil
// ajoute à chaque affirmation.
import { z } from 'zod';
import { BLOCK_TYPES } from './block';
import { claimSchema, dateTextSchema, storedClaimSchema } from './claim';
import { langSchema, slugSchema } from './common';

/** Version du fichier de recherche demandée par le prompt (ED4). */
export const RESEARCH_SCHEMA_VERSION = 2 as const;

/** Les types de bloc d'avant ED4 : sans `paragraphe`. */
const BLOCK_TYPES_V1 = BLOCK_TYPES.filter((t) => t !== 'paragraphe') as [Exclude<(typeof BLOCK_TYPES)[number], 'paragraphe'>, ...Exclude<(typeof BLOCK_TYPES)[number], 'paragraphe'>[]];

const blockV1Fields = {
  zone: slugSchema,
  type: z.enum(BLOCK_TYPES_V1),
  /** Information de la fiche : seulement pour un bloc `fiche`. */
  item: slugSchema.optional(),
  text: z.string().regex(/\S/, 'texte vide'),
  claims: z.array(slugSchema).min(1, 'une affirmation au moins'),
};

export const researchBlockV1Schema = z.strictObject(blockV1Fields);

export const researchBlockSchema = z
  .strictObject({
    ...blockV1Fields,
    type: z.enum(BLOCK_TYPES),
    /** Paragraphe de la chaîne nommée par `zone` : seulement pour un bloc `paragraphe`. */
    paragraphe: slugSchema.optional(),
    /** En-tête : l'intertitre d'un paragraphe, le titre d'une capsule, la question ; seulement quand le prompt le demande. */
    heading: z.string().regex(/\S/, 'en-tête vide').optional(),
  })
  .superRefine((b, ctx) => {
    if ((b.type === 'paragraphe') !== (b.paragraphe !== undefined)) ctx.addIssue({ code: 'custom', path: ['paragraphe'], message: 'attendu pour un bloc paragraphe, et seulement pour lui' });
  });
export type ResearchBlock = z.infer<typeof researchBlockSchema>;

const common = {
  subjectId: slugSchema,
  lang: langSchema,
  generatedAt: dateTextSchema,
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

const claims = z.array(claimSchema).min(1, 'une affirmation au moins');

/** Le fichier demandé par le prompt depuis ED4. */
export const researchImportSchema = z
  .strictObject({
    schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION, { error: `schemaVersion : ${RESEARCH_SCHEMA_VERSION} attendu` }),
    ...common,
    claims,
    blocks: z.array(researchBlockSchema).min(1, 'un bloc au moins'),
  })
  .superRefine(crossChecks);

/** Le fichier d'avant ED4, lu tel qu'il l'était. */
export const researchImportV1Schema = z
  .strictObject({ schemaVersion: z.literal(1), ...common, claims, blocks: z.array(researchBlockV1Schema).min(1, 'un bloc au moins') })
  .superRefine(crossChecks);

export type ResearchImport = z.infer<typeof researchImportSchema> | z.infer<typeof researchImportV1Schema>;

/** `research.json` : version 1 (d'avant ED4, comme celui du `raptor`) ou version 2 ; ses blocs gardent la forme de leur version. */
export const storedResearchSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(RESEARCH_SCHEMA_VERSION)], { error: `schemaVersion : 1 ou ${RESEARCH_SCHEMA_VERSION} attendu` }),
    ...common,
    claims: z.array(storedClaimSchema).min(1, 'une affirmation au moins'),
    blocks: z.array(researchBlockSchema).min(1, 'un bloc au moins'),
  })
  .superRefine((file, ctx) => {
    crossChecks(file, ctx);
    if (file.schemaVersion === 1) {
      file.blocks.forEach((b, i) => {
        if (b.type === 'paragraphe' || b.heading !== undefined) ctx.addIssue({ code: 'custom', path: ['blocks', i], message: 'version 1 : ni paragraphe ni en-tête' });
      });
    }
  });
export type StoredResearch = z.infer<typeof storedResearchSchema>;

/** Schéma publié : généré depuis zod, jamais écrit à la main. Celui de la version 2, demandée par le prompt. */
export const researchJsonSchema = () => z.toJSONSchema(researchImportSchema);
