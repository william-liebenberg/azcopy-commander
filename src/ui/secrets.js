import process from 'node:process';
import { Redactor } from '../urls.js';

const AWS_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

/**
 * The credentials the wizard collected, kept in memory only. Nothing here is ever written to disk,
 * put into an argument list or printed: `describe()` says where each value came from, never what it is.
 *
 *   - AWS keys: `useEnvironmentAws()` leaves the environment alone; `setAws()` holds typed values that
 *     `apply()` puts into the environment of this process (the S3 client of the commands reads them there)
 *     until `restore()` puts the previous values back.
 *   - SAS URL: held here and passed to the commands as `opts.targetSasUrl`.
 */
export class Secrets {
  constructor(env = process.env) {
    this.env = env;
    this.redactor = new Redactor();
    this.aws = { source: null, values: null };
    this.sas = { source: null, url: null };
    this.saved = null;
  }

  useEnvironmentAws() {
    this.aws = { source: 'environment', values: null };
  }

  setAws({ accessKeyId, secretAccessKey, sessionToken = '' }) {
    this.aws = { source: 'typed', values: { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } };
    this.redactor.add(accessKeyId, secretAccessKey, sessionToken);
  }

  setSas(url, source) {
    this.sas = { source, url };
    this.redactor.add(url, ...[...new URL(url).searchParams.values()].filter((v) => v.length >= 6));
  }

  forgetSas() {
    this.sas = { source: null, url: null };
  }

  /** Makes typed AWS values visible to this process. A session token of an earlier login is hidden too. */
  apply() {
    if (this.aws.source !== 'typed' || this.saved) return;
    this.saved = Object.fromEntries(AWS_VARS.map((k) => [k, this.env[k]]));
    for (const k of AWS_VARS) {
      if (this.aws.values[k]) this.env[k] = this.aws.values[k];
      else delete this.env[k];
    }
  }

  /** Puts the AWS environment variables back as they were before `apply()`. */
  restore() {
    if (!this.saved) return;
    for (const k of AWS_VARS) {
      if (this.saved[k] === undefined) delete this.env[k];
      else this.env[k] = this.saved[k];
    }
    this.saved = null;
  }

  /** Forgets everything. */
  clear() {
    this.restore();
    this.aws = { source: null, values: null };
    this.sas = { source: null, url: null };
  }

  redact(text) {
    return this.redactor.redact(text);
  }

  describe() {
    const aws = this.aws.source ?? 'none';
    const sas = this.sas.source === 'typed' ? 'typed (memory only)' : (this.sas.source ?? 'none');
    const awsText = this.aws.source === 'typed' ? 'typed (memory only)' : aws;
    return `AWS key: ${awsText} · AWS secret: ${awsText} · SAS: ${sas}`;
  }
}
