// src/schema/print-book.ts — `<bookId>/print-book.json` (spec §3.2).
// `trim` et `pageBudget` portent les valeurs provisoires du §3.2, décision ferme en PX1 : aucune géométrie n'en dépend ici.
import { z } from 'zod';
import { bookIdSchema, langSchema, schemaVersionSchema, slugSchema, uniqueList } from './common';
import { ficheSchema } from './style';

/** ISBN-13 : 978 ou 979, tirets admis ; la clé de contrôle sera vue au lot couverture (P-3). */
const isbnSchema = z.string().refine((s) => /^97[89]\d{10}$/.test(s.replace(/-/g, '')), 'ISBN : 13 chiffres commençant par 978 ou 979');

export const editionSchema = z.strictObject({
  lang: langSchema,
  trim: z.strictObject({
    widthIn: z.number().positive('largeur en pouces, positive'),
    heightIn: z.number().positive('hauteur en pouces, positive'),
  }),
  bleed: z.literal(true, { error: 'bleed : vrai attendu (MP-1)' }),
  ink: z.literal('premium-color', { error: 'ink : premium-color attendu (MP-1)' }),
  paper: z.literal('white', { error: 'paper : white attendu (MP-1)' }),
  isbn: isbnSchema.optional(),
});

export const printBookSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  bookId: bookIdSchema,
  edition: editionSchema,
  pageBudget: z.number().int('nombre de pages entier').positive().refine((n) => n % 2 === 0, 'nombre de pages pair attendu'),
  frontMatter: uniqueList(slugSchema, 'page liminaire'),
  backMatter: uniqueList(slugSchema, 'page finale'),
  subjects: uniqueList(slugSchema, 'sujet'),
  /** Remplace la fiche de `collection/style.json` pour ce livre (P-30). Les pictogrammes sont contrôlés avec la collection, au rendu. */
  fiche: ficheSchema.optional(),
  /** Style de la bibliothèque par défaut pour les illustrations du livre (IC2), réglé dans l'étape Styles. */
  defaultStyle: slugSchema.optional(),
});
export type PrintBook = z.infer<typeof printBookSchema>;

/** Valeurs d'un livre neuf : provisoires (spec §3.2). */
export function newPrintBook(bookId: string): PrintBook {
  return printBookSchema.parse({
    schemaVersion: 1,
    bookId,
    edition: { lang: 'fr', trim: { widthIn: 6, heightIn: 9 }, bleed: true, ink: 'premium-color', paper: 'white' },
    pageBudget: 46,
    frontMatter: [],
    backMatter: [],
    subjects: [],
  });
}
