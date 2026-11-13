// Minimal stand-in for azcopy used by the tests. Emits the same JSON line protocol.
//
// Environment switches:
//   FAKE_ARGS_FILE        append the arguments of every run (one JSON array per line)
//   FAKE_CHATTER          emit Info / stderr lines that carry secrets (they must be redacted)
//   FAKE_NO_TRANSFERS     answer a copy with "no transfers were scheduled"
//   FAKE_DRYRUN_COUNT     a --dry-run lists N files, d<i%3>/obj-<i>.bin of size 10*i, instead of the two fixed ones
//   FAKE_DRYRUN_COUNTS    "25,5,0": the same, one entry per dry run in turn (the last one repeats; 0 lists nothing);
//                         the dry runs are counted in <FAKE_ARGS_FILE>.dryruns
//   FAKE_DELAY_MS         a copy job takes this long (to see jobs running at once)
//   FAKE_EVENTS_FILE      append "start <ms>" / "end <ms>" lines for every copy job (to measure concurrency)
//   FAKE_FAIL_LIST        --list-of-files jobs fail these paths: "a.txt,b.txt:2" (":N" = only the first N times;
//                         the counts are kept in <FAKE_ARGS_FILE>.fails)
//   FAKE_ALL_FAILED       a job in which every file fails ends as `Failed`, as azcopy does, not CompletedWithErrors
import fs from 'node:fs';

const args = process.argv.slice(2);
const emit = (type, content) =>
  process.stdout.write(
    `${JSON.stringify({
      TimeStamp: new Date().toISOString(),
      MessageType: type,
      MessageContent: typeof content === 'string' ? content : JSON.stringify(content),
      PromptDetails: { PromptType: '', ResponseOptions: null, PromptTarget: '' },
    })}\n`,
  );

const S3 = 'https://s3.amazonaws.com/bkt/data';
const failed = (name) => ({
  Src: `${S3}/${name.split('/').map(encodeURIComponent).join('/')}`,
  Dst: `https://acct.blob.core.windows.net/c/data/${name}?sig=SECRETSIG123`,
  IsFolderProperties: false,
  TransferStatus: 'Failed',
  TransferSize: '10',
  ErrorCode: '403',
});
const base = {
  ErrorMsg: '',
  ActiveConnections: '8',
  JobStatus: 'InProgress',
  CompleteJobOrdered: true,
  FileTransfers: '4',
  FolderPropertyTransfers: '0',
  TotalTransfers: '4',
  TransfersCompleted: '0',
  TransfersFailed: '0',
  TransfersSkipped: '0',
  FoldersCompleted: '0',
  FoldersFailed: '0',
  FoldersSkipped: '0',
  TotalBytesTransferred: '0',
  TotalBytesEnumerated: '4000',
  TotalBytesExpected: '4000',
  PercentComplete: '0',
  FailedTransfers: [],
  SkippedTransfers: [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (name) => process.env.FAKE_EVENTS_FILE && fs.appendFileSync(process.env.FAKE_EVENTS_FILE, `${name} ${Date.now()}\n`);

/** The paths of the FAKE_FAIL_LIST that fail in this job, among the `listed` ones. */
function failingPaths(listed) {
  const failing = [];
  const countsFile = process.env.FAKE_ARGS_FILE ? `${process.env.FAKE_ARGS_FILE}.fails` : null;
  const counts = countsFile && fs.existsSync(countsFile) ? fs.readFileSync(countsFile, 'utf8').split('\n').filter(Boolean) : [];
  for (const entry of (process.env.FAKE_FAIL_LIST ?? '').split(',').filter(Boolean)) {
    const [name, times] = entry.split(/:(?=\d+$)/);
    if (!listed.includes(name)) continue;
    if (times !== undefined && counts.filter((c) => c === name).length >= Number(times)) continue;
    failing.push(name);
    if (countsFile) fs.appendFileSync(countsFile, `${name}\n`);
  }
  return failing;
}

/** The file count of this dry run: FAKE_DRYRUN_COUNTS in turn, else FAKE_DRYRUN_COUNT (NaN: the fixed files). */
function dryRunCount() {
  const counts = (process.env.FAKE_DRYRUN_COUNTS ?? '').split(',').filter(Boolean).map(Number);
  if (counts.length === 0) return Number(process.env.FAKE_DRYRUN_COUNT) || NaN;
  const file = `${process.env.FAKE_ARGS_FILE}.dryruns`;
  const done = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
  fs.appendFileSync(file, '.');
  return counts[Math.min(done, counts.length - 1)];
}

if (args[0] === '--version') {
  console.log('azcopy version 10.99.0-fake');
} else {
  if (process.env.FAKE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify(args)}\n`);
  if (args.includes('--dry-run')) {
    const item = (name, size, type = 'File') => emit('Dryrun', { EntityType: type, FromTo: 'S3Blob', Source: `${S3}/${name.split('/').map(encodeURIComponent).join('/')}`, Destination: 'dst', SourceSize: size });
    const count = dryRunCount();
    if (count >= 0) {
      for (let i = 1; i <= count; i++) item(`d${i % 3}/obj-${String(i).padStart(5, '0')}.bin`, i * 10);
    } else {
      item('a b.txt', 10);
      item('dir/c.txt', 20);
      item('dir', 0, 'Folder');
    }
    emit('EndOfJob', '');
  } else if (args[0] === 'jobs' && args[1] === 'show') {
    emit('EndOfJob', { ErrorMsg: '', JobID: 'job-1', Details: [failed('a b.txt'), failed('dir/c.txt')] });
  } else if (process.env.FAKE_NO_TRANSFERS) {
    emit('Error', 'no transfers were scheduled because no files matched the specified criteria');
    process.exitCode = 1;
  } else if (args.includes('--list-of-files') || (args[0] === 'jobs' && args[1] === 'resume')) {
    const resuming = args[0] === 'jobs';
    emit('Init', { JobID: resuming ? args[2] : 'job-2', LogFileLocation: 'x.log' });
    event('start');
    const listed = resuming ? [] : fs.readFileSync(args[args.indexOf('--list-of-files') + 1], 'utf8').split('\n').filter(Boolean);
    const n = listed.length;
    if (process.env.FAKE_DELAY_MS) {
      await sleep(Number(process.env.FAKE_DELAY_MS) / 2);
      emit('Progress', { ...base, FileTransfers: String(n), TotalTransfers: String(n), TransfersCompleted: String(Math.floor(n / 2)), TotalBytesTransferred: '1000', TotalBytesExpected: '2000' });
      await sleep(Number(process.env.FAKE_DELAY_MS) / 2);
    }
    const bad = failingPaths(listed);
    event('end');
    emit('EndOfJob', {
      ...base,
      // like azcopy, `Failed` when every transfer of the job failed (FAKE_ALL_FAILED)
      JobStatus: bad.length === 0 ? 'Completed' : process.env.FAKE_ALL_FAILED && bad.length === n ? 'Failed' : 'CompletedWithErrors',
      FileTransfers: String(n),
      TotalTransfers: String(n),
      TransfersCompleted: String(n - bad.length),
      TransfersFailed: String(bad.length),
      TotalBytesTransferred: '2000',
      PercentComplete: '100',
      FailedTransfers: bad.map(failed),
    });
    if (bad.length > 0) process.exitCode = 1;
  } else {
    emit('Init', { JobID: 'job-1', LogFileLocation: 'x.log' });
    if (process.env.FAKE_CHATTER) {
      emit('Info', 'listing https://acct.blob.core.windows.net/c?sig=SECRETSIG123');
      process.stderr.write('note awssecretawssecretawssecret\n');
    }
    emit('Progress', { ...base, CompleteJobOrdered: false, TransfersCompleted: '1', TotalBytesTransferred: '1000', FailedTransfers: [failed('a b.txt')] });
    emit('EndOfJob', {
      ...base,
      JobStatus: 'CompletedWithErrors',
      TransfersCompleted: '1',
      TransfersFailed: '2',
      TransfersSkipped: '1',
      TotalBytesTransferred: '1000',
      PercentComplete: '25',
    });
    process.exitCode = 1;
  }
}
