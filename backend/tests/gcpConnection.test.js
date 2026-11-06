import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {once} from "node:events";
import {GcpConnectionError,buildGcpSetupInstructions,registerGcpRoutes,verifyGcpConnection} from "../gcpConnection.js";

const projectId="omnicloud-sandbox-123";
const serviceAccountEmail="omnicloud-a1b2c3d4@omnicloud-sandbox-123.iam.gserviceaccount.com";
const callerEmail="omnicloud-backend@omnicloud-platform-123.iam.gserviceaccount.com";

async function withApi(pool,callback,options={}){
 const app=express();app.use(express.json());
 registerGcpRoutes(app,{pool,requireUser:(req,_res,next)=>{req.user={id:42};next()},omniCloudServiceAccountEmail:()=>callerEmail,...options});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 try{return await callback(`http://127.0.0.1:${server.address().port}`)}
 finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

test("Cloud Shell instructions create one delegated service account without a key and bind Token Creator to OmniCloud",()=>{
 const text=buildGcpSetupInstructions(projectId,serviceAccountEmail,callerEmail);
 assert.match(text,/gcloud iam service-accounts create/);
 assert.match(text,/roles\/iam\.serviceAccountTokenCreator/);
 assert.match(text,/roles\/browser/);
 assert.doesNotMatch(text,/compute\.googleapis\.com/);
 assert.doesNotMatch(text,/roles\/compute\.instanceAdmin\.v1/);
 assert.match(text,/OMNICLOUD_CALLER='omnicloud-backend@omnicloud-platform-123\.iam\.gserviceaccount\.com'/);
 assert.match(text,/--member="serviceAccount:\$OMNICLOUD_CALLER"/);
 assert.doesNotMatch(text,/service-account-keys create|private_key|\.json/);
 assert.throws(()=>buildGcpSetupInstructions("INVALID",serviceAccountEmail,callerEmail),/valid Google Cloud project ID/);
});

test("verification impersonates the configured customer service account and checks the selected project",async()=>{
 let target="",requestUrl="",authorization="";
 const result=await verifyGcpConnection(projectId,serviceAccountEmail,{
  tokenFactory:async email=>{target=email;return "short-lived-token"},
  fetchImpl:async(url,options)=>{requestUrl=url;authorization=options.headers.Authorization;return {ok:true,status:200,json:async()=>({projectId,name:"projects/123456789",state:"ACTIVE"})}}
 });
 assert.equal(target,serviceAccountEmail);
 assert.equal(requestUrl,`https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}`);
 assert.equal(authorization,"Bearer short-lived-token");
 assert.deepEqual(result,{projectId,serviceAccountEmail,projectName:"projects/123456789",state:"ACTIVE"});
});

test("verification rejects unauthorized token minting with actionable Token Creator guidance",async()=>{
 await assert.rejects(()=>verifyGcpConnection(projectId,serviceAccountEmail,{tokenFactory:async()=>{const error=new Error("permission denied");error.response={status:403};throw error}}),error=>error.code==="GCP_TOKEN_CREATOR_REQUIRED"&&/roles\/iam\.serviceAccountTokenCreator/.test(error.message));
});

test("verification explains missing project read permission",async()=>{
 await assert.rejects(()=>verifyGcpConnection(projectId,serviceAccountEmail,{tokenFactory:async()=>"token",fetchImpl:async()=>({ok:false,status:403})}),error=>error.code==="GCP_PROJECT_ACCESS_DENIED"&&/roles\/browser/.test(error.message));
});

test("GCP setup stores per-user project identifiers and returns generated customer instructions",async()=>{
 const calls=[];
 const pool={execute:async(sql,values)=>{calls.push({sql,values});return [{affectedRows:1}]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/setup`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId})});
  const body=await response.json();
  assert.equal(response.status,201);
  assert.equal(body.setup.projectId,projectId);
  assert.match(body.setup.serviceAccountEmail,/^omnicloud-[0-9a-f]{8}@omnicloud-sandbox-123\.iam\.gserviceaccount\.com$/);
  assert.match(body.setup.instructions,/roles\/iam\.serviceAccountTokenCreator/);
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/provider,account_id,role_arn,external_id,project_id,service_account_email,status/);
  assert.deepEqual(calls[0].values.slice(1,4),[42,projectId,body.setup.serviceAccountEmail]);
  assert.match(calls[0].sql,/NULL,\?,\?,\s*'setup'/);
 });
});

test("GCP setup is unavailable until the OmniCloud service account is configured",async()=>{
 let inserts=0;const pool={execute:async()=>{inserts++;return [{affectedRows:1}]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/setup`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId})});
  const body=await response.json();
  assert.equal(response.status,503);
  assert.equal(body.code,"GCP_NOT_CONFIGURED");
  assert.equal(inserts,0);
 },{omniCloudServiceAccountEmail:()=>""});
});

test("GCP connection is activated only after impersonation and project verification succeed",async()=>{
 const calls=[];
 const pool={execute:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith("SELECT id,project_id"))return [[{id:"gcp-setup-1",project_id:projectId,service_account_email:serviceAccountEmail,status:"setup"}]];return [{affectedRows:1}]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/setup/gcp-setup-1/verify`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.connection.status,"connected");
  assert.equal(body.connection.project_id,projectId);
  assert.equal(body.connection.service_account_email,serviceAccountEmail);
  assert.equal(calls.length,2);
  assert.match(calls[0].sql,/id=\? AND user_id=\? AND provider='gcp'/);
  assert.deepEqual(calls[0].values,["gcp-setup-1",42]);
  assert.match(calls[1].sql,/user_id=\? AND provider='gcp' AND status='setup'/);
  assert.deepEqual(calls[1].values.slice(1),["gcp-setup-1",42]);
 },{verifyConnection:async(p,email)=>({projectId:p,serviceAccountEmail:email,projectName:"projects/123",state:"ACTIVE"})});
});

test("a different user's GCP setup cannot be verified",async()=>{
 const calls=[];const pool={execute:async(sql,values)=>{calls.push({sql,values});return [[]]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/setup/other-user-setup/verify`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const body=await response.json();
  assert.equal(response.status,404);
  assert.equal(body.code,"SETUP_NOT_FOUND");
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].values,["other-user-setup",42]);
 });
});

test("a different user's setup instructions cannot be read",async()=>{
 const calls=[];const pool={execute:async(sql,values)=>{calls.push({sql,values});return [[]]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/setup/other-user-setup/instructions`);
  const body=await response.json();
  assert.equal(response.status,404);
  assert.equal(body.code,"SETUP_NOT_FOUND");
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].values,["other-user-setup",42]);
 });
});

test("failed GCP verification leaves setup pending",async()=>{
 const calls=[];const pool={execute:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith("SELECT id,project_id"))return [[{id:"gcp-setup-1",project_id:projectId,service_account_email:serviceAccountEmail,status:"setup"}]];return [{affectedRows:1}]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/setup/gcp-setup-1/verify`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const body=await response.json();
  assert.equal(response.status,409);
  assert.equal(body.code,"GCP_TOKEN_CREATOR_REQUIRED");
  assert.equal(calls.length,1);
 },{verifyConnection:async()=>{throw new GcpConnectionError("GCP_TOKEN_CREATOR_REQUIRED","Grant Token Creator.")}});
});
