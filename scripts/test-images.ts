// scripts/test-images.ts — nettoyage des PNG et cadrage (spec §5.2, étape 6). Fixtures synthétiques : les PNG sont fabriqués ici ou par sharp.
// L'absence de métadonnées se prouve en relisant les fragments du fichier, pas en se fiant à sharp.
import zlib from 'node:zlib';
import sharp from 'sharp';
import { cleanPng, ImageRefused, MAX_INPUT_PIXELS } from '../src/images/clean';
import { effectivePpi, placement, targetPixels, visibleCrop } from '../src/images/crop';
import { isPng, keepImageChunks, pngChunks, readPngHeader } from '../src/images/png';
import { pageSize } from '../src/templates/geometry';
import { chunk, makePng, withChunks } from './fixtures/make-png';
import { check, finish } from './test-lib';

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const rgb = makePng(40, 30, 3, (x, y) => [x * 5, y * 5, 100]);
const rgba = makePng(40, 30, 4, (x) => [255, 0, 0, x < 20 ? 0 : 255]);
const pixel = async (png: Buffer, left: number, top: number) => [...(await sharp(png).extract({ left, top, width: 1, height: 1 }).raw().toBuffer())];
const refused = async (name: string, input: Buffer, message: string) => {
  try {
    await cleanPng(input);
    check(name, false, 'accepté');
  } catch (e) {
    check(name, e instanceof ImageRefused && e.message.includes(message), (e as Error).message);
  }
};
const isClean = (name: string, png: Buffer, width: number, height: number) => {
  const h = readPngHeader(png)!;
  check(`${name} : RVB 8 bits sans alpha`, h.bitDepth === 8 && h.colorType === 2, h);
  check(`${name} : dimensions gardées`, h.width === width && h.height === height, h);
  check(`${name} : seulement IHDR, IDAT, IEND`, [...new Set(pngChunks(png))].join() === 'IHDR,IDAT,IEND', pngChunks(png));
};

// Refus
await refused('JPEG refusé', await sharp(rgb).jpeg().toBuffer(), 'pas un PNG');
await refused('WebP renommé refusé', await sharp(rgb).webp().toBuffer(), 'pas un PNG');
await refused('fichier vide refusé', Buffer.alloc(0), 'pas un PNG');
await refused('texte refusé', Buffer.from('ceci n\'est pas une image'), 'pas un PNG');
await refused('signature seule refusée', rgb.subarray(0, 8), 'en-tête invalide');
await refused('PNG tronqué refusé', rgb.subarray(0, 60), 'illisible');
{
  const bomb = Buffer.from(rgb);
  bomb.writeUInt32BE(50_000, 16);
  bomb.writeUInt32BE(50_000, 20);
  await refused('image piégée, pixels trop nombreux, refusée à l’en-tête', bomb, 'trop grande');
  const justOver = Buffer.from(rgb);
  justOver.writeUInt32BE(MAX_INPUT_PIXELS + 1, 16);
  justOver.writeUInt32BE(1, 20);
  await refused('un pixel de trop : refusée', justOver, 'trop grande');
  const zero = Buffer.from(rgb);
  zero.writeUInt32BE(0, 16);
  await refused('largeur nulle refusée', zero, 'en-tête invalide');
}

// Tous les modes en entrée
{
  const clean = await cleanPng(rgb);
  isClean('RVB', clean.png, 40, 30);
  check('RVB : couleurs gardées', (await pixel(clean.png, 39, 29)).join() === `${39 * 5},${29 * 5},100`);
  check('dimensions rendues', clean.width === 40 && clean.height === 30);
}
{
  const { png } = await cleanPng(rgba);
  isClean('RVBA', png, 40, 30);
  check('RVBA : transparence aplatie sur blanc', (await pixel(png, 0, 0)).join() === '255,255,255');
  check('RVBA : opaque inchangé', (await pixel(png, 39, 0)).join() === '255,0,0');
}
{
  const half = makePng(4, 4, 4, () => [0, 0, 0, 128]);
  const { png } = await cleanPng(half);
  const [r] = await pixel(png, 0, 0);
  check('RVBA demi-transparent : mélangé au blanc', r! > 120 && r! < 135, r);
}
{
  const { png } = await cleanPng(await sharp(rgb).toColourspace('rgb16').png().toBuffer());
  isClean('16 bits', png, 40, 30);
  const [r, g, b] = await pixel(png, 39, 29);
  check('16 bits : couleurs proches', Math.abs(r! - 195) <= 1 && Math.abs(g! - 145) <= 1 && Math.abs(b! - 100) <= 1, [r, g, b]);
}
{
  const input = await sharp(rgb).png({ palette: true, colours: 16 }).toBuffer();
  check('fixture palette : bien en mode palette', readPngHeader(input)!.colorType === 3);
  isClean('palette', (await cleanPng(input)).png, 40, 30);
  const withAlpha = await sharp(rgba).png({ palette: true, colours: 8 }).toBuffer();
  check('fixture palette et transparence : tRNS présent', pngChunks(withAlpha).includes('tRNS'));
  const { png } = await cleanPng(withAlpha);
  isClean('palette avec tRNS', png, 40, 30);
  check('palette avec tRNS : aplatie sur blanc', (await pixel(png, 0, 0)).join() === '255,255,255');
}
{
  const gray = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#808080' } }).toColourspace('b-w').png().toBuffer();
  check('fixture niveaux de gris', readPngHeader(gray)!.colorType === 0);
  const { png } = await cleanPng(gray);
  isClean('niveaux de gris', png, 40, 30);
  check('niveaux de gris : trois canaux égaux', new Set(await pixel(png, 0, 0)).size === 1);
  const gray16 = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#808080' } }).toColourspace('grey16').png().toBuffer();
  check('fixture niveaux de gris 16 bits', readPngHeader(gray16)!.bitDepth === 16);
  isClean('niveaux de gris 16 bits', (await cleanPng(gray16)).png, 40, 30);
}

// Métadonnées : ComfyUI range son workflow dans tEXt ; aucune résolution ne reste.
{
  const physical = Buffer.alloc(9);
  physical.writeUInt32BE(11811, 0);
  physical.writeUInt32BE(11811, 4);
  physical[8] = 1;
  const workflow = '{"workflow":{"nodes":[{"prompt":"secret"}]}}';
  const dirty = withChunks(
    rgb,
    chunk('pHYs', physical),
    chunk('tEXt', Buffer.from(`prompt\0${workflow}`, 'latin1')),
    chunk('iTXt', Buffer.from(`workflow\0\0\0\0\0${workflow}`, 'latin1')),
    chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0', 'latin1'), zlib.deflateSync(Buffer.from(workflow))])),
    chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])),
  );
  check('fixture : les fragments sont là avant', ['pHYs', 'tEXt', 'iTXt', 'zTXt', 'gAMA'].every((c) => pngChunks(dirty).includes(c)), pngChunks(dirty));
  const { png } = await cleanPng(dirty);
  isClean('métadonnées', png, 40, 30);
  for (const c of ['tEXt', 'iTXt', 'zTXt', 'pHYs', 'gAMA', 'iCCP', 'eXIf', 'tIME']) check(`fragment ${c} absent`, !pngChunks(png).includes(c));
  check('le workflow ne se retrouve nulle part dans le fichier', !png.includes('workflow') && !png.includes('secret'));
  check('sharp réécrit bien un pHYs : le filtre est utile', pngChunks(await sharp(rgb).png().toBuffer()).includes('pHYs'));
  const iccp = await sharp(rgb).withIccProfile('p3').png().toBuffer();
  check('fixture ICC : iCCP présent', pngChunks(iccp).includes('iCCP'));
  isClean('profil ICC', (await cleanPng(iccp)).png, 40, 30);
}
{
  // Un dégradé se compresse bien mieux avec le filtre adaptatif : la taille du fichier gardé le prouve.
  const gradient = makePng(600, 400, 3, (x, y) => [(x * 255) / 600, (y * 255) / 400, ((x + y) * 255) / 1000]);
  const { png } = await cleanPng(gradient);
  const unfiltered = await sharp(gradient).png({ compressionLevel: 6 }).toBuffer();
  check('compression : filtre adaptatif, fichier plus petit que sans filtre', png.length < unfiltered.length * 0.8, [png.length, unfiltered.length]);
}
check('filtre : un PNG reste lisible par sharp', isPng(keepImageChunks(rgb)) && (await sharp(keepImageChunks(rgb)).metadata()).width === 40);

// Cadrage : le fichier source et le zoom décident, jamais le PDF.
const zone66 = { widthMm: 155.575, heightMm: 234.95 };
const exact = { width: 1838, height: 2775 };
const center = { focusX: 0.5, focusY: 0.5, zoom: 1 };
{
  const crop = visibleCrop(exact, zone66, center);
  check('taille exacte : hauteur entière visible', near(crop.height, 2775) && near(crop.top, 0));
  check('taille exacte : un demi-pixel coupé en largeur', near(crop.width, 1837.5, 0.01) && near(crop.left, 0.25, 0.01), crop);
  check('taille exacte : 300 ppp', effectivePpi(crop, zone66) === 300, effectivePpi(crop, zone66));
  check('zoom 1,01 : 297 ppp', Math.floor(effectivePpi(visibleCrop(exact, zone66, { ...center, zoom: 1.01 }), zone66)) === 297);
  check('zoom 2 : 150 ppp', effectivePpi(visibleCrop(exact, zone66, { ...center, zoom: 2 }), zone66) === 150);
  const big = { width: 3676, height: 5550 };
  check('deux fois plus grand : 600 ppp', effectivePpi(visibleCrop(big, zone66, center), zone66) === 600);
  check('deux fois plus grand, zoom 2 : 300 ppp', effectivePpi(visibleCrop(big, zone66, { ...center, zoom: 2 }), zone66) === 300);
  const left = visibleCrop(exact, zone66, { focusX: 0, focusY: 0.5, zoom: 2 });
  const right = visibleCrop(exact, zone66, { focusX: 1, focusY: 0.5, zoom: 2 });
  check('point focal au bord : l’image ne sort pas du cadre', near(left.left, 0) && near(right.left + right.width, 1838), [left, right]);
  const topLeft = visibleCrop(exact, zone66, { focusX: 0.25, focusY: 0.25, zoom: 2 });
  check('point focal : centre de la partie visible', near(topLeft.left + topLeft.width / 2, 459.5, 0.01) && near(topLeft.top + topLeft.height / 2, 693.75, 0.01), topLeft);
  const wide = { width: 3000, height: 2775 };
  const shifted = visibleCrop(wide, zone66, { focusX: 0, focusY: 0.5, zoom: 1 });
  check('image plus large que la zone : le point focal se déplace à zoom 1', near(shifted.left, 0) && near(visibleCrop(wide, zone66, { focusX: 1, focusY: 0.5, zoom: 1 }).left, 3000 - shifted.width), shifted);
  const tall = visibleCrop({ width: 1838, height: 4000 }, zone66, center);
  check('image plus haute que la zone : la largeur décide', near(tall.width, 1838) && effectivePpi(tall, zone66) > 300 - 0.1, tall);
  const place = placement(exact, zone66, visibleCrop(exact, zone66, { focusX: 0, focusY: 0, zoom: 2 }));
  check('placement : image deux fois plus grande que la zone', near(place.heightMm, 2 * 234.95, 0.01) && near(place.leftMm, 0) && near(place.topMm, 0), place);
}

// Taille cible : calculée, jamais en dur. Tailles de référence : §6.4.
const zoneOf = (widthIn: number, heightIn: number) => {
  const size = pageSize({ widthIn, heightIn });
  return { widthMm: size.widthIn * 25.4, heightMm: size.heightIn * 25.4 };
};
check('6 × 9", page pleine : 1838 × 2775 px', JSON.stringify(targetPixels(zoneOf(6, 9))) === '{"width":1838,"height":2775}', targetPixels(zoneOf(6, 9)));
check('8,5 × 11", page pleine : 2588 × 3375 px', JSON.stringify(targetPixels(zoneOf(8.5, 11))) === '{"width":2588,"height":3375}', targetPixels(zoneOf(8.5, 11)));
check('6 × 9", double page : 3675 × 2775 px', JSON.stringify(targetPixels({ widthMm: 2 * 155.575, heightMm: 234.95 })) === '{"width":3675,"height":2775}');
check('8,5 × 11", double page : 5175 × 3375 px', JSON.stringify(targetPixels({ widthMm: 2 * 219.075, heightMm: 285.75 })) === '{"width":5175,"height":3375}');

finish('images');
