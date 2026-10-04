import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'.data/local/bin');
mkdirSync(dir,{recursive:true});
const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";
for(const name of ['pg_dump','pg_restore'])writeFileSync(path.join(dir,name),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root,'scripts/pg-client.ts'))} ${name} "$@"\n`,{mode:0o700});
console.log('Project-only PostgreSQL client wrappers ready in .data/local/bin');
