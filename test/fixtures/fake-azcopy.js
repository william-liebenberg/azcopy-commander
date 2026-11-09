// Minimal stand-in for azcopy used by the tests. Emits the same JSON line protocol.
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

if (args[0] === '--version') {
  console.log('azcopy version 10.99.0-fake');
} else {
  if (process.env.FAKE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify(args)}\n`);
  if (args.includes('--dry-run')) {
    const item = (name, size, type = 'File') => emit('Dryrun', { EntityType: type, FromTo: 'S3Blob', Source: `${S3}/${name.split('/').map(encodeURIComponent).join('/')}`, Destination: 'dst', SourceSize: size });
    item('a b.txt', 10);
    item('dir/c.txt', 20);
    item('dir', 0, 'Folder');
    emit('EndOfJob', '');
  } else if (args[0] === 'jobs' && args[1] === 'show') {
    emit('EndOfJob', { ErrorMsg: '', JobID: 'job-1', Details: [failed('a b.txt'), failed('dir/c.txt')] });
  } else if (process.env.FAKE_NO_TRANSFERS) {
    emit('Error', 'no transfers were scheduled because no files matched the specified criteria');
    process.exitCode = 1;
  } else if (args.includes('--list-of-files')) {
    emit('Init', { JobID: 'job-2', LogFileLocation: 'x.log' });
    const n = fs.readFileSync(args[args.indexOf('--list-of-files') + 1], 'utf8').split('\n').filter(Boolean).length;
    emit('EndOfJob', {
      ...base,
      JobStatus: 'Completed',
      FileTransfers: String(n),
      TotalTransfers: String(n),
      TransfersCompleted: String(n),
      TotalBytesTransferred: '2000',
      PercentComplete: '100',
    });
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
