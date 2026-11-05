// scripts/test-pricing.ts — simulateur de prix (spec §9) : barèmes, calcul, contrôles, scénarios, `pricing.json`, routes.
// Les exemples chiffrés viennent des pages KDP citées dans `kdp-rates.json`.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { bookFolder, deleteScenario, PricingRefused, readPricing, readPrintBook, retainScenario, saveScenario } from '../src/data/pricing-file';
import { createBookFolder } from '../src/data/create-book';
import { createPrintServer } from '../src/server/app';
import { divRound, estimatePages, evaluate, formatMoney, htToTtc, priceFor, printCost, ratesAreOld, resolvePages, royalty, royaltyRate, toCents, trimCategory, trimLabel, ttcToHt } from '../src/pricing/calc';
import { BINDINGS, loadRates, MARKETPLACES, parseRates, type Binding, type Ink, type Marketplace } from '../src/pricing/rates';
import { deviation, emptyPricing, pricingFileSchema, scenarioInputSchema, scenarioSchema, type ScenarioInput } from '../src/pricing/scenarios';
import { dirLink, fileLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

const rates = loadRates();
const today = new Date('2026-11-05T12:00:00Z');
const threshold = (market: Marketplace, binding: Binding = 'paperback') => {
  const zone = rates.zones[rates.marketplaces[market]!.zone]!;
  return { max50: toCents(zone.royalty[binding].rate50MaxPrice), min60: toCents(zone.royalty[binding].rate60MinPrice) };
};
const cost = (market: Marketplace, ink: Ink, category: 'regular' | 'large', pages: number, binding: Binding = 'paperback') => printCost(rates, { binding, ink, category, market, pages });
const base: ScenarioInput = {
  name: 'Essai',
  binding: 'paperback',
  trim: { widthIn: 6, heightIn: 9 },
  ink: 'premium-color',
  pages: { mode: 'saisi', pages: 46 },
  marketplace: 'amazon.fr',
  vat: 'reduced',
  price: { kind: 'ht', amount: 12 },
};
const run = (change: Partial<ScenarioInput> = {}, at = today) => evaluate(rates, { ...base, ...change }, at);
const hasText = (list: string[], text: string) => list.some((x) => x.includes(text));

// Barèmes : chaque valeur a sa source et sa date
check('barème : valide', rates.schemaVersion === 1);
check('barème : daté', rates.surveyedAt === '2026-11-05');
check('barème : six marketplaces', MARKETPLACES.every((m) => Object.hasOwn(rates.marketplaces, m)));
check('barème : chaque source a une URL KDP et une date', Object.values(rates.sources).every((s) => s.url.startsWith('https://kdp.amazon.com/') && /^\d{4}-\d{2}-\d{2}$/.test(s.surveyedAt)));
check('barème : TVA de fr, de, es, it, uk', ['fr', 'de', 'es', 'it', 'uk'].every((c) => Object.hasOwn(rates.vat.rates, c)));
check('barème : TVA fr 5,5 et 20', rates.vat.rates.fr!.reducedPct === 5.5 && rates.vat.rates.fr!.standardPct === 20);
const raw = JSON.parse(JSON.stringify(rates));
{
  const copy = structuredClone(raw);
  copy.zones.EUR.print.paperback['premium-color'].source = 'S99';
  let refused = false;
  try {
    parseRates(copy);
  } catch {
    refused = true;
  }
  check('barème : source inconnue refusée', refused);
}
{
  const copy = structuredClone(raw);
  delete copy.zones.EUR.royalty.paperback.source;
  let refused = false;
  try {
    parseRates(copy);
  } catch {
    refused = true;
  }
  check('barème : valeur sans source refusée', refused);
}
{
  const copy = structuredClone(raw);
  copy.sources.S4.surveyedAt = 'hier';
  let refused = false;
  try {
    parseRates(copy);
  } catch {
    refused = true;
  }
  check('barème : source sans date refusée', refused);
}
for (const binding of BINDINGS) {
  check(`formats ${binding} : catégorie conforme à la règle`, rates.trims[binding].every((t) => (t.widthIn > 6.12 || t.heightIn > 9) === (trimCategory(rates, t) === 'large')));
}
check('formats : 16 brochés et 5 reliés', rates.trims.paperback.length === 16 && rates.trims.hardcover.length === 5);

// Catégorie de format
check('6 × 9 : format normal', trimCategory(rates, { widthIn: 6, heightIn: 9 }) === 'regular');
check('6,14 × 9,21 : grand format', trimCategory(rates, { widthIn: 6.14, heightIn: 9.21 }) === 'large');
check('8,5 × 11 : grand format', trimCategory(rates, { widthIn: 8.5, heightIn: 11 }) === 'large');
check('8,25 × 6 : grand format par la largeur', trimCategory(rates, { widthIn: 8.25, heightIn: 6 }) === 'large');
check('libellé de format', trimLabel({ widthIn: 8.5, heightIn: 11 }) === '8,5 × 11"');

// Exemples publiés par KDP [S4] [S9] [S12] [S13]
check('[S4] 150 p., couleur standard, normal, .de : 4,35 €', cost('amazon.de', 'standard-color', 'regular', 150) === 435);
check('[S4] 300 p., noir, normal, .com : 4,60 $', cost('amazon.com', 'black-white', 'regular', 300) === 460);
check('[S4] 55 p., noir, normal, .co.uk : 1,93 £ (forfait)', cost('amazon.co.uk', 'black-white', 'regular', 55) === 193);
check('[S9] 333 p., noir, normal, .com : coût arrondi à 5,00 $', cost('amazon.com', 'black-white', 'regular', 333) === 500);
{
  const c = cost('amazon.com', 'black-white', 'regular', 333)!;
  check('[S9] 15 $ : redevance Amazon 4,00 $', royalty(1500, 60, c) === 400);
  check('[S9] 15 $ : distribution étendue 1,00 $', royalty(1500, 40, c) === 100);
  check('[S12] 300 p. à 9,99 $ : 1,39 $ à 60 %', royalty(999, royaltyRate(threshold('amazon.com'), 999), 460) === 139);
  check('[S12] 300 p. à 9,98 $ : 0,39 $ à 50 %', royalty(998, royaltyRate(threshold('amazon.com'), 998), 460) === 39);
}
check('[S13] relié, 300 p., noir, normal, .com : 9,25 $', cost('amazon.com', 'black-white', 'regular', 300, 'hardcover') === 925);
check('[S13] relié, 300 p., noir, grand, .com : 10,75 $', cost('amazon.com', 'black-white', 'large', 300, 'hardcover') === 1075);

// Barèmes : les tranches
check('couleur premium : 80 p., grand : 6,47 €', cost('amazon.fr', 'premium-color', 'large', 80) === 647);
check('couleur premium : 100 p., grand : 7,90 €', cost('amazon.fr', 'premium-color', 'large', 100) === 790);
check('couleur premium : 40 p., normal : forfait 2,85 €', cost('amazon.fr', 'premium-color', 'regular', 40) === 285);
check('couleur premium : 40 p., grand : forfait 3,61 €', cost('amazon.fr', 'premium-color', 'large', 40) === 361);
check('couleur premium : 42 p., normal : 2,96 €', cost('amazon.fr', 'premium-color', 'regular', 42) === 296);
check('couleur premium : 44 p., normal : 3,06 €', cost('amazon.fr', 'premium-color', 'regular', 44) === 306);
check('couleur premium : 46 p., grand : 4,04 €', cost('amazon.fr', 'premium-color', 'large', 46) === 404);
check('noir : 110 p., tranche par page retenue', cost('amazon.fr', 'black-white', 'regular', 110) === 207);
check('noir : 108 p., forfait', cost('amazon.fr', 'black-white', 'regular', 108) === 205);
check('noir sur crème : mêmes tarifs que sur blanc', cost('amazon.fr', 'black-cream', 'large', 200) === cost('amazon.fr', 'black-white', 'large', 200));
check('papier journal : 114 p.', cost('amazon.fr', 'black-groundwood', 'regular', 114) === 205);
check('.co.uk couleur premium : 46 p., normal', cost('amazon.co.uk', 'premium-color', 'regular', 46) === 285);
check('couleur standard refusée à 70 p. par le barème', cost('amazon.fr', 'standard-color', 'regular', 70) === null);
check('relié : couleur standard sans barème', cost('amazon.fr', 'standard-color', 'regular', 100, 'hardcover') === null);
check('relié : couleur premium, 100 p., normal, zone euro', cost('amazon.fr', 'premium-color', 'regular', 100, 'hardcover') === 1035);

// Arrondi
check('arrondi : 5 final vers le haut', divRound(31650, 100) === 317);
check('arrondi : négatif symétrique', divRound(-31650, 100) === -317);
check('arrondi : sous le 5', divRound(31649, 100) === 316);
check('affichage : euros', formatMoney(317, 'EUR') === '3,17 €');
check('affichage : centimes sur deux chiffres', formatMoney(405, 'USD') === '4,05 $');
check('affichage : négatif', formatMoney(-5, 'GBP') === '−0,05 £');

// Cas de David
{
  const r = run();
  check('cas de David : coût 3,17 €', r.printCost === 317, r);
  check('cas de David : redevance 4,03 €', r.royalty === 403, r);
  check('cas de David : taux 60 %', r.ratePct === 60);
  check('cas de David : format normal', r.category === 'regular');
  check('cas de David : distribution étendue 1,63 €', r.expandedRoyalty === 163, r);
  check('cas de David : prix minimum 6,34 €', r.minimumPrice === 634, r);
  check('cas de David : aucune erreur ni alerte', r.errors.length === 0 && r.alerts.length === 0, r);
  check('cas de David : TTC aux deux taux', r.price.ttcReduced === 1266 && r.price.ttcStandard === 1440, r.price);
}

// Taux et prix minimum
const euro = threshold('amazon.fr');
check('taux : 9,98 € à 50 %', royaltyRate(euro, 998) === 50);
check('taux : 9,99 € à 60 %', royaltyRate(euro, 999) === 60);
check('taux : 7,98 £ à 50 %', royaltyRate(threshold('amazon.co.uk'), 798) === 50);
check('taux : 7,99 £ à 60 %', royaltyRate(threshold('amazon.co.uk'), 799) === 60);
check('taux : relié, 9,98 € à 50 %', royaltyRate(threshold('amazon.fr', 'hardcover'), 998) === 50);
check('minimum : à 50 % quand le prix y tombe', priceFor(euro, 317, 0).price === 634 && priceFor(euro, 317, 0).ratePct === 50);
check('minimum : seuil de 9,99 € entre les deux taux', priceFor(euro, 550, 0).price === 999 && priceFor(euro, 550, 0).ratePct === 60);
check('minimum : à 60 % au-delà', priceFor(euro, 647, 0).price === 1079 && priceFor(euro, 647, 0).ratePct === 60);

// Conversion HT et TTC
check('HT → TTC à 5,5 %', htToTtc(1200, 5.5) === 1266);
check('HT → TTC à 20 %', htToTtc(1200, 20) === 1440);
check('TTC → HT à 5,5 %', ttcToHt(1266, 5.5) === 1200);
check('TTC → HT à 20 %', ttcToHt(1440, 20) === 1200);
check('TTC → HT : scénario à 5,5 %', run({ price: { kind: 'ttc', amount: 12.66 }, vat: 'reduced' }).price.ht === 1200);
check('TTC → HT : scénario à 20 %', run({ price: { kind: 'ttc', amount: 14.4 }, vat: 'standard' }).price.ht === 1200);
check('.com : TTC sans objet', run({ marketplace: 'amazon.com' }).price.ttcReduced === null);
check('.com : prix TTC pris tel quel', run({ marketplace: 'amazon.com', price: { kind: 'ttc', amount: 12 } }).price.ht === 1200);
check('.co.uk : taux réduit à 0 %', run({ marketplace: 'amazon.co.uk' }).price.ttcReduced === 1200);
check('.de : taux normal à 19 %', run({ marketplace: 'amazon.de' }).price.ttcStandard === 1428);

// Prix pour une redevance visée
{
  const r = run({ targetRoyalty: 4 });
  check('redevance visée : 4 € à 11,95 € HT', r.target?.ht === 1195 && r.target.ratePct === 60, r.target);
  check('redevance visée : TTC aux deux taux', r.target?.ttcReduced === 1261 && r.target.ttcStandard === 1434, r.target);
  check('redevance visée : atteinte au prix donné', royalty(r.target!.ht, 60, 317) === 400);
  check('redevance visée : tombe à 50 %', run({ targetRoyalty: 1 }).target?.ratePct === 50 && run({ targetRoyalty: 1 }).target?.ht === 834);
  check('redevance visée : seuil de 9,99 €', run({ targetRoyalty: 2 }).target?.ht === 999);
  check('redevance visée : absente', run().target === null);
}

// Estimation des pages
check('estimation par défaut : 15 × 2 + 14 = 44', estimatePages(15, 2, 14).pages === 44 && estimatePages(15, 2, 14).calculation === '15 × 2 + 14 = 44');
check('estimation : 46 avec 16 pages liminaires et finales', estimatePages(15, 2, 16).pages === 46);
check('estimation : arrondie au pair et affichée', estimatePages(15, 2, 15).pages === 46 && estimatePages(15, 2, 15).calculation.includes('arrondi au pair'));
check('estimation : 4 pages par sujet', estimatePages(20, 4, 14).pages === 94);
const estimated = { mode: 'estime', subjects: 15, pagesPerSubject: 2, extraPages: 14 } as const;
check('pages : résolues depuis l’estimation', resolvePages(estimated).pages === 44);
check('pages : saisies', resolvePages({ mode: 'saisi', pages: 46 }).calculation === 'saisi');
check('scénario estimé : calcul complet dans le résultat', run({ pages: estimated }).pagesCalculation === '15 × 2 + 14 = 44' && run({ pages: estimated }).printCost === 306);

// Contrôles : erreurs (§9.5)
{
  const r = run({ ink: 'standard-color', pages: { mode: 'saisi', pages: 70 } });
  check('erreur : couleur standard à 70 pages', hasText(r.errors, '72 à 600'), r.errors);
  check('erreur : sans barème, pas de redevance', r.royalty === null && r.printCost === null);
  check('couleur standard à 72 pages admise', run({ ink: 'standard-color', pages: { mode: 'saisi', pages: 72 } }).errors.length === 0);
  check('erreur : au-delà de la plage du format', hasText(run({ trim: { widthIn: 8.5, heightIn: 11 }, pages: { mode: 'saisi', pages: 600 } }).errors, '24 à 590'));
  check('erreur : sous 24 pages', hasText(run({ pages: { mode: 'saisi', pages: 22 } }).errors, '24 à 828'));
  check('erreur : relié sous 75 pages', hasText(run({ binding: 'hardcover', pages: { mode: 'saisi', pages: 46 } }).errors, '75 à 550'));
  check('relié à 76 pages admis', run({ binding: 'hardcover', pages: { mode: 'saisi', pages: 76 }, price: { kind: 'ht', amount: 15 } }).errors.length === 0);
  check('relié : format absent', hasText(run({ binding: 'hardcover', trim: { widthIn: 8.5, heightIn: 11 }, pages: { mode: 'saisi', pages: 100 } }).errors, 'absent'));
  check('erreur : format hors liste', hasText(run({ trim: { widthIn: 6, heightIn: 8 } }).errors, 'absent'));
  check('erreur : encre indisponible sur le format', hasText(run({ ink: 'standard-color', trim: { widthIn: 8.27, heightIn: 11.69 }, pages: { mode: 'saisi', pages: 100 } }).errors, 'indisponibles'));
  check('erreur : nombre de pages impair', hasText(run({ pages: { mode: 'saisi', pages: 47 } }).errors, 'pair'));
  check('erreur : prix sous le minimum', hasText(run({ price: { kind: 'ht', amount: 6.33 } }).errors, 'sous le prix minimum'));
  check('prix égal au minimum admis', run({ price: { kind: 'ht', amount: 6.34 } }).errors.length === 0);
  check('erreur : entre le prix à 60 % et le minimum réel', hasText(run({ price: { kind: 'ht', amount: 5.29 } }).errors, '6,34'));
}

// Contrôles : alertes (§9.5)
{
  check('alerte : prix à 9,98 €', hasText(run({ price: { kind: 'ht', amount: 9.98 } }).alerts, 'changement de taux'));
  check('alerte : prix à 9,99 €', hasText(run({ price: { kind: 'ht', amount: 9.99 } }).alerts, 'changement de taux'));
  check('pas d’alerte à 9,97 €', !hasText(run({ price: { kind: 'ht', amount: 9.97 } }).alerts, 'changement de taux'));
  check('pas d’alerte à 10 €', !hasText(run({ price: { kind: 'ht', amount: 10 } }).alerts, 'changement de taux'));
  check('alerte : seuil propre à .co.uk', hasText(run({ marketplace: 'amazon.co.uk', price: { kind: 'ht', amount: 7.98 } }).alerts, '7,99 £'));
  const low = run({ price: { kind: 'ht', amount: 7 } });
  check('alerte : distribution étendue négative', low.expandedRoyalty === -37 && hasText(low.alerts, 'distribution étendue'), low);
  check('relié : pas de distribution étendue', run({ binding: 'hardcover', pages: { mode: 'saisi', pages: 76 } }).expandedRoyalty === null);
  check('barème récent : pas d’alerte', !ratesAreOld('2026-11-05', new Date('2027-05-05T00:00:00Z')));
  check('barème de plus de 6 mois', ratesAreOld('2026-11-05', new Date('2027-05-06T00:00:00Z')));
  check('alerte : barème ancien', hasText(run({}, new Date('2027-06-01T00:00:00Z')).alerts, 'plus de 6 mois'));
}

// Schéma des scénarios : chaque refus
const refuses = (name: string, change: Record<string, unknown>) => check(`refus : ${name}`, !scenarioInputSchema.safeParse({ ...base, ...change }).success, change);
check('schéma : scénario valide', scenarioInputSchema.safeParse(base).success);
check('schéma : estimation valide', scenarioInputSchema.safeParse({ ...base, pages: estimated }).success);
check('schéma : redevance visée admise', scenarioInputSchema.safeParse({ ...base, targetRoyalty: 4 }).success);
refuses('nom vide', { name: '   ' });
refuses('nom trop long', { name: 'x'.repeat(61) });
refuses('clé inconnue', { autre: 1 });
refuses('reliure inconnue', { binding: 'spirale' });
refuses('encre inconnue', { ink: 'or' });
refuses('marketplace hors liste', { marketplace: 'amazon.ca' });
refuses('TVA inconnue', { vat: '5.5' });
refuses('largeur nulle', { trim: { widthIn: 0, heightIn: 9 } });
refuses('format incomplet', { trim: { widthIn: 6 } });
refuses('pages non entières', { pages: { mode: 'saisi', pages: 46.5 } });
refuses('pages nulles', { pages: { mode: 'saisi', pages: 0 } });
refuses('mode de pages inconnu', { pages: { mode: 'magie', pages: 46 } });
refuses('estimation sans sujet', { pages: { ...estimated, subjects: 0 } });
refuses('3 pages par sujet', { pages: { ...estimated, pagesPerSubject: 3 } });
refuses('pages liminaires négatives', { pages: { ...estimated, extraPages: -1 } });
refuses('clé inconnue dans les pages', { pages: { ...estimated, pages: 46 } });
refuses('prix négatif', { price: { kind: 'ht', amount: -1 } });
refuses('prix à trois décimales', { price: { kind: 'ht', amount: 12.345 } });
refuses('type de prix inconnu', { price: { kind: 'net', amount: 12 } });
refuses('redevance visée négative', { targetRoyalty: -1 });
refuses('redevance visée à trois décimales', { targetRoyalty: 4.001 });
check('refus : identifiant de scénario invalide', !scenarioSchema.safeParse({ ...base, id: 'Pas Bon' }).success);
const validFile = { schemaVersion: 1, bookId: 'livre-test', scenarios: [{ ...base, id: 's1' }], retainedId: 's1' };
check('fichier : valide', pricingFileSchema.safeParse(validFile).success);
check('refus : version de fichier', !pricingFileSchema.safeParse({ ...validFile, schemaVersion: 2 }).success);
check('refus : bookId du fichier', !pricingFileSchema.safeParse({ ...validFile, bookId: 'con' }).success);
check('refus : scénario en double', !pricingFileSchema.safeParse({ ...validFile, scenarios: [{ ...base, id: 's1' }, { ...base, id: 's1' }] }).success);
check('refus : scénario retenu inconnu', !pricingFileSchema.safeParse({ ...validFile, retainedId: 's2' }).success);
check('refus : clé inconnue du fichier', !pricingFileSchema.safeParse({ ...validFile, autre: 1 }).success);
check('fichier vide : valide', pricingFileSchema.safeParse(emptyPricing('livre-test')).success);

// Écart avec print-book.json
{
  const dataRoot = tempDir();
  createBookFolder(dataRoot, 'livre-test');
  const { book } = readPrintBook(dataRoot, 'livre-test');
  check('écart : print-book lu', book?.pageBudget === 46);
  check('écart : aucun', deviation(book!, base, 46).length === 0);
  check('écart : pages', hasText(deviation(book!, base, 44), '44 dans le scénario retenu, 46 dans print-book.json'));
  check('écart : format', hasText(deviation(book!, { trim: { widthIn: 8.5, heightIn: 11 } }, 46), '8,5 × 11"'));
  check('écart : les deux', deviation(book!, { trim: { widthIn: 8.5, heightIn: 11 } }, 44).length === 2);
}

// pricing.json
const refusedWith = (fn: () => unknown, text: string): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof PricingRefused && e.message.includes(text);
  }
};
const noTmp = (dir: string) => !fs.readdirSync(dir).some((f) => f.endsWith('.tmp'));
{
  const dataRoot = tempDir();
  const id = 'livre-test';
  check('dossier absent : pas de lecture', readPricing(dataRoot, id) === null && bookFolder(dataRoot, id) === null);
  check('dossier absent : enregistrement refusé', refusedWith(() => saveScenario(dataRoot, id, base), 'Dossier du livre absent'));
  createBookFolder(dataRoot, id);
  const dir = path.join(dataRoot, id);
  const file = path.join(dir, 'pricing.json');
  const book = fs.readFileSync(path.join(dir, 'print-book.json'), 'utf8');
  check('fichier absent : liste vide', readPricing(dataRoot, id)?.scenarios.length === 0 && !fs.existsSync(file));
  const first = saveScenario(dataRoot, id, base);
  check('enregistrement : identifiant donné', first.scenarios[0]?.id === 's1');
  check('enregistrement : écrit dans le dossier du livre', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).bookId === id);
  check('enregistrement : aucun fichier temporaire', noTmp(dir));
  saveScenario(dataRoot, id, { ...base, name: 'Deux' });
  const third = saveScenario(dataRoot, id, { ...base, name: 'Trois' });
  check('enregistrement : réécrit à chaque fois', third.scenarios.length === 3 && readPricing(dataRoot, id)?.scenarios.length === 3);
  const changed = saveScenario(dataRoot, id, { ...base, name: 'Deux bis' }, 's2');
  check('mise à jour : même place', changed.scenarios[1]?.name === 'Deux bis' && changed.scenarios.length === 3);
  check('mise à jour : scénario inconnu refusé', refusedWith(() => saveScenario(dataRoot, id, base, 's9'), 'inconnu'));
  check('retenu : un seul', retainScenario(dataRoot, id, 's1').retainedId === 's1' && retainScenario(dataRoot, id, 's2').retainedId === 's2');
  check('retenu : scénario inconnu refusé', refusedWith(() => retainScenario(dataRoot, id, 's9'), 'inconnu'));
  check('retenu : marque retirée', retainScenario(dataRoot, id, null).retainedId === null);
  retainScenario(dataRoot, id, 's3');
  const removed = deleteScenario(dataRoot, id, 's3');
  check('suppression : retire la marque', removed.scenarios.length === 2 && removed.retainedId === null);
  check('suppression : identifiant non réutilisé par collision', saveScenario(dataRoot, id, base).scenarios.at(-1)?.id === 's3');
  check('suppression : scénario inconnu refusé', refusedWith(() => deleteScenario(dataRoot, id, 's9'), 'inconnu'));
  check('print-book.json inchangé', fs.readFileSync(path.join(dir, 'print-book.json'), 'utf8') === book);

  const good = fs.readFileSync(file, 'utf8');
  for (const [name, content, text] of [
    ['JSON invalide', '{', 'JSON valide'],
    ['schéma invalide', '{"schemaVersion":2}', 'invalide'],
    ['autre bookId', JSON.stringify({ ...JSON.parse(good), bookId: 'autre-livre' }), 'autre-livre'],
  ] as const) {
    fs.writeFileSync(file, content);
    check(`fichier invalide : ${name}, lecture refusée`, refusedWith(() => readPricing(dataRoot, id), text));
    check(`fichier invalide : ${name}, jamais écrasé`, refusedWith(() => saveScenario(dataRoot, id, base), text) && fs.readFileSync(file, 'utf8') === content && noTmp(dir));
  }
  fs.writeFileSync(file, good);

  check('refus : bookId réservé', refusedWith(() => saveScenario(dataRoot, 'con', base), 'bookId refusé'));
  check('refus : chemin dans le bookId', refusedWith(() => readPricing(dataRoot, '../autre'), 'bookId refusé'));
  check('refus : bookId absolu', refusedWith(() => bookFolder(dataRoot, path.resolve(dataRoot)), 'bookId refusé'));

  fs.rmSync(file);
  fs.mkdirSync(file);
  check('refus : pricing.json est un dossier', refusedWith(() => saveScenario(dataRoot, id, base), 'fichier réel') && noTmp(dir));
  fs.rmdirSync(file);

  fs.writeFileSync(path.join(dataRoot, 'fichier'), '');
  check('refus : le dossier du livre est un fichier', refusedWith(() => readPricing(dataRoot, 'fichier'), 'dossier réel'));
  const outside = tempDir();
  dirLink(outside, path.join(dataRoot, 'lien'));
  check('refus : le dossier du livre est un lien', refusedWith(() => saveScenario(dataRoot, 'lien', base), 'dossier réel') && fs.readdirSync(outside).length === 0);

  const target = path.join(outside, 'cible.json');
  fs.writeFileSync(target, 'intact');
  if (fileLink(target, file)) {
    check('refus : pricing.json est un lien', refusedWith(() => saveScenario(dataRoot, id, base), 'fichier réel') && fs.readFileSync(target, 'utf8') === 'intact');
    fs.rmSync(file);
  }

  fs.writeFileSync(path.join(dir, 'print-book.json'), '{');
  check('print-book illisible : signalé', readPrintBook(dataRoot, id).error?.includes('illisible') === true);
  fs.writeFileSync(path.join(dir, 'print-book.json'), '{"schemaVersion":1}');
  check('print-book invalide : signalé', readPrintBook(dataRoot, id).error?.includes('invalide') === true);
  fs.rmSync(path.join(dir, 'print-book.json'));
  check('print-book absent : signalé', readPrintBook(dataRoot, id).error?.includes('absent') === true);
}

// Le simulateur ne lit ni n'importe GLBInterpreter : seul l'utilitaire de chemins, sans lecture, est partagé.
{
  const root = path.resolve(import.meta.dirname, '..', 'src');
  const files = ['pricing/calc.ts', 'pricing/rates.ts', 'pricing/scenarios.ts', 'data/pricing-file.ts', 'server/pricing-actions.ts'];
  check('aucune lecture de GLBInterpreter', files.every((f) => !/glbi\/read|readBook|listBooks|glbRoot/.test(fs.readFileSync(path.join(root, f), 'utf8'))));
  const pure = ['pricing/calc.ts', 'pricing/scenarios.ts'];
  check('calcul pur : aucun accès aux fichiers', pure.every((f) => !/node:fs|node:http/.test(fs.readFileSync(path.join(root, f), 'utf8'))));
}

// Routes
interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
{
  const parent = tempDir();
  const dataRoot = path.join(parent, 'donnees');
  fs.mkdirSync(dataRoot);
  const configPath = path.join(parent, 'config.local.json');
  put(parent, 'config.local.json', { glbRoot: makeGlbi(), dataRoot });
  const server = createPrintServer(configPath);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;
  const headers = { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
  const post = (p: string, body: unknown, h: Record<string, string> = headers) => request(port, { path: p, headers: h, body: JSON.stringify(body) });
  const bookId = 'livre-test';
  const routes: [string, unknown][] = [
    ['/api/pricing/state', { bookId }],
    ['/api/pricing/compute', { scenario: base }],
    ['/api/pricing/save', { bookId, scenario: base }],
    ['/api/pricing/delete', { bookId, id: 's1' }],
    ['/api/pricing/retain', { bookId, id: null }],
  ];
  const { 'x-book-print': _x, ...noHeader } = headers;
  const { Origin: _o, ...noOrigin } = headers;
  for (const [route, body] of routes) {
    check(`${route} : Host refusé`, (await post(route, body, { ...headers, Host: 'attaque.example' })).status === 403);
    check(`${route} : Origin refusée`, (await post(route, body, { ...headers, Origin: 'https://attaque.example' })).status === 403);
    check(`${route} : Origin absente refusée`, (await post(route, body, noOrigin)).status === 403);
    check(`${route} : en-tête absent refusé`, (await post(route, body, noHeader)).status === 403);
    check(`${route} : text/plain refusé`, (await post(route, body, { ...headers, 'Content-Type': 'text/plain' })).status === 403);
    const get = await request(port, { method: 'GET', path: route, headers: { Host: host } });
    check(`${route} : GET refusé`, get.status === 405 && get.headers.allow === 'POST');
    check(`${route} : corps invalide`, (await post(route, { autre: 1 })).status === 400);
  }
  check('aucune écriture par les requêtes refusées', fs.readdirSync(dataRoot).length === 0);

  const state = JSON.parse((await post('/api/pricing/state', { bookId })).body);
  check('état : dossier absent signalé', state.folder === false && state.scenarios.length === 0);
  check('état : avertissement du §9.7', state.catalog.warning === 'Estimation selon les barèmes KDP relevés le 05/11/2026. Vérifiez avec le calculateur officiel.' && state.catalog.calculatorUrl === 'https://kdp.amazon.com/royalty-calculator', state.catalog);
  check('état : formats de la liste', state.catalog.trims.paperback.some((t: { label: string; category: string }) => t.label === '6 × 9"' && t.category === 'regular'));
  const computed = JSON.parse((await post('/api/pricing/compute', { scenario: base })).body);
  check('calcul : sans dossier ni enregistrement', computed.result.royalty === 403 && fs.readdirSync(dataRoot).length === 0, computed);
  check('enregistrement sans dossier : 409', (await post('/api/pricing/save', { bookId, scenario: base })).status === 409);
  check('bookId refusé : 409', (await post('/api/pricing/state', { bookId: '../x' })).status === 409);
  check('scénario invalide : 400 avec le champ', (await post('/api/pricing/compute', { scenario: { ...base, ink: 'or' } })).body.includes('ink'));

  createBookFolder(dataRoot, bookId);
  const before = fs.readFileSync(path.join(dataRoot, bookId, 'print-book.json'), 'utf8');
  const saved = JSON.parse((await post('/api/pricing/save', { bookId, scenario: { ...base, pages: estimated } })).body);
  check('enregistrement : scénario et résultat renvoyés', saved.folder && saved.scenarios[0].scenario.id === 's1' && saved.scenarios[0].result.pages === 44, saved);
  await post('/api/pricing/save', { bookId, scenario: { ...base, trim: { widthIn: 8.5, heightIn: 11 } } });
  const reloaded = JSON.parse((await post('/api/pricing/state', { bookId })).body);
  check('rechargement : scénarios conservés', reloaded.scenarios.length === 2 && reloaded.scenarios[1].result.printCost === 404, reloaded);
  check('sans scénario retenu : aucun écart', reloaded.deviation.length === 0);
  const retained = JSON.parse((await post('/api/pricing/retain', { bookId, id: 's2' })).body);
  check('retenu différent : écart de format signalé', retained.retainedId === 's2' && hasText(retained.deviation, 'Format'), retained);
  const pagesOnly = JSON.parse((await post('/api/pricing/retain', { bookId, id: 's1' })).body);
  check('retenu différent : écart de pages signalé', pagesOnly.deviation.length === 1 && hasText(pagesOnly.deviation, '44'), pagesOnly);
  check('écart : print-book.json inchangé', fs.readFileSync(path.join(dataRoot, bookId, 'print-book.json'), 'utf8') === before);
  const gone = JSON.parse((await post('/api/pricing/delete', { bookId, id: 's1' })).body);
  check('suppression : scénario retenu retiré', gone.retainedId === null && gone.scenarios.length === 1);
  fs.writeFileSync(path.join(dataRoot, bookId, 'pricing.json'), '{');
  const broken = await post('/api/pricing/save', { bookId, scenario: base });
  check('fichier invalide : 409, conservé', broken.status === 409 && fs.readFileSync(path.join(dataRoot, bookId, 'pricing.json'), 'utf8') === '{', broken);
  check('page : section du simulateur servie', (await request(port, { method: 'GET', path: '/', headers: { Host: host } })).body.includes('id="prix"'));
  await new Promise((resolve) => server.close(resolve));
}

finish('prix');
