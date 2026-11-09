// src/lanceur/systeme.ts — ce que le lanceur demande au système (LC1) : sonder un port, lister les processus, arrêter un arbre, montrer une
// fenêtre de message, demander au Studio de s'arrêter. Windows seulement pour les processus et les fenêtres ; aucune sortie réseau hors de
// la boucle locale.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { Proc } from './etat';

/**
 * Chemin sondé : une adresse qu'aucun outil ne sert (réponse 404), jamais `/`. Le Studio compte un `GET /` comme un onglet ouvert
 * (`tabSeenAt`) et n'ouvrirait plus sa page.
 */
export const SONDE = '/__lanceur/sonde';

/** Un outil « répond » s'il renvoie une réponse HTTP quelconque sur son port (404 ou 403 compris : le serveur tourne). */
export function repond(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: SONDE, timeout: timeoutMs, headers: { host: `${host.includes(':') ? `[${host}]` : host}:${port}` } }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** Attend que `test` soit vrai, en le reposant toutes les `pasMs`, `delaiMs` au plus. `stop` : abandon (processus terminé). */
export async function attendre(test: () => Promise<boolean>, delaiMs: number, pasMs = 1_000, stop: () => boolean = () => false): Promise<boolean> {
  const fin = Date.now() + delaiMs;
  for (;;) {
    if (await test()) return true;
    if (stop() || Date.now() >= fin) return false;
    await new Promise((r) => setTimeout(r, pasMs));
  }
}

/**
 * Processus du système, par `Get-CimInstance Win32_Process` (comme le Studio), en `-Command` : la stratégie d'exécution de PowerShell ne
 * s'applique qu'aux fichiers de script. Heure de départ en millisecondes depuis 1970 (UTC).
 */
export function listerProcessus(): Proc[] {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$e = [datetime]'1970-01-01'",
    'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId;',
    '  debut = if ($_.CreationDate) { [int64]($_.CreationDate.ToUniversalTime() - $e).TotalMilliseconds } else { 0 }; commande = [string]$_.CommandLine } } |',
    '  ConvertTo-Json -Compress',
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`liste des processus illisible (PowerShell, code ${r.status}) : ${(r.stderr ?? '').trim().slice(0, 300)}`);
  const v = JSON.parse(r.stdout) as Proc | Proc[];
  return Array.isArray(v) ? v : [v];
}

/** Arrêt d'un arbre par son PID seulement (`taskkill /T /F`), comme le Studio : jamais par nom ni par titre de fenêtre. */
export function tuerArbre(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

export function vivant(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Texte d'une fenêtre de message, passé en argument à `lanceur.vbs message` : sans guillemet (VBScript ne les lit pas dans un argument),
 * lignes séparées par `|`, que le script remplace par des retours à la ligne.
 */
export function texteMessage(lignes: string[]): string {
  return lignes
    .map((l) => l.replace(/"/g, '\'').replace(/[|\r\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('|')
    .slice(0, 4_000);
}

/** Fenêtre de message Windows (`lanceur.vbs message`), sans attendre qu'elle soit fermée. */
export function afficherMessage(vbs: string, lignes: string[]): void {
  if (process.platform !== 'win32') return;
  try {
    const p = spawn('wscript.exe', ['//Nologo', vbs, 'message', texteMessage(lignes)], { detached: true, stdio: 'ignore', windowsHide: false });
    p.on('error', () => undefined);
    p.unref();
  } catch {
    // le journal garde le message
  }
}

/**
 * « Tout arrêter », lancé depuis Print (bouton « Tout arrêter et quitter ») : `wscript.exe lanceur.vbs arreter`, détaché. wscript se
 * termine aussitôt : le Node d'arrêt n'a plus de parent vivant, il n'est donc pas dans l'arbre qu'il arrête. Faux hors de Windows.
 */
export function lancerArret(vbs: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const p = spawn('wscript.exe', ['//Nologo', vbs, 'arreter'], { detached: true, stdio: 'ignore', windowsHide: false });
    p.on('error', () => undefined);
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/** Demande au Studio de s'arrêter comme son bouton « Tout arrêter et quitter » (`POST /__studio/action`, action `quitter`). */
export function quitterStudio(host: string, port: number): Promise<boolean> {
  const origin = `http://${host}:${port}`;
  const body = JSON.stringify({ action: 'quitter' });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: '/__studio/action',
        method: 'POST',
        timeout: 5_000,
        headers: { host: `${host}:${port}`, origin, 'content-type': 'application/json', 'x-glbi-studio': '1', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}
