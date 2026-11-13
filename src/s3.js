import { loadSdk } from './sdk.js';
import { UsageError } from './errors.js';

/*
 * S3 access: the listing, the HEAD of each object and the presigned GET URLs that Azure reads the objects from.
 *
 *   const s3 = await createS3({ bucket, region, maxSockets });
 *   s3.region                          the region the URLs are signed for (--source-region, or HeadBucket's answer)
 *   await s3.listPage(params, opts)    a ListObjectsV2 response
 *   await s3.headObject(key, opts)     a HeadObject response, or null when the object does not exist (404)
 *   await s3.presignGet(key)           a GET URL for the object, valid for an hour; a secret: never logged
 *
 * `opts.signal` (an AbortSignal) cancels the request. `withS3(opts, ...)` lets a test replace any of these (`opts.s3`).
 */

export const PRESIGN_SECONDS = 3600;

const statusOf = (err) => err?.$metadata?.httpStatusCode ?? err?.$response?.statusCode;

/** The region of a bucket, from HeadBucket (its BucketRegion, or the x-amz-bucket-region header of a redirect). */
async function bucketRegion(sdk, client, bucket) {
  try {
    const head = await client.send(new sdk.HeadBucketCommand({ Bucket: bucket }));
    if (head.BucketRegion) return head.BucketRegion;
  } catch (err) {
    const region = err?.$response?.headers?.['x-amz-bucket-region'];
    if (region) return region;
    throw new UsageError(`Cannot find the region of bucket "${bucket}" (HeadBucket: ${err?.name ?? err?.message ?? err}${statusOf(err) ? `, HTTP ${statusOf(err)}` : ''}): check the credentials, or pass --source-region.`);
  }
  throw new UsageError(`S3 did not say the region of bucket "${bucket}": pass --source-region.`);
}

/**
 * The real S3 access, with the AWS SDK. `maxSockets` sizes the HTTPS agent (the SDK's default of 50 would queue
 * most HEAD requests when many objects are copied at once). Without `region` the bucket's region is looked up,
 * unless `lookupRegion` is false (a listing only: the SDK follows the region redirects itself).
 */
export async function createS3({ bucket, region, maxSockets = 50, lookupRegion = true }) {
  const sdk = await loadSdk('@aws-sdk/client-s3');
  const requestHandler = { httpsAgent: { keepAlive: true, maxSockets } };
  const make = (r) => new sdk.S3Client({ region: r, followRegionRedirects: true, requestHandler });
  let resolved = region || '';
  if (!resolved && lookupRegion) resolved = await bucketRegion(sdk, make(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'), bucket);
  const client = make(resolved || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1');
  let presigner = null;
  return {
    region: resolved,
    listPage: (params, { signal } = {}) => client.send(new sdk.ListObjectsV2Command(params), { abortSignal: signal }),
    async headObject(key, { signal } = {}) {
      try {
        return await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
      } catch (err) {
        if (statusOf(err) === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
        throw err;
      }
    },
    async presignGet(key) {
      presigner ??= await loadSdk('@aws-sdk/s3-request-presigner');
      return presigner.getSignedUrl(client, new sdk.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: PRESIGN_SECONDS });
    },
    destroy: () => client.destroy(),
  };
}

/**
 * The S3 access of a command: `opts.s3` (a test hook) is an object with any of listPage, headObject, presignGet and
 * region; what it does not replace comes from the real client. `uses` names the functions the command needs: when the
 * hook has all of them, no real client is made.
 */
export async function withS3(opts, settings, uses = ['listPage', 'headObject', 'presignGet']) {
  const hook = opts.s3;
  if (hook && uses.every((k) => typeof hook[k] === 'function')) return { destroy() {}, ...hook, region: settings.region || hook.region || '' };
  const real = await createS3(settings);
  return { ...real, ...(hook ?? {}) };
}
