import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {once} from "node:events";
import {registerCloudRoutes} from "../cloudRoutes.js";

test("AWS deployment refresh reads the applying deployment primary key correctly",async()=>{
 const queries=[],pool={execute:async(sql,values)=>{queries.push({sql,values});if(sql.startsWith("SELECT id,role_arn FROM cloud_connections"))return [[{id:"connection-1",role_arn:null}]];if(sql.startsWith("UPDATE terraform_operations")||sql.startsWith("UPDATE terraform_deployments"))return [{affectedRows:0}];if(sql.startsWith("SELECT id,template_id,region FROM terraform_deployments"))return [[]];if(sql.startsWith("SELECT id FROM terraform_deployments"))return [[]];if(sql.startsWith("SELECT id,template_id,display_name,bucket_name"))return [[]];if(sql.startsWith("SELECT id,deployment_id,action,status,plan_summary"))return [[]];throw new Error(`Unexpected SQL: ${sql}`)}};
 const app=express();registerCloudRoutes(app,{pool,requireUser:(req,_res,next)=>{req.user={id:42};next()},verifyLocalProfile:async()=>({accountId:"123456789012",credentials:{accessKeyId:"a",secretAccessKey:"b",sessionToken:"c"}})});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/cloud-connections/connection-1/terraform`);assert.equal(response.status,200);assert.deepEqual((await response.json()).deployments,[]);const applyingQuery=queries.find(query=>query.sql.startsWith("SELECT id,template_id,region FROM terraform_deployments"));assert.ok(applyingQuery);assert.doesNotMatch(applyingQuery.sql,/deployment_id/);assert.ok(queries.some(query=>query.sql.includes("status='planning' AND updated_at<?")))}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});
