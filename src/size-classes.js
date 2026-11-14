import fs from 'node:fs';
import { UsageError } from './errors.js';
import { formatBytes, formatCount } from './format.js';
import { parseCount, parseSize } from './chunks.js';

/*
 * Size classes: the listing puts each object into the chunk of its size class, and each class has its own copy
 * profile. A class is `{ name, below, chunkFiles, concurrency, chunkBytes? }` (sizes in bytes): it holds the objects
 * smaller than `below` that no class before it holds; the last class has no `below`. `chunkFiles` is the most objects
 * in a chunk of the class, `concurrency` the objects copied at once in it, `chunkBytes` (optional) replaces
 * --chunk-bytes for it.
 */

const MiB = 2 ** 20;
const GiB = 2 ** 30;

export const DEFAULT_SIZE_CLASSES = Object.freeze([
  { name: 'very-small', below: MiB, chunkFiles: 100_000, concurrency: 128 },
  { name: 'small', below: 64 * MiB, chunkFiles: 50_000, concurrency: 64 },
  { name: 'medium', below: GiB, chunkFiles: 10_000, concurrency: 16 },
  { name: 'large', below: 100 * GiB, chunkFiles: 1_000, concurrency: 8 },
  { name: 'very-large', chunkFiles: 50, concurrency: 2 },
].map((c) => Object.freeze(c)));

const MAX_CLASSES = 10;
const NAME_RE = /^[a-z0-9-]+$/;
const KNOWN = new Set(['name', 'below', 'chunkFiles', 'concurrency', 'chunkBytes']);

/**
 * Reads a size profile file: `{ "classes": [{ "name", "below", "chunkFiles", "concurrency", "chunkBytes"? }, ...] }`,
 * sizes as numbers of bytes or texts such as "64MiB". Returns the classes with sizes in bytes; throws a UsageError
 * that names the file and the class for anything it cannot use.
 */
export function readSizeProfile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`Cannot read the size profile ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}.`);
  }
  let profile;
  try {
    profile = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`The size profile ${file} is not valid JSON: ${e.message}.`);
  }
  const bad = (what) => new UsageError(`Size profile ${file}: ${what}.`);
  const list = profile?.classes;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CLASSES) throw bad(`"classes" must be a list of 1 to ${MAX_CLASSES} classes`);
  const names = new Set();
  const classes = list.map((c, i) => {
    const where = `class ${i + 1}${typeof c?.name === 'string' ? ` ("${c.name}")` : ''}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad(`${where} must be an object`);
    const unknown = Object.keys(c).filter((k) => !KNOWN.has(k));
    if (unknown.length > 0) throw bad(`${where} has unknown setting(s) ${unknown.join(', ')} (use ${[...KNOWN].join(', ')})`);
    if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) throw bad(`${where} needs a "name" of lower-case letters, digits and dashes`);
    if (names.has(c.name)) throw bad(`the name "${c.name}" is used twice`);
    names.add(c.name);
    const last = i === list.length - 1;
    if (last && c.below !== undefined) throw bad(`the last class, "${c.name}", holds every larger object: it has no "below"`);
    if (!last && c.below === undefined) throw bad(`${where} needs "below", the size its objects are under`);
    return {
      name: c.name,
      ...(last ? {} : { below: parseSize(c.below, `"below" of ${where} in ${file}`) }),
      chunkFiles: parseCount(c.chunkFiles, `"chunkFiles" of ${where} in ${file}`),
      concurrency: parseCount(c.concurrency, `"concurrency" of ${where} in ${file}`),
      ...(c.chunkBytes === undefined ? {} : { chunkBytes: parseSize(c.chunkBytes, `"chunkBytes" of ${where} in ${file}`) }),
    };
  });
  for (let i = 1; i < classes.length - 1; i++) {
    const [before, c] = [classes[i - 1], classes[i]];
    if (!(c.below > before.below)) throw bad(`"below" must grow from one class to the next: "${c.name}" (${sizeText(c.below)}) is not above "${before.name}" (${sizeText(before.below)})`);
  }
  return classes;
}

/** The class of an object of `size` bytes: the first whose `below` is above it, else the last. */
export const classOf = (classes, size) => classes.find((c) => c.below === undefined || size < c.below) ?? classes.at(-1);

/** S3's order of keys: their UTF-8 bytes (JavaScript's string order differs for characters outside the BMP). */
export const compareKeys = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A size without useless decimals: 1 MiB, 1.5 GiB, 100 GiB. */
const sizeText = (bytes) => formatBytes(bytes).replace(/\.00 /, ' ');

/** The size range of class `i`: `< 1 MiB`, `1 MiB – < 64 MiB`, `≥ 100 GiB`. */
function rangeText(classes, i) {
  const c = classes[i];
  const from = i > 0 ? classes[i - 1].below : undefined;
  if (c.below === undefined) return from === undefined ? 'any size' : `≥ ${sizeText(from)}`;
  return from === undefined ? `< ${sizeText(c.below)}` : `${sizeText(from)} – < ${sizeText(c.below)}`;
}

/** The class table, one line per class (dry run, views, log, wizard). */
export function sizeClassLines(classes) {
  const width = Math.max(...classes.map((c) => c.name.length)) + 2;
  const ranges = classes.map((c, i) => rangeText(classes, i));
  const rangeWidth = Math.max(...ranges.map((r) => r.length)) + 2;
  return classes.map((c, i) => `${c.name.padEnd(width)}${ranges[i].padEnd(rangeWidth)}${formatCount(c.chunkFiles)} files per chunk, ${formatCount(c.concurrency)} at once${c.chunkBytes ? `, ≤ ${sizeText(c.chunkBytes)} per chunk` : ''}`);
}

/** `very-small 128, small 64, ...`: the objects copied at once of each class. */
export const concurrencyText = (classes) => classes.map((c) => `${c.name} ${formatCount(c.concurrency)}`).join(', ');
