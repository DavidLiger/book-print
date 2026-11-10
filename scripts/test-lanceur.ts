// scripts/test-lanceur.ts — lanceur unique (LC1) : construction des commandes, validation de la configuration, ports, outils à lancer,
// superviseurs et processus à arrêter, texte des fenêtres de message, sonde d'un port, demande d'arrêt au Studio. Sans framework.
// Fixtures synthétiques dans des dossiers temporaires : faux repo GLBInterpreter, faux dossier de ComfyUI.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aArreter, arbre, arretEnCours, ecrireEtat, estUnSuperviseur, LANCEMENT_MAX_MS, lancementEnCours, lireEtat, lireMarque, modifierEtat, parseEtat, portsAVerifier, prendreLancement, rendreLancement, type Proc, type Superviseur } from '../src/lanceur/etat';
import { commandeNavigateur, exeDe, pagesManquantes, URLS, valeurReg } from '../src/lanceur/pages';
import { aLancer, COMFY_PYTHON, comfyArgsSchema, DEFAULT_COMFY_ARGS, DELAIS_MS, LIGNE_BOUTON_STUDIO, npmCliOf, planLancement, quitteParBouton, STUDIO_PORT, toutArreterApres, type Outil } from '../src/lanceur/outils';
import { attendre, quitterStudio, repond, SONDE, texteMessage } from '../src/lanceur/systeme';
import { createPrintServer, EVENTS_ROUTE, QUIT_ROUTE, TABS_ROUTE } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { navigateurIntegre, pageAOuvrir, printOptions, PORT as PRINT_PORT, TAB_WAIT_MS } from '../src/server/rules';
import { put, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

const json = (v: unknown) => JSON.stringify(v);
const TOOL_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const NODE = process.execPath;
const NPM_CLI = npmCliOf(NODE);

/** Faux repo GLBInterpreter (script `studio`), faux ComfyUI (lanceur et Python embarqué), configuration. */
function decor(config: Record<string, unknown> | ((d: { glbRoot: string; comfyDir: string; bat: string }) => Record<string, unknown>), name = 'config.local.json') {
  const root = tempDir();
  const glbRoot = path.join(root, 'glbinterpreter');
  put(glbRoot, 'package.json', { name: 'glbinterpreter', scripts: { studio: 'tsx scripts/studio/server.ts' } });
  fs.mkdirSync(path.join(glbRoot, 'books'), { recursive: true });
  const comfyDir = path.join(root, 'ComfyUI');
  const bat = path.join(comfyDir, 'run_il0.bat');
  put(comfyDir, 'run_il0.bat', '.\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build --enable-manager\r\npause\r\n');
  put(comfyDir, 'python_embeded/python.exe', 'faux');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  const value = typeof config === 'function' ? config({ glbRoot, comfyDir, bat }) : config;
  const configPath = path.join(root, name);
  put(root, name, value);
  return { root, glbRoot, comfyDir, bat, dataRoot, configPath };
}
const plan = (configPath: string) => planLancement(configPath, TOOL_ROOT, NODE);
const outils = (p: ReturnType<typeof plan>) => p.lancements.map((l) => l.outil).join(',');
const refusDe = (p: ReturnType<typeof plan>, o: Outil) => p.refus.find((r) => r.outil === o)?.message ?? '';

// Plan complet : les trois commandes (questions 1, 5 et 7)
{
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, dataRoot: '/ailleurs', comfyLauncher: bat }));
  const p = plan(d.configPath);
  check('plan : trois outils, dans l\'ordre, aucun refus', outils(p) === 'studio,print,comfyui' && p.refus.length === 0, p);
  const [studio, print, comfy] = p.lancements;
  check('Studio : npm --prefix <glbRoot> run studio -- --port 4000 --no-open, sans shell', studio.file === NODE && json(studio.args) === json([NPM_CLI, '--prefix', d.glbRoot, 'run', 'studio', '--', '--port', '4000', '--no-open']), studio);
  check('Studio : sa page n\'est pas ouverte par lui (--no-open) : le lanceur l\'ouvre', studio.args.includes('--no-open'));
  check('Studio : dossier du repo, port 4000, 60 s', studio.cwd === d.glbRoot && studio.port === STUDIO_PORT && studio.port === 4000 && studio.delaiMs === 60_000 && studio.host === '127.0.0.1');
  check('Print : npm --prefix <book-print> run print -- --no-open', print.file === NODE && json(print.args) === json([NPM_CLI, '--prefix', TOOL_ROOT, 'run', 'print', '--', '--no-open']), print);
  check('Print : dossier du repo, port 4200, 60 s', print.cwd === TOOL_ROOT && print.port === PRINT_PORT && print.port === 4200 && print.delaiMs === DELAIS_MS.print);
  check('ComfyUI : Python embarqué à côté du lanceur', comfy.file === path.join(d.comfyDir, COMFY_PYTHON) && comfy.cwd === d.comfyDir, comfy);
  check('ComfyUI : options de run_il0.bat et --disable-auto-launch', json(comfy.args) === json(['-s', 'ComfyUI\\main.py', '--windows-standalone-build', '--enable-manager', '--disable-auto-launch']), comfy.args);
  check('ComfyUI : jamais le .bat (il ouvrirait la page et attendrait une touche)', !comfy.args.some((a) => /run_il0/i.test(a)) && comfy.file !== d.bat);
  check('ComfyUI : port 8188 par défaut, 3 min', comfy.port === 8188 && comfy.host === '127.0.0.1' && comfy.delaiMs === 180_000);
  check('ComfyUI : sortie en UTF-8, sans tampon', comfy.env?.PYTHONIOENCODING === 'utf-8' && comfy.env?.PYTHONUNBUFFERED === '1');
  check('npm-cli.js : celui du Node qui exécute le lanceur', NPM_CLI.endsWith(path.join('npm', 'bin', 'npm-cli.js')));
}

// comfyArgs et comfyUrl (question 5)
{
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat, comfyArgs: ['-s', 'ComfyUI\\main.py', '--port', '8190', '--disable-auto-launch'], comfyUrl: 'http://127.0.0.1:8190' }));
  const comfy = plan(d.configPath).lancements.find((l) => l.outil === 'comfyui');
  check('comfyArgs remplace les options par défaut', json(comfy?.args) === json(['-s', 'ComfyUI\\main.py', '--port', '8190', '--disable-auto-launch']), comfy);
  check('comfyUrl : port sondé', comfy?.port === 8190);
  const v6 = plan(decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat, comfyUrl: 'http://[::1]:8188' })).configPath).lancements.find((l) => l.outil === 'comfyui');
  check('comfyUrl [::1] : sondé sur ::1', v6?.host === '::1' && v6.port === 8188, v6);
  for (const [value, why] of [
    [[], 'liste vide'],
    ['--disable-auto-launch', 'liste d\'options attendue'],
    [[1], 'texte attendu'],
    [[''], 'option vide'],
    [Array(41).fill('-s'), '40 options'],
  ] as const) {
    const p = plan(decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat, comfyArgs: value })).configPath);
    check(`comfyArgs refusé (${why}) : ComfyUI seul n'est pas lancé`, outils(p) === 'studio,print' && refusDe(p, 'comfyui').includes(why) && refusDe(p, 'comfyui').includes('config.local.json'), p.refus);
  }
  const p = plan(decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat, comfyUrl: 'http://localhost:8188' })).configPath);
  check('comfyUrl refusé : ComfyUI non lancé, message nommé', outils(p) === 'studio,print' && refusDe(p, 'comfyui').includes('comfyUrl refusé'), p.refus);
  const p2 = plan(decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat, comfyUrl: 8188 })).configPath);
  check('comfyUrl qui n\'est pas un texte : refus', refusDe(p2, 'comfyui').includes('comfyUrl : texte attendu'), p2.refus);
  check('config.example.json : comfyArgs montré, égal au défaut', (() => {
    const ex = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'config.example.json'), 'utf8'));
    return json(ex.comfyArgs) === json(DEFAULT_COMFY_ARGS) && comfyArgsSchema.safeParse(ex.comfyArgs).success && ex.comfyLauncher && ex.glbRoot;
  })());
}

// Configuration absente ou illisible (question 4) : Print est lancé seul, il affiche lui-même la configuration à corriger
{
  const root = tempDir();
  const p = plan(path.join(root, 'config.local.json'));
  check('config absente : Print seul', outils(p) === 'print', p);
  check('config absente : Studio et ComfyUI refusés, message clair', refusDe(p, 'studio').includes('absent') && refusDe(p, 'studio').includes('config.example.json') && refusDe(p, 'comfyui').includes('ComfyUI n\'est pas lancé'), p.refus);
  put(root, 'config.local.json', '{ cassé');
  const p2 = plan(path.join(root, 'config.local.json'));
  check('JSON invalide : Print seul, refus nommé', outils(p2) === 'print' && refusDe(p2, 'studio').includes('n\'est pas un JSON valide'), p2.refus);
  put(root, 'config.local.json', '[1]');
  check('JSON qui n\'est pas un objet : refus', refusDe(plan(path.join(root, 'config.local.json')), 'studio').includes('objet JSON'));
}

// glbRoot (Studio)
{
  const cas: [string, (d: { glbRoot: string; bat: string }) => Record<string, unknown>, string][] = [
    ['absent', ({ bat }) => ({ comfyLauncher: bat }), 'glbRoot absent'],
    ['vide', ({ bat }) => ({ glbRoot: '', comfyLauncher: bat }), 'vide'],
    ['relatif', ({ bat }) => ({ glbRoot: 'glbinterpreter', comfyLauncher: bat }), 'chemin absolu'],
    ['introuvable', ({ glbRoot, bat }) => ({ glbRoot: `${glbRoot}-faux`, comfyLauncher: bat }), 'introuvable'],
  ];
  for (const [nom, cfg, why] of cas) {
    const p = plan(decor(cfg).configPath);
    check(`glbRoot ${nom} : Studio non lancé, Print et ComfyUI lancés`, outils(p) === 'print,comfyui' && refusDe(p, 'studio').includes(why) && refusDe(p, 'studio').includes('config.local.json'), p.refus);
  }
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat }));
  fs.rmSync(path.join(d.glbRoot, 'package.json'));
  check('glbRoot sans package.json : refus', refusDe(plan(d.configPath), 'studio').includes('package.json'));
  put(d.glbRoot, 'package.json', { scripts: { dev: 'next dev' } });
  check('glbRoot sans script studio : refus', refusDe(plan(d.configPath), 'studio').includes('script « studio »'));
}

// comfyLauncher (ComfyUI)
{
  const p = plan(decor(({ glbRoot }) => ({ glbRoot })).configPath);
  check('comfyLauncher absent : ComfyUI non lancé, message clair', outils(p) === 'studio,print' && refusDe(p, 'comfyui').includes('comfyLauncher absent'), p.refus);
  const p2 = plan(decor(({ glbRoot, comfyDir }) => ({ glbRoot, comfyLauncher: path.join(comfyDir, 'run_il0.exe') })).configPath);
  check('comfyLauncher qui n\'est pas un .bat : refus', refusDe(p2, 'comfyui').includes('.bat ou .cmd'), p2.refus);
  const p3 = plan(decor(({ glbRoot, comfyDir }) => ({ glbRoot, comfyLauncher: path.join(comfyDir, 'absent.bat') })).configPath);
  check('comfyLauncher introuvable : refus', refusDe(p3, 'comfyui').includes('introuvable'), p3.refus);
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat }));
  fs.rmSync(path.join(d.comfyDir, COMFY_PYTHON));
  const p4 = plan(d.configPath);
  check('Python embarqué absent : refus qui nomme le chemin', refusDe(p4, 'comfyui').includes('Python de ComfyUI introuvable') && refusDe(p4, 'comfyui').includes(path.join(d.comfyDir, COMFY_PYTHON)), p4.refus);
  const copie = decor(({ glbRoot }) => ({ glbRoot: `${glbRoot}-faux` }), 'copie.json');
  const p5 = plan(copie.configPath);
  check('copie de la configuration (--config) : son nom dans les messages', refusDe(p5, 'studio').includes('copie.json') && refusDe(p5, 'comfyui').includes('copie.json'), p5.refus);
}

// Configuration lue par Print : comfyArgs admis, contrôlé
{
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat, comfyArgs: [...DEFAULT_COMFY_ARGS] }));
  const raw = JSON.parse(fs.readFileSync(d.configPath, 'utf8'));
  put(d.root, 'config.local.json', { ...raw, dataRoot: d.dataRoot });
  check('Print : comfyArgs admis dans config.local.json', loadConfig(d.configPath).ok, loadConfig(d.configPath));
  put(d.root, 'config.local.json', { ...raw, dataRoot: d.dataRoot, comfyArgs: 'x' });
  const r = loadConfig(d.configPath);
  check('Print : comfyArgs invalide refusé, champ nommé', !r.ok && r.message.includes('comfyArgs'), r);
}

// Déjà lancé (question 3)
{
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat }));
  const all = plan(d.configPath).lancements;
  check('déjà lancé : rien n\'est relancé', aLancer(all, new Set<Outil>(['studio', 'print', 'comfyui'])).length === 0);
  check('outil arrêté à la main : relancé seul', aLancer(all, new Set<Outil>(['studio', 'comfyui'])).map((l) => l.outil).join() === 'print');
  check('rien ne répond : les trois', aLancer(all, new Set()).length === 3);
}

// Superviseurs et processus à arrêter (question 2)
{
  const cmd = 'node --import tsx "src\\lanceur\\main.ts" lancer';
  check('ligne de commande du superviseur reconnue', estUnSuperviseur(cmd) && estUnSuperviseur('"C:\\Program Files\\nodejs\\node.exe" --import tsx src/lanceur/main.ts lancer --config x.json'));
  check('« Tout arrêter » n\'est pas un superviseur', !estUnSuperviseur('node --import tsx "src\\lanceur\\main.ts" arreter'));
  check('autre programme Node : pas un superviseur', !estUnSuperviseur('node D:\\autre\\main.ts lancer') && !estUnSuperviseur('node --import tsx src\\server\\main.ts'));
  const s = (pid: number, debut: number): Superviseur => ({ pid, debut, outils: [{ outil: 'print', pid: pid + 1, host: '127.0.0.1', port: 4200 }] });
  const procs: Proc[] = [
    { pid: 100, ppid: 1, debut: 1_000_000, commande: cmd },
    { pid: 101, ppid: 100, debut: 1_000_500, commande: 'node npm-cli.js run print' },
    { pid: 102, ppid: 101, debut: 1_000_600, commande: 'cmd.exe /d /s /c tsx src/server/main.ts' },
    { pid: 103, ppid: 102, debut: 1_000_700, commande: 'node tsx src/server/main.ts' },
    { pid: 200, ppid: 1, debut: 5_000_000, commande: 'notepad.exe' },
    { pid: 300, ppid: 1, debut: 9_000_000, commande: cmd },
    { pid: 0, ppid: 0, debut: 0, commande: '' },
  ];
  const r = aArreter([s(100, 1_002_000), s(200, 5_000_000), s(300, 1_000_000), s(400, 1)], procs);
  check('à arrêter : superviseur vivant, même départ, même commande', json(r.arreter.map((x) => x.pid)) === json([100]), r);
  check('périmés : PID repris par un autre programme, autre heure de départ, arrêté', json(r.perimes.map((x) => x.pid)) === json([200, 300, 400]), r);
  const sup1: Superviseur = { pid: 100, debut: 1, outils: [{ outil: 'studio', pid: 101, host: '127.0.0.1', port: 4000 }, { outil: 'print', pid: 999, host: '127.0.0.1', port: 4200 }] };
  const sup2: Superviseur = { pid: 300, debut: 2, outils: [{ outil: 'print', pid: 102, host: '127.0.0.1', port: 4200 }] };
  check('ports à voir libérés : outils vivants seulement, une fois chacun', json(portsAVerifier([sup1, sup2], procs).map((o) => `${o.outil}:${o.pid}`)) === json(['studio:101', 'print:102']), portsAVerifier([sup1, sup2], procs));
  check('ports à voir libérés : Print arrêté à la main et relancé ailleurs, pas compté au premier', !portsAVerifier([sup1], procs).some((o) => o.outil === 'print'));
  check('arbre : la racine, ses enfants et petits-enfants, rien d\'autre', json(arbre(100, procs).sort()) === json([100, 101, 102, 103]));
  check('arbre : PID 0 parent de lui-même sans boucle', json(arbre(0, procs).sort((a, b) => a - b)) === json([0]));
  check('arbre : boucle de parents sans blocage', arbre(1, [{ pid: 2, ppid: 1, debut: 0, commande: '' }, { pid: 1, ppid: 2, debut: 0, commande: '' }]).length === 2);
  check('état illisible : aucun superviseur', parseEtat(null).length === 0 && parseEtat('{').length === 0 && parseEtat('{"superviseurs":[{"pid":"x"}]}').length === 0);
  const dir = tempDir();
  const file = path.join(dir, '.lanceur', 'etat.json');
  check('état absent : vide', lireEtat(file).length === 0);
  ecrireEtat(file, [s(100, 1)]);
  modifierEtat(file, (x) => [...x, s(300, 2)]);
  check('état : écrit, relu, modifié', json(lireEtat(file).map((x) => x.pid)) === json([100, 300]));
  modifierEtat(file, (x) => x.filter((y) => y.pid !== 100));
  check('état : superviseur retiré', json(lireEtat(file).map((x) => x.pid)) === json([300]) && !fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp')));
}

// Fenêtre de message (question 4)
{
  check('message : lignes séparées par |, sans guillemet', texteMessage(['ComfyUI ne répond pas sur le port 8188 après 180 s.', 'Journal : D:\\a "b"\\comfyui.log']) === 'ComfyUI ne répond pas sur le port 8188 après 180 s.|Journal : D:\\a \'b\'\\comfyui.log');
  check('message : retours à la ligne et | d\'une ligne remplacés', texteMessage(['a\r\nb|c', '', 'd']) === 'a b c|d');
  check('message : 4000 caractères au plus', texteMessage(['x'.repeat(5000)]).length === 4000);
}

// Fichiers du lanceur
{
  const vbs = fs.readFileSync(path.join(TOOL_ROOT, 'lanceur', 'lanceur.vbs'), 'utf8');
  const racc = fs.readFileSync(path.join(TOOL_ROOT, 'lanceur', 'raccourcis.vbs'), 'utf8');
  check('lanceur.vbs et raccourcis.vbs en ASCII (lus en ANSI par wscript)', /^[\x00-\x7f]*$/.test(vbs) && /^[\x00-\x7f]*$/.test(racc));
  check('lanceur.vbs : Node dans une console cachée (style 0), sans attendre', vbs.includes('src\\lanceur\\main.ts') && /sh\.Run commande, 0, False/.test(vbs) && vbs.includes('--import tsx'));
  check('lanceur.vbs : fenêtre de message au premier plan', vbs.includes('vbSystemModal') && vbs.includes('Replace(WScript.Arguments(1), "|", vbCrLf)'));
  check('raccourcis.vbs : wscript.exe sur lanceur.vbs, icône print.ico, deux modes', racc.includes('\\System32\\wscript.exe') && racc.includes('print.ico') && racc.includes('"lancer"') && racc.includes('"arreter"'));
  check('.gitignore : .lanceur/ ignoré', fs.readFileSync(path.join(TOOL_ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('.lanceur/'));
}

// Sonde d'un port, attente, demande d'arrêt au Studio
const recu: { headers: http.IncomingHttpHeaders; body: string; url?: string; method?: string }[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    recu.push({ headers: req.headers, body, url: req.url, method: req.method });
    res.writeHead(req.method === 'POST' ? 200 : 403).end('{}');
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const port = (fake.address() as AddressInfo).port;
check('sonde : un serveur qui répond (même 403) tourne', await repond('127.0.0.1', port));
check('sonde : jamais la page (le Studio compterait un onglet ouvert et n\'ouvrirait plus la sienne)', recu.at(-1)?.method === 'GET' && recu.at(-1)?.url === SONDE && !['/', '/index.html'].includes(SONDE), recu.at(-1)?.url);
const ferme = http.createServer();
await new Promise<void>((r) => ferme.listen(0, '127.0.0.1', r));
const portFerme = (ferme.address() as AddressInfo).port;
await new Promise<void>((r) => ferme.close(() => r()));
check('sonde : port fermé', !(await repond('127.0.0.1', portFerme)));
check('quitter le Studio : réponse 200', await quitterStudio('127.0.0.1', port));
const q = recu.at(-1)!;
check('quitter le Studio : POST JSON /__studio/action, action quitter', q.method === 'POST' && q.url === '/__studio/action' && json(JSON.parse(q.body)) === json({ action: 'quitter' }), q);
check('quitter le Studio : en-têtes du Studio (x-glbi-studio, Origin, Host)', q.headers['x-glbi-studio'] === '1' && q.headers.origin === `http://127.0.0.1:${port}` && q.headers.host === `127.0.0.1:${port}` && q.headers['content-type'] === 'application/json');
check('quitter un Studio absent : faux', !(await quitterStudio('127.0.0.1', portFerme)));
let n = 0;
check('attendre : vrai dès que le test l\'est', await attendre(async () => ++n >= 3, 5_000, 10));
const t0 = Date.now();
check('attendre : abandon dès que le processus est fini', !(await attendre(async () => false, 10_000, 10, () => true)) && Date.now() - t0 < 1_000);
check('attendre : faux après le délai', !(await attendre(async () => false, 100, 20)));
await new Promise<void>((r) => fake.close(() => r()));

// « Tout arrêter et quitter » de Print (LC1) : route, refus, arrêt après la réponse
{
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat }));
  const raw = JSON.parse(fs.readFileSync(d.configPath, 'utf8'));
  put(d.root, 'config.local.json', { ...raw, dataRoot: d.dataRoot });
  let quits = 0;
  const avec = createPrintServer(d.configPath, undefined, { quitter: () => void quits++ });
  const sans = createPrintServer(d.configPath);
  const ecoute = async (s: http.Server) => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };
  const pA = await ecoute(avec);
  const pS = await ecoute(sans);
  const req = (p: number, opts: { method?: string; headers?: Record<string, string>; body?: string }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p, path: QUIT_ROUTE, method: opts.method ?? 'POST', headers: { host: `127.0.0.1:${p}`, ...opts.headers } }, (res) => {
        let b = '';
        res.on('data', (x) => (b += x));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      r.end(opts.body);
    });
  const h = (p: number) => ({ origin: `http://127.0.0.1:${p}`, 'content-type': 'application/json', 'x-book-print': '1' });
  check('quitter : GET refusé (405)', (await req(pA, { method: 'GET' })).status === 405);
  check('quitter : sans en-tête x-book-print, refusé (403)', (await req(pA, { headers: { origin: `http://127.0.0.1:${pA}`, 'content-type': 'application/json' }, body: '{}' })).status === 403);
  check('quitter : autre origine, refusée (403)', (await req(pA, { headers: { ...h(pA), origin: 'http://exemple.test' }, body: '{}' })).status === 403);
  check('quitter : corps autre que {}, refusé (400)', (await req(pA, { headers: h(pA), body: '{"tout":true}' })).status === 400);
  check('quitter : rien d\'arrêté sur un refus', quits === 0);
  const s = await req(pS, { headers: h(pS), body: '{}' });
  check('quitter : serveur sans arrêt (tests), 409 nommé', s.status === 409 && s.body.includes('arrêt indisponible'), s);
  const ok = await req(pA, { headers: h(pA), body: '{}' });
  await new Promise((r) => setTimeout(r, 50));
  check('quitter : 200, arrêt demandé une fois', ok.status === 200 && quits === 1, { ok, quits });
  await new Promise<void>((r) => avec.close(() => r()));
  await new Promise<void>((r) => sans.close(() => r()));
  const mainSrc = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'server', 'main.ts'), 'utf8');
  check('Print : « quitter » lance l\'arrêt du lanceur, puis Print se ferme', mainSrc.includes('lancerArret(LANCEUR_VBS)') && mainSrc.includes('process.exit(0)') && mainSrc.includes("'../../lanceur/lanceur.vbs'"));
  const html = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'ui', 'app.js'), 'utf8');
  check('page : bouton « Tout arrêter et quitter » dans le bandeau, avec confirmation', /<header id="bandeau">[\s\S]*id="quitter"[\s\S]*Tout arrêter et quitter[\s\S]*<\/header>/.test(html) && js.includes('window.confirm(QUIT_CONFIRM)') && js.includes("action('/api/quitter')"));
}

// Onglets de Print (LC1, comme le studio) : flux d'événements, identifiant d'instance, page ouverte seulement sans onglet reconnecté
{
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat }));
  const raw = JSON.parse(fs.readFileSync(d.configPath, 'utf8'));
  put(d.root, 'config.local.json', { ...raw, dataRoot: d.dataRoot });
  let vus = 0;
  const a = createPrintServer(d.configPath, undefined, { onglet: () => void vus++ });
  const b = createPrintServer(d.configPath);
  const ports: number[] = [];
  for (const s of [a, b]) {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    ports.push((s.address() as AddressInfo).port);
  }
  /** Premier morceau du flux, puis la connexion reste ouverte. */
  const flux = (p: number, opts: { method?: string; host?: string } = {}) =>
    new Promise<{ status: number; type: string; debut: string; res: http.IncomingMessage }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p, path: EVENTS_ROUTE, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${p}` } }, (res) => {
        res.setEncoding('utf8');
        res.once('data', (debut: string) => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), debut, res }));
        res.once('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), debut: '', res }));
      });
      r.on('error', reject);
      r.end();
    });
  const fa = await flux(ports[0]!);
  const instanceA = /event: instance\ndata: ([0-9a-f-]{36})\n\n/.exec(fa.debut)?.[1];
  check('onglets : flux d\'événements, reconnexion en 1 s, identifiant d\'instance', fa.status === 200 && fa.type.startsWith('text/event-stream') && fa.debut.startsWith('retry: 1000\n') && !!instanceA, fa.debut);
  check('onglets : chaque connexion est signalée au serveur', vus === 1);
  let suiteA = '';
  fa.res.on('data', (x: string) => (suiteA += x));
  const finA = new Promise<void>((r) => fa.res.once('end', () => r()));
  const compter = (p: number) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p, path: TABS_ROUTE, method: 'POST', headers: { host: `127.0.0.1:${p}`, origin: `http://127.0.0.1:${p}`, 'content-type': 'application/json', 'x-book-print': '1' } }, (res) => {
        let b = '';
        res.on('data', (x) => (b += x));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      r.end('{}');
    });
  check('onglets : compte des onglets actifs (lanceur)', JSON.parse((await compter(ports[0]!)).body).onglets === 1);
  const fa2 = await flux(ports[0]!);
  check('onglets : même identifiant pour le même serveur', fa2.debut.includes(`data: ${instanceA}`) && vus === 2);
  const ferme = await Promise.race([finA.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3_000))]);
  check('un seul onglet actif : le premier reçoit « remplace » et son flux se ferme', ferme && suiteA.includes('event: remplace'), suiteA);
  check('un seul onglet actif : un onglet compté après la relève', JSON.parse((await compter(ports[0]!)).body).onglets === 1);
  const sansEntete = await new Promise<number>((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: ports[0], path: TABS_ROUTE, method: 'POST', headers: { host: `127.0.0.1:${ports[0]}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.end('{}');
  });
  check('onglets : compte refusé sans x-book-print (403)', sansEntete === 403);
  const fb = await flux(ports[1]!);
  check('onglets : un autre serveur (Print relancé), un autre identifiant', !!/data: ([0-9a-f-]{36})/.exec(fb.debut) && !fb.debut.includes(instanceA ?? 'x'));
  const post = await flux(ports[0]!, { method: 'POST' });
  check('onglets : POST refusé (405)', post.status === 405);
  const autre = await flux(ports[0]!, { host: 'exemple.test' });
  check('onglets : autre Host refusé (403)', autre.status === 403 && vus === 2);
  fa.res.destroy();
  const fermes: Promise<void>[] = [fa2].map((f) => new Promise<void>((r) => f.res.once('end', () => r())));
  await new Promise<void>((r) => a.close(() => r()));
  await Promise.all(fermes);
  check('onglets : le serveur fermé termine les flux (la fermeture aboutit)', true);
  await new Promise<void>((r) => b.close(() => r()));
  const t = 1_000_000;
  check('page au démarrage : ouverte si aucun onglet ne s\'est connecté depuis le démarrage', pageAOuvrir(0, t) && pageAOuvrir(t - 1, t) && !pageAOuvrir(t, t) && !pageAOuvrir(t + 500, t) && TAB_WAIT_MS === 3_000);
  const mainSrc = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'server', 'main.ts'), 'utf8');
  check('Print : attend 3 s un onglet déjà ouvert avant d\'ouvrir sa page', /setTimeout\(\(\) => \{\s*if \(pageAOuvrir\(ongletVuA, demarreA\)\) openBrowser\(url\);/.test(mainSrc) && mainSrc.includes('}, TAB_WAIT_MS);') && mainSrc.includes('onglet: () => {'));
  const js = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'ui', 'app.js'), 'utf8');
  check('page : flux relancé seul, rechargement sur un autre identifiant', js.includes("new EventSource('/evenements')") && js.includes('location.reload()') && /setTimeout\(\(\) => \{\s*relance = null;\s*ecouter\(\);\s*\}, 1000\)/.test(js));
  const html = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'ui', 'index.html'), 'utf8');
  check('page : veille sur « remplace », « Utiliser cet onglet » la reprend', js.includes("addEventListener('remplace'") && js.includes("$('veille').showModal()") && html.includes('id="veille"') && html.includes('Utiliser cet onglet'));
  check('Print : --no-open pour le lanceur, page ouverte sinon', printOptions([]).open && !printOptions(['--no-open']).open && (() => {
    try {
      printOptions(['--autre']);
      return false;
    } catch {
      return true;
    }
  })() && mainSrc.includes('if (!OPTIONS.open) return;'));
}

// Pages ouvertes par le lanceur (LC1) : registre, navigateur, pages manquantes
{
  const sortieProgId = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    BraveHTML\r\n\r\n';
  const sortieCommande = '\r\nHKEY_CLASSES_ROOT\\BraveHTML\\shell\\open\\command\r\n    (par défaut)    REG_SZ    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --single-argument %1\r\n';
  check('registre : valeur lue après REG_SZ, nom en toute langue', valeurReg(sortieProgId) === 'BraveHTML' && !!valeurReg(sortieCommande)?.startsWith('"C:\\Program Files\\BraveSoftware'), valeurReg(sortieCommande));
  check('registre : valeur absente', valeurReg('ERREUR : le système n\'a pas trouvé la clé') === null);
  check('navigateur : programme entre guillemets', exeDe(valeurReg(sortieCommande)!) === 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe');
  check('navigateur : programme sans guillemets, variable développée', exeDe('%PF%\\Firefox\\firefox.exe -osint -url "%1"', { PF: 'C:\\Programmes' }) === 'C:\\Programmes\\Firefox\\firefox.exe');
  check('navigateur : commande qui n\'est pas un .exe, refusée', exeDe('"C:\\x\\ouvrir.cmd" %1') === null && exeDe('') === null);
  check('pages manquantes : outils qui répondent sans onglet', json(pagesManquantes({ studio: 0, print: 0 })) === json(['studio', 'print']) && json(pagesManquantes({ studio: 1, print: 0 })) === json(['print']));
  check('pages manquantes : aucun pour un outil sans réponse ou absent', pagesManquantes({ studio: null, print: 2 }).length === 0 && pagesManquantes({}).length === 0);
  check('pages : adresses du Studio et de Print', URLS.studio === 'http://127.0.0.1:4000/' && URLS.print === 'http://127.0.0.1:4200/');
  const src = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'lanceur', 'pages.ts'), 'utf8');
  check('navigateur ouvert hors de l\'arbre du lanceur (cmd /c start), jamais fermé par l\'arrêt', src.includes('`start "" "${exe}" ${') && src.includes("spawn('cmd.exe', ['/d', '/s', '/c', commandeNavigateur(exe, urls)]") && src.includes("spawn('rundll32', ['url.dll,FileProtocolHandler', url]"));
}

// Studio fermé par son bouton : tout s'arrête (LC1)
{
  check('Studio prêt, code 0, fermé par son bouton : tout s\'arrête', toutArreterApres('studio', 0, true, true));
  check('Studio tombé (code 1), arrêté par taskkill, ou jamais prêt : rien de plus', !toutArreterApres('studio', 1, true, true) && !toutArreterApres('studio', null, true, true) && !toutArreterApres('studio', 0, false, true));
  check('Print ou ComfyUI qui se ferment : rien de plus', !toutArreterApres('print', 0, true, true) && !toutArreterApres('comfyui', 0, true, true));
  const vivants = new Set([42]);
  const vit = (pid: number) => vivants.has(pid);
  check('arrêt en cours : marque vivante et récente', arretEnCours({ pid: 42, debut: 1_000 }, 2_000, vit));
  check('arrêt en cours : marque absente, processus mort ou marque trop vieille', !arretEnCours(null, 2_000, vit) && !arretEnCours({ pid: 7, debut: 1_000 }, 2_000, vit) && !arretEnCours({ pid: 42, debut: 0 }, 200_000, vit));
  const dir = tempDir();
  const f = path.join(dir, 'arret.json');
  check('marque d\'arrêt : absente ou illisible, nulle ; lue sinon', lireMarque(f) === null && (fs.writeFileSync(f, '{'), lireMarque(f) === null) && (fs.writeFileSync(f, JSON.stringify({ pid: 3, debut: 4 })), json(lireMarque(f)) === json({ pid: 3, debut: 4 })));
  const main = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'lanceur', 'main.ts'), 'utf8');
  check('Tout arrêter : marque posée pendant tout le travail, retirée à la fin', /fs\.writeFileSync\(ARRET,[\s\S]*try \{\s*await arreterTout\(\);\s*\} finally \{\s*fs\.rmSync\(ARRET/.test(main));
  check('superviseur : Studio fermé hors d\'un arrêt en cours, arrêt de tout lancé', /toutArreterApres\(outil, code, await estPret, parBouton\)[\s\S]*arretEnCours\(lireMarque\(ARRET\), Date\.now\(\), vivant\)[\s\S]*lancerArret\(VBS\)/.test(main));
}

// LC2, défaut 1 : onglet du navigateur intégré de Claude Desktop, ni compté ni mis en veille par le navigateur de David (ni l'inverse)
{
  const UA_INTEGRE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/4.23118.0 Chrome/152.0.7977.167 Safari/537.36';
  const UA_BRAVE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  check('navigateur intégré : reconnu à Claude/<version> ou Electron/<version>', navigateurIntegre(UA_INTEGRE) && navigateurIntegre('x Electron/38.1.0 y'));
  check('navigateur de David (Brave, Chrome) ou sans User-Agent : pas le navigateur intégré', !navigateurIntegre(UA_BRAVE) && !navigateurIntegre(undefined) && !navigateurIntegre('') && !navigateurIntegre('ClaudeBot'));
  const d = decor(({ glbRoot, bat }) => ({ glbRoot, comfyLauncher: bat }));
  let vus = 0;
  const s = createPrintServer(d.configPath, undefined, { onglet: () => void vus++ });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  type Flux = { res: http.IncomingMessage; texte: () => string; fini: () => boolean };
  const ouvrir = (ua: string) =>
    new Promise<Flux>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: EVENTS_ROUTE, headers: { host: `127.0.0.1:${port}`, 'user-agent': ua } }, (res) => {
        let t = '';
        let f = false;
        res.setEncoding('utf8');
        res.on('data', (x: string) => (t += x));
        res.once('end', () => (f = true));
        res.once('data', () => resolve({ res, texte: () => t, fini: () => f }));
      });
      r.on('error', reject);
      r.end();
    });
  const compte = () =>
    new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: TABS_ROUTE, method: 'POST', headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-book-print': '1' } }, (res) => {
        let b = '';
        res.on('data', (x) => (b += x));
        res.on('end', () => resolve(JSON.parse(b).onglets));
      });
      r.on('error', reject);
      r.end('{}');
    });
  const pause = () => new Promise((r) => setTimeout(r, 150));
  const integre1 = await ouvrir(UA_INTEGRE);
  check('onglet du navigateur intégré seul : compté 0 pour le lanceur, connexion non signalée (attente de print.cmd)', (await compte()) === 0 && vus === 0);
  const brave1 = await ouvrir(UA_BRAVE);
  await pause();
  check('onglet de Brave ouvert ensuite : compté 1, signalé ; l\'onglet intégré reste connecté, sans veille', (await compte()) === 1 && vus === 1 && !integre1.fini() && !integre1.texte().includes('remplace'));
  const integre2 = await ouvrir(UA_INTEGRE);
  await pause();
  check('second onglet intégré : remplace le premier intégré seulement, Brave reste actif', integre1.fini() && integre1.texte().includes('event: remplace') && !brave1.fini() && (await compte()) === 1 && vus === 1);
  const brave2 = await ouvrir(UA_BRAVE);
  await pause();
  check('second onglet de Brave : remplace le premier de Brave seulement, l\'intégré reste connecté', brave1.fini() && brave1.texte().includes('event: remplace') && !integre2.fini() && (await compte()) === 1 && vus === 2);
  brave2.res.destroy();
  await pause();
  check('onglet de Brave fermé : compte 0 même avec l\'onglet intégré ouvert', (await compte()) === 0 && !integre2.fini());
  await new Promise<void>((r) => s.close(() => r()));
}

// LC2, défaut 2 : navigateur fermé, ouvert directement sur les pages qui manquent (plus de restauration attendue)
{
  const exe = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  check('navigateur fermé : une seule commande, le programme et chaque page manquante entre guillemets', commandeNavigateur(exe, [URLS.studio, URLS.print]) === `start "" "${exe}" "http://127.0.0.1:4000/" "http://127.0.0.1:4200/"`);
  const src = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'lanceur', 'pages.ts'), 'utf8');
  check('navigateur fermé : ouvert sur les pages manquantes, sans attente de restauration', /navigateurLance\(nav\.image\)\) \{\s*const manquent = pagesManquantes\(avant\);[\s\S]*demarrerNavigateur\(nav\.exe, manquent\.map\(\(o\) => URLS\[o\]\)\);[\s\S]*return note\(/.test(src) && !src.includes('ATTENTE_RESTAURATION_MS') && !src.includes('sans adresse pour'));
}

// LC2, défaut 3 : Studio fermé par son bouton vu dans son journal ; un seul lancement à la fois ; « Tout arrêter » attendu ; fin vue aussitôt
{
  const journal = (pid: number, bouton: boolean) =>
    `=== Studio de GLBInterpreter — 10/11/2026 11:03:13 — lancé par le lanceur (PID ${pid}) ===\r\n"node.exe" npm-cli.js run studio\r\n\r\nstudio : http://127.0.0.1:4000/ (repo D:\\x, PID 1316)\r\n${bouton ? `${LIGNE_BOUTON_STUDIO} : arrêt des processus gérés…\r\nstudio : arrêté\r\n` : ''}`;
  check('bouton du Studio : ligne du bouton dans le journal de ce superviseur', quitteParBouton(journal(13908, true), 13908));
  check('Studio sorti seul (code 0 sans le bouton, par exemple « déjà lancé ») : pas le bouton', !quitteParBouton(journal(13908, false), 13908) && !quitteParBouton('', 13908));
  check('journal remplacé par un autre lancement (autre PID) : pas le bouton de ce Studio', !quitteParBouton(journal(13712, true), 13908) && !quitteParBouton(journal(139080, true), 13908));
  check('Studio prêt, code 0, sans le bouton : rien de plus', !toutArreterApres('studio', 0, true, false));

  const vivants = new Set([42, 43]);
  const vit = (pid: number) => vivants.has(pid);
  check('lancement en cours : marque vivante et récente ; sinon non', lancementEnCours({ pid: 42, debut: 1_000 }, 2_000, vit) && !lancementEnCours(null, 2_000, vit) && !lancementEnCours({ pid: 7, debut: 1_000 }, 2_000, vit) && !lancementEnCours({ pid: 42, debut: 0 }, LANCEMENT_MAX_MS + 1, vit));
  const dir = tempDir();
  const f = path.join(dir, '.lanceur', 'lancement.json');
  const now = Date.now();
  const a = { pid: 42, debut: now };
  const b = { pid: 43, debut: now + 5 };
  check('verrou : pris par le premier lancement, marque écrite', prendreLancement(f, a, now, vit) && json(lireMarque(f)) === json(a));
  check('verrou : refusé au second pendant le premier (second double-clic)', !prendreLancement(f, b, now + 1_000, vit) && json(lireMarque(f)) === json(a));
  rendreLancement(f, b);
  check('verrou : un autre lancement ne le rend pas', json(lireMarque(f)) === json(a));
  rendreLancement(f, a);
  check('verrou : rendu par son lancement, repris ensuite', !fs.existsSync(f) && prendreLancement(f, b, now + 2_000, vit) && json(lireMarque(f)) === json(b));
  vivants.delete(43);
  check('verrou : lancement mort, repris', prendreLancement(f, a, now + 3_000, vit) && json(lireMarque(f)) === json(a));
  check('verrou : lancement trop long (plus de 5 min), repris', prendreLancement(f, { pid: 42, debut: now + 1 }, now + LANCEMENT_MAX_MS + 10, vit));
  fs.writeFileSync(f, '');
  check('verrou : marque illisible récente (en cours d\'écriture), refusé', !prendreLancement(f, a, Date.now(), vit));
  const vieux = new Date(Date.now() - 60_000);
  fs.utimesSync(f, vieux, vieux);
  check('verrou : marque illisible depuis plus de 5 s, reprise', prendreLancement(f, a, Date.now(), vit) && json(lireMarque(f)) === json(a));

  const main = fs.readFileSync(path.join(TOOL_ROOT, 'src', 'lanceur', 'main.ts'), 'utf8');
  check('lancer : verrou pris avant la sonde, attente du lancement précédent, rendu à la fin du démarrage', /if \(!prendreLancement\(LANCEMENT, moi, Date\.now\(\), vivant\)\) \{[\s\S]*await attendre\(async \(\) => prendreLancement\(LANCEMENT, moi, Date\.now\(\), vivant\)[\s\S]*try \{\s*suite = await demarrerTout\(configPath, debut\);\s*\} finally \{\s*rendreLancement\(LANCEMENT, moi\);\s*\}\s*await suite\?\.\(\);/.test(main) && main.indexOf('const sondes =') > main.indexOf('async function demarrerTout'));
  check('lancer : « Tout arrêter » en cours attendu avant la sonde', /async function demarrerTout[\s\S]*if \(arretEnCours\(lireMarque\(ARRET\), Date\.now\(\), vivant\)\) \{[\s\S]*await attendre\(async \(\) => !arretEnCours\(lireMarque\(ARRET\), Date\.now\(\), vivant\), ARRET_MAX_MS, 500\);[\s\S]*const sondes =/.test(main));
  const iReaction = main.indexOf('const reaction = fin.then((code) => finOutil(l.outil, code, estPret));');
  check('superviseur : fin d\'un outil vue aussitôt, avant que les autres soient prêts', iReaction > 0 && iReaction < main.indexOf('await Promise.all(pret.values());') && main.includes('await Promise.all(enCours.map((e) => e.reaction));'));
  check('superviseur : bouton du Studio lu dans son journal, marque d\'arrêt posée avant l\'arrêt', /const parBouton = quitteParBouton\(journal, process\.pid\);/.test(main) && /fs\.writeFileSync\(ARRET, JSON\.stringify\(\{ pid: process\.pid, debut: Date\.now\(\) \}\)\);\s*if \(!lancerArret\(VBS\)\) fs\.rmSync\(ARRET/.test(main));
}

finish('lanceur');
