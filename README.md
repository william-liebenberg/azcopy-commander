# azcopy-commander

Node.js controller for [AzCopy](https://aka.ms/downloadazcopy) that migrates a large S3 bucket
to an Azure Blob container. It is **append-only** by default, shows live progress, writes a timestamped copy log and keeps a
list of failed files that can be retried.

Requirements: Node.js >= 20.12 and `azcopy` v10 on `PATH` (or `--azcopy-path`). The commands `copy`, `list`, `retry` and `resume` have no runtime dependencies; only the optional terminal UI (`ui`) needs `npm install` (it uses [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts), loaded only by that command).

## Usage

```powershell
$env:AWS_ACCESS_KEY_ID     = "..."
$env:AWS_SECRET_ACCESS_KEY = "..."
$env:AZCOPY_COMMANDER_TARGET_SAS_URL = "https://acct.blob.core.windows.net/container?sv=...&sp=racwl&se=...&sig=..."

# 1. Initial copy of everything under a prefix
node bin/azcopy-commander.js copy --source-bucket my-bucket --source-prefix data/2024

# 2. Delta copy: only objects modified on/after a date, or since the previous run ("auto")
node bin/azcopy-commander.js copy --source-bucket my-bucket --source-prefix data/2024 --last-copy-date 2026-01-31T00:00:00Z
node bin/azcopy-commander.js copy --source-bucket my-bucket --source-prefix data/2024 --last-copy-date auto

# 3. Only list the source files a copy would transfer (prints `s3://bucket/key<TAB>size`, saves nothing)
node bin/azcopy-commander.js list --source-bucket my-bucket --source-prefix data/2024 --last-copy-date 2026-01-31 > files.txt

# 4. Re-copy the files that failed in a run
node bin/azcopy-commander.js retry --run runs/20261019T001543Z-full

# 5. Continue an interrupted azcopy job (Ctrl+C, reboot, ...)
node bin/azcopy-commander.js resume --run runs/20261019T001543Z-full
```

Without `--run`, `retry` and `resume` take the **latest run** in the output directory (the newest `<timestamp>-...` folder), show it and ask for confirmation; `--yes` skips the question (required when there is no terminal). A latest run that has no failed files (`retry`) or already succeeded (`resume`) is reported, not re-run.

`--dry-run` prints the (redacted) azcopy command without running it; `--help` lists all options.

| Input | Option |
|---|---|
| Source bucket / sub path | `--source-bucket` (a name or an ARN, `arn:aws:s3:::bucket[/prefix]`), `--source-prefix` (S3 keys keep their layout: `<container>/<prefix>/<key>`) |
| S3 endpoint (optional) | `--source-region <region>` uses `s3.<region>.amazonaws.com`, as azcopy recommends; must be the bucket's region |
| Target container SAS URL | `--target-sas-url` or env `AZCOPY_COMMANDER_TARGET_SAS_URL`; must allow write (`racwl` recommended) |
| Delta mode | `--last-copy-date <ISO 8601 date>` (no zone = **UTC**) or `auto` |
| S3 credentials | env `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN` (never arguments) |

## Terminal UI (`ui`)

```powershell
npm install                          # once: installs the prompt library
node bin/azcopy-commander.js ui      # or just: node bin/azcopy-commander.js  (in a terminal)
```

A step-by-step wizard instead of a long command line. It asks for:

1. **The action**: full copy, delta copy, list, retry failed files, resume a run, or quit.
2. **AWS credentials**: taken from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` when they are set (you choose *Use them* or *Enter other credentials*), otherwise typed with hidden input (plus an optional session token).
3. **The target SAS URL**: from `AZCOPY_COMMANDER_TARGET_SAS_URL` or typed hidden. It is validated as you type (container URL, signature, write permission, expiry); warnings such as "expires soon" are shown, the signature never is.
4. **An earlier run** (delta, retry, resume): a list of the runs in the output directory (`--output-dir`, default `./runs`), newest first, with start time (UTC), kind, outcome, copied / failed counts and bucket. Delta lists runs that finished (success or partial) and copies objects modified since that run started minus 10 minutes (as `--last-copy-date auto` does); *Enter a date instead* covers any other date, and is the only choice when no run exists yet. Retry lists runs with failed files; resume lists unfinished runs that have an azcopy job. When there is none, the wizard says so and returns to the menu.
5. **The source** (full, delta, list): bucket name **or ARN**, optional prefix and region, and whether to replace blobs when the S3 object is newer. A delta copy prefills these from the chosen run.
6. A **summary** and a confirmation, then the copy, retry or resume runs with a live dashboard (below).

A copy started from the wizard shows a live dashboard in the style of the prompts instead of the one-line progress and the plain summary:

```text
◇  Copying  amzn-s3-bucket-to-migrate → files3
│
│  ⠹ Copying                                              elapsed 2m 14s
│  ████████████████████░░░░░░░░░░░░░░░░░  58.3%   2.13 TiB / 3.65 TiB
│  speed 412.00 MiB/s  ▂▃▅▆▇▇▆▇   ETA 1h 12m
│  ✔ copied 1,204    ↷ ignored 15,000    ✖ failed 2    found 16,206
│  ✖ 403  data/2024/big file.bin
│  log  runs\20261020T014500Z-full\copy-20261020T014500Z.log
│  azcopy output
│  scanning bucket page 12
│  stderr connection reset, retrying
```

While azcopy is still listing the source the bar is animated and no ETA is shown. The latest three failed files are listed with their error code, and below the log path an "azcopy output" pane shows the latest azcopy messages that are not progress (Info lines and stderr, redacted like the log). The pane grows with the height of the terminal, up to 10 lines, and shows 3 lines when the height is unknown. Narrow terminals (< 60 columns) show a compact version without the sparkline, failures, azcopy output and log path, and below 36 columns a single line. Warnings are printed above the dashboard, and at the end it is replaced by a result panel (green for success, yellow for failed files or an interrupt, red for a failed job) with the most frequent error codes, the failed list and the next step. Colours follow `NO_COLOR` / `FORCE_COLOR`, and the symbols fall back to ASCII when the terminal is not UTF-8. The log, failed list, `run.json` and exit codes are the same as with the plain output. The dashboard is only used by the wizard on a terminal: `copy`, `retry` and `resume` on the command line, pipes and log files keep the plain output described under [Progress](#progress).

Secrets are kept **in memory only**: there is no flag for them, and nothing about them is added to `run.json`, `state.json`, the copy log, the failed-file lists or the command line of `azcopy-commander`. Typed AWS values are set in the environment of this process for the duration of the run (that is how azcopy receives them, as with environment variables today) and restored afterwards; the SAS URL is passed to the command in memory. The wizard never offers to save credentials. As with the other commands, azcopy itself receives the SAS URL in its command line. Ctrl+C at any prompt cancels (exit code 130); during a copy it keeps the usual stop-and-resume behaviour. Long paths and URLs are shortened in the middle to fit the terminal width, and colours follow `NO_COLOR`. `ui` refuses to start without a terminal (exit code 64). The options `--output-dir`, `--plan-dir`, `--azcopy-path`, `--azcopy-arg` and `--dry-run` apply to the wizard too.

## Copy semantics

Every run is `azcopy copy --recursive --overwrite=false --from-to S3Blob` on the global S3 endpoint (`s3.amazonaws.com`) unless `--source-region` is given:

* Existing blobs are **never overwritten**; nothing is deleted or mirrored. Objects already at the target are counted as *ignored*.
* Delta mode adds `--include-after <date>`: only objects whose S3 last-modified time is on/after the date are listed.
  `auto` = start of the previous run (from `<output-dir>/state.json`) minus 10 minutes; the overlap is harmless because existing blobs are skipped.
  `state.json` is updated after every run that completes, including runs with failed files (those are retried with `retry`).
  Interrupted or failed runs do not advance it.
* Consequently an object modified in S3 *after* it was copied is **not** re-copied, unless you opt in below.

### Optional: `--overwrite-modified`

Uses `--overwrite=ifSourceNewer`: an existing blob is replaced only when the S3 object is newer than the blob. New objects are
copied as usual and nothing is deleted. Use it with `--last-copy-date` so only recently modified objects are considered.

* Replacing a blob discards its previous content. Enable blob versioning or soft delete on the storage account if old versions must stay recoverable.
* AzCopy must compare against each existing blob, which can slow large runs (not benchmarked here).
* The comparison uses timestamps; an edit within the same second as the copy may be missed.
* `retry` reuses the setting of the original run; `resume` cannot change it (it is fixed in the job's plan).

## Listing only (`list`)

`list` takes the same inputs as `copy` (the SAS URL is only needed because azcopy requires a destination argument) and prints
each source object that a copy would consider, one per line, as `s3://<bucket>/<key><TAB><size in bytes>`. A file count and total size go to stderr,
so stdout can be redirected to a file. It runs `azcopy copy --dry-run --log-level NONE`: no run directory, manifest, state or azcopy log is written,
and nothing is copied. `--last-copy-date` takes an explicit date only (`auto` needs saved state).

Limitation: azcopy's dry run does not check the target, so objects that already exist there are listed too (a real `copy` skips them).

## Progress

A live line on a terminal; one line every 30 s in the log (and on stdout when it is not a terminal):

```
SCANNING+COPYING | discovered 1,234,567 | copied 1,000,000 | failed 12 | ignored 34 | 5.20 TiB / 12.30 TiB+ (42.3%) | 812.00 MiB/s | ETA after scan | elapsed 2h 3m 1s
```

* **discovered** is azcopy's transfer count: objects that matched the run. In delta mode, older objects are filtered while
  listing and never counted; counting them would need a second full listing of the bucket. It keeps growing while `SCANNING`;
  totals and ETA are only final once scanning is complete.
* **copied / failed / ignored** are azcopy's completed, failed and skipped transfer counts.

## Run directory (`runs/<timestamp>-full|delta|retry/`)

| File | Content |
|---|---|
| `copy-<ts>.log` | Timestamped copy log: azcopy messages, metrics, each failed file, final summary |
| `failed-<ts>.jsonl` | One record per failed file (`relativePath`, source, destination, error code, size); read by `retry` |
| `run.json` | Run manifest and final counters; needed by `retry` / `resume` |
| `azcopy-logs/`, `azcopy-plans/` | azcopy's own log and job plan files (needed by `resume`) |

SAS signatures and AWS secrets are redacted from logs and console output. The SAS URL is the one secret that cannot be kept
off the command line, because azcopy takes the destination as an argument; it is visible in the process list while azcopy runs.

Exit codes: `0` ok, `1` completed with failed files, `2` job failed, `64` usage error, `130` interrupted.

## Notes for very large runs

* AzCopy copies S3 -> Blob server to server (Put Block From URL); per Microsoft's documentation this does not use the
  bandwidth of the machine running it.
* Tune with azcopy's environment variables (`AZCOPY_CONCURRENCY_VALUE`, `AZCOPY_BUFFER_GB`, ...), which are inherited, or pass
  flags with `--azcopy-arg` (e.g. `--azcopy-arg=--cap-mbps=2000`). azcopy's log level is WARNING; override with `--azcopy-arg=--log-level=INFO`.
* azcopy writes a plan entry per file: put `--plan-dir` on a disk with plenty of free space for tens of millions of files.
* To parallelise or limit the blast radius, run one instance per `--source-prefix`.
* Make sure the SAS outlives the copy (the tool warns when it expires in < 7 days). `resume` and `retry` need the SAS again.

## Development

`npm test` runs unit tests and end-to-end tests against a fake azcopy (`test/fixtures/fake-azcopy.js`) that emits azcopy's JSON message protocol.

## What was and was not verified

* Verified with the real azcopy 10.32.8: all flags used are accepted; `--as-subdir=false` keeps the source layout (checked with a local
  source in `--dry-run`); JSON `Init`/`Error` messages parse; `--dry-run --output-type json --log-level NONE` emits `Dryrun` messages (`Source`, `SourceSize`, `EntityType`) and writes nothing under `~/.azcopy` (checked with a local source); a copy with invalid AWS credentials is reported as a failed run.
* Verified for the terminal UI: the flow against a scripted fake of the prompt library and a fake azcopy (tests), and the real prompt library rendering the menu from piped keystrokes. The dashboard is verified through its renderer at several widths and a fake terminal stream (one write per redraw, cursor handling, result panel). Not verified: interactive use, resizing and Ctrl+C during a copy in Windows Terminal at different widths and with `NO_COLOR=1`.
* Not verified (no S3 bucket / storage account was available): the shape of `Progress`/`EndOfJob` payloads (taken from azcopy's source),
  `--include-after` and `--overwrite=ifSourceNewer` against S3 sources, the exact `Src`/`Source` format azcopy reports for S3 objects (failed transfers and `list`), and the
  "no transfers were scheduled" message azcopy prints when a delta run matches nothing.
* `retry` relies on azcopy's `--list-of-files`, a flag that exists but is missing from `azcopy copy --help`, and that is untested with
  S3 sources. If it does not work for you, re-run the same `copy` (append-only runs are idempotent) or use `resume`.
