import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMacCapabilityPluginService } from "../src/mac-capability-plugin-service.mjs";

async function fixture(execute = async ({ capability }) => ({ ok: true, capability })) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-capability-")); const projects = path.join(root, "projects"); const workspace = path.join(projects, "users", "3");
  await mkdir(workspace, { recursive: true }); await writeFile(path.join(workspace, "sample.png"), "image-data");
  const service = createMacCapabilityPluginService({ databasePath: path.join(root, "control.sqlite"), projectsRoot: projects, executor: { ready: true, execute } });
  service.bindSession(3, "ses_test", workspace); return { root, workspace, service };
}

test("executes an allowlisted capability once and replays the idempotent result", async () => { let calls=0; const item=await fixture(async()=>{calls+=1;return {text:"ok"}}); try { const input={portalUserId:3,sessionId:"ses_test",messageId:"msg_1",capability:"document:ocr",path:"sample.png",idempotencyKey:"same"}; const first=await item.service.run(input); const replay=await item.service.run(input); assert.equal(first.status,"completed"); assert.deepEqual(replay.result,{text:"ok"}); assert.equal(calls,1); } finally { item.service.close(); await rm(item.root,{recursive:true}); } });

test("rejects capabilities, traversal, and symlinks outside the workspace", async () => { const item=await fixture(); try { const base={portalUserId:3,sessionId:"ses_test",messageId:"msg_1",path:"sample.png",idempotencyKey:"x"}; await assert.rejects(item.service.run({...base,capability:"shell:run"}),e=>e.code==="MAC_CAPABILITY_FORBIDDEN"); await assert.rejects(item.service.run({...base,capability:"document:ocr",path:"../../outside",idempotencyKey:"y"}),e=>e.code==="MAC_PATH_FORBIDDEN"); const outside=path.join(item.root,"outside.png");await writeFile(outside,"x");await symlink(outside,path.join(item.workspace,"escape.png"));await assert.rejects(item.service.run({...base,capability:"document:ocr",path:"escape.png",idempotencyKey:"z"}),e=>e.code==="MAC_PATH_FORBIDDEN"); } finally { item.service.close(); await rm(item.root,{recursive:true}); } });

test("records typed executor failures and cancellation", async () => { let entered; const started=new Promise(r=>{entered=r}); const item=await fixture(({signal})=>new Promise((_resolve,reject)=>{entered();signal.addEventListener("abort",()=>reject(Object.assign(new Error("stopped"),{code:"STOPPED"})),{once:true})})); try { const controller=new AbortController(); const pending=item.service.run({portalUserId:3,sessionId:"ses_test",messageId:"msg_1",capability:"media:inspect",path:"sample.png",idempotencyKey:"cancel",signal:controller.signal,controller}); await started; controller.abort(); const result=await pending; assert.equal(result.status,"cancelled"); assert.equal(result.error.code,"STOPPED"); } finally { item.service.close(); await rm(item.root,{recursive:true}); } });
