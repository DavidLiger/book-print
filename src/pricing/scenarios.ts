// src/pricing/scenarios.ts — schéma versionné de `<bookId>/pricing.json` (spec §9.6) et écart avec `print-book.json`.
import { z } from 'zod';
import { bookIdSchema, schemaVersionSchema, slugSchema, uniqueList } from '../schema/common';
import type { PrintBook } from '../schema/print-book';
import { trimLabel } from './calc';
import { BINDINGS, INKS, MARKETPLACES } from './rates';

const hasCents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const moneySchema = z.number().nonnegative('montant positif ou nul').refine(hasCents, 'deux décimales au plus');
const count = z.number().int('nombre entier');

const pagesSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('saisi'), pages: count.positive('nombre de pages positif') }),
  z.strictObject({
    mode: z.literal('estime'),
    subjects: count.positive('nombre de sujets positif'),
    pagesPerSubject: z.union([z.literal(2), z.literal(4), z.literal(6)], { error: 'pages par sujet : 2, 4 ou 6' }),
    extraPages: count.nonnegative('pages liminaires et finales : positif ou nul'),
  }),
]);

export const scenarioInputSchema = z.strictObject({
  name: z.string().trim().min(1, 'nom du scénario attendu').max(60, 'nom du scénario : 60 caractères au plus'),
  binding: z.enum(BINDINGS),
  trim: z.strictObject({ widthIn: z.number().positive(), heightIn: z.number().positive() }),
  ink: z.enum(INKS),
  pages: pagesSchema,
  marketplace: z.enum(MARKETPLACES),
  vat: z.enum(['reduced', 'standard']),
  price: z.strictObject({ kind: z.enum(['ht', 'ttc']), amount: moneySchema }),
  targetRoyalty: moneySchema.optional(),
});
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;

export const scenarioSchema = scenarioInputSchema.extend({ id: slugSchema });
export type Scenario = z.infer<typeof scenarioSchema>;

export const pricingFileSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    bookId: bookIdSchema,
    scenarios: z.array(scenarioSchema),
    retainedId: slugSchema.nullable(),
  })
  .superRefine((file, ctx) => {
    const ids = file.scenarios.map((s) => s.id);
    const unique = uniqueList(slugSchema, 'scénario').safeParse(ids);
    if (!unique.success) ctx.addIssue({ code: 'custom', message: unique.error.issues[0]!.message });
    if (file.retainedId !== null && !ids.includes(file.retainedId)) ctx.addIssue({ code: 'custom', message: `scénario retenu inconnu : ${file.retainedId}` });
  });
export type PricingFile = z.infer<typeof pricingFileSchema>;

export const emptyPricing = (bookId: string): PricingFile => ({ schemaVersion: 1, bookId, scenarios: [], retainedId: null });

/** Écart entre le livre et le scénario retenu (§9.6) : format et pages. L'outil le signale, il n'écrit pas `print-book.json`. */
export function deviation(book: PrintBook, scenario: Pick<ScenarioInput, 'trim'>, pages: number): string[] {
  const out: string[] = [];
  const { trim } = book.edition;
  if (trim.widthIn !== scenario.trim.widthIn || trim.heightIn !== scenario.trim.heightIn) {
    out.push(`Format : ${trimLabel(scenario.trim)} dans le scénario retenu, ${trimLabel(trim)} dans print-book.json.`);
  }
  if (book.pageBudget !== pages) out.push(`Pages : ${pages} dans le scénario retenu, ${book.pageBudget} dans print-book.json (pageBudget).`);
  return out;
}
