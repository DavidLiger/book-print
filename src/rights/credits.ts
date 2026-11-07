// src/rights/credits.ts — lecture de `credits.json`, écrit par « Générer les crédits » de l'addon `robot_maker` (spec §3.8, §13.3). Fonctions pures.
// Un crédit n'est jamais à ressaisir à la main ; une entrée déjà au registre n'est pas modifiée : une correction de David survit à un nouvel import.
import { z } from 'zod';
import { SLUG_PATTERN } from '../schema/common';
import type { RightsEntry } from '../schema/rights';

export class CreditsRefused extends Error {}

type Lang = 'fr' | 'en' | 'es';

export const CC_BY_LABEL = 'CC BY 4.0';
const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';
const SLUG_MAX = 80;

// Souple : le format appartient à l'addon, une clé ajoutée ne doit pas refuser le fichier.
const creditLine = z.object({
  asset: z.string().optional(),
  src_name: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  url: z.string().optional(),
  original: z.boolean().optional(),
});
const creditsFile = z.object({ entries: z.array(creditLine) });

export function parseCredits(content: string): z.infer<typeof creditsFile> {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^﻿/, ''));
  } catch (e) {
    throw new CreditsRefused(`credits.json n'est pas un JSON valide : ${(e as Error).message}`);
  }
  const parsed = creditsFile.safeParse(value);
  if (!parsed.success) throw new CreditsRefused(`credits.json invalide : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}`);
  return parsed.data;
}

/** `CC BY 4.0`, `CC-BY-4.0`, `C.C by 4.0` : même licence. Toute autre, dont Free Standard, reste à vérifier (§13.3). */
export function readLicense(raw: string): { license: string; commercialOk: RightsEntry['commercialOk'] } {
  const license = raw.trim();
  if (license.toLowerCase().replace(/[^a-z0-9]/g, '') === 'ccby40') return { license: CC_BY_LABEL, commercialOk: 'oui' };
  return { license, commercialOk: 'a-verifier' };
}

export function rightsId(author: string, name: string): string {
  const slug = `${author} ${name}`.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, SLUG_MAX).replace(/-+$/, '');
}

/**
 * Le texte à imprimer. CC BY 4.0, §3(a)(1) : créateur, lien vers l'œuvre, licence et son lien, et signaler une modification :
 * le repeint en est une. Sans auteur ou sans licence, aucun crédit : C11 le refuse tant que l'entrée n'est pas complétée.
 */
export function creditText(line: { name: string; author: string; license: string; url: string }, lang: Lang): string {
  const { name, author, license, url } = line;
  if (!author || !license) return '';
  const where = url ? ` (${url})` : '';
  const licence = license === CC_BY_LABEL ? `${license} (${CC_BY_URL})` : license;
  if (lang === 'en') return `"${name}" by ${author}${where}, licensed under ${licence}, modified.`;
  if (lang === 'es') return `«${name}», de ${author}${where}, licencia ${licence}, modificado.`;
  return `« ${name} », par ${author}${where}, licence ${licence}, modifié.`;
}

export interface CreditsImport {
  added: RightsEntry[];
  /** Déjà au registre, ou deux fois dans le fichier : rien n'est modifié. */
  kept: string[];
  originals: number;
  /** Ligne inutilisable, avec la raison. */
  skipped: string[];
}

/** `known` : les identifiants des deux registres. */
export function importCredits(file: z.infer<typeof creditsFile>, known: ReadonlySet<string>, lang: Lang): CreditsImport {
  const out: CreditsImport = { added: [], kept: [], originals: 0, skipped: [] };
  const seen = new Set(known);
  file.entries.forEach((line, index) => {
    if (line.original === true) {
      out.originals++;
      return;
    }
    const name = (line.src_name ?? '').trim() || (line.asset ?? '').trim();
    const author = (line.author ?? '').trim();
    const url = (line.url ?? '').trim();
    if (!name) {
      out.skipped.push(`ligne ${index + 1} : sans nom`);
      return;
    }
    const id = rightsId(author, name);
    if (!SLUG_PATTERN.test(id)) {
      out.skipped.push(`ligne ${index + 1} : aucun identifiant possible pour « ${name} »`);
      return;
    }
    if (seen.has(id)) {
      out.kept.push(id);
      return;
    }
    seen.add(id);
    const { license, commercialOk } = readLicense(line.license ?? '');
    out.added.push({ id, kind: 'modele-3d', name, author, license, ...(url ? { url } : {}), credit: creditText({ name, author, license, url }, lang), commercialOk: author && license ? commercialOk : 'a-verifier' });
  });
  return out;
}
