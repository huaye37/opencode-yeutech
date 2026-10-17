// Run from the v3-agent worktree root. Checks this local tree against the authorized baseline.
const fs=require('fs'), cp=require('child_process');const original=cp.execFileSync('git',['show','504d9dc22:deploy/yeutech-agent-isolated/web/src/App.jsx'],{encoding:'utf8'}).split('\n');const root='deploy/yeutech-agent-isolated/web/src/';const checks=[];
for(const [name,a,b] of [['workbench-bootstrap.js',1241,1337],['use-projection-events.js',1450,1623],['workbench-actions.js',1624,2046]]){
 const unchanged=fs.readFileSync(root+name,'utf8').includes(original.slice(a-1,b).join('\n'));checks.push({file:name,originalLines:[a,b],bodyByteIdentical:unchanged});if(!unchanged)throw Error(name+' changed');
}
for(const file of ['api.js','attachment-state.js','markdown-parser.js','message-projection.js','message-scroll.js','project-file-reference.js','session-ordering.js','portal-appearance.js']){
 const baseline=cp.execFileSync('git',['show','504d9dc22:'+root+file],{encoding:'utf8'});const unchanged=fs.readFileSync(root+file,'utf8')===baseline;checks.push({file,byteIdentical:unchanged});if(!unchanged)throw Error(file+' changed');
}
console.log(JSON.stringify(checks,null,2));fs.writeFileSync('qa-v3/behavior-preservation.json',JSON.stringify(checks,null,2)+'\n');

const changed=cp.execFileSync('git',['diff','--name-only','504d9dc22'],{encoding:'utf8'}).trim().split('\n');
const untracked=cp.execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n');
const files=[...new Set([...changed,...untracked])].filter(Boolean);
for (const file of files) {
  if (!file.startsWith('deploy/yeutech-agent-isolated/web/') && !file.startsWith('qa-v3/')) throw Error('Out-of-scope change: '+file);
  if (!fs.existsSync(file) || !/\.(?:js|jsx|css|mjs|mts|cjs)$/.test(file)) continue;
  const lines=fs.readFileSync(file,'utf8').trimEnd().split('\n').length;
  if (lines>600) throw Error(file+' exceeds 600 lines: '+lines);
}
const canonical='/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/yeutech-home-platform/frontend/design/';
const crypto=require('node:crypto');
const contracts=['yeutech-material-contract.css','yeutech-material-contract.mjs','yeutech-material-contract.d.mts'].map(file=>{
  const bytes=fs.readFileSync(root+'design/'+file);
  if (!bytes.equals(fs.readFileSync(canonical+file))) throw Error('Contract drift: '+file);
  return {file,canonicalByteIdentical:true,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
});
const scope={baseline:'504d9dc22',branch:cp.execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),scope:'custom web presentation + qa-v3 only',modifiedCodeFilesUnder600Lines:true,contracts};
fs.writeFileSync('qa-v3/scope-verification.json',JSON.stringify(scope,null,2)+'\n');
console.log(JSON.stringify(scope,null,2));
