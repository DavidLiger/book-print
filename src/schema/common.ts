// src/schema/common.ts — briques communes des schémas de book-print (spec §3).
import { z } from 'zod';

// Messages par défaut de Zod en français, comme dans GLBInterpreter.
z.config(z.locales.fr());

/** Version des fichiers écrits par ce lot : `schemaVersion` de `print-book.json`, `subject.json` et `rights.json`. */
export const SCHEMA_VERSION = 1 as const;
export const schemaVersionSchema = z.literal(SCHEMA_VERSION, { error: `schemaVersion : ${SCHEMA_VERSION} attendu` });

export const LANGS = ['fr', 'en', 'es'] as const;
export const langSchema = z.enum(LANGS);

/** Identifiant propre à book-print (spec §3) : minuscules, chiffres et tirets. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const slugSchema = z.string().regex(SLUG_PATTERN, 'identifiant : minuscules, chiffres et tirets');

/** Motif de `sceneIdSchema` de GLBInterpreter : `bookId` et `sceneId` viennent de ce repo, ils gardent son motif. */
export const GLBI_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const glbiIdSchema = z.string().regex(GLBI_ID_PATTERN, 'identifiant GLBInterpreter : lettres, chiffres, _ et -');

/** Noms que Windows réserve : un `bookId` devient un nom de dossier. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** `collection/` porte les données communes (architecture §4) : sans casse, car Windows confond `Collection` et `collection`. */
const DATA_RESERVED = /^collection$/i;
export const bookIdSchema = glbiIdSchema
  .refine((id) => !WINDOWS_RESERVED.test(id), 'nom réservé par Windows')
  .refine((id) => !DATA_RESERVED.test(id), 'bookId réservé : collection/ porte les données communes');

/** Liste sans doublon : renvoie le premier doublon trouvé dans le message. */
export function uniqueList<T extends z.ZodType>(item: T, label: string) {
  return z.array(item).superRefine((list, ctx) => {
    const seen = new Set<unknown>();
    for (const x of list) {
      if (seen.has(x)) ctx.addIssue({ code: 'custom', message: `${label} en double : ${String(x)}` });
      seen.add(x);
    }
  });
}
