// src/schema/block.ts — bloc rempli d'un sujet (spec §3.5). `titre` n'est pas un bloc : il vient de la scène. La légende du QR non plus :
// c'est un texte du sujet, sans fait. `chapeau` est un type de bloc, avec affirmation. Un bloc de fiche porte une information : `item`.
import { z } from 'zod';
import { langSchema, slugSchema } from './common';

export const BLOCK_TYPES = ['chapeau', 'texte', 'encadre', 'fiche', 'chiffre-cle', 'legende', 'etiquette'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const BLOCK_STATES = ['a-relire', 'valide', 'a-reprendre'] as const;
export type BlockState = (typeof BLOCK_STATES)[number];

/** Un texte peut être vide le temps de le récrire : C12 et C13 le refusent ensuite. */
export const localizedText = z.partialRecord(langSchema, z.string());

export const blockSchema = z
  .strictObject({
    id: slugSchema,
    zone: slugSchema,
    type: z.enum(BLOCK_TYPES),
    item: slugSchema.optional(),
    text: localizedText,
    claims: z.array(slugSchema).min(1, 'une affirmation au moins'),
    state: z.enum(BLOCK_STATES),
  })
  .superRefine((b, ctx) => {
    if ((b.type === 'fiche') !== (b.item !== undefined)) ctx.addIssue({ code: 'custom', path: ['item'], message: 'item : attendu pour un bloc de fiche, et seulement pour lui' });
    if (new Set(b.claims).size !== b.claims.length) ctx.addIssue({ code: 'custom', path: ['claims'], message: 'affirmation citée deux fois' });
  });
export type Block = z.infer<typeof blockSchema>;

/** Identifiant d'un bloc : la zone, ou la zone et l'information pour une fiche. */
export const blockId = (zone: string, item?: string) => (item ? `${zone}-${item}` : zone);
