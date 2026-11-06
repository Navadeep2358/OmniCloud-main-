import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {once} from "node:events";
import {registerGcpTerraformRoutes} from "../gcpTerraformRoutes.js";

const connectionId="12345678-1234-1234-1234-123456789012";
const customerAccount={id:connectionId,project_id:"omnicloud-sandbox-123",service_account_email:"omnicloud-a1b2c3d4@omnicloud-sandbox-123.iam.gserviceaccount.com"};
async function withApi(pool,callback,overrides={}){
 const app=express();app.use(express.json());
 registerGcpTerraformRoutes(app,{pool,requireUser:(req,_res,next)=>{req.user={id:42};next()},tokenFactory:async()=>"mock-short-lived-access-token",createPlan:async()=>({summary:{resourceChanges:[{address:"google_compute_instance.vm",actions:["create"]}],applyable:true,complete:true}}),applyPlan:async()=>({instanceName:"omnicloud-123456789012",zone:"asia-south1-a",internalIp:"10.0.0.2"}),removePlan:async()=>{},now:()=>1000,expiry:()=>901000,...overrides});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 try{return await callback(`http://127.0.0.1:${server.address().port}`)}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

test("GCP VM planning is scoped to the signed-in user's connected project",async()=>{
 const calls=[];const pool={execute:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith("SELECT id,project_id,service_account_email"))return [[customerAccount]];return [{affectedRows:1}]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/${connectionId}/terraform/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",templateId:"gcp_compute_instance",displayName:"First VM",zone:"asia-south1-a",machineType:"e2-micro"})});
  const body=await response.json();
  assert.equal(response.status,201);assert.equal(body.operation.status,"planned");assert.equal(body.deployment.project_id,customerAccount.project_id);
  assert.match(calls[0].sql,/user_id=\? AND provider='gcp' AND status='connected'/);assert.deepEqual(calls[0].values,[connectionId,42]);
  assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO gcp_terraform_deployments")));
  assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO gcp_terraform_operations")));
 });
});

test("GCP VM planning rejects unreviewed template and invalid machine types",async()=>{
 const pool={execute:async(sql)=>sql.startsWith("SELECT id,project_id,service_account_email")?[[customerAccount]]:[{affectedRows:1}]};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/${connectionId}/terraform/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",templateId:"arbitrary_hcl",displayName:"VM",zone:"asia-south1-a",machineType:"huge"})});
  assert.equal(response.status,400);
 });
});

test("disabled Compute API failures explain the billing prerequisite and retry step",async()=>{
 const pool={execute:async(sql)=>sql.startsWith("SELECT id,project_id,service_account_email")?[[customerAccount]]:[{affectedRows:1}]};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/${connectionId}/terraform/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",templateId:"gcp_compute_instance",displayName:"First VM",zone:"asia-south1-a",machineType:"e2-micro"})});
  const body=await response.json();
  assert.equal(response.status,502);assert.equal(body.code,"GCP_COMPUTE_API_DISABLED");
  assert.match(body.message,/billing is linked to an open account/i);
 },{createPlan:async()=>{throw new Error("googleapi: Error 403: Compute Engine API has not been used in project before or it is disabled. reason: SERVICE_DISABLED")}});
});

test("closed billing account errors are distinguished from other disabled services",async()=>{
 const pool={execute:async(sql)=>sql.startsWith("SELECT id,project_id,service_account_email")?[[customerAccount]]:[{affectedRows:1}]};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/${connectionId}/terraform/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",templateId:"gcp_compute_instance",displayName:"First VM",zone:"asia-south1-a",machineType:"e2-micro"})});
  const body=await response.json();
  assert.equal(response.status,502);assert.equal(body.code,"GCP_BILLING_REQUIRED");
  assert.match(body.message,/not linked to an open billing account/i);
 },{createPlan:async()=>{throw new Error("Billing account for project is not open. UREQ_PROJECT_BILLING_NOT_OPEN")}});
});

test("a connection owned by another user cannot be used to create a GCP VM",async()=>{
 let inserts=0;const pool={execute:async(sql)=>{if(sql.startsWith("SELECT id,project_id,service_account_email"))return [[]];inserts++;return [{affectedRows:1}]}};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/gcp/${connectionId}/terraform/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",templateId:"gcp_compute_instance",displayName:"First VM",zone:"asia-south1-a",machineType:"e2-micro"})});
  assert.equal(response.status,404);assert.equal(inserts,0);
 });
});

test("GCP apply requires explicit confirmation and returns VM outputs",async()=>{
 const deploymentId="22222222-2222-2222-2222-222222222222",operationId="33333333-3333-3333-3333-333333333333";let applyCalls=0;
 const pool={execute:async(sql,values)=>{
  if(sql.startsWith("SELECT o.id"))return [[{id:operationId,deployment_id:deploymentId,action:"create",status:"planned",plan_summary:"{}",expires_at:9999999,deployment_status:"planned",template_id:"gcp_compute_instance",display_name:"First VM",instance_name:"omnicloud-123456789012",zone:"asia-south1-a",machine_type:"e2-micro",project_id:customerAccount.project_id,service_account_email:customerAccount.service_account_email}]];
  return [{affectedRows:1}];
 }};
 await withApi(pool,async base=>{
  const noConfirm=await fetch(`${base}/api/cloud-connections/gcp/${connectionId}/terraform/operations/${operationId}/apply`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  assert.equal(noConfirm.status,400);
  const response=await fetch(`${base}/api/cloud-connections/gcp/${connectionId}/terraform/operations/${operationId}/apply`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.deployment.outputs.internalIp,"10.0.0.2");
  applyCalls++;
 });
 assert.equal(applyCalls,1);
});
