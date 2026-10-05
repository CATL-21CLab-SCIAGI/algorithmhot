import { spawnSync } from "node:child_process";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, copyFile, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditBundle, destination, verifyPushUrls, safeGitEnvironment, validateApprovedHeads, verifyApprovedHistory, auditStageFiles, validatePaperFigures, assertPaperFigurePng, assertPagesBranch, PAGES_BRANCH } from '../scripts/pages-publisher.ts';
import type { PublicPaperFigure } from '../scripts/pages-publisher.ts';
const repo='PKUCY2016/algorithmhot';
const branch=PAGES_BRANCH;
async function fixture(extra: Record<string,string | Uint8Array>={}) {
 const dir=await mkdtemp(path.join(tmpdir(),'algorithmhot-public-'));
 const files={ 'index.html':'<!doctype html><h1>科研热点</h1>', '.nojekyll':'', ...extra };
 for(const [name,value] of Object.entries(files)){ await mkdir(path.dirname(path.join(dir,name)),{recursive:true});await writeFile(path.join(dir,name),value); }
 await writeFile(path.join(dir,'export-manifest.json'),JSON.stringify({schemaVersion:1,publicBaseUrl:destination(repo).base,generatedAt:new Date().toISOString(),files:Object.entries(files).map(([name,value])=>({path:name,sha256:createHash('sha256').update(value).digest('hex'),bytes:Buffer.byteLength(value)}))}));
 return dir;
}
test('audited Pages export binds full inventory, hashes and exact project URL',async()=>{
 const dir=await fixture({'assets/style.css':'body{color:teal}'});
 try { assert.equal((await auditBundle(dir,repo)).files.length,3); await assert.rejects(auditBundle(dir,'PKUCY2016/other'),/identity/);
 await writeFile(path.join(dir,'index.html'),'changed');await assert.rejects(auditBundle(dir,repo),/checksum/); } finally {await rm(dir,{recursive:true});}
});
test('unlisted secrets and symlink files are rejected',async()=>{
 const dir=await fixture();
 try { await writeFile(path.join(dir,'.env'),'secret');await assert.rejects(auditBundle(dir,repo),/inventory/);await rm(path.join(dir,'.env'));
 await symlink(path.join(dir,'index.html'),path.join(dir,'linked.html'));await assert.rejects(auditBundle(dir,repo),/symbolic/); } finally {await rm(dir,{recursive:true});}
});
test('private configuration and executable markup are rejected even with valid hashes',async()=>{
 for(const content of ['http://127.0.0.1:3101/api','/Users/example/.env','postgres://user:pass@db/a','<script>alert(1)</script>','<svg onload="x"/>']){
  const dir=await fixture({'page.html':content});try {await assert.rejects(auditBundle(dir,repo));}finally{await rm(dir,{recursive:true});}
 }
});
test('git metadata is ignored only at the root of the registered public checkout',async()=>{
 const dir=await fixture();try { await mkdir(path.join(dir,'.git'));await writeFile(path.join(dir,'.git','config'),'local');
 await assert.rejects(auditBundle(dir,repo),/inventory/);assert.equal((await auditBundle(dir,repo,true)).files.length,2);
 } finally{await rm(dir,{recursive:true});}
});

test('manifest itself rejects private markers and unknown fields in root or file entries',async()=>{
 for(const mutation of [
  (m:any)=>{m.privateConfig='DATABASE_URL=postgres://fake:fake@localhost/db';},
  (m:any)=>{m.extra='innocent but not a public schema field';},
  (m:any)=>{m.files[0].privatePayload='not allowed';},
  (m:any)=>{m.files[0].sha256='a'.repeat(63);},
 ]){
  const dir=await fixture();try { const m=JSON.parse(await readFile(path.join(dir,'export-manifest.json'),'utf8'));mutation(m);await writeFile(path.join(dir,'export-manifest.json'),JSON.stringify(m));await assert.rejects(auditBundle(dir,repo)); }
  finally{await rm(dir,{recursive:true});}
 }
});
test('push URL must be one exact target, not an alternate or additional push remote',()=>{
 const remote=destination(repo).remote;verifyPushUrls(remote,remote);
 assert.throws(()=>verifyPushUrls('https://github.com/other/target.git',remote),/push destination/);
 assert.throws(()=>verifyPushUrls(`${remote}\nhttps://github.com/other/target.git`,remote),/push destination/);
});
test('Git subprocesses cannot inherit alternate checkout/index/config or tracing variables',()=>{
 const env=safeGitEnvironment({PATH:'/bin',HOME:'/tmp/example',GH_TOKEN:'fake',GIT_DIR:'/private/repo',GIT_WORK_TREE:'/private/tree',GIT_INDEX_FILE:'/private/index',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/private/hooks',GIT_TRACE:'1',GIT_ASKPASS:'/private/prompt'});
 assert.equal(env.GH_TOKEN,'fake');assert.equal(env.PATH,'/bin');assert.equal(env.GIT_TERMINAL_PROMPT,'0');
 assert.deepEqual(Object.keys(env).filter(k=>k.startsWith('GIT_')).sort(),['GIT_TERMINAL_PROMPT']);
 assert.equal(env.GIT_CONFIG_NOSYSTEM,undefined,'installed keychain credential helpers remain available');
});
test('every unpublished ancestor must have a registered approved commit receipt',()=>{
 const record=validateApprovedHeads({version:1,repo,branch,heads:[{sha:'a'.repeat(40),manifestSha256:'b'.repeat(64),createdAt:new Date().toISOString()}]},repo);
 verifyApprovedHistory(['a'.repeat(40)],record);
 assert.throws(()=>verifyApprovedHistory(['a'.repeat(40),'c'.repeat(40)],record),/Unregistered unpublished/);
 assert.throws(()=>validateApprovedHeads(record,'other/repo'),/Invalid approved/);
 assert.throws(()=>validateApprovedHeads({...record,branch:'main'},repo),/controlled migration/);
 const {branch:_,...legacy}=record;
 assert.throws(()=>validateApprovedHeads(legacy,repo),/controlled migration/);
});
test('publisher branch is fixed and does not accept legacy, detached or arbitrary branches',()=>{
 assert.equal(PAGES_BRANCH,'gh-pages');
 assert.doesNotThrow(()=>assertPagesBranch('gh-pages','Test checkout'));
 for(const branch of [undefined,null,'','main','source','refs/heads/gh-pages']) assert.throws(()=>assertPagesBranch(branch,'Test checkout'),/controlled migration/);
});
test('staging recovery accepts mixed verified old/new bytes and rejects user changes or symlinks',async()=>{
 const dir=await fixture();
 try {
  const manifest=await auditBundle(dir,repo),raw=await readFile(path.join(dir,'export-manifest.json'));
  const oldFiles=[...manifest.files,{path:'export-manifest.json',bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')}];
  const updated='<h1>next public issue</h1>';
  const next=oldFiles.map(file=>file.path==='index.html'?{path:file.path,bytes:Buffer.byteLength(updated),sha256:createHash('sha256').update(updated).digest('hex')}:file);
  const hash=oldFiles.find(f=>f.path==='export-manifest.json')!.sha256;
  const journal={version:1 as const,repo,branch,oldHead:'a'.repeat(40),phase:'copying' as const,oldManifestSha256:hash,newManifestSha256:hash,oldFiles,newFiles:next};
  await writeFile(path.join(dir,'index.html'),updated);await auditStageFiles(dir,journal,repo);
  await assert.rejects(auditStageFiles(dir,{...journal,branch:'main'} as unknown as typeof journal,repo),/controlled migration/);
  const {branch:_,...legacy}=journal;
  await assert.rejects(auditStageFiles(dir,legacy as unknown as typeof journal,repo),/controlled migration/);
  await writeFile(path.join(dir,'index.html'),'a user edit');await assert.rejects(auditStageFiles(dir,journal,repo),/user modification/);
  await writeFile(path.join(dir,'index.html'),updated);await writeFile(path.join(dir,'personal.txt'),'personal');await assert.rejects(auditStageFiles(dir,journal,repo),/Unrecognized/);
  await rm(path.join(dir,'personal.txt'));await symlink(path.join(dir,'index.html'),path.join(dir,'linked.html'));await assert.rejects(auditStageFiles(dir,journal,repo),/symbolic/);
 }finally{await rm(dir,{recursive:true});}
});

test('publisher CLI restores only its journaled generated checkout without network access',async()=>{
 const app=await realpath(await mkdtemp(path.join(tmpdir(),'algorithmhot-publisher-cli-')));
 const projectRoot=path.resolve(import.meta.dirname,'..');
 try {
  await mkdir(path.join(app,'scripts/daily-delivery'),{recursive:true});
  for(const file of ['pages-publisher.ts','publish-pages.ts','daily-delivery/core.ts']) await copyFile(path.join(projectRoot,'scripts',file),path.join(app,'scripts',file));
  await writeFile(path.join(app,'package.json'),'{"type":"module"}');
  await symlink(path.join(projectRoot,'node_modules'),path.join(app,'node_modules'),'dir');
  const checkout=path.join(app,'.data/pages-repo'),state=path.join(app,'.data/pages-publisher');
  await mkdir(checkout,{recursive:true});await mkdir(state,{recursive:true});
  const runGit=(args:string[])=>{
   const result=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:checkout,encoding:'utf8',env:{...safeGitEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'}});
   assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  runGit(['init','-b',branch]);runGit(['remote','add','origin',destination(repo).remote]);runGit(['config','user.name','Test']);runGit(['config','user.email','test@example.invalid']);
  const source=await fixture();
  let oldFiles;
  try {
   const manifest=await auditBundle(source,repo),bytes=await readFile(path.join(source,'export-manifest.json'));
   oldFiles=[...manifest.files,{path:'export-manifest.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
   for(const file of oldFiles) await copyFile(path.join(source,file.path),path.join(checkout,file.path));
  }finally{await rm(source,{recursive:true});}
  runGit(['add','--all']);runGit(['commit','-m','Known public baseline']);const oldHead=runGit(['rev-parse','HEAD']);
  const next='<h1>Generated next issue</h1>',nextFile={path:'next.html',bytes:Buffer.byteLength(next),sha256:createHash('sha256').update(next).digest('hex')};
  const manifestHash=oldFiles.find(file=>file.path==='export-manifest.json')!.sha256;
  const journal={version:1,repo,branch,oldHead,phase:'copying',oldManifestSha256:manifestHash,newManifestSha256:manifestHash,oldFiles,newFiles:[...oldFiles,nextFile]};
  await writeFile(path.join(state,'checkout.json'),JSON.stringify({path:checkout,repo,branch}));
  await writeFile(path.join(state,'staging.json'),JSON.stringify(journal));
  await rm(path.join(checkout,'index.html'));await writeFile(path.join(checkout,'next.html'),next);runGit(['add','--all']);
  const recover=()=>spawnSync(process.execPath,[path.join(app,'scripts/publish-pages.ts'),'--recover-stage'],{cwd:app,encoding:'utf8'});
  // Fail before recovery writes on old markers, mismatched current branches or old approval state.
  for(const marker of [{path:checkout,repo},{path:checkout,repo,branch:'main'}]){
   await writeFile(path.join(state,'checkout.json'),JSON.stringify(marker));
   const rejected=recover();assert.equal(rejected.status,1);assert.match(rejected.stderr,/controlled migration/);
   assert.equal(await readFile(path.join(checkout,'next.html'),'utf8'),next);
   assert.equal(runGit(['branch','--show-current']),branch);
  }
  await writeFile(path.join(state,'checkout.json'),JSON.stringify({path:checkout,repo,branch}));
  runGit(['branch','-m','main']);
  const wrongBranch=recover();assert.equal(wrongBranch.status,1);assert.match(wrongBranch.stderr,/Public checkout branch.*controlled migration/);
  assert.equal(await readFile(path.join(checkout,'next.html'),'utf8'),next);
  runGit(['branch','-m',branch]);
  await writeFile(path.join(state,'approved-heads.json'),JSON.stringify({version:1,repo,heads:[]}));
  const wrongHistory=recover();assert.equal(wrongHistory.status,1);assert.match(wrongHistory.stderr,/Approved publisher history.*controlled migration/);
  await writeFile(path.join(state,'approved-heads.json'),JSON.stringify({version:1,repo,branch,heads:[]}));
  await writeFile(path.join(state,'staging.json'),JSON.stringify({...journal,branch:'main'}));
  const wrongJournal=recover();assert.equal(wrongJournal.status,1);assert.match(wrongJournal.stderr,/recovery journal.*controlled migration/);
  await writeFile(path.join(state,'staging.json'),JSON.stringify(journal));
  const result=recover();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/"networkRequests":0/);assert.match(result.stdout,/"branch":"gh-pages"/);
  assert.equal(runGit(['status','--porcelain']),'');assert.equal(runGit(['rev-parse','HEAD']),oldHead);
  await writeFile(path.join(state,'staging.json'),JSON.stringify(journal));await writeFile(path.join(checkout,'index.html'),'user changes');
  const rejected=recover();assert.equal(rejected.status,1);assert.match(rejected.stderr,/user modification/);
  assert.equal(await readFile(path.join(checkout,'index.html'),'utf8'),'user changes');
 }finally{await rm(app,{recursive:true,force:true});}
});

const reviewedFigure: PublicPaperFigure = {
 itemId:'paper1',sourceRevision:2,imageOrigin:'remote',imageUrl:'https://arxiv.org/html/2610.01234v2/figure1.png',sourceUrl:'https://arxiv.org/html/2610.01234v2#S2.F1',figureLabel:'Figure 1',caption:'Original method diagram.',attribution:'Author et al.',licenseName:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',verifiedAt:'2026-10-04T08:00:00.000Z',width:640,height:320,contentType:'image/png',sha256:'a'.repeat(64),
};
function figurePackage(figure=reviewedFigure): Record<string,string | Uint8Array> {
 const src=figure.imageOrigin==='remote'?figure.imageUrl:`/algorithmhot/assets${figure.imageUrl}`;
 const origin=figure.imageOrigin==='remote'?` ${new URL(figure.imageUrl).origin}`:'';
 const html=`<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:${origin}; base-uri 'none'; form-action 'none'"></head><body><figure data-paper-figure="true" data-item-id="paper1" data-source-revision="2"><img data-paper-figure="paper1" src="${src}" alt="Original figure" width="${figure.width}" height="${figure.height}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><figcaption>${figure.figureLabel} ${figure.caption} ${figure.attribution} <a href="${figure.sourceUrl}">Source</a> <a href="${figure.licenseUrl}">${figure.licenseName}</a></figcaption></figure></body>`;
 return {'pilot/2026-10-03/index.html':html,'data/paper-figures.json':JSON.stringify({schemaVersion:1,figures:[figure]}),'data/snapshot.json':JSON.stringify({items:[{id:'paper1'}],reports:[{kind:'pilot',key:'2026-10-03',revision:1,sections:[{items:[{itemId:'paper1',available:true,researchBrief:{sourceRevision:2}}]}]}]})};
}
test('reviewed external images are bound to published citation revisions and precise per-page CSP',async()=>{
 const dir=await fixture(figurePackage());try{await auditBundle(dir,repo);}finally{await rm(dir,{recursive:true});}
 for(const transform of [
  (files:Record<string,string|Uint8Array>)=>{delete files['data/paper-figures.json'];},
  (files:Record<string,string|Uint8Array>)=>{files['data/snapshot.json']=String(files['data/snapshot.json']).replace('"sourceRevision":2','"sourceRevision":1');},
  (files:Record<string,string|Uint8Array>)=>{files['pilot/2026-10-03/index.html']=String(files['pilot/2026-10-03/index.html']).replace('figure1.png','wrong.png');},
  (files:Record<string,string|Uint8Array>)=>{files['pilot/2026-10-03/index.html']=String(files['pilot/2026-10-03/index.html']).replace('referrerpolicy="no-referrer"','srcset="https://other.example/image.png 2x"');},
  (files:Record<string,string|Uint8Array>)=>{files['pilot/2026-10-03/index.html']=String(files['pilot/2026-10-03/index.html']).replace('Author et al.','Different author');},
  (files:Record<string,string|Uint8Array>)=>{files['pilot/2026-10-03/index.html']=String(files['pilot/2026-10-03/index.html']).replace("data: https://arxiv.org;","data: https:;");},
  (files:Record<string,string|Uint8Array>)=>{files['index.html']=files['pilot/2026-10-03/index.html'];},
 ]){
  const files=figurePackage();transform(files);const bad=await fixture(files);try{await assert.rejects(auditBundle(bad,repo));}finally{await rm(bad,{recursive:true});}
 }
});
test('paper figure schema rejects unknown fields, local origins, credentials, duplicate identities and path escapes',()=>{
 validatePaperFigures({schemaVersion:1,figures:[reviewedFigure]});
 for(const patch of [{secret:'not public'},{sourceRevision:0},{imageUrl:'http://arxiv.org/image.png'},{imageUrl:'https://127.0.0.1/image.png'},{imageUrl:'https://a.local/image.png'},{imageUrl:'https://user:pass@arxiv.org/image.png'},{imageUrl:'https://arxiv.org/image.png#fragment'},{imageOrigin:'pdf-extract',imageUrl:'/paper-figures/../private.png'},{sha256:'bad'}]){
  assert.throws(()=>validatePaperFigures({schemaVersion:1,figures:[{...reviewedFigure,...patch}]}));
 }
 assert.throws(()=>validatePaperFigures({schemaVersion:1,figures:[reviewedFigure,reviewedFigure]}),/Duplicate/);
});
test('PDF-extracted PNG files require approved path, exact bytes, MIME and dimensions',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=','base64');
 const local:PublicPaperFigure={...reviewedFigure,imageOrigin:'pdf-extract',imageUrl:'/paper-figures/original-figure.png',width:1,height:1,sha256:createHash('sha256').update(png).digest('hex')};
 assertPaperFigurePng(png,local);
 assert.throws(()=>assertPaperFigurePng(png,{...local,width:2}),/dimensions or hash/);
 assert.throws(()=>assertPaperFigurePng(Buffer.from('<svg/>'),local),/signature/);
 assert.throws(()=>assertPaperFigurePng(png,{...local,contentType:'image/svg+xml'}),/signature/);
 const good=await fixture({...figurePackage(local),'assets/paper-figures/original-figure.png':png});
 try{await auditBundle(good,repo);}finally{await rm(good,{recursive:true});}
 const invalidFiles: Array<Record<string,string | Uint8Array>> = [figurePackage(local),{...figurePackage(local),'assets/paper-figures/original-figure.png':Buffer.from(png).fill(0,16,20)},{'assets/paper-figures/unregistered.png':png},{'assets/arbitrary.png':png}];
 for(const files of invalidFiles){
  const bad=await fixture(files);try{await assert.rejects(auditBundle(bad,repo));}finally{await rm(bad,{recursive:true});}
 }
});

test('publisher uses only gh-pages refs while a local mock remote main source branch stays unchanged',async()=>{
 const app=await realpath(await mkdtemp(path.join(tmpdir(),'algorithmhot-branch-publish-')));
 const source=await fixture();
 const realGit=spawnSync('/bin/sh',['-c','command -v git'],{encoding:'utf8'}).stdout.trim();
 try{
  const projectRoot=path.resolve(import.meta.dirname,'..'),remote=path.join(app,'remote.git'),seed=path.join(app,'source-seed'),bin=path.join(app,'bin'),log=path.join(app,'git-network.jsonl');
  await mkdir(path.join(app,'scripts/daily-delivery'),{recursive:true});await mkdir(bin);await mkdir(seed);
  for(const file of ['pages-publisher.ts','publish-pages.ts','daily-delivery/core.ts']) await copyFile(path.join(projectRoot,'scripts',file),path.join(app,'scripts',file));
  await writeFile(path.join(app,'package.json'),'{"type":"module"}');await symlink(path.join(projectRoot,'node_modules'),path.join(app,'node_modules'),'dir');
  const runGit=(args:string[],cwd=seed)=>{const r=spawnSync(realGit,['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',env:{...safeGitEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  runGit(['init','--bare',remote],app);runGit(['init','-b','main']);runGit(['config','user.name','Test']);runGit(['config','user.email','test@example.invalid']);
  await writeFile(path.join(seed,'source.ts'),'export const sourceOnly = true;\n');runGit(['add','source.ts']);runGit(['commit','-m','Source remains on main']);runGit(['push',remote,'main']);
  const mainBefore=runGit(['rev-parse','refs/heads/main'],remote);
  // Network verbs are redirected to an isolated on-disk bare Git repository. No network is used.
  const wrapper=`#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);let command=0;while(args[command]==='-c')command+=2;
if(['fetch','push','ls-remote'].includes(args[command])){
 appendFileSync(process.env.TEST_PAGES_GIT_LOG,JSON.stringify(args.slice(command))+'\\n');
 const origin=args.indexOf('origin',command+1);if(origin<0)process.exit(97);
 args[origin]=process.env.TEST_PAGES_REMOTE;
}
const result=spawnSync(process.env.TEST_PAGES_REAL_GIT,['-c','commit.gpgsign=false',...args],{stdio:'inherit',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null'}});process.exit(result.status??98);
`;
  await writeFile(path.join(bin,'git'),wrapper);await chmod(path.join(bin,'git'),0o755);
  const publish=()=>spawnSync(process.execPath,[path.join(app,'scripts/publish-pages.ts'),'--source',source],{cwd:app,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TEST_PAGES_REAL_GIT:realGit,TEST_PAGES_REMOTE:remote,TEST_PAGES_GIT_LOG:log}});
  const first=publish();assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/"branch":"gh-pages"/);
  const state=path.join(app,'.data/pages-publisher'),checkout=path.join(app,'.data/pages-repo');
  for(const file of ['checkout.json','approved-heads.json','receipt.json'])assert.equal(JSON.parse(await readFile(path.join(state,file),'utf8')).branch,'gh-pages');
  assert.equal(runGit(['branch','--show-current'],checkout),'gh-pages');
  const second=publish();assert.equal(second.status,0,second.stderr);
  // A new independent checkout may fast-forward its unborn gh-pages branch from the existing ref.
  await rm(checkout,{recursive:true});await rm(state,{recursive:true});
  const fresh=publish();assert.equal(fresh.status,0,fresh.stderr);
  assert.equal(runGit(['rev-parse','refs/heads/main'],remote),mainBefore);
  assert.equal(runGit(['show','refs/heads/main:source.ts'],remote),'export const sourceOnly = true;');
  assert.equal(runGit(['rev-parse','HEAD'],checkout),runGit(['rev-parse','refs/heads/gh-pages'],remote));
  const commands=String(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
  assert.ok(commands.some(args=>args[0]==='fetch'));
  for(const args of commands){
   assert.equal(args.some(arg=>arg.includes('refs/heads/main')||arg.startsWith('+')||arg==='--force'||arg==='--mirror'),false);
   if(args[0]==='fetch')assert.deepEqual(args,['fetch','--no-tags','--refmap=','origin','refs/heads/gh-pages:refs/remotes/origin/gh-pages']);
   if(args[0]==='ls-remote')assert.deepEqual(args,['ls-remote','--heads','origin','refs/heads/gh-pages']);
   if(args[0]==='push')assert.equal(args.at(-1),'HEAD:refs/heads/gh-pages');
  }
 }finally{await rm(app,{recursive:true,force:true});await rm(source,{recursive:true,force:true});}
});
