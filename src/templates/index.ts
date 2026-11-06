// src/templates/index.ts — liste des gabarits livrés. Chacun est validé au chargement : un gabarit invalide ne démarre pas.
import { TEMPLATE_2A } from './2A';
import { templateSchema, type Template } from './model';

export const TEMPLATES: Record<string, Template> = Object.fromEntries([TEMPLATE_2A].map((t) => [t.id, templateSchema.parse(t)]));
