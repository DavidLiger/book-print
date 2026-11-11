// src/research/blocks.ts — blocs attendus d'une mise en page (spec §4.3, §24.9) : élément par élément, le type, la sorte de paragraphe, les
// longueurs et l'en-tête à écrire. Le prompt, l'import, l'écart des blocs et C12 lisent cette même liste. Le titre et la légende du QR n'y sont
// pas : ils ne citent aucune affirmation (§3.5).
import { BLOCK_TYPES, blockId, type BlockType } from '../schema/block';
import type { Fiche } from '../schema/style';
import { chainsOf, elementsOf, type MiseEnPage } from '../layout/model';
import type { Kind } from './kinds';

type Lang = 'fr' | 'en' | 'es';

export interface ExpectedBlock {
  id: string;
  /** L'élément du bloc ; pour un `paragraphe`, la chaîne (ED4). */
  zone: string;
  type: BlockType;
  item?: string;
  /** Paragraphe de la chaîne (ED4). */
  paragraphe?: string;
  label: string;
  maxChars: number | null;
  /** Sorte de paragraphe : la consigne du prompt (ED4). */
  kind: Kind;
  /** En-tête à écrire par la recherche, avec sa longueur (ED4) ; `null` : aucun en-tête attendu. */
  heading: { maxChars: number } | null;
  /** En-tête fixé par la mise en page (un encadré à `heading`), dans la langue de l'édition : imprimé tel quel, rien à écrire. */
  fixedHeading?: string;
  /** Ce que montre l'image, écrit par David pour une légende ou une étiquette (ED1), repris par le prompt. */
  consigne?: string;
}

const isBlockType = (type: string): type is BlockType => (BLOCK_TYPES as readonly string[]).includes(type);

/**
 * Dans l'ordre de la mise en page. Une chaîne donne ses paragraphes, dans leur ordre, à la place de son premier cadre ; ses autres cadres
 * n'attendent rien (ED4). Un encadré sans en-tête fixé attend un en-tête écrit quand il a `headingMaxChars` (capsule à titre, question).
 */
export function expectedBlocks(template: MiseEnPage, fiche: Fiche, lang: Lang): ExpectedBlock[] {
  const out: ExpectedBlock[] = [];
  const chains = new Map(chainsOf(template).map((c) => [c.id, c]));
  const placed = new Set<string>();
  for (const zone of elementsOf(template)) {
    const { type } = zone;
    if (!isBlockType(type)) continue;
    if (zone.chaine !== undefined) {
      const chain = chains.get(zone.chaine);
      if (!chain || placed.has(chain.id)) continue;
      placed.add(chain.id);
      for (const p of chain.paragraphes) {
        out.push({
          id: blockId(chain.id, p.id),
          zone: chain.id,
          type: 'paragraphe',
          paragraphe: p.id,
          label: `${chain.id}, ${p.id}`,
          maxChars: p.maxChars,
          kind: 'paragraphe',
          heading: p.intertitre && p.headingMaxChars !== undefined ? { maxChars: p.headingMaxChars } : null,
        });
      }
      continue;
    }
    if (type === 'fiche') {
      for (const item of fiche) out.push({ id: blockId(zone.id, item.id), zone: zone.id, type, item: item.id, label: item.label[lang], maxChars: zone.itemMaxChars ?? null, kind: 'fiche', heading: null });
      continue;
    }
    const base = { id: zone.id, zone: zone.id, type, label: zone.id, maxChars: zone.maxChars ?? null };
    if (type === 'encadre') {
      const kind: Kind = zone.sorte === 'question' ? 'question' : 'capsule';
      out.push({
        ...base,
        kind,
        heading: zone.heading === undefined && zone.headingMaxChars !== undefined ? { maxChars: zone.headingMaxChars } : null,
        ...(zone.heading ? { fixedHeading: zone.heading[lang] } : {}),
      });
    } else out.push({ ...base, kind: type as Kind, heading: null, ...(zone.consigne !== undefined && (type === 'legende' || type === 'etiquette') ? { consigne: zone.consigne } : {}) });
  }
  return out;
}

/** Identifiants de bloc portés par deux blocs attendus (ED4) : un élément nommé comme une chaîne et son paragraphe, par exemple. */
export function duplicateBlocks(expected: ExpectedBlock[]): string[] {
  const seen = new Map<string, ExpectedBlock>();
  const out: string[] = [];
  for (const b of expected) {
    const first = seen.get(b.id);
    if (first) out.push(`${b.id} (${first.label} et ${b.label})`);
    else seen.set(b.id, b);
  }
  return out;
}

/** Ce qui empêche le prompt et l'import (ED4) : un identifiant de bloc en double, nommé. `null` : rien. */
export function duplicateFault(expected: ExpectedBlock[]): string | null {
  const dup = duplicateBlocks(expected);
  return dup.length === 0 ? null : `Identifiant de bloc en double : ${dup.join(', ')}. Renommer l'élément ou le paragraphe dans l'étape Mise en page.`;
}

/** Limite d'une zone sans bloc : le titre (porté par un titre ou par un bandeau, ED1), la légende du QR. */
export function zoneLimit(template: MiseEnPage, type: 'titre' | 'qr'): number | null {
  const types: string[] = type === 'titre' ? ['titre', 'bandeau'] : ['qr'];
  return elementsOf(template).find((z) => types.includes(z.type))?.maxChars ?? null;
}

/**
 * Écart entre les blocs d'un sujet et ceux que sa mise en page attend (GB1) : une mise en page modifiée sous un sujet. Un bloc dont la zone a
 * changé de type compte des deux côtés. ED4 : un en-tête manquant là où il est exigé, ou présent là où il ne l'est plus, compte aussi.
 * Rien n'est réécrit : un second import règle l'écart.
 */
export function blocksGap(blocks: { id: string; type: string; heading?: unknown }[], expected: ExpectedBlock[]): { missing: string[]; extra: string[] } {
  const key = (b: { id: string; type: string }) => `${b.id} (${b.type})`;
  const have = new Map(blocks.map((b) => [key(b), b]));
  const want = new Map(expected.map((b) => [key(b), b]));
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const extra = [...have.keys()].filter((k) => !want.has(k));
  for (const [k, w] of want) {
    const b = have.get(k);
    if (!b) continue;
    if (w.heading && b.heading === undefined) missing.push(`en-tête de ${w.id}`);
    if (!w.heading && b.heading !== undefined) extra.push(`en-tête de ${w.id}`);
  }
  return { missing, extra };
}
