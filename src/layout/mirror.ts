// src/layout/mirror.ts — action « Miroir » de l'éditeur (ED3, spec §24.12), pour une mise en page modèle. Pure. Sur chaque page, `x` devient
// largeur rognée − `x` − `w` (sur deux largeurs pour un élément à cheval) ; le point d'une flèche d'étiquette aussi ; `exterieur` reste
// `exterieur` (le bord extérieur change de côté avec la page) ; `start` change de côté ; l'habillage d'un détouré aussi (`gauche` ↔
// `droite`, décision de David). Le résultat passe par le schéma : une mise en page
// que le miroir rendrait invalide (un élément à cheval qui tomberait sur une page droite) est refusée avec le motif du schéma.
import { MM_PER_IN } from '../templates/geometry';
import { layoutSchema, type Layout } from './schema';

/** Millionième de mm, comme la conversion de la version 1 : pas de bruit de virgule flottante dans le fichier. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** La mise en page retournée, non validée. */
export function mirrored(layout: Layout): Layout {
  const W = layout.trim.widthIn * MM_PER_IN;
  return {
    ...structuredClone(layout),
    start: layout.start === 'gauche' ? 'droite' : 'gauche',
    elements: layout.elements.map((e) => {
      const span = e.double ? 2 * W : W;
      const out = { ...structuredClone(e), x: round(span - e.x - e.w) };
      if (e.fleche) out.fleche = { x: round(W - e.fleche.x), y: e.fleche.y };
      // L'image change de côté : le texte qui passait à sa droite passe à sa gauche (décision de David, ED3) ; `aucun` reste `aucun`.
      if (e.habillage === 'gauche') out.habillage = 'droite';
      else if (e.habillage === 'droite') out.habillage = 'gauche';
      return out;
    }),
  };
}

/** « Miroir » : la mise en page retournée, validée ; `issues` porte le motif du schéma quand elle ne l'est pas. */
export function mirrorLayout(layout: Layout): { layout: Layout } | { issues: string } {
  const parsed = layoutSchema.safeParse(mirrored(layout));
  if (parsed.success) return { layout: parsed.data };
  return { issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ') };
}
