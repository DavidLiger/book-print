// src/research/prompt.ts — prompt de recherche généré (spec §5.2, étape 3 ; §24.9, ED4). Modèle générique : aucun sujet ni texte du livre dans
// le repo. Tout ce qui est propre au sujet vient des données ; la liste des blocs vient de la mise en page, dans son ordre, chacun avec sa sorte
// de paragraphe, sa consigne (`kinds.ts`), ses longueurs et la consigne de David pour une légende ou une étiquette ; le schéma vient de zod.
import { MAX_CLAIM_CHARS, MAX_SUPPORT_CHARS } from '../schema/claim';
import { RESEARCH_SCHEMA_VERSION, researchJsonSchema } from '../schema/research';
import type { ExpectedBlock } from './blocks';
import { KIND_RULES } from './kinds';

/** Public du livre (MP-13). */
export const AGE_TARGET = '7 à 10 ans';
const LANG_NAMES = { fr: 'français', en: 'anglais', es: 'espagnol' } as const;

export interface PromptInput {
  subjectId: string;
  subjectTitle: string;
  bookTitle: string;
  lang: 'fr' | 'en' | 'es';
  templateId: string;
  pages: number;
  blocks: ExpectedBlock[];
  /** Jour de la génération, pour `accessed` et `generatedAt`. */
  today: string;
}

/** Un bloc à rédiger : où il va dans le JSON, sa sorte, ce qu'il doit être, ses longueurs, son en-tête et la consigne de David. */
export function blockLine(b: ExpectedBlock): string {
  const rule = KIND_RULES[b.kind];
  const where = [`"zone": "${b.zone}"`, `"type": "${b.type}"`, ...(b.item ? [`"item": "${b.item}"`] : []), ...(b.paragraphe ? [`"paragraphe": "${b.paragraphe}"`] : [])].join(', ');
  const what = b.type === 'fiche' ? `information de fiche « ${b.label} » (une valeur courte)` : rule.text === null ? rule.name : `${rule.name} : ${rule.text}`;
  const lines = [`- ${where} : ${what}${b.maxChars === null ? '' : `, ${b.maxChars} caractères au plus`}`];
  if (b.heading) lines.push(`  "heading" : ${rule.heading ?? 'un en-tête'}, ${b.heading.maxChars} caractères au plus.`);
  else if (b.fixedHeading !== undefined) lines.push(`  En-tête déjà imprimé : « ${b.fixedHeading} ». Pas de "heading".`);
  if (b.consigne !== undefined) lines.push(`  Ce que montre l'image (consigne de l'éditeur) : ${b.consigne}`);
  return lines.join('\n');
}

export function researchPrompt(p: PromptInput): string {
  return `Tu prépares le contenu d'un sujet de ${p.pages} pages d'un livre documentaire imprimé pour enfants de ${AGE_TARGET}.

Livre : ${p.bookTitle}
Sujet : ${p.subjectTitle}
Identifiant du sujet (subjectId) : ${p.subjectId}
Langue du texte (lang) : ${p.lang} (${LANG_NAMES[p.lang]})
Gabarit : ${p.templateId}
Date du jour : ${p.today}

Travail demandé
1. Fais une recherche web sur le sujet, avec des sources fiables : institutions, musées, universités, publications scientifiques, encyclopédies reconnues.
2. Écris des affirmations courtes et vérifiables, ${MAX_CLAIM_CHARS} caractères au plus chacune. Chacune porte sur un seul fait.
3. Rédige ensuite le texte de chaque bloc pour un enfant de ${AGE_TARGET} : phrases courtes, mots simples, un mot difficile est expliqué. Le texte ne contient aucun fait absent des affirmations qu'il cite.

Règles
- Une source au moins par affirmation. Chaque source doit être une page que tu as réellement consultée.
- "support" est une paraphrase du passage qui appuie l'affirmation, ${MAX_SUPPORT_CHARS} caractères au plus. Aucune citation longue.
- N'invente ni URL, ni titre, ni date. Si une date de publication est inconnue, omets "published".
- "accessed" et "generatedAt" valent ${p.today}.
- "confidence" vaut "forte", ou "debattue" pour un fait discuté entre spécialistes ou mal établi. Signale tout fait débattu, et dis-le aussi dans le texte du bloc (« on pense que… »).
- Chaque bloc cite dans "claims" les identifiants de toutes les affirmations sur lesquelles il repose, au moins une.
- Respecte strictement les longueurs : elles viennent de la place réelle dans la page.
- Le titre et la légende du QR ne sont pas à rédiger.

Blocs à rédiger, exactement ceux-ci, un de chaque, dans l'ordre de la page
Chaque bloc suit la consigne de sa sorte. Un bloc a un "heading" seulement si la ligne le demande : l'en-tête repose sur les affirmations citées par le bloc, sans fait de plus. Un bloc "paragraphe" porte, en plus de "zone" (la chaîne), le champ "paragraphe" ; aucun autre bloc ne le porte.
${p.blocks.map(blockLine).join('\n')}

Format du résultat
Produis un seul fichier JSON nommé research.json, sans commentaire ni texte autour, conforme à ce schéma. "schemaVersion" vaut ${RESEARCH_SCHEMA_VERSION}.

${JSON.stringify(researchJsonSchema(), null, 2)}
`;
}
