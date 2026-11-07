// src/comfy/launcher.ts — lancement de ComfyUI à la demande de David (IC1, correctif du lanceur). Le lanceur est le `.bat` de David, nommé dans
// `config.local.json` (`comfyLauncher`), jamais dans le repo. L'outil l'ouvre dans sa propre fenêtre, comme un double-clic, et ne fait rien
// d'autre : il ne ferme jamais ComfyUI, ne le modifie pas et ne le lance jamais de lui-même.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Launcher = { state: 'absent' } | { state: 'ok'; file: string } | { state: 'refuse'; message: string };

/** Caractères que `cmd.exe` interprète même entre guillemets : refusés plutôt qu'échappés. */
const UNSAFE = /["%^&|<>!]/;

export function checkLauncher(value: string | undefined): Launcher {
  if (value === undefined) return { state: 'absent' };
  const refuse = (why: string): Launcher => ({ state: 'refuse', message: `comfyLauncher refusé (${value}) : ${why}. Corriger config.local.json, par exemple "comfyLauncher": "D:/IA/ComfyUI/run_il0.bat".` });
  if (!path.isAbsolute(value) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value))) return refuse('chemin absolu attendu');
  if (!/\.(bat|cmd)$/i.test(value)) return refuse('un fichier .bat ou .cmd est attendu');
  if (UNSAFE.test(value)) return refuse('caractère interdit dans le chemin');
  const stat = fs.statSync(value, { throwIfNoEntry: false });
  if (!stat) return refuse('fichier introuvable');
  if (!stat.isFile()) return refuse('ce n\'est pas un fichier');
  return { state: 'ok', file: path.resolve(value) };
}

/**
 * Ligne de commande de `cmd.exe` : `start` ouvre le lanceur dans une nouvelle fenêtre, avec son dossier comme dossier courant. Toute la commande
 * est entre guillemets, comme le fait Node pour `shell: true` : `/s` retire ces deux guillemets extérieurs et garde ceux de l'intérieur.
 */
export function launchCommand(file: string): string[] {
  return ['/d', '/s', '/c', `"start "ComfyUI" /D "${path.dirname(file)}" "${file}""`];
}

/** Lance et rend la main aussitôt : le processus n'est pas suivi par l'outil, qui interroge ensuite `/system_stats`. */
export function launch(file: string): void {
  if (process.platform !== 'win32') throw new Error('Le lancement de ComfyUI est prévu sous Windows.');
  const child = spawn('cmd.exe', launchCommand(file), { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: false });
  child.unref();
}
