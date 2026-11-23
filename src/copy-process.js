import { containerFor, createCopier } from './blob-copy.js';
import { serveCopies } from './copy-processes.js';
import { createS3 } from './s3.js';

/* A copy process (see copy-processes.js): its own S3 client and ContainerClient, made from the settings it is sent. */

serveCopies(async ({ s3: settings, target, copier }) => {
  const s3 = await createS3({ ...settings, lookupRegion: false });
  const { container, directory } = await containerFor(target);
  return createCopier({ s3, container, directory, ...copier });
});
