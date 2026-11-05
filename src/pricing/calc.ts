// src/pricing/calc.ts — calcul du simulateur (spec §9.3 à §9.5), fonctions pures. Tout se compte en entiers : les montants
// en centimes, les coûts bruts en dix-millièmes, la TVA en pour-mille. Un montant comme 3,165 ne dépend donc d'aucun flottant.
import type { Binding, Ink, Marketplace, Rates, Zone } from './rates';

export type TrimCategory = 'regular' | 'large';
export interface Trim {
  widthIn: number;
  heightIn: number;
}

export const toCents = (amount: number): number => Math.round(amount * 100);
const toUnits = (amount: number): number => Math.round(amount * 10000);
const toPerMille = (pct: number): number => Math.round(pct * 10);

/** Division entière arrondie au plus proche, le 5 final s'éloignant de zéro. */
export function divRound(n: number, d: number): number {
  const q = Math.floor((Math.abs(n) * 2 + d) / (2 * d));
  return n < 0 ? -q : q;
}
const divCeil = (n: number, d: number): number => Math.floor((n + d - 1) / d);

const SYMBOLS: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')} ${SYMBOLS[currency] ?? currency}`;
}
const inches = (n: number): string => String(n).replace('.', ',');
export const trimLabel = (t: Trim): string => `${inches(t.widthIn)} × ${inches(t.heightIn)}"`;

export function trimCategory(rates: Rates, t: Trim): TrimCategory {
  const { widthOverIn, heightOverIn } = rates.rules.largeTrim;
  return t.widthIn > widthOverIn || t.heightIn > heightOverIn ? 'large' : 'regular';
}

/** Les encres de [S1] partagent les barèmes de [S4] : noir sur blanc et noir sur crème ont les mêmes tarifs. */
function costKey(ink: Ink): 'black' | 'groundwood' | 'standard-color' | 'premium-color' {
  if (ink === 'black-white' || ink === 'black-cream') return 'black';
  return ink === 'black-groundwood' ? 'groundwood' : ink;
}

const zoneOf = (rates: Rates, market: Marketplace): Zone => rates.marketplaces[market]!.zone;

/** Coût d'impression en centimes, `null` sans barème pour ce nombre de pages. La dernière tranche gagne : voir `rules.overlap`. */
export function printCost(rates: Rates, q: { binding: Binding; ink: Ink; category: TrimCategory; market: Marketplace; pages: number }): number | null {
  const print = rates.zones[zoneOf(rates, q.market)]!.print;
  const key = costKey(q.ink);
  const table = q.binding === 'paperback' ? print.paperback[key] : key === 'black' || key === 'premium-color' ? print.hardcover[key] : undefined;
  if (!table) return null;
  const tier = table.tiers.findLast((t) => q.pages >= t.from && q.pages <= t.to);
  if (!tier) return null;
  const [fixed, perPage] = tier[q.category];
  return divRound(toUnits(fixed) + q.pages * toUnits(perPage), 100);
}

interface Thresholds {
  max50: number;
  min60: number;
}
function thresholds(rates: Rates, market: Marketplace, binding: Binding): Thresholds {
  const r = rates.zones[zoneOf(rates, market)]!.royalty[binding];
  return { max50: toCents(r.rate50MaxPrice), min60: toCents(r.rate60MinPrice) };
}

export const royaltyRate = (t: Thresholds, price: number): 50 | 60 => (price <= t.max50 ? 50 : 60);

/** (taux × prix) − coût, arrondi au centime, le coût étant déjà arrondi (règle [S12]). */
export const royalty = (price: number, ratePct: number, cost: number): number => divRound(price * ratePct - cost * 100, 100);

/**
 * Plus petit prix qui couvre `cost + target`. Le taux dépend du prix : 3,17 / 0,6 = 5,29 tomberait à 50 %, où ce prix ne
 * couvre plus le coût. Entre les deux, le premier prix à 60 % est le seuil lui-même.
 */
export function priceFor(t: Thresholds, cost: number, target: number): { price: number; ratePct: 50 | 60 } {
  const need = (cost + target) * 100;
  const at50 = divCeil(need, 50);
  if (at50 <= t.max50) return { price: at50, ratePct: 50 };
  return { price: Math.max(t.min60, divCeil(need, 60)), ratePct: 60 };
}

export const htToTtc = (ht: number, vatPct: number): number => divRound(ht * (1000 + toPerMille(vatPct)), 1000);
export const ttcToHt = (ttc: number, vatPct: number): number => divRound(ttc * 1000, 1000 + toPerMille(vatPct));

/** Estimation du §9.3 : le calcul complet reste visible, il n'y a aucune valeur cachée. */
export function estimatePages(subjects: number, pagesPerSubject: number, extraPages: number): { pages: number; calculation: string } {
  const total = subjects * pagesPerSubject + extraPages;
  const pages = total + (total % 2);
  const calculation = `${subjects} × ${pagesPerSubject} + ${extraPages} = ${total}${pages === total ? '' : `, arrondi au pair : ${pages}`}`;
  return { pages, calculation };
}

export type PageInput = { mode: 'saisi'; pages: number } | { mode: 'estime'; subjects: number; pagesPerSubject: number; extraPages: number };
export function resolvePages(input: PageInput): { pages: number; calculation: string } {
  if (input.mode === 'saisi') return { pages: input.pages, calculation: 'saisi' };
  return estimatePages(input.subjects, input.pagesPerSubject, input.extraPages);
}

export interface PricingInput {
  binding: Binding;
  trim: Trim;
  ink: Ink;
  pages: PageInput;
  marketplace: Marketplace;
  vat: 'reduced' | 'standard';
  price: { kind: 'ht' | 'ttc'; amount: number };
  targetRoyalty?: number;
}

export interface Taxed {
  ht: number;
  ttcReduced: number | null;
  ttcStandard: number | null;
}

export interface PricingResult {
  currency: string;
  trim: string;
  category: TrimCategory;
  pages: number;
  pagesCalculation: string;
  vatPct: { reduced: number; standard: number } | null;
  printCost: number | null;
  ratePct: 50 | 60 | null;
  price: Taxed;
  royalty: number | null;
  /** `null` : sans coût calculable, ou relié (pas de distribution étendue [S12]). */
  expandedRoyalty: number | null;
  minimumPrice: number | null;
  target: (Taxed & { ratePct: 50 | 60 }) | null;
  errors: string[];
  alerts: string[];
}

/** Date de relevé + 6 mois, au jour près (§9.5). */
export function ratesAreOld(surveyedAt: string, today: Date): boolean {
  const limit = new Date(`${surveyedAt}T00:00:00Z`);
  limit.setUTCMonth(limit.getUTCMonth() + 6);
  return today.getTime() > limit.getTime();
}

export const dateFr = (iso: string): string => iso.split('-').reverse().join('/');

export function evaluate(rates: Rates, input: PricingInput, today: Date): PricingResult {
  const market = input.marketplace;
  const currency = rates.zones[zoneOf(rates, market)]!.currency;
  const money = (cents: number) => formatMoney(cents, currency);
  const country = rates.marketplaces[market]!.vatCountry;
  const vat = country === null ? null : rates.vat.rates[country]!;
  const vatPct = vat && { reduced: vat.reducedPct, standard: vat.standardPct };
  const taxed = (ht: number): Taxed => ({
    ht,
    ttcReduced: vatPct && htToTtc(ht, vatPct.reduced),
    ttcStandard: vatPct && htToTtc(ht, vatPct.standard),
  });

  const errors: string[] = [];
  const alerts: string[] = [];
  const { pages, calculation } = resolvePages(input.pages);
  const category = trimCategory(rates, input.trim);
  const label = trimLabel(input.trim);

  const trim = rates.trims[input.binding].find((t) => t.widthIn === input.trim.widthIn && t.heightIn === input.trim.heightIn);
  const pageRange = trim?.pages[input.ink];
  if (!trim) errors.push(`Format ${label} absent de la liste KDP pour cette reliure.`);
  else if (!pageRange) errors.push(`Encre et papier indisponibles en ${label} pour cette reliure.`);
  else if (pages < pageRange[0] || pages > pageRange[1]) errors.push(`${pages} pages hors de la plage : ${pageRange[0]} à ${pageRange[1]} pages pour cette encre en ${label}.`);
  if (pages % 2 !== 0) errors.push(`${pages} pages : nombre pair attendu.`);

  const amount = toCents(input.price.amount);
  const ht = input.price.kind === 'ttc' && vatPct ? ttcToHt(amount, vatPct[input.vat]) : amount;
  const t = thresholds(rates, market, input.binding);
  if (ht >= t.max50 && ht <= t.min60) alerts.push(`Prix à la limite du changement de taux : 50 % jusqu'à ${money(t.max50)} HT, 60 % à partir de ${money(t.min60)} HT.`);
  if (ratesAreOld(rates.surveyedAt, today)) alerts.push(`Barèmes relevés le ${dateFr(rates.surveyedAt)}, il y a plus de 6 mois : à relever de nouveau.`);

  const cost = printCost(rates, { binding: input.binding, ink: input.ink, category, market, pages });
  if (cost === null) return { currency, trim: label, category, pages, pagesCalculation: calculation, vatPct, printCost: null, ratePct: null, price: taxed(ht), royalty: null, expandedRoyalty: null, minimumPrice: null, target: null, errors, alerts };

  const ratePct = royaltyRate(t, ht);
  const minimumPrice = priceFor(t, cost, 0).price;
  if (ht < minimumPrice) errors.push(`Prix de ${money(ht)} HT sous le prix minimum de ${money(minimumPrice)} HT.`);

  const expandedRoyalty = input.binding === 'paperback' ? royalty(ht, rates.rules.expandedDistribution.paperbackRatePct, cost) : null;
  if (expandedRoyalty !== null && expandedRoyalty < 0) alerts.push(`Redevance négative en distribution étendue : ${money(expandedRoyalty)}.`);

  let target: PricingResult['target'] = null;
  if (input.targetRoyalty !== undefined) {
    const found = priceFor(t, cost, toCents(input.targetRoyalty));
    target = { ...taxed(found.price), ratePct: found.ratePct };
  }

  return { currency, trim: label, category, pages, pagesCalculation: calculation, vatPct, printCost: cost, ratePct, price: taxed(ht), royalty: royalty(ht, ratePct, cost), expandedRoyalty, minimumPrice, target, errors, alerts };
}
