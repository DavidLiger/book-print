// scripts/fixtures/recherche.ts — fichier de recherche synthétique : le Fictivore n'existe pas, ses sources non plus. Aucun contenu réel.
import type { ResearchImport } from '../../src/schema/research';

const source = (n: number) => ({
  url: `https://source-${n}.example/page`,
  title: `Page de synthèse ${n}`,
  publisher: 'Éditeur fictif',
  accessed: '2026-11-06',
  support: 'Le passage dit la même chose, avec d\'autres mots.',
});

/** Fichier valide pour le gabarit 2A et la fiche par défaut. */
export function makeResearch(subjectId = 'alpha', lang: ResearchImport['lang'] = 'fr'): ResearchImport {
  return {
    schemaVersion: 1,
    subjectId,
    lang,
    generatedAt: '2026-11-06',
    claims: [
      { id: 'c1', text: 'Le Fictivore vit dans les pages de tests.', sources: [source(1)], confidence: 'forte' },
      { id: 'c2', text: 'Le Fictivore mesure deux mètres.', sources: [source(2)], confidence: 'forte' },
      { id: 'c3', text: 'Le Fictivore mange des baies.', sources: [source(3), source(4)], confidence: 'debattue' },
    ],
    blocks: [
      { zone: 'chapeau', type: 'chapeau', text: 'Voici le Fictivore, un animal inventé qui vit dans les pages de tests.', claims: ['c1'] },
      { zone: 'texte', type: 'texte', text: 'Le Fictivore mesure deux mètres. On pense qu\'il mange surtout des baies, mais personne n\'en est sûr.', claims: ['c2', 'c3'] },
      { zone: 'fiche', type: 'fiche', item: 'taille', text: '2 m', claims: ['c2'] },
      { zone: 'fiche', type: 'fiche', item: 'poids', text: '80 kg', claims: ['c2'] },
      { zone: 'fiche', type: 'fiche', item: 'epoque', text: 'Aujourd\'hui', claims: ['c1'] },
      { zone: 'fiche', type: 'fiche', item: 'regime', text: 'Baies', claims: ['c3'] },
      { zone: 'fiche', type: 'fiche', item: 'lieu', text: 'Pages de tests', claims: ['c1'] },
    ],
  };
}
