import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {once} from "node:events";
import {registerAzureRoutes} from "../azureConnection.js";
import {registerAzureTerraformRoutes} from "../azureTerraformRoutes.js";

const connectionId="12345678-1234-4234-8234-123456789012";
const connection={id:connectionId,azure_subscription_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",azure_tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",azure_resource_group:"omnicloud-test"};
async function withApi(pool,callback,overrides={}){
 const app=express();app.use(express.json());const identityProvider=()=>({tenantId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",principalId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"});
 registerAzureRoutes(app,{pool,requireUser:(req,_res,next)=>{req.user={id:42};next()},identityProvider,verifyConnection:async target=>({...target,resourceGroupId:`/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`})});
 registerAzureTerraformRoutes(app,{pool,requireUser:(req,_res,next)=>{req.user={id:42};next()},verifyConnection:async()=>{},createPlan:async()=>({summary:{resourceChanges:[{address:"azurerm_linux_virtual_machine.vm",actions:["create"]}],applyable:true,complete:true}}),applyPlan:async()=>({vmName:"oc-123456789abc",privateIp:"10.40.1.4"}),removePlan:async()=>{},now:()=>1000,expiry:()=>901000,...overrides});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");try{return await callback(`http://127.0.0.1:${server.address().port}`)}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

test("Azure setup is stored per signed-in user and template uses configured OmniCloud identity",async()=>{
 const calls=[];const pool={execute:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith("SELECT id,azure_subscription_id"))return [[{...connection,status:"setup"}]];return [{affectedRows:1}]}};
 await withApi(pool,async base=>{
  const start=await fetch(`${base}/api/cloud-connections/azure/setup`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({subscriptionId:connection.azure_subscription_id,tenantId:connection.azure_tenant_id,resourceGroup:connection.azure_resource_group})});const setupBody=await start.json();assert.equal(start.status,201);assert.equal(setupBody.setup.status,"setup");
  const templateResponse=await fetch(`${base}/api/cloud-connections/azure/setup/${setupBody.setup.id}/template`);const template=await templateResponse.json();
  assert.equal(templateResponse.status,200);assert.equal(template.resources[0].properties.managedByTenantId,"cccccccc-cccc-4ccc-8ccc-cccccccccccc");assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO cloud_connections")&&call.values[1]===42));
 });
});

test("Azure verification marks the setup connected and records the subscription ID",async()=>{
 const updates=[];
 const pool={execute:async(sql,values)=>{
  if(sql.startsWith("SELECT id,azure_subscription_id"))return [[{...connection,status:"setup"}]];
  if(sql.startsWith("UPDATE cloud_connections")){updates.push({sql,values});return [{affectedRows:1}]}
  return [{affectedRows:1}];
 }};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/azure/setup/${connectionId}/verify`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.connection.status,"connected");assert.equal(body.connection.subscription_id,connection.azure_subscription_id);
  assert.equal(updates[0].values[0],connection.azure_subscription_id);assert.match(updates[0].sql,/WHERE id=\? AND user_id=\? AND provider='azure' AND status='setup'/);
 });
});

test("Azure VM plans remain tenant scoped and never return the saved SSH public key",async()=>{
 let plannedDeployment,verificationScope;
 const pool={execute:async(sql,values)=>{
  if(sql.startsWith("SELECT id,azure_subscription_id"))return [[connection]];
  if(sql.startsWith("SELECT id,template_id"))return [[]];
  return [{affectedRows:1}];
 }};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/azure/${connectionId}/terraform/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",templateId:"azure_linux_vm",displayName:"Test Linux VM",location:"centralindia",machineSize:"Standard_B1s",adminUsername:"omniadmin",sshPublicKey:"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTest demo"})});
  const body=await response.json();assert.equal(response.status,201);assert.equal(body.operation.status,"planned");assert.equal(body.deployment.subscription_id,connection.azure_subscription_id);assert.equal(Object.hasOwn(body.deployment,"ssh_public_key"),false);assert.equal(plannedDeployment.admin_username,"omniadmin");assert.equal(verificationScope.resourceGroup,connection.azure_resource_group);
 },{verifyConnection:async scope=>{verificationScope=scope},createPlan:async({deployment})=>{plannedDeployment=deployment;return {summary:{resourceChanges:[],applyable:true,complete:true}}}});
});

test("Azure VM plan rejects malformed SSH key and action without calling Terraform",async()=>{
 let terraformCalls=0;const pool={execute:async(sql)=>sql.startsWith("SELECT id,azure_subscription_id")?[[connection]]:[{affectedRows:1}]};
 await withApi(pool,async base=>{
  const response=await fetch(`${base}/api/cloud-connections/azure/${connectionId}/terraform/plans`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",templateId:"azure_linux_vm",displayName:"Test Linux VM",location:"centralindia",machineSize:"Standard_B1s",adminUsername:"omniadmin",sshPublicKey:"private key"})});
  assert.equal(response.status,400);assert.match((await response.json()).message,/SSH public key/);
 },{verifyConnection:async()=>{},createPlan:async()=>{terraformCalls++}});
 assert.equal(terraformCalls,0);
});
