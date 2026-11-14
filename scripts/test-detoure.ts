// scripts/test-detoure.ts — détouré généré (ED5) : recadrage de ComfyUI, aplatissement sur gris, alpha à la taille de sortie, trous du contour,
// Mist sans dégradé, fichier de contour. Fixtures synthétiques, aucun ComfyUI.
import sharp from 'sharp';
import { alphaForOutput, centerCrop, flattenOnGray, mistLevels, pyRound, renderAlphaFault } from '../src/comfy/detoure';
import { contourFile, contourFileSchema } from '../src/data/contour-file';
import { contourOf, outlineIn } from '../src/images/contour';
import { makePng } from './fixtures/make-png';
import { check, finish } from './test-lib';

check('pyRound : arrondi au pair', pyRound(0.5) === 0 && pyRound(1.5) === 2 && pyRound(2.5) === 2 && pyRound(3.2) === 3 && pyRound(3.7) === 4);
check('recadrage : même rapport, rien rogné', JSON.stringify(centerCrop({ width: 200, height: 100 }, { width: 100, height: 50 })) === JSON.stringify({ x: 0, y: 0, width: 200, height: 100 }));
check('recadrage : source trop large, rogné à gauche et à droite', JSON.stringify(centerCrop({ width: 200, height: 100 }, { width: 100, height: 100 })) === JSON.stringify({ x: 50, y: 0, width: 100, height: 100 }));
check('recadrage : source trop haute, rogné en haut et en bas', JSON.stringify(centerCrop({ width: 100, height: 200 }, { width: 100, height: 100 })) === JSON.stringify({ x: 0, y: 50, width: 100, height: 100 }));
check('recadrage : 2 × 832 × 1216 vers 815 × 1087 (libre 60 × 80 mm)', JSON.stringify(centerCrop({ width: 1664, height: 2432 }, { width: 815, height: 1087 })) === JSON.stringify({ x: 0, y: 106, width: 1664, height: 2220 }));

// Aplatissement sur gris : la partie transparente prend le gris, l'opaque garde sa couleur.
{
  const rgba = makePng(16, 12, 4, (x) => (x < 8 ? [255, 0, 0, 0] : [0, 0, 255, 255]));
  const flat = await flattenOnGray(rgba, 128);
  const meta = await sharp(flat).metadata();
  const px = async (x: number) => [...(await sharp(flat).extract({ left: x, top: 5, width: 1, height: 1 }).raw().toBuffer())];
  check('aplati : RVB sans alpha, même taille', meta.channels === 3 && meta.width === 16 && meta.height === 12, meta);
  check('aplati : transparent devenu gris 128', JSON.stringify(await px(2)) === JSON.stringify([128, 128, 128]), await px(2));
  check('aplati : opaque inchangé', JSON.stringify(await px(12)) === JSON.stringify([0, 0, 255]), await px(12));
  const black = await flattenOnGray(rgba, 0);
  check('aplati : gris réglable (0)', [...(await sharp(black).extract({ left: 2, top: 5, width: 1, height: 1 }).raw().toBuffer())].join() === '0,0,0');
}

// Alpha à la taille de sortie
{
  const rgba = makePng(16, 12, 4, (x) => [10, 10, 10, x < 8 ? 0 : 255]);
  const alpha = await alphaForOutput(rgba, { width: 16, height: 12 }, { width: 20, height: 15 });
  check('alpha : une valeur par pixel de sortie', alpha.length === 20 * 15, alpha.length);
  check('alpha : moitié gauche transparente, droite opaque', alpha[5 * 20 + 2] === 0 && alpha[5 * 20 + 17] === 255, [alpha[5 * 20 + 2], alpha[5 * 20 + 17]]);
  const cropped = await alphaForOutput(rgba, { width: 16, height: 12 }, { width: 16, height: 6 });
  check('alpha : recadrée au rapport de la sortie', cropped.length === 16 * 6, cropped.length);
  let refused = false;
  try {
    await alphaForOutput(rgba, { width: 32, height: 24 }, { width: 20, height: 15 });
  } catch {
    refused = true;
  }
  check('alpha : rendu d\'une autre taille refusé', refused);
}

// Refus du rendu : mêmes que le dépôt d'un détouré
{
  check('rendu : RVB sans alpha refusé', (await renderAlphaFault(makePng(8, 8, 3, () => [1, 2, 3])))?.includes('sans transparence') === true);
  check('rendu : opaque partout refusé', (await renderAlphaFault(makePng(8, 8, 4, () => [1, 2, 3, 255])))?.includes('opaque partout') === true);
  check('rendu : transparent partout refusé', (await renderAlphaFault(makePng(8, 8, 4, () => [1, 2, 3, 0])))?.includes('transparent partout') === true);
  check('rendu : mi-transparent accepté', (await renderAlphaFault(makePng(8, 8, 4, (x) => [1, 2, 3, x < 4 ? 0 : 255]))) === null);
}

// Mist : niveaux distincts
{
  check('Mist : 2 niveaux seulement', (await mistLevels(makePng(32, 32, 3, (x) => (x < 16 ? [0, 0, 0] : [255, 255, 255])))) === 2);
  check('Mist : dégradé complet', (await mistLevels(makePng(256, 4, 3, (x) => [x, x, x]))) === 256);
}

// Trous du contour : seuil 0,5 % de l'image, trous cernés seulement
{
  const W = 100;
  const H = 100;
  const make = (inHole: (x: number, y: number) => boolean) => {
    const a = new Uint8Array(W * H);
    for (let y = 10; y < 90; y++) for (let x = 10; x < 90; x++) a[y * W + x] = inHole(x, y) ? 0 : 255;
    return a;
  };
  const big = contourOf(make((x, y) => x >= 40 && x < 60 && y >= 40 && y < 60), W, H);
  check('trous : un trou de 4 % est gardé', big.trous.length === 1 && big.trous[0]!.length >= 4, big.trous.length);
  check('trous : contour extérieur inchangé', big.points.length >= 4);
  const small = contourOf(make((x, y) => x >= 40 && x < 42 && y >= 40 && y < 42), W, H);
  check('trous : un trou de 0,04 % est comblé', small.trous.length === 0, small.trous.length);
  const open = contourOf(make((x, y) => x >= 40 && x < 60 && y >= 10 && y < 50), W, H);
  check('trous : une échancrure ouverte n\'est pas un trou', open.trous.length === 0, open.trous.length);
  const none = contourOf(make(() => false), W, H);
  check('trous : aucun trou, liste vide', none.trous.length === 0);
  const o = outlineIn({ left: 0, top: 0, right: 100, bottom: 100 }, big);
  check('outline : trous en pourcentage de l\'image', o.trous?.length === 1 && o.trous[0]!.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 100));
  check('outline : sans trou, pas de champ', outlineIn({ left: 0, top: 0, right: 100, bottom: 100 }, none).trous === undefined);
  const png = Buffer.from('x');
  const file = contourFile(big, png);
  check('fichier de contour : trous écrits', file.trous.length === 1);
  const { trous: _ignored, ...old } = contourFile(none, png);
  check('fichier de contour d\'ED2 (sans trous) : lu, aucun trou', contourFileSchema.parse(old).trous.length === 0);
}

finish('detoure');
