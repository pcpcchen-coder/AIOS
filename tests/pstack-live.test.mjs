import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const script=join(root,'tools','pstack-observe-live.mjs');
const work=()=>mkdtempSync(join(tmpdir(),'pstack-live-test-'));
const call=(cwd,...args)=>spawnSync(process.execPath,[script,...args,'--workspace',cwd],{
 encoding:'utf8',env:{...process.env,PSTACK_OBSERVE_PUBLICATION_ACK:'',GH_TOKEN:'',GITHUB_TOKEN:''}
});
test('live sidecar creates real local steps without publishing when ACK is absent',()=>{
 const cwd=work();
 const start=call(cwd,'start','--repo','pcpcchen-coder/AIOS','--run','test-live','--title','Local CI check','--steps','inspect,verify');
 assert.equal(start.status,0,start.stderr);assert.match(start.stdout,/LOCAL_ONLY/);
 const s=call(cwd,'step','--run','test-live','--step','inspect','--status','running');assert.equal(s.status,0,s.stderr);
 assert.equal(call(cwd,'step','--run','test-live','--step','inspect','--status','passed').status,0);
 assert.equal(call(cwd,'step','--run','test-live','--step','verify','--status','skipped','--note','Test only').status,0);
 assert.equal(call(cwd,'finish','--run','test-live','--status','passed').status,0);
 const file=join(cwd,'.pstack','observability','runs','test-live.json');
 assert.ok(existsSync(file));assert.equal(JSON.parse(readFileSync(file,'utf8')).status,'passed');
});
test('public wrapper does not allow raw unfiltered Recorder upload',()=>{
 const cwd=work();
 const result=call(cwd,'start','--repo','pcpcchen-coder/AIOS','--run','bad','--publish','--public-ok');
 assert.notEqual(result.status,0);assert.match(result.stderr,/Do not pass raw Recorder publish flags/);
 assert.ok(!existsSync(join(cwd,'.pstack','observability','runs','bad.json')));
});
