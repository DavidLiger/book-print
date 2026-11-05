// src/server/pricing-actions.ts — actions du simulateur de prix (spec §9). Aucune lecture de GLBInterpreter : seuls le barème
// du repo et le dossier de données sont lus. Le `bookId` vient de la page et passe par les refus de `pricing-file.ts`.
import { z } from 'zod';
import { deleteScenario, readPricing, readPrintBook, retainScenario, saveScenario } from '../data/pricing-file';
import { dateFr, evaluate, resolvePages, trimCategory, trimLabel } from '../pricing/calc';
import { loadRates, type Rates } from '../pricing/rates';
import { deviation, scenarioInputSchema, type PricingFile } from '../pricing/scenarios';
import { slugSchema } from '../schema/common';

export class BadPricingRequest extends Error {}

type Json = Record<string, unknown>;

const bookOnly = z.strictObject({ bookId: z.string() });
const compute = z.strictObject({ scenario: scenarioInputSchema });
const save = z.strictObject({ bookId: z.string(), scenario: scenarioInputSchema, id: slugSchema.optional() });
const remove = z.strictObject({ bookId: z.string(), id: slugSchema });
const retain = z.strictObject({ bookId: z.string(), id: slugSchema.nullable() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadPricingRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

/** Ce que la page affiche pour construire son formulaire : tout vient du barème. */
function catalog(rates: Rates): Json {
  const trims = (list: Rates['trims']['paperback']) => list.map((t) => ({ widthIn: t.widthIn, heightIn: t.heightIn, label: trimLabel(t), category: trimCategory(rates, t) }));
  return {
    surveyedAt: rates.surveyedAt,
    warning: `Estimation selon les barèmes KDP relevés le ${dateFr(rates.surveyedAt)}. Vérifiez avec le calculateur officiel.`,
    calculatorUrl: rates.calculatorUrl,
    trims: { paperback: trims(rates.trims.paperback), hardcover: trims(rates.trims.hardcover) },
    marketplaces: Object.keys(rates.marketplaces),
  };
}

function view(dataRoot: string, bookId: string, file: PricingFile | null): Json {
  const rates = loadRates();
  const today = new Date();
  if (!file) return { catalog: catalog(rates), folder: false, scenarios: [], retainedId: null, deviation: [], bookAlert: null };
  const retained = file.scenarios.find((s) => s.id === file.retainedId);
  const { book, error } = readPrintBook(dataRoot, bookId);
  return {
    catalog: catalog(rates),
    folder: true,
    scenarios: file.scenarios.map((scenario) => ({ scenario, result: evaluate(rates, scenario, today) })),
    retainedId: file.retainedId,
    deviation: retained && book ? deviation(book, retained, resolvePages(retained.pages).pages) : [],
    bookAlert: retained ? error : null,
  };
}

export const PRICING_ACTIONS: Record<string, (body: unknown, dataRoot: string) => Json> = {
  '/api/pricing/state': (body, dataRoot) => {
    const { bookId } = parse(bookOnly, body);
    return view(dataRoot, bookId, readPricing(dataRoot, bookId));
  },
  '/api/pricing/compute': (body) => ({ result: evaluate(loadRates(), parse(compute, body).scenario, new Date()) }),
  '/api/pricing/save': (body, dataRoot) => {
    const { bookId, scenario, id } = parse(save, body);
    return view(dataRoot, bookId, saveScenario(dataRoot, bookId, scenario, id));
  },
  '/api/pricing/delete': (body, dataRoot) => {
    const { bookId, id } = parse(remove, body);
    return view(dataRoot, bookId, deleteScenario(dataRoot, bookId, id));
  },
  '/api/pricing/retain': (body, dataRoot) => {
    const { bookId, id } = parse(retain, body);
    return view(dataRoot, bookId, retainScenario(dataRoot, bookId, id));
  },
};
