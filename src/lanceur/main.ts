// src/lanceur/main.ts — lanceur unique (LC1). Lancé sans fenêtre par `lanceur/lanceur.vbs` :
//   node --import tsx src\lanceur\main.ts lancer  [--config <fichier>]   icône « Livres – Lancer »
//   node --import tsx src\lanceur\main.ts arreter                         icône « Livres – Tout arrêter »
// `--config` sert à la vérification (copie de config.local.json au chemin faux).
//
// lancer : lit la configuration, sonde les ports, lance les outils qui ne répondent pas, chacun dans la console cachée du lanceur, sortie
// dans `.lanceur/journaux/<outil>.log`. Le processus reste en vie tant qu'un outil qu'il a lancé tourne (superviseur) : sous Windows, Node
// arrête ses enfants directs quand il se termine, et un enfant « détaché » ouvrirait ses propres fenêtres de commande. Un outil qui ne
// répond pas dans son délai, ou une configuration à corriger : fenêtre de message qui nomme l'outil et le journal. Tout va bien : rien.
// Pages du Studio et de Print ouvertes par le lanceur, à chaque double-clic (`pages.ts`) : onglets existants d'abord, navigateur fermé
// ouvert directement sur les pages qui manquent (LC2), nouvelles pages seulement s'il en manque. Studio fermé par son bouton « Tout
// arrêter et quitter », vu dans son journal (LC2) : arrêt de tout (`toutArreterApres`), aussitôt.
// Un seul lancement à la fois (LC2) : verrou `.lanceur/lancement.json`, tenu de la sonde jusqu'à ce que tout soit prêt ; un second
// double-clic attend, puis ne fait que retrouver ou ouvrir les pages. Un « Tout arrêter » en cours est attendu avant de lancer.
//
// arreter : arrête ce que les superviseurs notés dans `.lanceur/etat.json` ont lancé, et seulement eux : le Studio par son action
// « quitter » (comme son bouton), puis l'arbre de chaque superviseur (`taskkill /T /F`). Un échec : fenêtre de message.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aArreter, ARRET_MAX_MS, arbre, arretEnCours, LANCEMENT_MAX_MS, lireEtat, lireMarque, modifierEtat, portsAVerifier, prendreLancement, rendreLancement, type MarqueArret, type Superviseur } from './etat';
import { aLancer, LABELS, montrer, planLancement, quitteParBouton, toutArreterApres, type Lancement, type Outil } from './outils';
import { ouvrirPages, type OutilPage } from './pages';
import { afficherMessage, attendre, lancerArret, listerProcessus, quitterStudio, repond, tuerArbre, vivant } from './systeme';

const TOOL_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const LANCEUR_DIR = path.join(TOOL_ROOT, '.lanceur');
const JOURNAUX = path.join(LANCEUR_DIR, 'journaux');
const ETAT = path.join(LANCEUR_DIR, 'etat.json');
const ARRET = path.join(LANCEUR_DIR, 'arret.json');
const LANCEMENT = path.join(LANCEUR_DIR, 'lancement.json');
const VBS = path.join(TOOL_ROOT, 'lanceur', 'lanceur.vbs');
const JOURNAL = path.join(JOURNAUX, 'lanceur.log');
const JOURNAL_MAX = 1024 * 1024;
const journalDe = (outil: Outil) => path.join(JOURNAUX, `${outil}.log`);

const horodatage = () => new Date().toLocaleString('fr-FR');
function note(msg: string): void {
  try {
    fs.appendFileSync(JOURNAL, `${horodatage()} [${process.pid}] ${msg}\n`);
  } catch {
    // journal impossible : la fenêtre de message reste
  }
}

function preparer(): void {
  fs.mkdirSync(JOURNAUX, { recursive: true });
  const taille = fs.statSync(JOURNAL, { throwIfNoEntry: false })?.size ?? 0;
  if (taille > JOURNAL_MAX) fs.renameSync(JOURNAL, path.join(JOURNAUX, 'lanceur.precedent.log'));
}

function message(lignes: string[]): void {
  note(`fenêtre de message : ${lignes.join(' / ')}`);
  afficherMessage(VBS, lignes);
}

/** Lance un outil dans la console du lanceur (cachée), sortie dans son journal, remplacé à chaque lancement. */
function demarrer(l: Lancement): ChildProcess {
  const fd = fs.openSync(journalDe(l.outil), 'w');
  fs.writeSync(fd, `=== ${LABELS[l.outil]} — ${horodatage()} — lancé par le lanceur (PID ${process.pid}) ===\n${montrer(l)}\n(dossier : ${l.cwd})\n\n`);
  try {
    return spawn(l.file, l.args, { cwd: l.cwd, env: { ...process.env, ...l.env }, stdio: ['ignore', fd, fd], windowsHide: true });
  } finally {
    fs.closeSync(fd);
  }
}

async function lancer(configPath: string): Promise<void> {
  note(`lancer (configuration : ${configPath})`);
  const debut = Math.round(Date.now() - process.uptime() * 1000);
  const moi: MarqueArret = { pid: process.pid, debut };
  // Un seul lancement à la fois (LC2) : un second double-clic attend la fin du premier, puis sonde (tout répond : rien n'est lancé).
  if (!prendreLancement(LANCEMENT, moi, Date.now(), vivant)) {
    note(`lancement déjà en cours (${JSON.stringify(lireMarque(LANCEMENT))}) : attente de sa fin, rien n'est relancé`);
    if (!(await attendre(async () => prendreLancement(LANCEMENT, moi, Date.now(), vivant), LANCEMENT_MAX_MS + 10_000, 1_000))) {
      return message(['Lancement : un autre lancement ne se termine pas.', `Fichier : ${LANCEMENT}`, `Journal : ${JOURNAL}`]);
    }
    note('lancement précédent terminé : suite');
  }
  let suite: (() => Promise<void>) | null = null;
  try {
    suite = await demarrerTout(configPath, debut);
  } finally {
    rendreLancement(LANCEMENT, moi);
  }
  await suite?.();
}

/** Le lancement proprement dit, verrou tenu ; rend la supervision (attente de la fin des outils lancés), faite verrou rendu. */
async function demarrerTout(configPath: string, debut: number): Promise<(() => Promise<void>) | null> {
  // « Tout arrêter » en cours (LC2) : attendu, sinon il arrêterait ce qui va être lancé.
  if (arretEnCours(lireMarque(ARRET), Date.now(), vivant)) {
    note('« Tout arrêter » en cours : attente de sa fin avant de lancer');
    await attendre(async () => !arretEnCours(lireMarque(ARRET), Date.now(), vivant), ARRET_MAX_MS, 500);
  }
  const plan = planLancement(configPath, TOOL_ROOT, process.execPath);
  for (const r of plan.refus) note(`refus : ${LABELS[r.outil]} : ${r.message}`);
  if (plan.refus.length) message(['Lancement : configuration à corriger.', ...plan.refus.map((r) => `${LABELS[r.outil]} : ${r.message}`), `Journal : ${JOURNAL}`]);

  const sondes = await Promise.all(plan.lancements.map(async (l) => [l.outil, await repond(l.host, l.port)] as const));
  const deja = new Set(sondes.filter(([, ok]) => ok).map(([o]) => o));
  for (const o of deja) note(`${LABELS[o]} répond déjà : pas relancé`);
  const todo = aLancer(plan.lancements, deja);
  /** Outil prêt (il répond sur son port) : tout de suite pour ceux qui tournaient déjà. */
  const pret = new Map<Outil, Promise<boolean>>([...deja].map((o) => [o, Promise.resolve(true)]));

  const enCours = todo.map((l) => {
    const child = demarrer(l);
    let fini = false;
    const fin = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        fini = true;
        resolve(code);
      });
      child.once('error', (e) => {
        fini = true;
        note(`${LABELS[l.outil]} : lancement impossible : ${e.message}`);
        resolve(-1);
      });
    });
    note(`${LABELS[l.outil]} lancé (PID ${child.pid ?? '?'}) : ${montrer(l)}`);
    const estFini = () => fini;
    const estPret = attendre(() => repond(l.host, l.port), l.delaiMs, 1_000, estFini).then(async (ok) => {
      if (ok) {
        note(`${LABELS[l.outil]} répond sur le port ${l.port}`);
        return true;
      }
      const why = estFini() ? `${LABELS[l.outil]} s'est arrêté au lancement (code ${await fin}).` : `${LABELS[l.outil]} ne répond pas sur le port ${l.port} après ${Math.round(l.delaiMs / 1000)} s.`;
      message([why, `Journal : ${journalDe(l.outil)}`]);
      return false;
    });
    pret.set(l.outil, estPret);
    // Fin d'un outil vue aussitôt (LC2), même si les autres ne sont pas encore prêts : le 10/11, elle ne l'était qu'une fois ComfyUI prêt.
    const reaction = fin.then((code) => finOutil(l.outil, code, estPret));
    return { l, child, reaction };
  });
  if (enCours.length) {
    const moi: Superviseur = {
      pid: process.pid,
      debut,
      outils: enCours.filter((e) => e.child.pid).map((e) => ({ outil: e.l.outil, pid: e.child.pid!, host: e.l.host, port: e.l.port })),
    };
    modifierEtat(ETAT, (s) => [...s.filter((x) => x.pid !== process.pid), moi]);
  } else note('rien à lancer');

  // Pages du Studio et de Print, une fois qu'ils répondent (sans attendre ComfyUI) : à chaque double-clic, même sans rien lancer.
  const avecPage: OutilPage[] = [];
  for (const o of ['studio', 'print'] as const) if (pret.has(o) && (await pret.get(o))) avecPage.push(o);
  if (avecPage.length) await ouvrirPages(avecPage, note);
  await Promise.all(pret.values());
  if (!enCours.length) return null;
  return async () => {
    await Promise.all(enCours.map((e) => e.reaction));
    modifierEtat(ETAT, (s) => s.filter((x) => x.pid !== process.pid));
    note('superviseur terminé : plus aucun outil lancé');
  };
}

/** Fin d'un outil lancé : le Studio fermé par son bouton « Tout arrêter et quitter » (vu dans son journal) arrête tout, aussitôt. */
async function finOutil(outil: Outil, code: number | null, estPret: Promise<boolean>): Promise<void> {
  note(`${LABELS[outil]} terminé (code ${code})`);
  if (outil !== 'studio') return;
  let journal = '';
  try {
    journal = fs.readFileSync(journalDe('studio'), 'utf8');
  } catch {
    // journal illisible : pas le bouton
  }
  const parBouton = quitteParBouton(journal, process.pid);
  if (!toutArreterApres(outil, code, await estPret, parBouton)) {
    if (code === 0 && !parBouton) note('Studio fermé sans son bouton « Tout arrêter et quitter » (journal) : rien de plus');
    return;
  }
  if (arretEnCours(lireMarque(ARRET), Date.now(), vivant)) return note('Studio fermé pendant « Tout arrêter » : rien de plus');
  note('Studio fermé par « Tout arrêter et quitter » : arrêt de tout ce que le lanceur a démarré');
  // Marque posée aussitôt (le processus d'arrêt la remplace en démarrant) : un double-clic dans l'intervalle attend l'arrêt.
  fs.writeFileSync(ARRET, JSON.stringify({ pid: process.pid, debut: Date.now() }));
  if (!lancerArret(VBS)) fs.rmSync(ARRET, { force: true });
}

async function arreter(): Promise<void> {
  // Arrêt en cours, noté pendant tout le travail : le Studio qui se ferme sur « quitter » ne relance pas un second arrêt.
  fs.writeFileSync(ARRET, JSON.stringify({ pid: process.pid, debut: Date.now() }));
  try {
    await arreterTout();
  } finally {
    fs.rmSync(ARRET, { force: true });
  }
}

async function arreterTout(): Promise<void> {
  note('tout arrêter');
  const superviseurs = lireEtat(ETAT);
  if (!superviseurs.length) return note('rien à arrêter');
  let procs;
  try {
    procs = listerProcessus();
  } catch (e) {
    return message(['Tout arrêter : impossible de lister les processus.', (e as Error).message, `Journal : ${JOURNAL}`]);
  }
  const { arreter: cibles, perimes } = aArreter(superviseurs, procs);
  for (const s of perimes) note(`superviseur ${s.pid} déjà arrêté ou PID repris : ignoré`);
  const problemes: string[] = [];

  for (const s of cibles) {
    const studio = s.outils.find((o) => o.outil === 'studio');
    if (studio && vivant(studio.pid) && (await repond(studio.host, studio.port))) {
      const ok = await quitterStudio(studio.host, studio.port);
      note(`Studio : « quitter » ${ok ? 'accepté' : 'refusé ou sans réponse'}`);
      if (ok) await attendre(async () => !vivant(studio.pid), 20_000, 500);
    }
  }
  // Tous les arbres d'abord, puis les ports : un outil arrêté à la main et relancé par un autre superviseur a gardé son port.
  const pids: number[] = [];
  for (const s of cibles) {
    const tree = arbre(s.pid, procs);
    pids.push(...tree);
    note(`arrêt du superviseur ${s.pid} et de son arbre (${tree.length} processus) : ${s.outils.map((o) => o.outil).join(', ')}`);
    tuerArbre(s.pid);
  }
  for (const o of portsAVerifier(cibles, procs)) {
    const libre = await attendre(async () => !(await repond(o.host, o.port)), 15_000, 500);
    if (!libre) problemes.push(`${LABELS[o.outil]} répond encore sur le port ${o.port}.`);
  }
  const restes = pids.filter(vivant);
  if (restes.length) problemes.push(`Processus encore en marche après l'arrêt : PID ${restes.join(', ')}.`);
  const retires = new Set([...cibles, ...perimes].map((s) => s.pid));
  modifierEtat(ETAT, (s) => s.filter((x) => !retires.has(x.pid)));
  if (problemes.length) message(['Tout arrêter : problème.', ...problemes, `Journal : ${JOURNAL}`]);
  else note('tout est arrêté');
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  let configPath = path.join(TOOL_ROOT, 'config.local.json');
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--config' && rest[i + 1]) configPath = path.resolve(rest[++i]);
    else throw new Error(`option inconnue « ${rest[i]} » (option : --config <fichier>)`);
  }
  if (process.platform !== 'win32') throw new Error('le lanceur est prévu sous Windows');
  preparer();
  if (mode === 'lancer') return lancer(configPath);
  if (mode === 'arreter') return arreter();
  throw new Error(`mode inconnu « ${mode ?? ''} » (lancer ou arreter)`);
}

main().catch((e: Error) => {
  note(`erreur : ${e.stack ?? e.message}`);
  message(['Lanceur : erreur inattendue.', e.message, `Journal : ${JOURNAL}`]);
  console.error(`lanceur : ${e.message}`);
  process.exitCode = 1;
});
