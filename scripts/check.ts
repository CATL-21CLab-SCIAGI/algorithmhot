// Reproducible offline acceptance on a fresh project-owned test database. No real model transport.
import { spawnSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const stamp=new Date().toISOString().replace(/[-:.]/g,'');
const out=path.join(root,'.data/checks',stamp);mkdirSync(out,{recursive:true});
const local=parseEnv(readFileSync(path.join(root,'.env'),'utf8'));
const name=`algorithmhot_check_${Date.now()}_test`;
const db=new URL(local.DATABASE_URL!);db.pathname=`/${name}`;
const env={...process.env,DATABASE_URL:db.toString(),MODEL_CALLS_ENABLED:'true',COLLECT_ENABLED:'false',LLM_TRANSPORT:'openai_compatible',
 RESEARCH_ADMISSION_ENABLED:'false',RESEARCH_REPORTS_ENABLED:'false',MODEL_RUN_ID:'',AIHOT_CREDENTIALS_DIR:'/nonexistent-test-credentials',
 PATH:`${path.join(root,'.data/local/bin')}:${process.env.PATH}`};
const checks:Array<{name:string;status:string;durationMs:number}>=[];
function step(label:string,bin:string,args:string[]){
 const start=Date.now(); const r=spawnSync(bin,args,{cwd:root,env,encoding:'utf8',maxBuffer:64*1024*1024});
 const log=`${r.stdout??''}\n${r.stderr??''}`.split(db.toString()).join('[test database]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[database redacted]');
 writeFileSync(path.join(out,`${label}.log`),log,{mode:0o600});
 checks.push({name:label,status:r.status===0?'PASS':'FAIL',durationMs:Date.now()-start});
 writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2),{mode:0o600});
 console.log(`${label}: ${r.status===0?'PASS':'FAIL'} (${Date.now()-start} ms)`);
 if(r.status!==0)throw new Error(`${label} failed; inspect ${out}`);
}
step('clients',process.execPath,['scripts/setup-pg-tools.ts']);
step('create-test-db','docker',['--context','colima-algorithmhot','exec','algorithmhot-db','createdb','-U','algorithmhot',name]);
try{
 step('migrations',process.execPath,['scripts/migrate.ts']);
 step('industry',process.execPath,['industry/validate.mjs']);
 step('typecheck','npm',['run','typecheck']);
 step('database-tests',process.execPath,['--test','--test-concurrency=1','--test-timeout=120000','tests/*.test.ts']);
 step('web-build','npm',['run','build','-w','@aihot/web']);
 step('web-tests',process.execPath,['--test','apps/web/tests/*.test.ts']);
 step('diff','git',['diff','--check']);
 step('drop-test-db','docker',['--context','colima-algorithmhot','exec','algorithmhot-db','dropdb','-U','algorithmhot',name]);
 console.log(`All offline checks passed. ${path.join(out,'checks.json')}`);
}catch(error){
 writeFileSync(path.join(out,'test.env'),`DATABASE_URL=${db}\n`,{mode:0o600});
 console.error(String(error));process.exitCode=1;
}
