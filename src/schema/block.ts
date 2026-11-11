// src/schema/block.ts — bloc rempli d'un sujet (spec §3.5). `titre` n'est pas un bloc : il vient de la scène. La légende du QR non plus :
// c'est un texte du sujet, sans fait. `chapeau` est un type de bloc, avec affirmation. Un bloc de fiche porte une information : `item`.
// ED4 : un bloc `paragraphe` par paragraphe d'une chaîne, `zone` étant la chaîne et `paragraphe` le paragraphe ; un en-tête écrit (`heading`,
// l'intertitre d'un paragraphe, le titre d'une capsule, la question), relu à part (`headingState`), qui cite les mêmes affirmations que le texte.
import { z } from 'zod';
import { langSchema, slugSchema } from './common';

export const BLOCK_TYPES = ['chapeau', 'texte', 'paragraphe', 'encadre', 'fiche', 'chiffre-cle', 'legende', 'etiquette'] as const;
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
    /** Paragraphe d'une chaîne (ED4) : seulement pour un bloc `paragraphe` ; `zone` est alors la chaîne. */
    paragraphe: slugSchema.optional(),
    text: localizedText,
    /** En-tête écrit par la recherche (ED4), par langue : présent seulement quand la mise en page l'attend. */
    heading: localizedText.optional(),
    /** État de relecture de l'en-tête (ED4), présent avec lui seulement : le bloc n'est relu que si son texte et son en-tête le sont. */
    headingState: z.enum(BLOCK_STATES).optional(),
    claims: z.array(slugSchema).min(1, 'une affirmation au moins'),
    state: z.enum(BLOCK_STATES),
  })
  .superRefine((b, ctx) => {
    if ((b.type === 'fiche') !== (b.item !== undefined)) ctx.addIssue({ code: 'custom', path: ['item'], message: 'item : attendu pour un bloc de fiche, et seulement pour lui' });
    if ((b.type === 'paragraphe') !== (b.paragraphe !== undefined)) ctx.addIssue({ code: 'custom', path: ['paragraphe'], message: 'paragraphe : attendu pour un bloc paragraphe, et seulement pour lui' });
    if ((b.heading === undefined) !== (b.headingState === undefined)) ctx.addIssue({ code: 'custom', path: ['headingState'], message: 'headingState : attendu avec un en-tête, et seulement avec lui' });
    if (new Set(b.claims).size !== b.claims.length) ctx.addIssue({ code: 'custom', path: ['claims'], message: 'affirmation citée deux fois' });
  });
export type Block = z.infer<typeof blockSchema>;

/** Identifiant d'un bloc : la zone, ou la zone et l'information pour une fiche, ou la chaîne et le paragraphe (ED4). */
export const blockId = (zone: string, item?: string) => (item ? `${zone}-${item}` : zone);

/**
 * État de relecture d'un bloc entier (ED4) : relu (`valide`) seulement si son texte et son en-tête le sont ; à reprendre si l'un des deux l'est ;
 * à relire sinon. Sans en-tête, l'état du texte.
 */
export function reviewState(b: Pick<Block, 'state' | 'headingState'>): BlockState {
  if (b.headingState === undefined) return b.state;
  if (b.state === 'a-reprendre' || b.headingState === 'a-reprendre') return 'a-reprendre';
  return b.state === 'valide' && b.headingState === 'valide' ? 'valide' : 'a-relire';
}
