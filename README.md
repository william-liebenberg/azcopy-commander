# azcopy-commander

Migrate a large Amazon S3 bucket to an Azure Blob Storage container — server to server.
Azure pulls each object from a presigned S3 URL, so the data never passes through your machine.
Copying starts while the bucket is still being listed, every run can be stopped and continued,
and delta migrations keep the target in sync until you cut over.

## Features

- **Server-side copies**: Put Blob From URL, and Put Block From URL for large objects; your machine only sends requests.
- **Copy while listing**: the listing is cut into chunks, and each chunk is copied as soon as it is closed.
- **Append-only and safe**: existing blobs are never replaced (unless you ask for it), and nothing is ever deleted.
- **Resumable**: stop with Ctrl+C or reboot, then continue where it left off; failed files are retried.
- **Delta migrations**: copy only what changed since the last run, repeatedly, until you are ready to cut over.
- **Live dashboard**: a step-by-step wizard and a full-screen progress view, plus timestamped logs.

## Requirements

- Node.js 20.12 or later.
- AWS keys with `s3:ListBucket` and `s3:GetObject` on the source bucket.
- A SAS URL for the target container with write permission (`racwl` recommended).

AzCopy is not needed (the name is historical).

## Install

```sh
npm install -g github:william-liebenberg/azcopy-commander
azcopy-commander --help
```

Or from a clone:

```sh
git clone https://github.com/william-liebenberg/azcopy-commander.git
cd azcopy-commander
npm install
node bin/azcopy-commander.js --help
```

## Quick start

```powershell
$env:AWS_ACCESS_KEY_ID     = "..."
$env:AWS_SECRET_ACCESS_KEY = "..."
$env:AZCOPY_COMMANDER_TARGET_SAS_URL = "https://<account>.blob.core.windows.net/<container>?<sas>"

azcopy-commander            # step-by-step wizard with a live dashboard
# or, without the wizard:
azcopy-commander migrate --source-bucket my-bucket --source-prefix data/2024
```

Objects keep their layout: `s3://my-bucket/data/2024/a.txt` becomes `<container>/data/2024/a.txt`.
Each migration is recorded in a folder under `./runs`.

## Common tasks

Continue a migration after Ctrl+C, a reboot or failed files (without `--migration`, the latest one, after confirmation):

```sh
azcopy-commander migrate --migration runs/20261113T020000Z-migration
```

Copy only what changed since the previous migration, plus what it did not copy:

```sh
azcopy-commander migrate --source-bucket my-bucket --last-copy-date auto
```

Run a full migration, then deltas one after another until one finds few objects (then stop the writers and cut over):

```sh
azcopy-commander migrate --source-bucket my-bucket --repeat
```

List the source without copying anything (prints `s3://bucket/key<TAB>size`; needs no SAS URL):

```sh
azcopy-commander list --source-bucket my-bucket --source-prefix data/2024 > files.txt
```

See what a migration would do, without doing it:

```sh
azcopy-commander migrate --source-bucket my-bucket --dry-run
```

Tune how objects of each size are copied with a size profile:

```sh
azcopy-commander --generate-size-profile profile.json
azcopy-commander migrate --source-bucket my-bucket --size-profile profile.json
```

## Options

The main options; run `azcopy-commander --help` for all of them.

| Option | Description |
| --- | --- |
| `--source-bucket <name>` | Source bucket: a name or an ARN (`arn:aws:s3:::bucket[/prefix]`). |
| `--source-prefix <path>` | Only copy keys under this prefix. |
| `--source-region <region>` | The bucket's region; asked from S3 when omitted. |
| `--target-sas-url <url>` | Container SAS URL; prefer the `AZCOPY_COMMANDER_TARGET_SAS_URL` variable. |
| `--last-copy-date <date>` | Delta: only objects modified on/after an ISO 8601 date (UTC), or `auto`. |
| `--overwrite-modified` | Also replace an existing blob when the S3 object is newer. |
| `--migration <dir>` | Continue this migration. |
| `--repeat` | After the migration, run deltas until one lists at most `--repeat-until` objects (default 10000). |
| `--parallel <n>` | Chunks copied at once (default 4). |
| `--size-profile <file>` | Size classes from a JSON file (see `--generate-size-profile`). |
| `--stop-after inventory` | List and analyse the source, copy nothing. |
| `--output-dir <dir>` | Where migration folders go (default `./runs`). |
| `--dry-run` | Print what would be done without doing it. |

## Exit codes

`0` ok, `1` completed with failed files, `2` failed, `64` usage error, `130` interrupted.

## Security

Credentials come from the environment (or hidden input in the wizard) only. The AWS keys, the SAS URL and the
presigned URLs are never written to disk, and secrets are redacted from logs and console output.
Copies are append-only by default, and nothing is ever deleted at the source or the target.

## Status

Version 2 is covered by unit and end-to-end tests with in-memory fakes of S3 and Azure Blob Storage. It has not yet
been run at production scale against real S3 and Azure. Before a large migration, try it on a small prefix, and run
`--stop-after inventory` first to see what the bucket holds.

## Learn more

[How it works](docs/how-it-works.md): chunks and size classes, how each object is copied, failures and retries, the
migration folder, delta migrations and cutover, the dashboard, and tuning and limits.

## Contributing

```sh
git clone https://github.com/william-liebenberg/azcopy-commander.git
cd azcopy-commander
npm install
npm test
```

The tests use no network: S3 and the blob container are in-memory fakes in [`test/fakes.js`](test/fakes.js).
Issues and pull requests are welcome.

## License

[MIT](LICENSE)
