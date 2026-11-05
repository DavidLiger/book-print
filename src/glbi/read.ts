// src/glbi/read.ts — lecture seule de GLBInterpreter (spec §3.6, MP-7). Aucune fonction d'écriture dans ce module.
// Fichiers lus : books/<dossier>/book.json, out/book.json, out/scenes/<id>.json, dist/qr/<bookId>/ (liste et urls.txt).
// Une erreur interdit de créer le dossier du livre ; une alerte s'affiche sans bloquer.
import fs from 'node:fs';
import { z } from 'zod';
import { bookIdSchema, glbiIdSchema, langSchema, LANGS } from '../schema/common';
import { nativeRealpath, PathMissing, PathRefused, resolveUnder, type Realpath } from './paths';

const text = z.string().trim().min(1);
const localized = z.looseObject({ fr: text, en: text, es: text });
export type Localized = { fr: string; en: string; es: string };

const sourceBookSchema = z.looseObject({
  bookId: bookIdSchema,
  title: localized,
  languages: z.array(langSchema).min(1),
  scenes: z.array(glbiIdSchema).min(1, 'au moins une scène'),
  origin: z.string().regex(/^https:\/\/[^/\s]+(\/[^\s]*[^/\s])?$/, 'adresse https sans / final attendue'),
  game: z.unknown().optional(),
});

const builtBookSchema = z.looseObject({
  bookId: z.string(),
  scenes: z.array(z.string()).optional(),
  fixture: z.unknown().optional(),
});

const creditSchema = z.looseObject({
  name: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  url: z.string().optional(),
});

const builtSceneSchema = z.looseObject({
  scene: z.looseObject({ id: z.string(), name: localized }),
  build: z.looseObject({ modelCredits: z.array(creditSchema) }),
});

export type ModelCredit = z.infer<typeof creditSchema>;

export interface SceneReading {
  rank: number;
  id: string;
  /** `scene.name` de `out/scenes/<id>.json`, `null` si le fichier est refusé. */
  title: Localized | null;
  modelCredits: ModelCredit[];
  qr: { file: string; url: string } | null;
}

export interface BookReading {
  dir: string;
  bookId: string | null;
  title: Localized | null;
  origin: string | null;
  languages: string[];
  scenes: SceneReading[];
  gameQr: { file: string; url: string } | null;
  errors: string[];
  alerts: string[];
}

export interface BookEntry {
  dir: string;
  bookId: string | null;
  /** Ce livre est celui de `out/book.json`, le dernier construit. */
  built: boolean;
  error: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');

function readJson(root: string, rel: string, realpath: Realpath): unknown {
  const real = resolveUnder(root, rel, realpath);
  try {
    return JSON.parse(fs.readFileSync(real, 'utf8'));
  } catch (e) {
    throw new Error(`${rel} illisible : ${message(e)}`);
  }
}

function readParsed<T>(root: string, rel: string, schema: z.ZodType<T>, realpath: Realpath): T {
  const parsed = schema.safeParse(readJson(root, rel, realpath));
  if (!parsed.success) throw new Error(`${rel} : ${issues(parsed.error)}`);
  return parsed.data;
}

/** Un dossier de livre est un seul segment : `dir` vient de la page. */
const bookRel = (dir: string) => {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(dir)) throw new PathRefused(`dossier de livre refusé : ${dir}`);
  return `books/${dir}/book.json`;
};

/** Livres de `books/*` portant un `book.json` ; un dossier sans ce fichier n'est pas un livre. */
export function listBooks(root: string, realpath: Realpath = nativeRealpath): BookEntry[] {
  let builtId: string | null = null;
  try {
    const built = readParsed(root, 'out/book.json', builtBookSchema, realpath);
    if (built.fixture !== true) builtId = built.bookId;
  } catch {
    // out/ absent ou refusé : la lecture du livre le dira.
  }
  const booksDir = resolveUnder(root, 'books', realpath);
  const entries: BookEntry[] = [];
  for (const d of fs.readdirSync(booksDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    try {
      const book = readParsed(root, bookRel(d.name), sourceBookSchema, realpath);
      entries.push({ dir: d.name, bookId: book.bookId, built: book.bookId === builtId, error: null });
    } catch (e) {
      if (e instanceof PathMissing) continue;
      entries.push({ dir: d.name, bookId: null, built: false, error: message(e) });
    }
  }
  return entries;
}

function parseUrls(content: string, errors: string[]): Map<string, string> {
  const urls = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [file, url, ...rest] = line.split('\t');
    if (!url || rest.length > 0 || /[/\\]/.test(file)) {
      errors.push(`urls.txt : ligne invalide « ${line} »`);
      continue;
    }
    if (urls.has(file)) errors.push(`urls.txt : ${file} en double`);
    urls.set(file, url.trim());
  }
  return urls;
}

/** Contrôle de l'URL d'un QR : sous `origin` (avec son `/`, pour refuser `<origin>.autre.fr`), puis égale à l'attendue. */
function checkUrl(file: string, url: string | undefined, expected: string, origin: string, errors: string[]): string | null {
  if (url === undefined) {
    errors.push(`${file} absent de urls.txt`);
    return null;
  }
  if (!url.startsWith(`${origin}/`)) {
    errors.push(`${file} : URL hors de origin (${url})`);
    return null;
  }
  if (url !== expected) {
    errors.push(`${file} : URL ${url}, attendu ${expected}`);
    return null;
  }
  return url;
}

function readQrs(root: string, reading: BookReading, source: z.infer<typeof sourceBookSchema>, realpath: Realpath): void {
  const { errors, alerts } = reading;
  const qrRel = `dist/qr/${source.bookId}`;
  let files: string[];
  let urls: Map<string, string>;
  try {
    files = fs.readdirSync(resolveUnder(root, qrRel, realpath)).sort();
    urls = parseUrls(fs.readFileSync(resolveUnder(root, `${qrRel}/urls.txt`, realpath), 'utf8'), errors);
  } catch (e) {
    errors.push(`QR illisibles (${qrRel}) : ${message(e)}`);
    return;
  }

  const expectedByScene = new Map(source.scenes.map((id, i) => [id, `${String(i + 1).padStart(2, '0')}-${id}.svg`]));
  for (const f of [...files, ...urls.keys()]) {
    try {
      if (files.includes(f)) resolveUnder(root, `${qrRel}/${f}`, realpath);
      else errors.push(`urls.txt cite ${f}, fichier absent`);
    } catch (e) {
      errors.push(message(e));
    }
  }

  for (const scene of reading.scenes) {
    const expected = expectedByScene.get(scene.id)!;
    if (!files.includes(expected)) {
      errors.push(`scène « ${scene.id} » sans QR : ${expected} attendu`);
      continue;
    }
    const url = checkUrl(expected, urls.get(expected), `${source.origin}/s/${scene.id}`, source.origin, errors);
    if (url) scene.qr = { file: expected, url };
  }

  const hasGame = source.game !== undefined;
  for (const f of files) {
    if (f === 'urls.txt' || [...expectedByScene.values()].includes(f)) continue;
    if (f === 'jeu.svg') {
      if (!hasGame) errors.push('jeu.svg présent alors que le livre n’a pas de jeu');
      continue;
    }
    const m = /^(\d+)-(.+)\.svg$/.exec(f);
    if (m && expectedByScene.has(m[2])) errors.push(`${f} : mauvais rang, ${expectedByScene.get(m[2])} attendu`);
    else if (f.toLowerCase().endsWith('.svg')) errors.push(`QR sans scène : ${f}`);
    else alerts.push(`fichier inattendu dans ${qrRel} : ${f}`);
  }
  if (hasGame) {
    if (!files.includes('jeu.svg')) errors.push('livre avec jeu sans QR : jeu.svg attendu');
    else {
      const url = checkUrl('jeu.svg', urls.get('jeu.svg'), `${source.origin}/jeu`, source.origin, errors);
      if (url) reading.gameQr = { file: 'jeu.svg', url };
    }
  }
}

/** Lit le livre `books/<dir>/` et sa sortie de build. Ne lève pas pour une règle : elle va dans `errors`. */
export function readBook(root: string, dir: string, realpath: Realpath = nativeRealpath): BookReading {
  const reading: BookReading = { dir, bookId: null, title: null, origin: null, languages: [], scenes: [], gameQr: null, errors: [], alerts: [] };
  const { errors, alerts } = reading;

  let source: z.infer<typeof sourceBookSchema>;
  let sourceRel: string;
  try {
    sourceRel = bookRel(dir);
    source = readParsed(root, sourceRel, sourceBookSchema, realpath);
  } catch (e) {
    errors.push(message(e));
    return reading;
  }
  const dup = source.scenes.find((s, i) => source.scenes.indexOf(s) !== i);
  if (dup) errors.push(`scène en double dans book.json : ${dup}`);
  const missingLang = LANGS.filter((l) => !source.languages.includes(l));
  if (missingLang.length) alerts.push(`langues absentes de book.json : ${missingLang.join(', ')}`);

  reading.bookId = source.bookId;
  reading.title = source.title as Localized;
  reading.origin = source.origin;
  reading.languages = source.languages;

  try {
    const built = readParsed(root, 'out/book.json', builtBookSchema, realpath);
    if (built.fixture === true) errors.push('out/book.json est une cartouche de test (fixture: true)');
    if (built.bookId !== source.bookId) errors.push(`out/book.json porte le livre « ${built.bookId} », pas « ${source.bookId} » : construire ce livre`);
    if (built.scenes && built.scenes.join() !== source.scenes.join()) alerts.push('scènes différentes entre book.json et out/book.json : reconstruire le livre');
    const sourceTime = fs.statSync(resolveUnder(root, sourceRel, realpath)).mtimeMs;
    const builtTime = fs.statSync(resolveUnder(root, 'out/book.json', realpath)).mtimeMs;
    if (sourceTime > builtTime) alerts.push('book.json est plus récent que le dernier build');
  } catch (e) {
    errors.push(e instanceof PathMissing ? 'out/book.json absent : construire le livre' : message(e));
  }

  source.scenes.forEach((id, i) => {
    const scene: SceneReading = { rank: i + 1, id, title: null, modelCredits: [], qr: null };
    reading.scenes.push(scene);
    try {
      const built = readParsed(root, `out/scenes/${id}.json`, builtSceneSchema, realpath);
      if (built.scene.id !== id) errors.push(`out/scenes/${id}.json porte la scène « ${built.scene.id} »`);
      scene.title = built.scene.name as Localized;
      scene.modelCredits = built.build.modelCredits;
    } catch (e) {
      errors.push(message(e));
    }
  });
  const noCredit = reading.scenes.filter((s) => s.title && s.modelCredits.length === 0).map((s) => s.id);
  if (noCredit.length) alerts.push(`scènes sans crédit de modèle : ${noCredit.join(', ')}`);

  readQrs(root, reading, source, realpath);
  return reading;
}
