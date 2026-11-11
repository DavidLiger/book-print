// src/research/kinds.ts — consignes de rédaction par sorte de paragraphe (spec §24.9, ED4). Ce que le prompt demande pour chaque bloc, en plus
// des règles générales (une affirmation par fait, sources, paraphrase, enfants de 7 à 10 ans). Modèle générique : aucun sujet du livre ici.

/** Sorte de paragraphe d'un bloc attendu : le type du bloc, et pour un encadré sa sorte (capsule ou question). */
export const KINDS = ['chapeau', 'texte', 'paragraphe', 'capsule', 'question', 'legende', 'etiquette', 'chiffre-cle', 'fiche'] as const;
export type Kind = (typeof KINDS)[number];

export interface KindRule {
  /** Nom de la sorte dans le prompt. */
  name: string;
  /** Ce que le texte du bloc doit être ; `null` : aucune consigne propre (texte seul et fiche, inchangés). */
  text: string | null;
  /** Ce que l'en-tête doit être, quand la mise en page en demande un écrit. */
  heading: string | null;
}

export const KIND_RULES: Record<Kind, KindRule> = {
  chapeau: { name: 'chapô', text: 'une ou deux phrases qui disent l\'essentiel du sujet et donnent envie de lire', heading: null },
  texte: { name: 'texte', text: null, heading: null },
  paragraphe: { name: 'paragraphe', text: 'un seul aspect du sujet', heading: 'un intertitre de 2 à 5 mots qui annonce ce que contient le paragraphe' },
  capsule: { name: 'capsule', text: 'un fait étonnant ou une petite activité', heading: 'un titre court' },
  question: { name: 'question', text: 'la réponse, expliquée simplement', heading: 'une question « Pourquoi… ? » qu\'un enfant se pose sur le sujet' },
  legende: { name: 'légende', text: 'une phrase qui dit ce que montre l\'image, d\'après la consigne', heading: null },
  etiquette: { name: 'étiquette', text: 'un ou deux mots : le nom de ce qui est montré', heading: null },
  'chiffre-cle': { name: 'chiffre-clé', text: 'un nombre et son unité, puis quelques mots', heading: null },
  fiche: { name: 'information de fiche', text: null, heading: null },
};
