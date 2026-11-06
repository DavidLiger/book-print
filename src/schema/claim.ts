// src/schema/claim.ts — affirmation et source (spec §3.7). Le fichier importé porte seulement ce que la recherche a produit ; l'outil
// ajoute ensuite le statut, la note de David et le résultat du contrôle des URL. `text` reste le texte importé : une correction de David
// va dans `correctedText`, pour qu'un second import identique ne l'efface pas.
import { z } from 'zod';
import { slugSchema } from './common';

export const MAX_CLAIM_CHARS = 300;
/** Paraphrase du passage : une citation longue n'y tient pas (§5.2). */
export const MAX_SUPPORT_CHARS = 400;

export const CONFIDENCE = ['forte', 'debattue'] as const;
export const CLAIM_STATUS = ['propose', 'valide', 'rejete', 'corrige'] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

/** `corrige` compte comme validé : David en a écrit le texte. */
export const claimIsValidated = (status: ClaimStatus) => status === 'valide' || status === 'corrige';

const filled = (label: string) => z.string().regex(/\S/, `${label} vide`);

/** Date écrite par la recherche : un jour, ou un instant ISO. */
export const dateTextSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'date attendue : AAAA-MM-JJ')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'date invalide');

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Ce filtre protège aussi la page : un lien `javascript:` n'arrive jamais dans un `href`. */
export const httpUrlSchema = z.string().regex(/^https?:\/\//i, 'URL http ou https attendue').refine(isHttpUrl, 'URL invalide');

export const sourceSchema = z.strictObject({
  url: httpUrlSchema,
  title: filled('titre'),
  publisher: filled('éditeur'),
  published: filled('date de publication').optional(),
  accessed: dateTextSchema,
  support: filled('paraphrase').max(MAX_SUPPORT_CHARS, `paraphrase : ${MAX_SUPPORT_CHARS} caractères au plus, sans citation longue`),
});
export type Source = z.infer<typeof sourceSchema>;

export const claimSchema = z.strictObject({
  id: slugSchema,
  text: filled('affirmation').max(MAX_CLAIM_CHARS, `affirmation : ${MAX_CLAIM_CHARS} caractères au plus`),
  sources: z.array(sourceSchema).min(1, 'au moins une source'),
  confidence: z.enum(CONFIDENCE),
});
export type Claim = z.infer<typeof claimSchema>;

/** Dernier contrôle local, par source : une affirmation peut en avoir plusieurs. `code` nul : aucune réponse, `error` dit pourquoi. */
export const urlCheckSchema = z.strictObject({
  date: z.iso.datetime(),
  code: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type UrlCheck = z.infer<typeof urlCheckSchema>;

const storedSourceSchema = sourceSchema.extend({ urlCheck: urlCheckSchema.optional() });

export const storedClaimSchema = claimSchema.extend({
  sources: z.array(storedSourceSchema).min(1, 'au moins une source'),
  status: z.enum(CLAIM_STATUS),
  validatedAt: z.iso.datetime().nullable(),
  note: z.string(),
  correctedText: filled('correction').optional(),
});
export type StoredClaim = z.infer<typeof storedClaimSchema>;

/** Texte en vigueur : celui de David s'il a corrigé. */
export const claimText = (claim: StoredClaim) => claim.correctedText ?? claim.text;
