import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicProjection} from '../scripts/pstack-public-export.mjs';
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
