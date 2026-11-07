// src/comfy/address.ts — adresse de ComfyUI (IC1, question 1). Seule la boucle locale est admise, en `http`, avec un port : `127.0.0.1` ou `[::1]`.
// `localhost` est refusé, parce que ce nom peut se résoudre ailleurs. Aucun chemin, identifiant, paramètre ni fragment : l'outil ajoute lui-même
// les seules routes qu'il appelle (§13.5).

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

export type ComfyAddress = { ok: true; origin: string } | { ok: false; message: string };

export function parseComfyUrl(value: string | undefined): ComfyAddress {
  const raw = value ?? DEFAULT_COMFY_URL;
  const refuse = (why: string): ComfyAddress => ({ ok: false, message: `comfyUrl refusé (${raw}) : ${why}. Corriger config.local.json, par exemple ${DEFAULT_COMFY_URL}.` });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('adresse illisible');
  }
  if (url.protocol !== 'http:') return refuse('http:// attendu');
  if (!LOOPBACK.has(url.hostname)) return refuse('seule la boucle locale est admise, 127.0.0.1 ou [::1]');
  if (url.username || url.password) return refuse('identifiant interdit');
  // `URL` efface le port 80, qui est celui de `http` : il est relu dans le texte.
  const port = url.port || (/^http:\/\/(127\.0\.0\.1|\[::1\]):80\/?$/.test(raw) ? '80' : '');
  if (port === '') return refuse('port attendu');
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) return refuse('paramètre interdit');
  if (url.pathname !== '/') return refuse('chemin interdit');
  return { ok: true, origin: `http://${url.hostname}:${port}` };
}
