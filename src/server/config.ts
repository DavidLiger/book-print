// src/server/config.ts — `config.local.json` (MP-7, architecture §2), validé par zod. Relu à chaque état de la page :
// une correction se voit en rechargeant, sans relancer l'outil.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import '../schema/common';
import { isInside } from '../glbi/paths';

const rootSchema = z
  .string({ error: 'chemin attendu' })
  .min(1, 'chemin vide')
  .refine((p) => path.isAbsolute(p), 'chemin absolu attendu, par exemple D:/GLBInterpreter/glbinterpreter');

/** `comfyLauncher` (IC1) : le .bat qui lance ComfyUI, contrôlé à l'usage (`src/comfy/launcher.ts`). Adresse de ComfyUI (IC1), facultative : sans elle, `http://127.0.0.1:8188`. Elle n'est contrôlée qu'à l'usage (`src/comfy/address.ts`) :
 * une adresse refusée se voit dans l'étape Workflows et dans la vue Générer, sans bloquer le reste de l'outil. */
const configSchema = z.strictObject({ glbRoot: rootSchema, dataRoot: rootSchema, comfyUrl: z.string({ error: 'comfyUrl : texte attendu' }).optional(), comfyLauncher: z.string({ error: 'comfyLauncher : texte attendu' }).optional() });
export type Config = z.infer<typeof configSchema>;

export type ConfigState = { ok: true; config: Config } | { ok: false; message: string };

/** Racine du repo public book-print : le contenu réel n'y arrive jamais. */
const TOOL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

export function loadConfig(file: string): ConfigState {
  const fail = (message: string): ConfigState => ({ ok: false, message });
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fail(`Fichier absent : ${file}. Copier config.example.json sous le nom config.local.json, renseigner glbRoot et dataRoot, puis recharger la page.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return fail(`config.local.json n'est pas un JSON valide : ${(e as Error).message}. Corriger le fichier, puis recharger la page.`);
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
    return fail(`config.local.json : ${detail}. Corriger le fichier, puis recharger la page.`);
  }
  const { glbRoot, dataRoot } = parsed.data;
  if (!isDir(glbRoot)) return fail(`glbRoot n'existe pas : ${glbRoot}. Corriger config.local.json avec le chemin du repo GLBInterpreter, puis recharger la page.`);
  if (!isDir(path.join(glbRoot, 'books'))) return fail(`glbRoot ne contient pas de dossier books/ : ${glbRoot}. Vérifier que c'est bien le repo GLBInterpreter.`);
  if (!isDir(dataRoot)) return fail(`dataRoot n'existe pas : ${dataRoot}. Cloner le repo privé book-print-data, ou corriger config.local.json, puis recharger la page.`);
  const glbReal = fs.realpathSync.native(glbRoot);
  const dataReal = fs.realpathSync.native(dataRoot);
  if (isInside(glbReal, dataReal) || isInside(dataReal, glbReal)) {
    return fail('glbRoot et dataRoot ne doivent pas être l\'un dans l\'autre : rien ne doit être écrit dans GLBInterpreter. Corriger config.local.json, puis recharger la page.');
  }
  const toolReal = fs.realpathSync.native(TOOL_ROOT);
  if (isInside(toolReal, dataReal) || isInside(dataReal, toolReal)) {
    return fail('dataRoot et le repo book-print ne doivent pas être l\'un dans l\'autre : aucun contenu réel dans un repo public. Corriger config.local.json, puis recharger la page.');
  }
  return { ok: true, config: parsed.data };
}
