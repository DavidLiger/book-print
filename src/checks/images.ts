// src/checks/images.ts — C5 et C11 (spec §7), fonctions pures sur des faits. Ils ne demandent pas Chromium : le parcours les calcule à chaque lecture.
import { containPpi, effectivePpi, MAX_PPI, TARGET_PPI, visibleCrop, type Framing, type Size, type ZoneSizeMm } from '../images/crop';
import type { RightsEntry } from '../schema/rights';
import type { CheckResult, Level } from './rules';

export interface PlacedImage {
  zone: string;
  /** Dimensions du fichier source : Chromium n'embarque que la partie visible (§16.6), celles du PDF ne disent rien. */
  image: Size;
  size: ZoneSizeMm;
  framing: Framing;
  /** Détouré (ED2) : l'image entière, centrée dans sa boîte, sans cadrage ; la résolution est celle de cette taille affichée. */
  contain?: boolean;
}

const fmt = (n: number) => n.toFixed(0);

export const ppiOf = (p: PlacedImage) => (p.contain ? containPpi(p.image, p.size) : effectivePpi(visibleCrop(p.image, p.size, p.framing), p.size));

export function c5Resolution(images: PlacedImage[]): CheckResult {
  const errors: string[] = [];
  const alerts: string[] = [];
  for (const p of images) {
    const ppi = ppiOf(p);
    if (ppi < TARGET_PPI) errors.push(`${p.zone} : ${fmt(Math.floor(ppi))} ppp, ${TARGET_PPI} au moins`);
    else if (ppi > MAX_PPI) alerts.push(`${p.zone} : ${fmt(Math.ceil(ppi))} ppp, fichier lourd au-delà de ${MAX_PPI}`);
  }
  const level: Level = errors.length ? 'erreur' : alerts.length ? 'alerte' : 'ok';
  return { id: 'C5', label: 'Résolution effective dans la zone, avec le cadrage', level, details: [...errors, ...alerts] };
}

export interface LinkedImage {
  zone: string;
  /** Identifiants rattachés ; `null` : aucune entrée `illustrations[]` dans `rights.json`. */
  rights: string[] | null;
}

/** `registry` : les entrées des deux registres. La présence dans les pages de crédits attend ces pages (MP6) : le libellé le dit. */
export function c11Rights(images: LinkedImage[], registry: ReadonlyMap<string, RightsEntry>): CheckResult {
  const errors: string[] = [];
  const alerts: string[] = [];
  const once = (list: string[], line: string) => {
    if (!list.includes(line)) list.push(line);
  };
  for (const { zone, rights } of images) {
    if (rights === null) {
      errors.push(`${zone} : image absente du registre`);
      continue;
    }
    const entries = rights.flatMap((id) => {
      const entry = registry.get(id);
      if (!entry) errors.push(`${zone} : droit inconnu du registre, ${id}`);
      return entry ? [entry] : [];
    });
    if (!entries.some((e) => e.kind === 'modele-ia')) errors.push(`${zone} : aucun modèle d'IA rattaché`);
    if (!entries.some((e) => e.kind === 'modele-3d')) alerts.push(`${zone} : aucun modèle 3D rattaché`);
    for (const e of entries) {
      if (!e.license) once(errors, `${e.id} : licence manquante`);
      if (!e.credit) once(errors, `${e.id} : crédit vide`);
      if (e.commercialOk === 'non') once(errors, `${e.id} : usage commercial refusé`);
      if (e.commercialOk === 'a-verifier') once(alerts, `${e.id} : usage commercial à vérifier`);
    }
  }
  const level: Level = errors.length ? 'erreur' : alerts.length ? 'alerte' : 'ok';
  return { id: 'C11', label: 'Droits des illustrations (présence dans les pages de crédits contrôlée en MP6)', level, details: [...errors, ...alerts] };
}

/** Ce qui empêche une entrée d'être imprimée : l'étape Droits le montre pour tout le registre, pas seulement pour ce qui est rattaché. */
export function entryFaults(e: RightsEntry): string[] {
  return [...(e.license ? [] : ['licence manquante']), ...(e.credit ? [] : ['crédit vide'])];
}
