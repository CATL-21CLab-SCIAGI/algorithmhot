// Use the project's PostgreSQL 17 client without a second host installation.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const tool = process.argv[2];
if (!['pg_dump','pg_restore'].includes(tool ?? '')) throw new Error('unsupported client');
let args = process.argv.slice(3), output: string | null = null, input: Buffer | undefined;
if (tool === 'pg_dump') {
  const i = args.indexOf('--file');
  if (i >= 0) { output = args[i+1]!; args.splice(i,2); }
} else {
  const last = args.at(-1);
  if (last && !last.startsWith('-') && !last.startsWith('postgres')) { input = readFileSync(last); args.pop(); }
}
args = args.map(a => {
  if (!/^postgres(?:ql)?:\/\//.test(a)) return a;
  const u = new URL(a);
  if (!['localhost','127.0.0.1'].includes(u.hostname)) throw new Error('Only the project local database is supported');
  u.hostname='127.0.0.1';u.port='5432';return u.toString();
});
const r = spawnSync('docker',['--context','colima-algorithmhot','exec','-i','algorithmhot-db',tool!,...args],{input,maxBuffer:128*1024*1024});
if (r.status!==0) {
  const diagnostic=(r.stderr?.toString()??r.error?.message??'client failure').replace(/postgres(?:ql)?:\/\/\S+/g,'[database redacted]');
  console.error(diagnostic);process.exit(r.status??1);
}
if(output)writeFileSync(output,r.stdout,{mode:0o600});else process.stdout.write(r.stdout);
