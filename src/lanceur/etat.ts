// src/lanceur/etat.ts — ce que le lanceur a démarré (LC1, question 2) : `.lanceur/etat.json`, ignoré par git. Un superviseur par
// double-clic qui a lancé au moins un outil : son PID, son heure de départ et les outils qu'il a lancés, avec leur PID. « Tout arrêter »
// n'arrête que ces superviseurs (et leurs arbres), après avoir vérifié que le PID est toujours le leur : même heure de départ, même ligne
// de commande. Fonctions pures, sauf la lecture et l'écriture du fichier.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OUTILS, type Outil } from './outils';

const superviseurSchema = z.object({
  pid: z.number().int().positive(),
  debut: z.number().int().nonnegative(),
  outils: z.array(z.object({ outil: z.enum(OUTILS as [Outil, ...Outil[]]), pid: z.number().int().positive(), host: z.string().min(1), port: z.number().int().min(1).max(65535) })),
});
const etatSchema = z.object({ superviseurs: z.array(superviseurSchema) });
export type Superviseur = z.infer<typeof superviseurSchema>;

/** Processus du système : PID, parent, heure de départ (ms depuis 1970), ligne de commande. */
export type Proc = { pid: number; ppid: number; debut: number; commande: string };

/** Écart toléré entre l'heure de départ notée et celle du système (arrondis, horloge). */
export const ECART_DEBUT_MS = 5_000;

/** Fichier illisible ou invalide : aucun superviseur connu (rien n'est arrêté au hasard). */
export function parseEtat(text: string | null): Superviseur[] {
  if (text === null) return [];
  try {
    const r = etatSchema.safeParse(JSON.parse(text));
    return r.success ? r.data.superviseurs : [];
  } catch {
    return [];
  }
}

/** Ligne de commande d'un superviseur : `node --import tsx src\lanceur\main.ts lancer`. */
export function estUnSuperviseur(commande: string): boolean {
  const c = commande.replace(/\\/g, '/').toLowerCase();
  return c.includes('src/lanceur/main.ts') && /(^|\s|")lancer(\s|"|$)/.test(c);
}

/**
 * Superviseurs à arrêter : vivants, même heure de départ, ligne de commande du lanceur. Les autres sont périmés (arrêtés, ou PID repris
 * par un autre programme) : retirés du fichier, jamais arrêtés.
 */
export function aArreter(superviseurs: Superviseur[], procs: Proc[]): { arreter: Superviseur[]; perimes: Superviseur[] } {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const arreter: Superviseur[] = [];
  const perimes: Superviseur[] = [];
  for (const s of superviseurs) {
    const p = byPid.get(s.pid);
    if (p && Math.abs(p.debut - s.debut) <= ECART_DEBUT_MS && estUnSuperviseur(p.commande)) arreter.push(s);
    else perimes.push(s);
  }
  return { arreter, perimes };
}

/**
 * Ports à voir libérés après l'arrêt : ceux des outils encore vivants au moment de l'arrêt, une fois chacun. Un outil arrêté à la main puis
 * relancé par un autre superviseur n'est compté qu'avec ce dernier : son port, repris, n'est pas un échec du premier.
 */
export function portsAVerifier(cibles: Superviseur[], procs: Proc[]): Superviseur['outils'] {
  const vivants = new Set(procs.map((p) => p.pid));
  const vus = new Map<string, Superviseur['outils'][number]>();
  for (const s of cibles) for (const o of s.outils) if (vivants.has(o.pid)) vus.set(`${o.host}:${o.port}`, o);
  return [...vus.values()];
}

/** Processus d'un arbre (la racine comprise), d'après les parents : ce que `taskkill /T` arrête. */
export function arbre(racine: number, procs: Proc[]): number[] {
  const enfants = new Map<number, number[]>();
  for (const p of procs) if (p.pid !== p.ppid) enfants.set(p.ppid, [...(enfants.get(p.ppid) ?? []), p.pid]);
  const vus = new Set<number>();
  const pile = [racine];
  while (pile.length) {
    const pid = pile.pop()!;
    if (vus.has(pid)) continue;
    vus.add(pid);
    pile.push(...(enfants.get(pid) ?? []));
  }
  return [...vus];
}

export function lireEtat(file: string): Superviseur[] {
  try {
    return parseEtat(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Écriture par fichier temporaire et renommage. */
export function ecrireEtat(file: string, superviseurs: Superviseur[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ superviseurs }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Lecture, changement pur, écriture. */
export function modifierEtat(file: string, change: (s: Superviseur[]) => Superviseur[]): void {
  ecrireEtat(file, change(lireEtat(file)));
}

/** Arrêt en cours (`.lanceur/arret.json`) : noté par « Tout arrêter » pendant qu'il travaille, pour qu'un superviseur ne le relance pas. */
export type MarqueArret = { pid: number; debut: number };
export const ARRET_MAX_MS = 120_000;
/** Marque vivante : processus d'arrêt en marche, depuis moins de 2 min. */
export function arretEnCours(marque: MarqueArret | null, maintenant: number, vivant: (pid: number) => boolean): boolean {
  return !!marque && maintenant - marque.debut < ARRET_MAX_MS && vivant(marque.pid);
}
/**
 * Lancement en cours (LC2) : `.lanceur/lancement.json`, même forme que la marque d'arrêt, tenu par un seul `lancer` à la fois, de la
 * sonde des ports jusqu'à ce que tous ses outils soient prêts et les pages ouvertes. Un second double-clic attend qu'il soit rendu,
 * puis sonde : tout répond, il ne lance rien et ne fait que retrouver ou ouvrir les pages. Marque d'un processus mort ou plus vieille
 * que `LANCEMENT_MAX_MS` (délai de ComfyUI, pages, marge) : reprise.
 */
export const LANCEMENT_MAX_MS = 300_000;
export function lancementEnCours(marque: MarqueArret | null, maintenant: number, vivant: (pid: number) => boolean): boolean {
  return !!marque && maintenant - marque.debut < LANCEMENT_MAX_MS && vivant(marque.pid);
}
/**
 * Prise du verrou de lancement : création exclusive du fichier. Occupé par un lancement en cours : `false`. Marque périmée, ou illisible
 * depuis plus de 5 s : retirée, puis une seule nouvelle tentative (deux reprises simultanées : une seule gagne).
 */
export function prendreLancement(file: string, moi: MarqueArret, maintenant: number, vivant: (pid: number) => boolean): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let essai = 0; essai < 2; essai++) {
    try {
      fs.writeFileSync(file, JSON.stringify(moi), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (essai > 0) return false;
    const marque = lireMarque(file);
    // Illisible : peut-être en cours d'écriture par un autre lancement ; périmée seulement au bout de 5 s.
    const age = maintenant - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (marque ? lancementEnCours(marque, maintenant, vivant) : age < ECART_DEBUT_MS) return false;
    fs.rmSync(file, { force: true });
  }
  return false;
}
/** Verrou rendu : seulement s'il est encore le sien (même PID, même heure de départ). */
export function rendreLancement(file: string, moi: MarqueArret): void {
  const m = lireMarque(file);
  if (m && m.pid === moi.pid && m.debut === moi.debut) fs.rmSync(file, { force: true });
}
export function lireMarque(file: string): MarqueArret | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MarqueArret>;
    return typeof v.pid === 'number' && typeof v.debut === 'number' ? { pid: v.pid, debut: v.debut } : null;
  } catch {
    return null;
  }
}

