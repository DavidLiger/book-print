// src/server/layout-actions.ts — étape « Mise en page » d'un sujet (ED1, spec §24.8, parcours seulement). Sans éditeur : la mise en page se
// modifie dans `subjects/<sujetId>/layout.json`, à la main, comme les gabarits en GB1. L'étape montre la copie (ou le gabarit d'un sujet créé
// avant ED1), ses éléments, ses fautes (format, C16, C17) et son aperçu au texte de remplissage maximal ; « Contrôler » rend le PDF en mémoire,
// sans rien écrire. `dir` est le dossier du livre dans GLBInterpreter, comme pour les autres routes d'un sujet.
import { z } from 'zod';
import { c17Overlaps } from '../checks/overlaps';
import { readCollection } from '../data/collection';
import { readPrintBook } from '../data/pricing-file';
import { firstPageOf, readSubject, readSubjectLayout, SubjectRefused } from '../data/subject-file';
import { fromV1 } from '../layout/from-v1';
import { LAYOUT_FILE, layoutOf } from '../layout/files';
import { elementsOf, isLayout, placeMiseEnPage, type MiseEnPage } from '../layout/model';
import { subjectLayoutFacts } from '../parcours/facts';
import { controlTemplate, templateContent, type TemplatePreview } from '../render/gabarit';
import { applyBookFiche, renderHtml, RenderRefused } from '../render/html';
import { slugSchema } from '../schema/common';
import { readTemplates, templateOf } from '../templates/files';
import type { Config } from './config';
import { BadSubjectRequest, reading } from './subject-actions';

type Json = Record<string, unknown>;

const subjectBody = z.strictObject({ dir: z.string(), subjectId: slugSchema });

function parse(value: unknown): z.infer<typeof subjectBody> {
  const body = subjectBody.safeParse(value);
  if (!body.success) throw new BadSubjectRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

interface View {
  model: MiseEnPage;
  source: 'layout.json' | 'gabarit';
  file: string;
  modele: { id: string; empreinte: string; date: string } | null;
  errors: string[];
  preview: TemplatePreview | null;
  firstPage: number;
}

/** La mise en page du sujet et son aperçu au texte de remplissage. Pas d'aperçu tant qu'elle ne se pose pas (format, côté). */
function view(config: Config, dir: string, subjectId: string): View {
  const { bookId } = reading(config, dir);
  const { book, error } = readPrintBook(config.dataRoot, bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  const read = readCollection(config.dataRoot);
  if (!read) throw new SubjectRefused('collection/ absent : le créer d\'abord dans la page.');
  const style = applyBookFiche(read.style, book);
  const subject = readSubject(config.dataRoot, bookId, subjectId);
  const facts = subjectLayoutFacts(config.dataRoot, book, subject);
  if (facts.templateError) throw new RenderRefused(facts.templateError);
  const copy = readSubjectLayout(config.dataRoot, bookId, subjectId);
  let model: MiseEnPage;
  if (copy) model = layoutOf(copy);
  else {
    const found = templateOf(readTemplates(config.dataRoot, style), subject.template);
    if ('error' in found) throw new RenderRefused(found.error);
    model = found.template;
  }
  const firstPage = firstPageOf(config.dataRoot, book, subjectId);
  const trim = book.edition.trim;
  const placeable = !facts.miseEnPage.errors.some((e) => !e.startsWith('C17'));
  let preview: TemplatePreview | null = null;
  if (placeable) {
    const layout = placeMiseEnPage(model, trim, style.margins, firstPage);
    preview = { html: renderHtml(layout, trim, style, templateContent(model, style.fiche, subject.variant.theme, trim), read.pictos), layout, trim, template: model };
  }
  return {
    model,
    source: copy ? 'layout.json' : 'gabarit',
    file: copy ? `${bookId}/subjects/${subjectId}/${LAYOUT_FILE}` : `collection/gabarits/${subject.template}.json`,
    modele: copy?.modele ?? null,
    errors: facts.miseEnPage.errors,
    preview,
    firstPage,
  };
}

/** Coordonnées des éléments, en mm sur la page rognée : celles du fichier, ou celles de la conversion pour un gabarit d'avant ED1 (rien n'est écrit). */
function rows(v: View, config: Config, dir: string): Json[] {
  const { bookId } = reading(config, dir);
  const book = readPrintBook(config.dataRoot, bookId).book!;
  const margins = readCollection(config.dataRoot)!.style.margins;
  let layout = isLayout(v.model) ? v.model : null;
  if (!layout && v.preview) layout = fromV1(v.model as Parameters<typeof fromV1>[0], book.edition.trim, margins, v.firstPage);
  if (!layout) return elementsOf(v.model).map((e) => ({ id: e.id, type: e.type, page: e.page }));
  return layout.elements.map((e) => ({ id: e.id, type: e.type, page: e.page, x: e.x, y: e.y, w: e.w, h: e.h, double: e.double ?? false }));
}

function state(config: Config, dir: string, subjectId: string): Json {
  const v = view(config, dir, subjectId);
  return {
    source: v.source,
    file: v.file,
    modele: v.modele,
    version: isLayout(v.model) ? 2 : 1,
    id: v.model.id,
    pages: v.model.pages,
    start: v.model.start,
    firstPage: v.firstPage,
    errors: v.errors,
    elements: rows(v, config, dir),
    layout: v.preview?.layout ?? null,
  };
}

let controlling = false;

export const LAYOUT_ACTIONS: Record<string, (body: unknown, config: Config) => Json | Promise<Json>> = {
  '/api/mise-en-page/state': (body, config) => {
    const { dir, subjectId } = parse(body);
    return state(config, dir, subjectId);
  },
  '/api/mise-en-page/controle': async (body, config) => {
    const { dir, subjectId } = parse(body);
    const v = view(config, dir, subjectId);
    if (!v.preview) throw new RenderRefused(v.errors.join(' '));
    if (controlling) throw new RenderRefused('Un contrôle de mise en page est déjà en cours.');
    controlling = true;
    try {
      const checks = await controlTemplate(v.preview);
      return { checks: checks.some((c) => c.id === 'C17') ? checks : [...checks, c17Overlaps(v.preview.layout)] };
    } finally {
      controlling = false;
    }
  },
};

export function layoutPreviewHtml(dir: string | null, subjectId: string | null, config: Config): string {
  const body = parse({ dir, subjectId });
  const v = view(config, body.dir, body.subjectId);
  if (!v.preview) throw new RenderRefused(v.errors.join(' '));
  return v.preview.html;
}
