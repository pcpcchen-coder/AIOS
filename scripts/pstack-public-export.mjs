#!/usr/bin/env node
// AIOS public metadata publisher. No cross-repo token or raw transcript upload.
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const TARGET='pcpcchen-coder/AIOS', REF='telemetry/pstack';
const RUNS='observability/public/runs/', INDEX='observability/public/index.json';
const validId=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const statuses=new Set(['running','passed','failed','blocked','cancelled']);
const stageStates=new Set(['pending','running','passed','failed','blocked','skipped']);
const sensitive=/(github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|AKIA[A-Z0-9]{16})/i;
function plain(v,n=350){const s=String(v??'').slice(0,n);if(sensitive.test(s))throw Error('Sensitive text rejected from public export');return s;}
const stamp=v=>v&&Number.isFinite(Date.parse(v))?String(v):null;
function evidence(v){
 if(!Array.isArray(v))return [];
 return v.slice(0,10).map(e=>{
   const u=new URL(String(e.url));
   if(u.protocol!=='https:'||u.hostname!=='github.com'||!/^\/pcpcchen-coder\/(AIOS|CursorPlugins)(\/|$)/.test(u.pathname))throw Error('Evidence must be a public project GitHub URL');
   return {label:plain(e.label??'Evidence',70),url:u.toString().slice(0,600)};
 });
}
export function publicProjection(r){
 if(r.schema_version!==1||r.repo!==TARGET||!validId.test(r.run_id||'')||!statuses.has(r.status))throw Error('Invalid run identity');
 if(!stamp(r.started_at)||!stamp(r.updated_at))throw Error('Invalid run time');
 if(!Array.isArray(r.steps)||r.steps.length<1||r.steps.length>40)throw Error('Invalid stage count');
 const seen=new Set();
 const steps=r.steps.map(s=>{
   if(!validId.test(s.id||'')||seen.has(s.id)||!stageStates.has(s.status))throw Error('Invalid/duplicate stage');
   seen.add(s.id);
   return {id:s.id,title:plain(s.title,90),status:s.status,started_at:stamp(s.started_at),ended_at:stamp(s.ended_at),note:plain(s.note),evidence:evidence(s.evidence)};
 });
 const events=(r.events||[]).slice(-200).map(e=>({
   at:stamp(e.at),type:plain(e.type,70),step_id:e.step_id?plain(e.step_id,80):null,status:plain(e.status,25),note:plain(e.note)
 }));
 return {schema_version:1,repo:TARGET,run_id:r.run_id,title:plain(r.title,160),
 playbook:plain(r.playbook,80),branch:plain(r.branch,120),commit_sha:plain(r.commit_sha,64),
 status:r.status,started_at:r.started_at,updated_at:r.updated_at,ended_at:stamp(r.ended_at),
 steps,events,provenance:r.playbook==='investigation-ci'?'Scripted CI investigation, not native pstack Agent':'Agent self-reported'};
}
function summary(r){return {repo:TARGET,run_id:r.run_id,title:r.title,playbook:r.playbook,status:r.status,
 updated_at:r.updated_at,started_at:r.started_at,ended_at:r.ended_at,branch:r.branch,commit_sha:r.commit_sha,
 passed_steps:r.steps.filter(x=>x.status==='passed').length,total_steps:r.steps.length,provenance:r.provenance};}
async function request(path,method='GET',body){
 const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
 if(!token)throw Error('Missing same-repository GitHub Actions token');
 const u='https://api.github.com/repos/'+TARGET+'/contents/'+path+(method==='GET'?'?ref='+encodeURIComponent(REF):'');
 return fetch(u,{method,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:'Bearer '+token},
 ...(body?{body:JSON.stringify(body)}:{})});
}
async function read(path){
 const res=await request(path);if(res.status===404)return null;
 if(!res.ok)throw Error('GitHub read '+res.status);
 const d=await res.json();return {sha:d.sha,value:JSON.parse(Buffer.from(d.content.replace(/\s/g,''),'base64').toString('utf8'))};
}
async function put(path,value,sha){
 const body={message:'data(pstack): publish AIOS '+(value.run_id||'feed index'),branch:REF,
   content:Buffer.from(JSON.stringify(value,null,2)+'\n').toString('base64'),...(sha?{sha}:{})};
 const res=await request(path,'PUT',body);
 if(!res.ok)throw Error('GitHub write '+res.status+': '+(await res.text()).slice(0,350));
}
export function nextIndex(old,r){
 if(old&&(old.schema_version!==1||old.repo!==TARGET||!Array.isArray(old.runs)))throw Error('Invalid source index');
 const runs=(old?.runs||[]).filter(x=>x.run_id!==r.run_id);
 runs.push(summary(r));runs.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
 return {schema_version:1,repo:TARGET,updated_at:new Date().toISOString(),runs:runs.slice(0,100)};
}
export async function publishPublicRun(original){
 const r=publicProjection(original);
 const path=RUNS+r.run_id+'.json';
 const existing=await read(path);await put(path,r,existing?.sha);
 for(let i=0;i<3;i++){
   const prev=await read(INDEX);
   try{await put(INDEX,nextIndex(prev?.value,r),prev?.sha);return r;}
   catch(e){if(i===2||!/GitHub write (409|422)/.test(e.message))throw e;}
 }
}
function git(cwd,...a){
 const p=spawnSync('git',a,{cwd,encoding:'utf8',timeout:120000});
 if(p.status!==0)throw Error('git '+a[0]+' failed: '+String(p.stderr||'').trim().slice(0,300));
 return p.stdout.trim();
}
// Claude Code cloud sessions reach GitHub through a proxy that refuses REST content writes but accepts git push.
export function publishViaGit(original,workspace){
 const r=publicProjection(original);
 const remote=git(workspace,'remote','get-url','origin');
 const dir=mkdtempSync(join(tmpdir(),'pstack-public-'));
 try{
   git(dir,'clone','--quiet','--depth','1','--branch',REF,remote,'.');
   for(let i=0;i<3;i++){
     mkdirSync(join(dir,RUNS),{recursive:true});
     writeFileSync(join(dir,RUNS+r.run_id+'.json'),JSON.stringify(r,null,2)+'\n');
     const ip=join(dir,INDEX);
     writeFileSync(ip,JSON.stringify(nextIndex(existsSync(ip)?JSON.parse(readFileSync(ip,'utf8')):null,r),null,2)+'\n');
     git(dir,'add','observability/public');
     git(dir,'-c','user.name=AIOS pstack observer','-c','user.email=pstack-observer@users.noreply.github.com',
       'commit','--quiet','-m','data(pstack): publish AIOS '+r.run_id);
     const push=spawnSync('git',['push','--quiet','origin','HEAD:'+REF],{cwd:dir,encoding:'utf8',timeout:120000});
     if(push.status===0)return r;
     if(i===2)throw Error('git push failed: '+String(push.stderr||'').trim().slice(0,300));
     git(dir,'fetch','--quiet','--depth','1','origin',REF);git(dir,'reset','--quiet','--hard','FETCH_HEAD');
   }
 }finally{rmSync(dir,{recursive:true,force:true});}
}
async function publish(original,workspace){
 const transport=process.env.PSTACK_PUBLISH_TRANSPORT||'auto';
 if(!['auto','api','git'].includes(transport))throw Error('PSTACK_PUBLISH_TRANSPORT must be auto, api or git');
 const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
 if(transport==='git'||(transport==='auto'&&!token))return publishViaGit(original,workspace);
 try{return await publishPublicRun(original);}
 catch(e){
   if(transport==='api'||!/GitHub (read|write) (401|403)/.test(e.message))throw e;
   console.error('REST publication refused ('+e.message.slice(0,120)+'); retrying with git push.');
   return publishViaGit(original,workspace);
 }
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
 try{
   const args=process.argv.slice(2),p=args.indexOf('--run'),id=p>=0?args[p+1]:null;
   if(!validId.test(id||''))throw Error('Use --run with a valid ID');
   if(!args.includes('--public-ok')||process.env.PSTACK_OBSERVE_PUBLICATION_ACK!=='1')throw Error('Publication requires --public-ok and explicit approval flag');
   const wi=args.indexOf('--workspace');
   const workspace=wi>=0?resolve(args[wi+1]):process.cwd();
   const local=join(workspace,'.pstack','observability','runs',id+'.json');
   const r=await publish(JSON.parse(readFileSync(local,'utf8')),workspace);
   console.log('PUBLISHED PUBLIC AIOS RUN '+r.run_id+' '+r.status+' ('+r.steps.length+' steps)');
 }catch(e){console.error('PUBLICATION FAILED: '+e.message);process.exitCode=1;}
}
