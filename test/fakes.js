/*
 * Fakes of S3 and of a blob container for the tests: what src/s3.js and src/blob-copy.js call, in memory.
 *
 *   const s3 = fakeS3({ 'data/a.txt': { size: 10 }, ... });   opts.s3 of migrate and list
 *   const container = fakeContainer(s3);                       opts.container of migrate
 *
 * Both count the requests in flight (`maxInFlight`) and can be slowed down (`delayMs`) or made to fail (`fail`).
 */

export const PRESIGN_SECRET = 'PRESIGNEDSIGNATURE0123456789abcdef';

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/** Waits `ms`, or rejects at once when `signal` aborts. */
function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** An in-flight counter: `run(fn)` counts fn while it runs. */
function counter() {
  const c = {
    inFlight: 0,
    maxInFlight: 0,
    async run(fn) {
      c.inFlight++;
      c.maxInFlight = Math.max(c.maxInFlight, c.inFlight);
      try {
        return await fn();
      } finally {
        c.inFlight--;
      }
    },
  };
  return c;
}

const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

/**
 * A fake S3 bucket. `objects` maps a key to { size, lastModified, storageClass, restore, metadata, contentType }.
 *   s3.pages             the ListObjectsV2 params of each page asked for
 *   s3.heads             the keys HEAD was asked for
 *   s3.beforePage(n, params)   awaited before page n (0-based) is answered: a test holds the listing with it
 *   s3.failPage(n)       an error to throw for page n, or nothing
 *   s3.delayMs           the time of a HEAD
 *   s3.longUrl(key)      true to make the presigned URL of a key longer than 2 KiB
 */
export function fakeS3(objects = {}, { pageSize, region = 'ap-southeast-2' } = {}) {
  const store = new Map(Object.entries(objects).map(([k, o]) => [k, { size: 0, lastModified: '2026-01-15T00:00:00Z', ...o }]));
  const heads = counter();
  const s3 = {
    region,
    store,
    pages: [],
    heads: [],
    presigned: 0,
    beforePage: null,
    failPage: null,
    delayMs: 0,
    longUrl: () => false,
    get maxHeadsInFlight() {
      return heads.maxInFlight;
    },
    put(key, o) {
      store.set(key, { size: 0, lastModified: new Date().toISOString(), ...o });
    },
    async listPage(params, { signal } = {}) {
      const n = s3.pages.length;
      s3.pages.push(params);
      if (s3.beforePage) await s3.beforePage(n, params);
      if (signal?.aborted) throw abortError();
      const error = s3.failPage?.(n);
      if (error) throw error;
      const after = params.ContinuationToken ?? params.StartAfter ?? '';
      // UTF-8 binary order, as S3 lists keys
      const keys = [...store.keys()].filter((k) => k.startsWith(params.Prefix ?? '') && Buffer.compare(Buffer.from(k), Buffer.from(after)) > 0).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const max = Math.min(params.MaxKeys ?? 1000, pageSize ?? 1000);
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      return {
        Contents: page.map((Key) => {
          const o = store.get(Key);
          return { Key, Size: o.size, LastModified: new Date(o.lastModified), StorageClass: o.storageClass ?? 'STANDARD', ...(o.restore ? { RestoreStatus: o.restore } : {}) };
        }),
        IsTruncated: truncated,
        ...(truncated ? { NextContinuationToken: page.at(-1) } : {}),
      };
    },
    headObject(key, { signal } = {}) {
      s3.heads.push(key);
      return heads.run(async () => {
        await wait(s3.delayMs, signal);
        const o = store.get(key);
        if (!o) return null;
        return {
          ContentLength: o.size,
          LastModified: new Date(o.lastModified),
          ContentType: o.contentType ?? 'application/octet-stream',
          Metadata: o.metadata ?? {},
        };
      });
    },
    async presignGet(key) {
      s3.presigned++;
      const pad = s3.longUrl(key) ? `&X-Amz-Security-Token=${'T'.repeat(2100)}` : '';
      return `https://bkt.s3.${region}.amazonaws.com/${encodeKey(key)}?X-Amz-Credential=AKIATESTTESTTEST%2F20260115&X-Amz-Signature=${PRESIGN_SECRET}${pad}`;
    },
  };
  return s3;
}

const httpError = (statusCode, code) => Object.assign(new Error(`${code} (${statusCode})`), { statusCode, code, details: { errorCode: code } });

/**
 * A fake blob container that reads its sources from a fakeS3. Its blobs are a Map of name -> { size, lastModified,
 * metadata, headers, from }; writes honour `ifNoneMatch: '*'` and `ifUnmodifiedSince` as Azure does.
 *   container.fail(name, request)   an error to throw for a blob (request: 'put', 'stage', 'commit'), or nothing
 *   container.delayMs               the time of a write
 *   container.requests              [{ request, name, ... }] in the order they came
 */
export function fakeContainer(s3) {
  const blobs = new Map();
  const writes = counter();
  const sourceOf = (url) => {
    const u = new URL(url);
    if (!u.searchParams.get('X-Amz-Signature')) throw httpError(403, 'CannotVerifyCopySource');
    const key = decodeURIComponent(u.pathname.slice(1));
    const o = s3.store.get(key);
    if (!o) throw httpError(404, 'CannotVerifyCopySource');
    return { key, o };
  };
  const check = (name, conditions = {}) => {
    const existing = blobs.get(name);
    if (conditions.ifNoneMatch === '*' && existing) throw httpError(409, 'BlobAlreadyExists');
    if (conditions.ifUnmodifiedSince && existing && existing.lastModified > new Date(conditions.ifUnmodifiedSince)) throw httpError(412, 'ConditionNotMet');
  };
  const container = {
    blobs,
    writeCount: new Map(), // name -> how many times the blob was written
    requests: [],
    delayMs: 0,
    fail: () => null,
    get maxWritesInFlight() {
      return writes.maxInFlight;
    },
    /** A blob already at the target, written at `lastModified`. */
    seed(name, { size = 1, lastModified = new Date(), from = 'seed' } = {}) {
      blobs.set(name, { size, lastModified: new Date(lastModified), metadata: {}, headers: {}, from });
    },
    getBlockBlobClient(name) {
      const staged = new Map();
      const write = (request, options, fn) =>
        writes.run(async () => {
          const req = { request, name, conditions: options?.conditions };
          container.requests.push(req);
          await wait(container.delayMs, options?.abortSignal);
          const error = container.fail(name, request);
          if (error) throw error;
          return fn(req);
        });
      const store = (size, from, options) => {
        blobs.set(name, { size, lastModified: new Date(), metadata: options.metadata ?? {}, headers: options.blobHTTPHeaders ?? {}, from });
        container.writeCount.set(name, (container.writeCount.get(name) ?? 0) + 1);
      };
      return {
        upload: (body, length, options = {}) =>
          write('put', options, () => {
            check(name, options.conditions);
            store(length, 'upload', options);
          }),
        syncUploadFromURL: (url, options = {}) =>
          write('put', options, () => {
            const { key, o } = sourceOf(url);
            check(name, options.conditions);
            store(o.size, key, options);
          }),
        async getProperties() {
          container.requests.push({ request: 'properties', name });
          const b = blobs.get(name);
          if (!b) throw httpError(404, 'BlobNotFound');
          return { contentLength: b.size, lastModified: b.lastModified };
        },
        stageBlockFromURL: (id, url, offset, count, options = {}) =>
          write('stage', options, (req) => {
            const { key, o } = sourceOf(url);
            if (offset + count > o.size) throw httpError(416, 'InvalidRange');
            req.block = { id, offset, count };
            staged.set(id, { key, count });
          }),
        commitBlockList: (ids, options = {}) =>
          write('commit', options, (req) => {
            check(name, options.conditions);
            const size = ids.reduce((s, id) => s + staged.get(id).count, 0);
            store(size, staged.get(ids[0])?.key, options);
            req.ids = ids;
          }),
      };
    },
  };
  return container;
}

export { httpError, wait };
