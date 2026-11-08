// src/styles/library.ts — règles de la bibliothèque de styles (IC2), en lecture seule : style prêt à générer, droits de sa référence, style d'une
// zone, clé d'un aperçu, et cohérence du livre (questions 5 à 9). Le parcours s'en sert : rien n'est écrit ici.
import fs from 'node:fs';
import type { RightsEntry } from '../schema/rights';
import type { PrintBook } from '../schema/print-book';
import type { Subject } from '../schema/subject';
import { okStyle, readStyle, sha256, StyleRefused, type EssaiState, type StyleState } from './read';
import { BASE_STYLE_ID, type Style } from './schema';
import type { StyleRun } from '../comfy/run';

/** Ce qui ne va pas dans le droit de la référence : inconnu, d'un autre type, refusé. `a-verifier` est une alerte, rendue à part. */
export function referenceFaults(style: Style, registry: Map<string, RightsEntry>): string[] {
  if (style.reference.type === 'aucune') return [];
  const id = style.reference.rights;
  const e = registry.get(id);
  if (!e) return [`${style.name} : droit de la référence inconnu du registre (${id}).`];
  if (e.kind !== 'image-reference') return [`${style.name} : ${id} n'est pas une image de référence (${e.kind}).`];
  if (e.commercialOk === 'non') return [`${style.name} : la référence ${id} n'admet pas l'usage commercial.`];
  return [];
}

export const referenceToCheck = (style: Style, registry: Map<string, RightsEntry>): boolean =>
  style.reference.type !== 'aucune' && registry.get(style.reference.rights)?.commercialOk === 'a-verifier';

/** Tout ce qui empêche de générer avec ce style. Liste vide : le style est prêt. */
export function styleFaults(s: StyleState, registry: Map<string, RightsEntry>): string[] {
  if (s.state !== 'ok') return [s.message];
  return [...s.faults, ...referenceFaults(s.style, registry)];
}

/** Le style emporté par une tâche : lu maintenant, avec les octets de sa référence. */
export function styleRun(dataRoot: string, id: string, registry: Map<string, RightsEntry>): StyleRun {
  const s = readStyle(dataRoot, id);
  const faults = styleFaults(s, registry);
  if (faults.length > 0) throw new StyleRefused(`Style ${id} : ${faults.join(' ')}`);
  const ok = okStyle(s)!;
  return { id, sha256: ok.sha256, style: ok.style, reference: ok.reference ? { bytes: fs.readFileSync(ok.reference.path), kind: ok.reference.kind } : null };
}

/** Style d'une zone : son choix propre, sinon le style par défaut du livre. `null` : aucun. */
export const zoneStyleId = (book: PrintBook, subject: Subject, zone: string): string | null => subject.generationStyles?.[zone] ?? book.defaultStyle ?? null;

/**
 * Clé d'un aperçu (question 8) : tout ce qui change l'image. Modifier un style ne change que sa clé, les autres aperçus restent en cache ;
 * changer le rendu d'essai, son prompt ou le workflow les refait tous.
 */
export function previewKey(style: StyleState & { state: 'ok' }, essai: EssaiState, prompt: string, workflowSha: string, seed: number): string | null {
  const { rendu, mist } = essai.inputs;
  if (rendu.state !== 'ok' || mist.state !== 'ok') return null;
  const parts = { v: 1, style: style.sha256, reference: style.reference?.sha256 ?? null, rendu: rendu.sha256, mist: mist.sha256, prompt, workflow: workflowSha, seed };
  return sha256(JSON.stringify(parts)).slice(0, 16);
}

export interface ImageStyle {
  /** `<sujet>/<zone>`. */
  zone: string;
  styleId: string;
  /** Image d'IC1 sans style tracé : comptée dans le style de base (question 7). */
  assumed: boolean;
  /** Empreinte du style au moment de la génération, si elle est tracée. */
  sha256: string | null;
}

/** Style de chaque image produite par l'outil. Une image déposée à la main n'a pas de style : elle n'entre pas dans la règle. */
export function imageStyles(subjects: Subject[]): ImageStyle[] {
  return subjects.flatMap((s) => s.illustrations.flatMap((i) => {
    if (!i.generation) return [];
    const style = i.generation.style;
    return [{ zone: `${s.id}/${i.zone}`, styleId: style?.id ?? BASE_STYLE_ID, assumed: !style, sha256: style?.sha256 ?? null }];
  }));
}

/** Alertes de cohérence du livre : plusieurs styles mêlés, zones nommées ; style modifié depuis une image ; style disparu. */
export function coherenceAlerts(images: ImageStyle[], styles: StyleState[]): string[] {
  const alerts: string[] = [];
  const byStyle = new Map<string, string[]>();
  for (const i of images) byStyle.set(i.styleId, [...(byStyle.get(i.styleId) ?? []), i.zone]);
  const name = (id: string) => okStyle(styles.find((s) => s.id === id))?.style.name ?? id;
  if (byStyle.size > 1) {
    const parts = [...byStyle.entries()].map(([id, zones]) => `${name(id)} (${zones.join(', ')})`);
    alerts.push(`Plusieurs styles dans le livre : ${parts.join(' ; ')}.`);
  }
  for (const i of images) {
    const s = styles.find((x) => x.id === i.styleId);
    if (!s) alerts.push(`${i.zone} : générée avec le style ${i.styleId}, absent de la bibliothèque.`);
    else if (s.state === 'ok' && i.sha256 !== null && i.sha256 !== s.sha256) alerts.push(`${i.zone} : générée avec une version antérieure du style ${s.style.name}.`);
  }
  return alerts;
}
