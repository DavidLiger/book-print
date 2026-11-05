// src/pricing/rates.ts — lecture et validation de `kdp-rates.json` (spec §9.2). Une valeur sans source ni date est refusée
// au chargement : le fichier ne se met à jour que par un lot, avec les pages KDP sous les yeux.
import fs from 'node:fs';
import { z } from 'zod';
import '../schema/common';

export const BINDINGS = ['paperback', 'hardcover'] as const;
export type Binding = (typeof BINDINGS)[number];
/** Les colonnes du tableau des formats de KDP [S1]. */
export const INKS = ['black-white', 'black-cream', 'black-groundwood', 'standard-color', 'premium-color'] as const;
export type Ink = (typeof INKS)[number];
export const MARKETPLACES = ['amazon.fr', 'amazon.de', 'amazon.es', 'amazon.it', 'amazon.co.uk', 'amazon.com'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];
const ZONES = ['EUR', 'GBP', 'USD'] as const;
export type Zone = (typeof ZONES)[number];

const dateSchema = z.iso.date();
const pair = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
const range = z.tuple([z.number().int().positive(), z.number().int().positive()]);
const sourced = { source: z.string().min(1) };

const inkCostSchema = z.strictObject({
  ...sourced,
  tiers: z.array(z.strictObject({ from: z.number().int().positive(), to: z.number().int().positive(), regular: pair, large: pair })).min(1),
});
const royaltySchema = z.strictObject({ ...sourced, rate50MaxPrice: z.number().positive(), rate60MinPrice: z.number().positive() });
const trimSchema = z.strictObject({
  widthIn: z.number().positive(),
  heightIn: z.number().positive(),
  pages: z.partialRecord(z.enum(INKS), range),
});

export const ratesSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    surveyedAt: dateSchema,
    calculatorUrl: z.url(),
    sources: z.record(z.string(), z.strictObject({ title: z.string().min(1), url: z.url(), surveyedAt: dateSchema })),
    rules: z.strictObject({
      rounding: z.strictObject({ ...sourced, decimals: z.literal(2), half: z.literal('up'), rule: z.string().min(1) }),
      largeTrim: z.strictObject({ ...sourced, widthOverIn: z.number().positive(), heightOverIn: z.number().positive() }),
      minimumPrice: z.strictObject({ ...sourced, rule: z.string().min(1) }),
      expandedDistribution: z.strictObject({ ...sourced, paperbackRatePct: z.number().positive(), rule: z.string().min(1) }),
      overlap: z.string().min(1),
    }),
    marketplaces: z.record(z.enum(MARKETPLACES), z.strictObject({ zone: z.enum(ZONES), vatCountry: z.string().nullable() })),
    vat: z.strictObject({ ...sourced, rates: z.record(z.string(), z.strictObject({ reducedPct: z.number().nonnegative(), standardPct: z.number().positive() })) }),
    zones: z.record(
      z.enum(ZONES),
      z.strictObject({
        currency: z.string().length(3),
        royalty: z.strictObject({ paperback: royaltySchema, hardcover: royaltySchema }),
        print: z.strictObject({
          paperback: z.strictObject({ black: inkCostSchema, groundwood: inkCostSchema, 'standard-color': inkCostSchema, 'premium-color': inkCostSchema }),
          hardcover: z.strictObject({ black: inkCostSchema, 'premium-color': inkCostSchema }),
        }),
      }),
    ),
    trims: z.strictObject({ ...sourced, paperback: z.array(trimSchema).min(1), hardcover: z.array(trimSchema).min(1) }),
  })
  .superRefine((rates, ctx) => {
    const known = new Set(Object.keys(rates.sources));
    const walk = (value: unknown, at: string): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'source' && !known.has(String(child))) ctx.addIssue({ code: 'custom', message: `${at} : source inconnue ${String(child)}` });
        walk(child, `${at}.${key}`);
      }
    };
    const { sources: _sources, ...rest } = rates;
    walk(rest, 'barèmes');
    for (const [id, m] of Object.entries(rates.marketplaces)) {
      if (m.vatCountry !== null && !Object.hasOwn(rates.vat.rates, m.vatCountry)) ctx.addIssue({ code: 'custom', message: `${id} : pays de TVA sans taux` });
    }
  });
export type Rates = z.infer<typeof ratesSchema>;

export function parseRates(value: unknown): Rates {
  return ratesSchema.parse(value);
}

/** Lu à la demande : une erreur de barème remonte comme les autres, sans empêcher le serveur de démarrer. */
export function loadRates(): Rates {
  return parseRates(JSON.parse(fs.readFileSync(new URL('./kdp-rates.json', import.meta.url), 'utf8')));
}
