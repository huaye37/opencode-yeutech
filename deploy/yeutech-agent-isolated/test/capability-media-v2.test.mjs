import assert from "node:assert/strict";
import test from "node:test";
import {normalizeModelCatalog,validateCapabilityCatalog} from "../src/model-catalog.mjs";

const media = (output,workload) => ({id:`test-${output}`,available:true,selectable:true,capability_status:"ready",context_length:0,max_output_tokens:0,supported_input_modalities:["text"],supported_output_modalities:[output],supported_workloads:[workload],token_limits_applicable:false,availability_basis:"registered_route_state",verification_status:"not_verified_by_catalog"});
test("v2 media does not poison the text catalog or become a text agent",()=>{
  const payload={data:[media("image","image_generation"),media("video","video_generation"),media("audio","speech_generation")]};
  assert.equal(validateCapabilityCatalog(payload),payload);
  for(const model of normalizeModelCatalog(payload)){assert.equal(model.selectable,false);assert.equal(model.limit,null);assert.equal(model.disabledReason,"当前工作台不支持该模型类型");}
});
test("media flag cannot disguise incomplete text or fabricate acceptance",()=>{
  assert.throws(()=>validateCapabilityCatalog({data:[media("text","agent")]}),/must be positive/);
  assert.throws(()=>validateCapabilityCatalog({data:[{...media("image","image_generation"),verification_status:"passed"}]}),/cannot claim live verification/);
});
