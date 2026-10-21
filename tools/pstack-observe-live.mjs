#!/usr/bin/env node
// AIOS-approved public sidecar. Records locally first; publishes a sanitized snapshot.
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const command=args[0];
function flag(name){const i=args.indexOf('--'+name);return i===-1?null:args[i+1];}
function fail(msg,code=2){console.error('PSTACK OBSERVATORY: '+msg);process.exitCode=code;}
if(!['start','step','finish'].includes(command)){
 fail('Use start/step/finish and forward normal Recorder options.'); 
}else if(args.includes('--publish')||args.includes('--public-ok')){
 fail('Do not pass raw Recorder publish flags. The public wrapper filters metadata first.');
}else{
 const work=resolve(flag('workspace')||process.cwd());
 const local=spawnSync(process.execPath,[join(root,'tools','pstack-observe.mjs'),...args],{
  cwd:work,env:process.env,encoding:'utf8',timeout:60000
 });
 if(local.stdout)process.stdout.write(local.stdout);
 if(local.stderr)process.stderr.write(local.stderr);
 if(local.status!==0){
  fail('Local Recorder failed; nothing was published.',local.status||2);
 }else{
  const id=flag('run')||local.stdout?.match(/RUN_ID=([A-Za-z0-9._-]+)/)?.[1];
  if(!id)fail('Recorder wrote locally, but could not determine Run ID.',3);
  else if(process.env.PSTACK_OBSERVE_PUBLICATION_ACK!=='1'){
   console.log('LOCAL_ONLY: set PSTACK_OBSERVE_PUBLICATION_ACK=1 to use the owner-approved public AIOS feed.');
  }else{
   let token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
   if(!token){
    const auth=spawnSync('gh',['auth','token'],{encoding:'utf8',timeout:8000});
    if(auth.status===0)token=auth.stdout.trim();
   }
   if(!token)fail('Local step recorded, publication unavailable: no GitHub authentication. Do not report PUBLIC success.',3);
   else{
    const publish=spawnSync(process.execPath,[join(root,'scripts','pstack-public-export.mjs'),'--run',id,'--workspace',work,'--public-ok'],{
     cwd:work,env:{...process.env,GH_TOKEN:token},encoding:'utf8',timeout:60000
    });
    if(publish.stdout)process.stdout.write(publish.stdout);
    if(publish.stderr)process.stderr.write(publish.stderr);
    if(publish.status!==0)fail('Local step recorded; PUBLIC snapshot failed. Retry exporter without duplicating steps.',3);
   }
  }
 }
}
