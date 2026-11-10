// src/server/gabarit-actions.ts — étape Gabarits (GB1) : la liste des gabarits de la collection, l'ajout des gabarits livrés sans écrasement,
// l'aperçu d'un gabarit et son contrôle. Aucune lecture de GLBInterpreter : le `bookId` vient de la page et passe par les refus de `bookFolder`.
// L'éditeur (ED3) écrit les modèles par `layout-actions.ts` ; aucune suppression : un modèle se retire à la main, dans `collection/gabarits/`.
import { z } from 'zod';
import { CollectionRefused, readCollection } from '../data/collection';
import { bookFolder, readPrintBook } from '../data/pricing-file';
import { readSubject, SubjectRefused } from '../data/subject-file';
import { controlTemplate, flowedPreview, templatePreview } from '../render/gabarit';
import { RenderRefused } from '../render/html';
import { slugSchema, TEMPLATE_ID_PATTERN } from '../schema/common';
import { formatLabel, formatOf, sameFormat, versionOf } from '../layout/model';
import { addDeliveredTemplates, readTemplates, TEMPLATES_DIR } from '../templates/files';

export class BadGabaritRequest extends Error {}

type Json = Record<string, unknown>;

const bookOnly = z.strictObject({ bookId: z.string() });
const templateBody = z.strictObject({ bookId: z.string(), id: z.string().regex(TEMPLATE_ID_PATTERN, 'gabarit : par exemple 4B ou 12A'), theme: slugSchema.optional() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadGabaritRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

export function requireBook(dataRoot: string, bookId: string) {
  if (bookFolder(dataRoot, bookId) === null) throw new RenderRefused(`Dossier du livre absent : ${bookId}/.`);
  const { book, error } = readPrintBook(dataRoot, bookId);
  if (!book) throw new RenderRefused(error ?? `print-book.json absent : ${bookId}/.`);
  return book;
}

/** Une erreur de gabarit se montre dans la liste : c'est là que David voit quel fichier reprendre. */
function state(dataRoot: string, bookId: string): Json {
  const book = requireBook(dataRoot, bookId);
  const collection = readCollection(dataRoot);
  if (!collection) throw new CollectionRefused('collection/ absent : le créer d\'abord dans la page.');
  const library = readTemplates(dataRoot, collection.style);
  const uses = new Map<string, string[]>();
  for (const id of book.subjects) {
    try {
      const subject = readSubject(dataRoot, bookId, id);
      uses.set(subject.template, [...(uses.get(subject.template) ?? []), id]);
    } catch (e) {
      if (!(e instanceof SubjectRefused)) throw e;
    }
  }
  return {
    folder: `collection/${TEMPLATES_DIR}/`,
    present: library.present,
    error: library.error,
    templates: library.entries.map((e) => {
      const format = e.template ? formatOf(e.template) : null;
      return {
        id: e.id,
        file: e.file,
        pages: e.template?.pages ?? null,
        start: e.template?.start ?? null,
        error: e.error,
        subjects: uses.get(e.id) ?? [],
        version: e.template ? versionOf(e.template) : null,
        format: format ? formatLabel(format) : null,
        // Une mise en page d'un autre format est listée, sans être en erreur ni proposée pour ce livre (ED1).
        otherFormat: e.template ? !sameFormat(e.template, book.edition.trim) : false,
      };
    }),
    themes: Object.keys(collection.style.palette.themes),
    theme: collection.style.variants.rotation[0],
  };
}

let controlling = false;

export const GABARIT_ACTIONS: Record<string, (body: unknown, dataRoot: string) => Json | Promise<Json>> = {
  '/api/gabarits/state': (body, dataRoot) => state(dataRoot, parse(bookOnly, body).bookId),
  '/api/gabarits/ajouter': (_body, dataRoot) => ({ result: addDeliveredTemplates(dataRoot) }),
  '/api/gabarits/apercu': (body, dataRoot) => {
    const { bookId, id, theme } = parse(templateBody, body);
    requireBook(dataRoot, bookId);
    return { layout: templatePreview(dataRoot, bookId, id, theme).layout };
  },
  '/api/gabarits/controle': async (body, dataRoot) => {
    const { bookId, id, theme } = parse(templateBody, body);
    requireBook(dataRoot, bookId);
    if (controlling) throw new RenderRefused('Un contrôle de gabarit est déjà en cours.');
    controlling = true;
    try {
      return { checks: await controlTemplate(templatePreview(dataRoot, bookId, id, theme)) };
    } finally {
      controlling = false;
    }
  },
};

export async function gabaritPreviewHtml(bookId: string | null, id: string | null, theme: string | null, dataRoot: string): Promise<string> {
  const body = parse(templateBody, { bookId, id, ...(theme ? { theme } : {}) });
  requireBook(dataRoot, body.bookId);
  return (await flowedPreview(templatePreview(dataRoot, body.bookId, body.id, body.theme))).html;
}
