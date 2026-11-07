// src/comfy/prompt.ts — alerte sur les couleurs du prompt (spec §13.2) : les couleurs viennent des textures de la scène, jamais du prompt.
// Une liste de noms courants, en anglais (langue des prompts) et en français. C'est une alerte : le prompt reste celui de David.

const COLOR_WORDS = [
  'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'violet', 'pink', 'brown', 'black', 'white', 'grey', 'gray', 'gold', 'golden', 'silver',
  'crimson', 'scarlet', 'beige', 'turquoise', 'cyan', 'magenta', 'teal', 'emerald', 'amber', 'ochre', 'tan',
  'rouge', 'rouges', 'vert', 'verte', 'verts', 'vertes', 'bleu', 'bleue', 'bleus', 'bleues', 'jaune', 'jaunes', 'rose', 'roses', 'marron', 'brun', 'brune',
  'noir', 'noire', 'noirs', 'noires', 'blanc', 'blanche', 'blancs', 'blanches', 'gris', 'grise', 'doré', 'dorée', 'argenté', 'argentée', 'ocre', 'pourpre',
];

/** Noms de couleur trouvés, sans doublon, dans l'ordre du prompt. */
export function colorWords(prompt: string): string[] {
  const words = prompt.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  return [...new Set(words.filter((w) => COLOR_WORDS.includes(w)))];
}
