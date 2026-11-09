import { UsageError } from './errors.js';

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const SAS_WARN_BEFORE_EXPIRY_MS = 7 * 24 * 3600 * 1000;

export const normalizePrefix = (prefix = '') => String(prefix).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

const encodePath = (segments) => segments.filter(Boolean).map(encodeURIComponent).join('/');

/**
 * Accepts a bucket name or a bucket / object ARN and returns `{ bucket, prefix }`:
 *   my-bucket                      -> { bucket: 'my-bucket', prefix: '' }
 *   arn:aws:s3:::my-bucket         -> { bucket: 'my-bucket', prefix: '' }
 *   arn:aws:s3:::my-bucket/data/x  -> { bucket: 'my-bucket', prefix: 'data/x' }
 * Other ARNs (access points, multi-region access points) need different azcopy URLs and are rejected.
 */
export function parseBucketInput(text) {
  const input = String(text ?? '').trim();
  if (!input) throw new UsageError('Missing S3 bucket name or ARN.');
  if (!/^arn:/i.test(input)) {
    if (!BUCKET_RE.test(input)) throw new UsageError(`Invalid S3 bucket name "${input}".`);
    return { bucket: input, prefix: '' };
  }
  const m = /^arn:aws[a-z-]*:s3:::([^/]+)(?:\/(.*))?$/i.exec(input);
  if (!m) throw new UsageError(`Unsupported ARN "${input}": only bucket and object ARNs (arn:aws:s3:::bucket[/prefix]) are supported, not access points.`);
  if (!BUCKET_RE.test(m[1])) throw new UsageError(`Invalid S3 bucket name "${m[1]}" in the ARN.`);
  return { bucket: m[1], prefix: normalizePrefix(m[2]) };
}

/**
 * Path-style source URL. Without `region` it uses the global endpoint (s3.amazonaws.com), the form used
 * in Microsoft's AzCopy/S3 documentation; with `region` (e.g. ap-southeast-2) the regional endpoint,
 * which azcopy recommends for a bucket in that region.
 */
export function buildSourceUrl(bucket, prefix = '', region = '') {
  if (!BUCKET_RE.test(bucket ?? '')) throw new UsageError(`Invalid S3 bucket name "${bucket ?? ''}".`);
  if (region && !REGION_RE.test(region)) throw new UsageError(`Invalid AWS region "${region}" (expected e.g. ap-southeast-2).`);
  const host = region ? `s3.${region}.amazonaws.com` : 's3.amazonaws.com';
  return `https://${host}/${encodePath([bucket, ...normalizePrefix(prefix).split('/')])}`;
}

/**
 * Validates the container SAS URL and splits it into `base` (no query, safe to log) and `query` (the secret).
 * Throws on anything that would make the copy fail later (expired token, no write permission);
 * `warnings` holds the non-fatal findings.
 */
export function parseTargetSasUrl(raw, now = new Date()) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError('Target SAS URL is not a valid URL.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) throw new UsageError('Target SAS URL must include the container, e.g. https://acct.blob.core.windows.net/container?<sas>');
  if (!url.searchParams.get('sig')) throw new UsageError('Target URL is not a SAS URL (no "sig" query parameter).');

  const warnings = [];
  const permissions = url.searchParams.get('sp'); // absent when the SAS uses a stored access policy
  if (permissions !== null && !permissions.includes('w')) {
    throw new UsageError(`SAS permissions "sp=${permissions}" do not include write (w).`);
  }
  const expiry = new Date(url.searchParams.get('se') ?? NaN);
  if (!Number.isNaN(expiry.getTime())) {
    if (expiry <= now) throw new UsageError(`SAS token expired at ${expiry.toISOString()}.`);
    if (expiry - now < SAS_WARN_BEFORE_EXPIRY_MS) {
      warnings.push(`SAS token expires at ${expiry.toISOString()} (< 7 days); a multi-TB copy may outlive it.`);
    }
  }
  return { base: url.origin + path, query: url.search.slice(1), sig: url.searchParams.get('sig'), warnings };
}

/** Destination directory, optionally extended with `subpath`. No SAS. */
export const buildTargetBase = (target, subpath = '') =>
  [target.base, encodePath(normalizePrefix(subpath).split('/'))].filter(Boolean).join('/');

/** Destination URL including the SAS: only ever passed to azcopy, never logged. */
export const buildTargetUrl = (target, subpath = '') => `${buildTargetBase(target, subpath)}?${target.query}`;

/**
 * Maps the `Src` azcopy reports for a failed transfer to a path relative to the source root
 * (what `--list-of-files` expects). The exact shape of Src is not documented, so accept a
 * path-style URL, a virtual-hosted URL or an already relative path.
 */
export function relativeSourcePath(src, { bucket, prefix = '' }) {
  const withoutQuery = String(src).split('?')[0];
  if (!/^https?:\/\//i.test(withoutQuery)) return withoutQuery.replace(/^\/+/, '');

  const url = new URL(withoutQuery);
  let segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const virtualHosted = url.hostname.startsWith(`${bucket}.`);
  if (!virtualHosted && segments[0] === bucket) segments.shift();
  const prefixSegments = normalizePrefix(prefix).split('/').filter(Boolean);
  if (prefixSegments.every((p, i) => segments[i] === p)) segments = segments.slice(prefixSegments.length);
  return segments.join('/');
}

/** Removes secrets (SAS signatures, AWS credentials) from everything that is logged or printed. */
export class Redactor {
  constructor() {
    this.secrets = [];
  }

  add(...values) {
    for (const v of values) if (v && v.length >= 6) this.secrets.push(v);
  }

  redact(text) {
    const exact = this.secrets.reduce((t, s) => t.split(s).join('***'), String(text));
    return exact.replace(/(sig(?:=|%3[dD]))[^&"'\s]+/g, '$1REDACTED');
  }
}
