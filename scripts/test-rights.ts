// scripts/test-rights.ts — registre des droits et `credits.json` (spec §3.8, §13.3). Tout est synthétique : auteurs et modèles sont inventés.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { allEntries, addBookEntries, addMissingDefaults, defaultEntries, ensureIllustrationRights, missingDefaults, readBookRights, readCollectionRights, RightsRefused, saveEntry, setIllustrationRights } from '../src/rights/registry';
import { CC_BY_LABEL, CreditsRefused, creditText, importCredits, parseCredits, readLicense, rightsId } from '../src/rights/credits';
import { rightsEntrySchema } from '../src/schema/rights';
import { fileLink, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

const BOOK = 'livre-essai';
const dataRoot = tempDir();
createCollection(dataRoot);
createBookFolder(dataRoot, BOOK);
const commonFile = path.join(dataRoot, 'collection', 'rights.json');
const bookFile = path.join(dataRoot, BOOK, 'rights.json');
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const refused = (name: string, run: () => unknown, message: string) => {
  try {
    run();
    check(name, false, 'accepté');
  } catch (e) {
    check(name, e instanceof RightsRefused && e.message.includes(message), (e as Error).message);
  }
};
const entry = (over: object = {}) => ({ id: 'modele-essai', kind: 'modele-3d', name: 'Modèle d\'essai', author: 'Auteur Fictif', license: 'CC BY 4.0', credit: 'Crédit d\'essai', commercialOk: 'oui', ...over });

// Valeurs par défaut
check('création : le registre commun a tout', missingDefaults(readCollectionRights(dataRoot)).length === 0);
check('valeurs par défaut valides, 11 entrées', defaultEntries().length === 11);

// Compléter un registre créé avant MP4 : ajout sans écrasement
{
  const before = JSON.parse(fs.readFileSync(commonFile, 'utf8'));
  const old = { ...before, entries: before.entries.slice(0, 3) };
  old.entries[0] = { ...old.entries[0], credit: 'Crédit corrigé par David', license: 'SIL OFL 1.1, relue' };
  old.entries.push(entry({ id: 'entree-de-david' }));
  fs.writeFileSync(commonFile, `${JSON.stringify(old, null, 2)}\n`);
  check('registre ancien : 8 entrées manquent', missingDefaults(readCollectionRights(dataRoot)).length === 8);
  const first = addMissingDefaults(dataRoot);
  const after = readCollectionRights(dataRoot);
  check('ajout : les 8 absentes, dans le fichier', first.added.length === 8 && after.entries.length === 12, first);
  check('ajout : l’entrée modifiée par David n’est pas touchée', after.entries[0]!.credit === 'Crédit corrigé par David' && after.entries[0]!.license === 'SIL OFL 1.1, relue');
  check('ajout : l’entrée propre à David reste', after.entries.some((e) => e.id === 'entree-de-david'));
  check('ajout : les entrées d’origine restent en tête, dans l’ordre', after.entries.slice(0, 4).map((e) => e.id).join() === 'andika,baloo-2,pictos-maison,entree-de-david');
  const footprint = hash(commonFile);
  const time = fs.statSync(commonFile).mtimeMs;
  const second = addMissingDefaults(dataRoot);
  check('second ajout : rien', second.added.length === 0);
  check('second ajout : fichier identique, octet pour octet', hash(commonFile) === footprint && fs.statSync(commonFile).mtimeMs === time);
  check('plus rien ne manque', missingDefaults(readCollectionRights(dataRoot)).length === 0);
}

// Ajout et modification d'une entrée
{
  saveEntry(dataRoot, BOOK, 'livre', entry(), 'ajout');
  check('ajout dans le livre', readBookRights(dataRoot, BOOK).entries[0]?.id === 'modele-essai');
  refused('ajout d’un id déjà pris dans le livre', () => saveEntry(dataRoot, BOOK, 'livre', entry(), 'ajout'), 'existe déjà');
  refused('ajout d’un id déjà pris dans le registre commun', () => saveEntry(dataRoot, BOOK, 'livre', entry({ id: 'andika' }), 'ajout'), 'existe déjà');
  refused('ajout dans le commun d’un id du livre', () => saveEntry(dataRoot, BOOK, 'collection', entry(), 'ajout'), 'existe déjà');
  saveEntry(dataRoot, BOOK, 'livre', entry({ commercialOk: 'a-verifier' }), 'modification');
  check('modification', readBookRights(dataRoot, BOOK).entries[0]?.commercialOk === 'a-verifier' && readBookRights(dataRoot, BOOK).entries.length === 1);
  saveEntry(dataRoot, BOOK, 'collection', entry({ id: 'andika', kind: 'police', name: 'Andika', credit: 'Modifié' }), 'modification');
  check('modification dans le commun', readCollectionRights(dataRoot).entries[0]?.credit === 'Modifié');
  refused('modification d’une entrée inconnue', () => saveEntry(dataRoot, BOOK, 'livre', entry({ id: 'fantome' }), 'modification'), 'inconnue');
  refused('modification hors de son registre', () => saveEntry(dataRoot, BOOK, 'livre', entry({ id: 'andika' }), 'modification'), 'inconnue');
  refused('entrée invalide : type inconnu', () => saveEntry(dataRoot, BOOK, 'livre', entry({ id: 'x', kind: 'autre' }), 'ajout'), 'Entrée invalide');
  refused('entrée invalide : nom vide', () => saveEntry(dataRoot, BOOK, 'livre', entry({ id: 'x', name: ' ' }), 'ajout'), 'Entrée invalide');
  check('les deux registres réunis', allEntries(readCollectionRights(dataRoot), readBookRights(dataRoot, BOOK)).has('modele-essai') && allEntries(readCollectionRights(dataRoot), readBookRights(dataRoot, BOOK)).has('andika'));
}

// Écriture sûre
{
  const dir = path.dirname(bookFile);
  check('aucun temporaire laissé', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
  const raw = fs.readFileSync(bookFile, 'utf8');
  check('fichier lisible et terminé par un saut de ligne', raw.endsWith('\n') && JSON.parse(raw).schemaVersion === 1);
}

// Illustrations
{
  ensureIllustrationRights(dataRoot, BOOK, 'sujet-a', 'illustration');
  const [image] = readBookRights(dataRoot, BOOK).illustrations;
  check('illustration : aiGenerated et fichier écrits', image?.aiGenerated === true && image.file === 'illustrations/sujet-a/illustration.png' && image.rights.length === 0, image);
  setIllustrationRights(dataRoot, BOOK, 'sujet-a', 'illustration', ['sdxl-base-1-0', 'modele-essai']);
  check('rattachement', readBookRights(dataRoot, BOOK).illustrations[0]?.rights.length === 2);
  ensureIllustrationRights(dataRoot, BOOK, 'sujet-a', 'illustration');
  check('nouveau dépôt : les droits restent', readBookRights(dataRoot, BOOK).illustrations.length === 1 && readBookRights(dataRoot, BOOK).illustrations[0]?.rights.length === 2);
  refused('rattachement sans image', () => setIllustrationRights(dataRoot, BOOK, 'sujet-b', 'illustration', []), 'déposer');
}

// Fichier invalide conservé
{
  const good = fs.readFileSync(bookFile, 'utf8');
  fs.writeFileSync(bookFile, '{ pas du json');
  const broken = hash(bookFile);
  refused('livre : JSON cassé, refusé à la lecture', () => readBookRights(dataRoot, BOOK), 'conservé tel quel');
  refused('livre : JSON cassé, aucune écriture', () => saveEntry(dataRoot, BOOK, 'livre', entry({ id: 'autre' }), 'ajout'), 'conservé tel quel');
  refused('livre : JSON cassé, aucun import', () => addBookEntries(dataRoot, BOOK, []), 'conservé tel quel');
  check('livre : fichier cassé conservé tel quel', hash(bookFile) === broken);
  fs.writeFileSync(bookFile, JSON.stringify({ schemaVersion: 1, entries: [{ id: 'a' }], illustrations: [] }));
  refused('livre : schéma invalide, refusé', () => readBookRights(dataRoot, BOOK), 'invalide');
  fs.writeFileSync(bookFile, good);
  const common = fs.readFileSync(commonFile, 'utf8');
  fs.writeFileSync(commonFile, '{');
  const brokenCommon = hash(commonFile);
  refused('commun : JSON cassé, « Ajouter ce qui manque » refusé', () => addMissingDefaults(dataRoot), 'conservé tel quel');
  check('commun : fichier cassé conservé tel quel', hash(commonFile) === brokenCommon);
  fs.writeFileSync(commonFile, common);
}

// Lien refusé
{
  const outside = path.join(tempDir(), 'rights.json');
  fs.writeFileSync(outside, fs.readFileSync(bookFile));
  const before = hash(outside);
  const saved = fs.readFileSync(bookFile);
  fs.rmSync(bookFile);
  if (fileLink(outside, bookFile)) {
    refused('rights.json en lien : lecture refusée', () => readBookRights(dataRoot, BOOK), 'fichier réel');
    refused('rights.json en lien : écriture refusée', () => saveEntry(dataRoot, BOOK, 'livre', entry({ id: 'autre' }), 'ajout'), 'fichier réel');
    check('rights.json en lien : la cible n’a pas bougé', hash(outside) === before);
    fs.rmSync(bookFile);
  } else console.log('saut : lien de fichier impossible sur cette machine');
  fs.writeFileSync(bookFile, saved);
}

// Livre absent
refused('livre absent', () => readBookRights(dataRoot, 'inconnu'), 'Dossier du livre absent');
{
  const empty = tempDir();
  refused('collection absente', () => addMissingDefaults(empty), 'collection/ absent');
}
{
  // `rights.json` retiré à la main : un registre vide, pas une erreur.
  const fresh = tempDir();
  createBookFolder(fresh, BOOK);
  fs.rmSync(path.join(fresh, BOOK, 'rights.json'));
  check('rights.json du livre absent : registre vide', readBookRights(fresh, BOOK).entries.length === 0);
}

// Licences de credits.json
for (const raw of ['CC BY 4.0', 'CC-BY-4.0', 'C.C by 4.0', 'cc by 4.0', ' CC  BY  4.0 ', 'CC_BY_4.0']) {
  const read = readLicense(raw);
  check(`licence reconnue : ${raw}`, read.license === CC_BY_LABEL && read.commercialOk === 'oui', read);
}
for (const raw of ['Free Standard', 'Standard', 'CC BY-NC 4.0', 'CC BY-SA 4.0', 'CC BY 3.0', 'CC0', 'tous droits réservés', '']) {
  const read = readLicense(raw);
  check(`licence à vérifier : « ${raw} »`, read.commercialOk === 'a-verifier' && read.license === raw, read);
}

// Identifiants
check('id : auteur et nom', rightsId('Auteur Fictif', 'Grand Modèle #2') === 'auteur-fictif-grand-modele-2');
check('id : accents retirés', rightsId('Éloïse', 'Forêt') === 'eloise-foret');
check('id : valide au schéma', rightsEntrySchema.safeParse(entry({ id: rightsId('A_b', '--C--') })).success);
check('id : longueur bornée, sans tiret final', rightsId('a'.repeat(79), 'b c').length <= 80 && !rightsId('a'.repeat(79), 'b c').endsWith('-'));

// Texte du crédit : CC BY 4.0 §3(a)(1)
{
  const line = { name: 'Modèle', author: 'Auteur', license: CC_BY_LABEL, url: 'https://exemple.test/m' };
  const fr = creditText(line, 'fr');
  check('crédit : auteur, lien, licence et son lien, modification signalée', fr.includes('Auteur') && fr.includes('https://exemple.test/m') && fr.includes('CC BY 4.0') && fr.includes('creativecommons.org/licenses/by/4.0') && fr.includes('modifié'), fr);
  check('crédit : langue de l’édition', creditText(line, 'en').includes('modified') && creditText(line, 'es').includes('modificado'));
  check('crédit : sans URL, pas de parenthèses vides', !creditText({ ...line, url: '' }, 'fr').includes('()'));
  check('crédit : autre licence, sans lien CC', !creditText({ ...line, license: 'Free Standard' }, 'fr').includes('creativecommons'));
  check('crédit : sans auteur, vide', creditText({ ...line, author: '' }, 'fr') === '');
  check('crédit : sans licence, vide', creditText({ ...line, license: '' }, 'fr') === '');
}

// Lecture de credits.json
const line = (over: object = {}) => ({ asset: '', src_name: 'Modèle de synthèse', author: 'Auteur Fictif', license: 'CC-BY-4.0', url: 'https://exemple.test/m', original: false, ...over });
const parse = (entries: object[]) => parseCredits(JSON.stringify({ entries }));
const noneKnown = new Set<string>();
{
  const out = importCredits(parse([line()]), noneKnown, 'fr');
  const [e] = out.added;
  check('import : entrée complète', out.added.length === 1 && e!.kind === 'modele-3d' && e!.id === 'auteur-fictif-modele-de-synthese' && e!.name === 'Modèle de synthèse' && e!.url === 'https://exemple.test/m', e);
  check('import : licence normalisée, usage commercial oui', e!.license === CC_BY_LABEL && e!.commercialOk === 'oui');
  check('import : valide au schéma', rightsEntrySchema.safeParse(e).success);
  check('import : asset vide accepté', out.skipped.length === 0);
  const std = importCredits(parse([line({ license: 'Free Standard' })]), noneKnown, 'fr').added[0]!;
  check('import : Free Standard, à vérifier', std.commercialOk === 'a-verifier' && std.license === 'Free Standard');
  check('import : licence inconnue, à vérifier', importCredits(parse([line({ license: 'Maison' })]), noneKnown, 'fr').added[0]!.commercialOk === 'a-verifier');
  const original = importCredits(parse([line({ original: true })]), noneKnown, 'fr');
  check('import : original vrai, ignoré', original.added.length === 0 && original.originals === 1);
  const twice = importCredits(parse([line(), line({ license: 'Autre' })]), noneKnown, 'fr');
  check('import : doublon dans le fichier, le premier reste', twice.added.length === 1 && twice.added[0]!.license === CC_BY_LABEL && twice.kept.length === 1, twice);
  const known = importCredits(parse([line()]), new Set(['auteur-fictif-modele-de-synthese']), 'fr');
  check('import : déjà au registre, rien', known.added.length === 0 && known.kept.join() === 'auteur-fictif-modele-de-synthese');
  const noName = importCredits(parse([line({ src_name: '', asset: '' })]), noneKnown, 'fr');
  check('import : sans nom, ligne écartée et dite', noName.added.length === 0 && noName.skipped[0]!.includes('ligne 1'));
  check('import : nom pris dans asset si src_name est vide', importCredits(parse([line({ src_name: '', asset: 'Actif' })]), noneKnown, 'fr').added[0]!.name === 'Actif');
  check('import : aucun identifiant possible, ligne écartée', importCredits(parse([line({ author: '', src_name: '恐竜' })]), noneKnown, 'fr').skipped.length === 1);
  const noAuthor = importCredits(parse([line({ author: '' })]), noneKnown, 'fr').added[0]!;
  check('import : sans auteur, importée à vérifier, crédit vide', noAuthor.commercialOk === 'a-verifier' && noAuthor.credit === '' && noAuthor.author === '', noAuthor);
  const noLicense = importCredits(parse([line({ license: '' })]), noneKnown, 'fr').added[0]!;
  check('import : sans licence, importée à vérifier, crédit vide', noLicense.commercialOk === 'a-verifier' && noLicense.credit === '' && noLicense.license === '', noLicense);
  check('import : clé inconnue de l’addon tolérée', importCredits(parse([line({ nouvelle: 1 })]), noneKnown, 'fr').added.length === 1);
  check('import : BOM accepté', parseCredits(`﻿${JSON.stringify({ entries: [] })}`).entries.length === 0);
  for (const [name, content] of [['JSON cassé', '{'], ['sans entries', '{}'], ['entries qui n’est pas une liste', '{"entries":{}}'], ['champ du mauvais type', '{"entries":[{"author":1}]}']] as const) {
    let message = '';
    try {
      parseCredits(content);
    } catch (e) {
      message = e instanceof CreditsRefused ? e.message : '';
    }
    check(`credits.json refusé : ${name}`, message.includes('credits.json'), message);
  }
}

// Second import : n'écrase pas une correction de David
{
  const fresh = tempDir();
  createCollection(fresh);
  createBookFolder(fresh, BOOK);
  const known = () => new Set(allEntries(readCollectionRights(fresh), readBookRights(fresh, BOOK)).keys());
  const file = parse([line(), line({ src_name: 'Autre modèle', license: 'Free Standard' })]);
  addBookEntries(fresh, BOOK, importCredits(file, known(), 'fr').added);
  check('premier import : deux entrées', readBookRights(fresh, BOOK).entries.length === 2);
  saveEntry(fresh, BOOK, 'livre', { ...readBookRights(fresh, BOOK).entries[0]!, license: 'Corrigée par David', commercialOk: 'non' }, 'modification');
  const second = importCredits(file, known(), 'fr');
  check('second import : rien à ajouter', second.added.length === 0 && second.kept.length === 2);
  const target = path.join(fresh, BOOK, 'rights.json');
  const footprint = hash(target);
  addBookEntries(fresh, BOOK, second.added);
  check('second import : fichier inchangé', hash(target) === footprint);
  check('second import : la correction reste', readBookRights(fresh, BOOK).entries[0]!.license === 'Corrigée par David');
}

finish('droits');
