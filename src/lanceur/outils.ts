// src/lanceur/outils.ts — lanceur unique (LC1) : ce que le lanceur démarre, lu dans `config.local.json`. Pur, à part la lecture du
// fichier et l'existence des chemins. Trois outils : le Studio de GLBInterpreter (`npm run studio -- --port 4000 --no-open`, qui lance
// lui-même l'Atelier), Print (`npm run print -- --no-open`) et ComfyUI (son Python, avec les options de `run_il0.bat` et
// `--disable-auto-launch`). Aucun n'ouvre sa page : le lanceur ouvre celles du Studio et de Print (`pages.ts`). Aucun shell : programme et arguments en tableau, comme le Studio (`npmRun` de GLBInterpreter).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import '../schema/common';
import { parseComfyUrl } from '../comfy/address';
import { checkLauncher } from '../comfy/launcher';
import { PORT as PRINT_PORT } from '../server/rules';

export type Outil = 'studio' | 'print' | 'comfyui';
export const OUTILS: readonly Outil[] = ['studio', 'print', 'comfyui'];
export const LABELS: Record<Outil, string> = { studio: 'Studio de GLBInterpreter', print: 'Print (book-print)', comfyui: 'ComfyUI' };

/** Port du Studio : son port par défaut, passé explicitement (`--port`). */
export const STUDIO_PORT = 4000;
export const LOOPBACK = '127.0.0.1';
/** Délai pour répondre sur son port, après le lancement (question 4) : ComfyUI charge ses nœuds. */
export const DELAIS_MS: Record<Outil, number> = { studio: 60_000, print: 60_000, comfyui: 180_000 };

/**
 * Options du Python de ComfyUI (`comfyArgs`, facultatif) : par défaut, celles de `run_il0.bat`, plus `--disable-auto-launch`, sans quoi
 * `--windows-standalone-build` ouvre la page (`comfy/cli_args.py`).
 */
export const DEFAULT_COMFY_ARGS: readonly string[] = ['-s', 'ComfyUI\\main.py', '--windows-standalone-build', '--enable-manager', '--disable-auto-launch'];
/** Python embarqué, à côté du lanceur de ComfyUI (`comfyLauncher`). */
export const COMFY_PYTHON = path.join('python_embeded', 'python.exe');

export const comfyArgsSchema = z
  .array(z.string({ error: 'comfyArgs : texte attendu pour chaque option' }).min(1, 'comfyArgs : option vide').refine((s) => !s.includes('\0'), 'comfyArgs : caractère nul'), {
    error: 'comfyArgs : liste d\'options attendue, par exemple ["-s", "ComfyUI\\\\main.py", "--disable-auto-launch"]',
  })
  .min(1, 'comfyArgs : liste vide')
  .max(40, 'comfyArgs : 40 options au plus');

export type Lancement = {
  outil: Outil;
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Adresse sondée : 127.0.0.1, ou celle de `comfyUrl` pour ComfyUI. */
  host: string;
  port: number;
  delaiMs: number;
};

export type Refus = { outil: Outil; message: string };
export type Plan = { lancements: Lancement[]; refus: Refus[] };

/** `npm-cli.js` de l'installation de Node qui exécute le lanceur (Windows : `<dossier de node.exe>/node_modules/npm/bin/npm-cli.js`). */
export function npmCliOf(nodeExe: string): string {
  const dir = path.dirname(nodeExe);
  return process.platform === 'win32' || /\.exe$/i.test(nodeExe)
    ? path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** `npm --prefix <repo> run <script> [-- <args>]`, sans shell. */
export function npmRun(nodeExe: string, root: string, script: string, args: string[] = []): { file: string; args: string[] } {
  return { file: nodeExe, args: [npmCliOf(nodeExe), '--prefix', root, 'run', script, ...(args.length ? ['--', ...args] : [])] };
}

const CONFIG = 'config.local.json';
const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * Ce que le lanceur démarre (`lancements`) et ce qu'il ne peut pas démarrer, avec le message à montrer (`refus`). Print est toujours lancé :
 * il affiche lui-même une configuration à corriger. `configPath` : `config.local.json` (ou sa copie, pour la vérification).
 */
export function planLancement(configPath: string, toolRoot: string, nodeExe: string): Plan {
  const lancements: Lancement[] = [];
  const refus: Refus[] = [];
  const name = path.basename(configPath);

  lancements.push({ outil: 'print', ...npmRun(nodeExe, toolRoot, 'print', ['--no-open']), cwd: toolRoot, host: LOOPBACK, port: PRINT_PORT, delaiMs: DELAIS_MS.print });

  let raw: Record<string, unknown> | null = null;
  let general: string | null = null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) raw = value as Record<string, unknown>;
    else general = `${name} : un objet JSON est attendu`;
  } catch (e) {
    general = (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${name} absent (${configPath}) : copier config.example.json sous le nom ${CONFIG}` : `${name} n'est pas un JSON valide : ${(e as Error).message}`;
  }
  if (!raw) {
    refus.push({ outil: 'studio', message: `${general}. Le Studio n'est pas lancé.` });
    refus.push({ outil: 'comfyui', message: `${general}. ComfyUI n'est pas lancé.` });
    return { lancements, refus };
  }

  // Studio : glbRoot, repo GLBInterpreter avec le script `studio`.
  const studio = studioRefus(raw.glbRoot, name);
  if (studio) refus.push({ outil: 'studio', message: studio });
  else {
    const glbRoot = path.resolve(raw.glbRoot as string);
    lancements.push({ outil: 'studio', ...npmRun(nodeExe, glbRoot, 'studio', ['--port', String(STUDIO_PORT), '--no-open']), cwd: glbRoot, host: LOOPBACK, port: STUDIO_PORT, delaiMs: DELAIS_MS.studio });
  }

  // ComfyUI : comfyLauncher (dossier et Python), comfyArgs, port de comfyUrl.
  const comfy = comfyLancement(raw, name);
  if ('message' in comfy) refus.push({ outil: 'comfyui', message: comfy.message });
  else lancements.push(comfy);

  lancements.sort((a, b) => OUTILS.indexOf(a.outil) - OUTILS.indexOf(b.outil));
  return { lancements, refus };
}

function studioRefus(glbRoot: unknown, name: string): string | null {
  const why = (s: string) => `glbRoot ${s} : corriger ${name}, par exemple "glbRoot": "D:/GLBInterpreter/glbinterpreter". Le Studio n'est pas lancé.`;
  if (glbRoot === undefined) return why('absent');
  if (typeof glbRoot !== 'string' || glbRoot === '') return why('vide ou qui n\'est pas un texte');
  if (!path.isAbsolute(glbRoot)) return why(`(${glbRoot}) n'est pas un chemin absolu`);
  if (!isDir(glbRoot)) return why(`(${glbRoot}) introuvable`);
  let scripts: unknown;
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(glbRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts;
  } catch {
    return why(`(${glbRoot}) sans package.json lisible : ce n'est pas le repo GLBInterpreter`);
  }
  if (!scripts || typeof scripts !== 'object' || typeof (scripts as Record<string, unknown>).studio !== 'string') return why(`(${glbRoot}) sans script « studio » : ce n'est pas le repo GLBInterpreter`);
  return null;
}

function comfyLancement(raw: Record<string, unknown>, name: string): Lancement | { message: string } {
  const fail = (s: string) => ({ message: `${s} ComfyUI n'est pas lancé.` });
  if (raw.comfyLauncher === undefined) return fail(`comfyLauncher absent de ${name} : le lanceur ne sait pas où est ComfyUI. Ajouter par exemple "comfyLauncher": "D:/IA/ComfyUI/run_il0.bat".`);
  if (typeof raw.comfyLauncher !== 'string') return fail(`comfyLauncher : texte attendu dans ${name}.`);
  const launcher = checkLauncher(raw.comfyLauncher);
  if (launcher.state === 'refuse') return fail(launcher.message.replace('config.local.json', name));
  if (launcher.state !== 'ok') return fail(`comfyLauncher absent de ${name}.`);
  const dir = path.dirname(launcher.file);
  const python = path.join(dir, COMFY_PYTHON);
  if (!isFile(python)) return fail(`Python de ComfyUI introuvable : ${python} (attendu à côté de comfyLauncher, comme dans run_il0.bat).`);
  let args = [...DEFAULT_COMFY_ARGS];
  if (raw.comfyArgs !== undefined) {
    const parsed = comfyArgsSchema.safeParse(raw.comfyArgs);
    if (!parsed.success) return fail(`${parsed.error.issues.map((i) => i.message).join(' ; ')}. Corriger ${name}.`);
    args = parsed.data;
  }
  if (raw.comfyUrl !== undefined && typeof raw.comfyUrl !== 'string') return fail(`comfyUrl : texte attendu dans ${name}.`);
  const address = parseComfyUrl(raw.comfyUrl as string | undefined);
  if (!address.ok) return fail(address.message.replace('config.local.json', name));
  const url = new URL(address.origin);
  const port = Number(url.port || 80);
  return {
    outil: 'comfyui',
    file: python,
    args,
    cwd: dir,
    // Journal dans un fichier : UTF-8 (sinon une sortie non ASCII casse Python sous Windows) et sans tampon.
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    delaiMs: DELAIS_MS.comfyui,
  };
}

/** Outils à lancer : ceux qui ne répondent pas déjà sur leur port (question 3). */
export function aLancer(lancements: Lancement[], repond: ReadonlySet<Outil>): Lancement[] {
  return lancements.filter((l) => !repond.has(l.outil));
}

/** Ligne de commande lisible, pour le journal (guillemets autour des arguments à espaces). */
export const montrer = (l: { file: string; args: string[] }): string =>
  [l.file, ...l.args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');

/**
 * Studio fermé par son bouton « Tout arrêter et quitter » (décision de David, 09/11/2026) : le Studio lancé par le lanceur, prêt, qui
 * se termine de lui-même avec le code 0, entraîne l'arrêt de tout ce que le lanceur a démarré. Un Studio tombé (autre code) ou arrêté
 * par « Tout arrêter » (arrêt déjà en cours) ne le déclenche pas.
 */
export const toutArreterApres = (outil: Outil, code: number | null, pret: boolean): boolean => outil === 'studio' && code === 0 && pret;
