// src/research/blocks.ts — blocs attendus d'un gabarit (spec §4.3) : zone par zone, le type et la longueur maximale. Le prompt, l'import et
// C12 lisent cette même liste. Le titre et la légende du QR n'y sont pas : ils ne citent aucune affirmation (§3.5).
import { BLOCK_TYPES, blockId, type BlockType } from '../schema/block';
import type { Fiche } from '../schema/style';
import { elementsOf, type MiseEnPage } from '../layout/model';

type Lang = 'fr' | 'en' | 'es';

export interface ExpectedBlock {
  id: string;
  zone: string;
  type: BlockType;
  item?: string;
  label: string;
  maxChars: number | null;
}

const isBlockType = (type: string): type is BlockType => (BLOCK_TYPES as readonly string[]).includes(type);

export function expectedBlocks(template: MiseEnPage, fiche: Fiche, lang: Lang): ExpectedBlock[] {
  const out: ExpectedBlock[] = [];
  for (const zone of elementsOf(template)) {
    const { type } = zone;
    if (!isBlockType(type)) continue;
    if (type === 'fiche') {
      for (const item of fiche) out.push({ id: blockId(zone.id, item.id), zone: zone.id, type, item: item.id, label: item.label[lang], maxChars: zone.itemMaxChars ?? null });
    } else out.push({ id: zone.id, zone: zone.id, type, label: zone.id, maxChars: zone.maxChars ?? null });
  }
  return out;
}

/** Limite d'une zone sans bloc : le titre (porté par un titre ou par un bandeau, ED1), la légende du QR. */
export function zoneLimit(template: MiseEnPage, type: 'titre' | 'qr'): number | null {
  const types: string[] = type === 'titre' ? ['titre', 'bandeau'] : ['qr'];
  return elementsOf(template).find((z) => types.includes(z.type))?.maxChars ?? null;
}

/**
 * Écart entre les blocs d'un sujet et ceux que son gabarit attend (GB1) : un gabarit modifié sous un sujet. Un bloc dont la zone a changé de
 * type compte des deux côtés. Rien n'est réécrit : un second import règle l'écart.
 */
export function blocksGap(blocks: { id: string; type: string }[], expected: ExpectedBlock[]): { missing: string[]; extra: string[] } {
  const key = (b: { id: string; type: string }) => `${b.id} (${b.type})`;
  const have = new Set(blocks.map(key));
  const want = new Set(expected.map(key));
  return { missing: [...want].filter((k) => !have.has(k)), extra: [...have].filter((k) => !want.has(k)) };
}
