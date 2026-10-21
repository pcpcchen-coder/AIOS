import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const recorder=join(root,'tools','pstack-observe.mjs');
const temp=()=>mkdtempSync(join(tmpdir(),'aios-pstack-observer-'));
const call=(workspace,...args)=>spawnSync(process.execPath,[recorder,...args,'--workspace',workspace],{
  encoding:'utf8',env:{...process.env,PSTACK_OBSERVE_PUBLICATION_ACK:''}
});
const read=(workspace,id)=>JSON.parse(readFileSync(join(workspace,'.pstack','observability','runs',id+'.json'),'utf8'));

test('real recorder lifecycle records step state and rejects premature success',()=>{
  const w=temp(),id='lifecycle';
  const started=call(w,'start','--repo','pcpcchen-coder/AIOS','--run',id,'--title','Recorder CI smoke (not pstack)','--playbook','observer-smoke','--steps','check,artifact');
  assert.equal(started.status,0,started.stderr);
  assert.match(started.stdout,/RUN_ID=lifecycle/);
  assert.notEqual(call(w,'finish','--run',id,'--status','passed').status,0);
  assert.equal(call(w,'step','--run',id,'--step','check','--status','running').status,0);
  assert.equal(call(w,'step','--run',id,'--step','check','--status','passed','--note','Observed CI check').status,0);
  assert.equal(call(w,'step','--run',id,'--step','artifact','--status','skipped','--note','Not performed in this test').status,0);
  const finished=call(w,'finish','--run',id,'--status','passed');
  assert.equal(finished.status,0,finished.stderr);
  assert.equal(read(w,id).status,'passed');
  assert.deepEqual(read(w,id).steps.map(s=>s.status),['passed','skipped']);
  assert.ok(read(w,id).events.length>=5);
});
test('public publishing is denied unless separately authorized; invalid IDs rejected',()=>{
  const w=temp();
  assert.notEqual(call(w,'start','--repo','pcpcchen-coder/AIOS','--run','../traversal').status,0);
  const start=call(w,'start','--repo','pcpcchen-coder/AIOS','--run','safe','--steps','check');
  assert.equal(start.status,0,start.stderr);
  assert.notEqual(call(w,'publish','--run','safe','--public-ok').status,0);
  assert.notEqual(call(w,'publish','--run','safe').status,0);
  assert.notEqual(call(w,'step','--run','safe','--step','check','--status','passed','--evidence','javascript:alert(1)').status,0);
  assert.ok(existsSync(join(w,'.pstack','observability','runs','safe.json')));
});
test('original pstack remains pinned and observer policy defaults to local only',()=>{
  const guide=readFileSync(join(root,'AGENTS.md'),'utf8');
  assert.match(guide,/vendor\/pstack\/skills\/poteto-mode\/SKILL\.md/);
  assert.match(guide,/PSTACK_OBSERVABILITY_BEGIN/);
  assert.match(guide,/No automatic public upload is enabled/);
  assert.match(readFileSync(join(root,'.gitignore'),'utf8'),/^\.pstack\/observability\/$/m);
});
