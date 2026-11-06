import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {once} from "node:events";
import {registerCloudRoutes} from "../cloudRoutes.js";

const connectionId="12345678-1234-4234-8234-123456789012";

async function withApi(pool,disconnectAzure,callback){
 const app=express();
 registerCloudRoutes(app,{pool,requireUser:(req,_res,next)=>{req.user={id:42};next()},verifyRole:async()=>{},verifyBackend:async()=>{},disconnectAzure});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 try{return await callback(`http://127.0.0.1:${server.address().port}`)}
 finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

test("disconnect is blocked while a Terraform resource remains active",async()=>{
 let updateCalled=false;
 const pool={execute:async(sql)=>{
  if(sql.startsWith("SELECT id,provider,status"))return [[{id:connectionId,provider:"gcp",status:"connected"}]];
  if(sql.startsWith("SELECT COUNT(*)"))return [[{total:1}]];
  if(sql.startsWith("UPDATE cloud_connections"))updateCalled=true;
  return [{affectedRows:1}];
 }};
 await withApi(pool,async()=>{throw new Error("Azure delegation removal must not run for GCP")},async base=>{
  const response=await fetch(`${base}/api/cloud-connections/${connectionId}/disconnect`,{method:"POST"});
  assert.equal(response.status,409);assert.equal((await response.json()).code,"CLOUD_RESOURCES_REMAIN");assert.equal(updateCalled,false);
 });
});

test("Azure disconnect removes its delegation before marking the tenant-owned connection disconnected",async()=>{
 let revoked,updated=false;
 const pool={execute:async(sql)=>{
  if(sql.startsWith("SELECT id,provider,status"))return [[{id:connectionId,provider:"azure",status:"connected"}]];
  if(sql.startsWith("SELECT COUNT(*)"))return [[{total:0}]];
  if(sql.startsWith("SELECT id,azure_subscription_id"))return [[{id:connectionId,azure_subscription_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",azure_tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",azure_resource_group:"omnicloud-test"}]];
  if(sql.startsWith("UPDATE cloud_connections"))updated=true;
  return [{affectedRows:1}];
 }};
 await withApi(pool,async value=>{revoked=value},async base=>{
  const response=await fetch(`${base}/api/cloud-connections/${connectionId}/disconnect`,{method:"POST"}),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.connection.status,"disconnected");
  assert.equal(revoked.id,connectionId);assert.equal(revoked.resourceGroup,"omnicloud-test");assert.equal(updated,true);
 });
});

test("canceling an unverified Azure setup clears it locally without requiring Azure CLI",async()=>{
 let revoked=false,updated=false;
 const pool={execute:async(sql)=>{
  if(sql.startsWith("SELECT id,provider,status"))return [[{id:connectionId,provider:"azure",status:"setup"}]];
  if(sql.startsWith("SELECT COUNT(*)"))return [[{total:0}]];
  if(sql.startsWith("SELECT id,azure_subscription_id"))throw new Error("Pending setup cancellation should not need Azure lookups");
  if(sql.startsWith("UPDATE cloud_connections"))updated=true;
  return [{affectedRows:1}];
 }};
 await withApi(pool,async()=>{revoked=true},async base=>{
  const response=await fetch(`${base}/api/cloud-connections/${connectionId}/disconnect`,{method:"POST"}),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.connection.status,"disconnected");
  assert.match(body.message,/Pending Azure setup canceled/);assert.match(body.message,/If you already deployed/);
  assert.equal(revoked,false);assert.equal(updated,true);
 });
});

test("another user's cloud connection cannot be disconnected",async()=>{
 let revoked=false,updateCalled=false;
 const pool={execute:async(sql)=>{if(sql.startsWith("SELECT id,provider,status"))return [[]];if(sql.startsWith("UPDATE cloud_connections"))updateCalled=true;return [{affectedRows:1}]}};
 await withApi(pool,async()=>{revoked=true},async base=>{
  const response=await fetch(`${base}/api/cloud-connections/${connectionId}/disconnect`,{method:"POST"});
  assert.equal(response.status,404);assert.equal(revoked,false);assert.equal(updateCalled,false);
 });
});
