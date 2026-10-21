import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nextIndex,publicProjection} from '../scripts/pstack-public-export.mjs';
const t='2026-10-21T04:00:00.000Z';
const example=()=>({
 schema_version:1,repo:'pcpcchen-coder/AIOS',run_id:'ci-a-1',title:'CI investigation',
 playbook:'investigation-ci',branch:'main',commit_sha:'a'.repeat(40),
 status:'passed',started_at:t,updated_at:t,ended_at:t,
 steps:[{id:'inspect',title:'Inspect',status:'passed',started_at:t,ended_at:t,
 note:'Inspected source',evidence:[{label:'CI',url:'https://github.com/pcpcchen-coder/AIOS/actions/runs/100'}]}],
 events:[{at:t,type:'step_updated',step_id:'inspect',status:'passed',note:'Complete'}]
});
test('exports a real run with bounded evidence and explicit CI provenance',()=>{
 const r=publicProjection(example());assert.equal(r.steps[0].status,'passed');
 assert.match(r.provenance,/not native pstack Agent/);assert.equal(r.events.length,1);
});
test('rejects sensitive strings and external evidence',()=>{
 let r=example();r.steps[0].note='ghp_ABCDEFGHIJKLMNO123456789';assert.throws(()=>publicProjection(r),/Sensitive/);
 r=example();r.steps[0].note='/Users/george/private';assert.throws(()=>publicProjection(r),/Sensitive/);
 r=example();r.steps[0].evidence[0].url='https://attacker.example/phish';assert.throws(()=>publicProjection(r),/Evidence/);
});
test('cannot forge repo, traversal IDs, or invalid stage success',()=>{
 let r=example();r.repo='other/name';assert.throws(()=>publicProjection(r),/identity/);
 r=example();r.run_id='../broken';assert.throws(()=>publicProjection(r),/identity/);
 r=example();r.steps[0].status='faked';assert.throws(()=>publicProjection(r),/stage/);
 r=example();r.steps.push({...r.steps[0]});assert.throws(()=>publicProjection(r),/stage/);
});

const exporter=resolve(fileURLToPath(new URL('../scripts/pstack-public-export.mjs',import.meta.url)));
const git=(cwd,...a)=>{const p=spawnSync('git',['-c','user.name=t','-c','user.email=t@example.com',...a],{cwd,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
function telemetryRemote(){
 const bare=mkdtempSync(join(tmpdir(),'pstack-bare-'));git(bare,'init','--quiet','--bare');
 const seed=mkdtempSync(join(tmpdir(),'pstack-seed-'));git(seed,'init','--quiet');git(seed,'checkout','--quiet','-b','telemetry/pstack');
 mkdirSync(join(seed,'observability','public'),{recursive:true});
 writeFileSync(join(seed,'observability','public','index.json'),JSON.stringify({schema_version:1,repo:'pcpcchen-coder/AIOS',updated_at:t,runs:[{run_id:'older',updated_at:'2026-10-20T00:00:00.000Z'}]}));
 git(seed,'add','.');git(seed,'commit','--quiet','-m','seed');git(seed,'push','--quiet',bare,'telemetry/pstack');
 const work=mkdtempSync(join(tmpdir(),'pstack-work-'));git(work,'init','--quiet');git(work,'remote','add','origin',bare);
 mkdirSync(join(work,'.pstack','observability','runs'),{recursive:true});
 const run={...example(),run_id:'agent-run-1',playbook:'feature'};
 writeFileSync(join(work,'.pstack','observability','runs','agent-run-1.json'),JSON.stringify(run));
 return {bare,work};
}
const exportRun=(work,env)=>spawnSync(process.execPath,[exporter,'--run','agent-run-1','--workspace',work,'--public-ok'],{
 encoding:'utf8',env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:'',PSTACK_OBSERVE_PUBLICATION_ACK:'1',...env}
});
test('publishes with git push to telemetry/pstack when no API token is available',()=>{
 const {bare,work}=telemetryRemote();
 const out=exportRun(work,{});assert.equal(out.status,0,out.stderr);
 const run=JSON.parse(git(bare,'show','telemetry/pstack:observability/public/runs/agent-run-1.json'));
 assert.equal(run.run_id,'agent-run-1');assert.equal(run.provenance,'Agent self-reported');
 const index=JSON.parse(git(bare,'show','telemetry/pstack:observability/public/index.json'));
 assert.deepEqual(index.runs.map(x=>x.run_id),['agent-run-1','older']);
 assert.equal(exportRun(work,{PSTACK_PUBLISH_TRANSPORT:'git'}).status,0,'republishing the same run is idempotent');
 assert.deepEqual(JSON.parse(git(bare,'show','telemetry/pstack:observability/public/index.json')).runs.map(x=>x.run_id),['agent-run-1','older']);
});
test('rejects an unknown transport and still requires the publication flag',()=>{
 const {work}=telemetryRemote();
 assert.match(exportRun(work,{PSTACK_PUBLISH_TRANSPORT:'ftp'}).stderr,/must be auto, api or git/);
 assert.match(exportRun(work,{PSTACK_OBSERVE_PUBLICATION_ACK:''}).stderr,/explicit approval flag/);
});
test('index keeps one entry per run, newest first, at most 100',()=>{
 const r=publicProjection(example());
 const old={schema_version:1,repo:'pcpcchen-coder/AIOS',runs:Array.from({length:120},(_,i)=>({run_id:'r'+i,updated_at:'2026-01-01T00:00:'+String(i%60).padStart(2,'0')+'.000Z'}))};
 const next=nextIndex({...old,runs:[...old.runs,{run_id:r.run_id,updated_at:'2000-01-01T00:00:00.000Z'}]},r);
 assert.equal(next.runs.length,100);assert.equal(next.runs[0].run_id,r.run_id);
 assert.equal(next.runs.filter(x=>x.run_id===r.run_id).length,1);
 assert.throws(()=>nextIndex({schema_version:2,repo:'pcpcchen-coder/AIOS',runs:[]},r),/Invalid source index/);
});
