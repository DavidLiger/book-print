// src/checks/content.ts — contrôles du contenu d'un sujet (spec §7) : C10, C12, C13. Fonctions pures : elles reçoivent le sujet, la recherche,
// les blocs attendus et les mesures du rendu, et rendent un verdict sans rien lire.
import type { ExpectedBlock } from '../research/blocks';
import type { Block } from '../schema/block';
import { claimIsValidated, type UrlCheck } from '../schema/claim';
import type { Measures } from '../render/measure';
import type { ChainCut, ChainText } from '../render/flow';
import type { Chain } from '../layout/schema';
import type { CheckResult, Level } from './rules';

type Lang = 'fr' | 'en' | 'es';

/** Les sites qui bloquent les robots répondent 401, 403 ou 429 : le lien n'est pas mort, David l'ouvre à la main. */
const BOT_REFUSALS = [401, 403, 429];

/** Une URL qui ne répond plus (C10). Sans contrôle, rien n'est reproché : le contrôle est une action de David. */
export function urlIsDead(check: UrlCheck | undefined): boolean {
  if (!check) return false;
  if (check.code === null) return true;
  return !(check.code >= 200 && check.code < 300) && !BOT_REFUSALS.includes(check.code);
}

export interface C10Claim {
  id: string;
  status: 'propose' | 'valide' | 'rejete' | 'corrige';
  sources: { url: string; urlCheck?: UrlCheck }[];
}

function verdict(id: string, label: string, errors: string[], alerts: string[] = []): CheckResult {
  const level: Level = errors.length > 0 ? 'erreur' : alerts.length > 0 ? 'alerte' : 'ok';
  return { id, label, level, details: [...new Set([...errors, ...alerts])] };
}

export function c10Sources(blocks: Pick<Block, 'id' | 'claims'>[], claims: C10Claim[]): CheckResult {
  const known = new Map(claims.map((c) => [c.id, c]));
  const errors: string[] = [];
  const alerts: string[] = [];
  for (const block of blocks) {
    for (const id of block.claims) {
      const claim = known.get(id);
      if (!claim) errors.push(`bloc ${block.id} : affirmation inconnue, ${id}`);
      else if (!claimIsValidated(claim.status)) errors.push(`bloc ${block.id} : affirmation ${id} non validée (${claim.status})`);
    }
  }
  for (const claim of claims) {
    if (!claimIsValidated(claim.status)) continue;
    if (claim.sources.length === 0) errors.push(`affirmation ${claim.id} : aucune source`);
    for (const source of claim.sources) {
      if (urlIsDead(source.urlCheck)) alerts.push(`affirmation ${claim.id} : ${source.url} ne répond plus (${source.urlCheck!.code ?? source.urlCheck!.error})`);
    }
  }
  return verdict('C10', 'Sources : seulement des affirmations validées, chacune avec sa source', errors, alerts);
}

export interface TextInput {
  blocks: Block[];
  expected: ExpectedBlock[];
  lang: Lang;
  title: string;
  titleMax: number | null;
  legend: string;
  legendMax: number | null;
  /** Chaînes de la mise en page (ED2) : leurs définitions, leur texte et la coupure de la première passe. */
  chains?: { defs: Chain[]; texts: Record<string, ChainText>; flow: Record<string, ChainCut> };
}

export const charCount = (text: string) => [...text].length;
const fmt = (n: number) => n.toFixed(1).replace('.', ',');
const words = (n: number) => `${n} mot${n > 1 ? 's' : ''}`;

/**
 * C12 sur une chaîne (ED2, spec §24.5) : du texte resté après la dernière boîte, avec le nombre de mots en trop ; un paragraphe ou un
 * intertitre plus long que sa limite. Le débordement de chaque boîte est mesuré comme celui des autres zones (`data-fill`).
 */
export function chainFaults(flow: Record<string, ChainCut>, texts: Record<string, ChainText>, chains: Chain[]): string[] {
  const out: string[] = [];
  for (const chain of chains) {
    const cut = flow[chain.id];
    if (cut && cut.rest > 0) out.push(`chaîne ${chain.id} : ${words(cut.rest)} en trop après la dernière boîte`);
    const text = texts[chain.id];
    if (!text) continue;
    for (const p of chain.paragraphes) {
      const got = text.paragraphs.find((t) => t.id === p.id);
      if (!got) continue;
      if (charCount(got.text) > p.maxChars) out.push(`chaîne ${chain.id}, ${p.id} : ${charCount(got.text)} caractères, ${p.maxChars} au plus`);
      if (got.heading !== null && p.headingMaxChars !== undefined && charCount(got.heading) > p.headingMaxChars) out.push(`chaîne ${chain.id}, intertitre de ${p.id} : ${charCount(got.heading)} caractères, ${p.headingMaxChars} au plus`);
    }
  }
  return out;
}

/** C12 mesure le débordement réel (§16.6) : un texte court peut déborder, un texte long peut tenir. Les limites restent des erreurs : le prompt les annonce. */
export function c12Texts({ blocks, expected, lang, title, titleMax, legend, legendMax, chains }: TextInput, measures: Pick<Measures, 'overflows'>): CheckResult {
  const errors: string[] = [];
  const over = (label: string, text: string, max: number | null) => {
    if (max !== null && charCount(text) > max) errors.push(`${label} : ${charCount(text)} caractères, ${max} au plus`);
  };
  over('titre', title, titleMax);
  over('légende du QR', legend, legendMax);
  for (const block of blocks) {
    const text = block.text[lang];
    if (text === undefined || text.trim() === '') {
      errors.push(`bloc ${block.id} : aucun texte en ${lang}`);
      continue;
    }
    over(`bloc ${block.id}`, text, expected.find((b) => b.id === block.id)?.maxChars ?? null);
  }
  for (const o of measures.overflows) errors.push(`page ${o.page}, ${o.item ? `fiche, ${o.item}` : o.zone} : déborde de ${fmt(o.overMm)} mm`);
  if (chains) errors.push(...chainFaults(chains.flow, chains.texts, chains.defs));
  return verdict('C12', 'Texte dans la langue de l\'édition, dans les limites, sans débordement', errors);
}

const FILLER = [/lorem\s+ipsum/i, /\bipsum\b/i, /texte\s+(factice|d['’]essai|de\s+remplissage|provisoire)/i, /à\s+(compléter|rédiger|remplir)/i, /\b(todo|tbd|fixme|placeholder)\b/i, /\bx{3,}\b/i, /\?{3,}/, /essaisaurus/i];

const normalized = (text: string) => text.toLowerCase().replace(/[’]/g, '\'').replace(/\s+/g, ' ').trim();

export interface FillerInput {
  blocks: Block[];
  expected: ExpectedBlock[];
  lang: Lang;
  title: string;
  legend: string;
  /** Phrases du sujet d'essai. */
  essaiPhrases: string[];
  /** Valeurs de fiche du sujet d'essai : comparées à la valeur entière, car elles sont courtes. */
  essaiValues: string[];
  /** Chaînes au texte de remplissage (ED2) : leur texte viendra de la recherche par paragraphe (ED4). */
  fillerChains?: string[];
}

export function c13Filler({ blocks, expected, lang, title, legend, essaiPhrases, essaiValues, fillerChains }: FillerInput): CheckResult {
  const errors: string[] = [];
  for (const id of fillerChains ?? []) errors.push(`chaîne ${id} : texte de remplissage jusqu'à ED4`);
  const phrases = essaiPhrases.map(normalized);
  const values = essaiValues.map(normalized);
  const inspect = (label: string, text: string) => {
    const plain = normalized(text);
    if (plain === '') return;
    if (FILLER.some((re) => re.test(text))) errors.push(`${label} : texte de remplissage`);
    else if (phrases.some((p) => plain.includes(p)) || values.includes(plain)) errors.push(`${label} : phrase du sujet d'essai`);
  };
  if (title.trim() === '') errors.push('titre vide');
  if (legend.trim() === '') errors.push('légende du QR vide');
  inspect('titre', title);
  inspect('légende du QR', legend);
  for (const want of expected) {
    const block = blocks.find((b) => b.id === want.id);
    const text = block?.text[lang] ?? '';
    if (text.trim() === '') errors.push(`zone ${want.item ? `fiche, ${want.item}` : want.zone} vide`);
    else inspect(`bloc ${want.id}`, text);
  }
  return verdict('C13', 'Aucun texte de remplissage, aucune zone vide', errors);
}

export interface SubjectCheckInput extends TextInput, Pick<FillerInput, 'essaiPhrases' | 'essaiValues' | 'fillerChains'> {
  claims: C10Claim[];
  measures: Pick<Measures, 'overflows'>;
}

export function runSubjectChecks(input: SubjectCheckInput): CheckResult[] {
  return [c10Sources(input.blocks, input.claims), c12Texts(input, input.measures), c13Filler(input)];
}
