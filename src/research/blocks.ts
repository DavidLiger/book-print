// src/research/blocks.ts — blocs attendus d'un gabarit (spec §4.3) : zone par zone, le type et la longueur maximale. Le prompt, l'import et
// C12 lisent cette même liste. Le titre et la légende du QR n'y sont pas : ils ne citent aucune affirmation (§3.5).
import { BLOCK_TYPES, blockId, type BlockType } from '../schema/block';
import type { Fiche } from '../schema/style';
import type { Template } from '../templates/model';

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

export function expectedBlocks(template: Template, fiche: Fiche, lang: Lang): ExpectedBlock[] {
  const out: ExpectedBlock[] = [];
  for (const zone of template.sheets.flatMap((s) => s.zones)) {
    const { type } = zone;
    if (!isBlockType(type)) continue;
    if (type === 'fiche') {
      for (const item of fiche) out.push({ id: blockId(zone.id, item.id), zone: zone.id, type, item: item.id, label: item.label[lang], maxChars: zone.constraints?.itemMaxChars ?? null });
    } else out.push({ id: zone.id, zone: zone.id, type, label: zone.id, maxChars: zone.constraints?.maxChars ?? null });
  }
  return out;
}

/** Limite d'une zone sans bloc : le titre, la légende du QR. */
export function zoneLimit(template: Template, type: 'titre' | 'qr'): number | null {
  return template.sheets.flatMap((s) => s.zones).find((z) => z.type === type)?.constraints?.maxChars ?? null;
}
