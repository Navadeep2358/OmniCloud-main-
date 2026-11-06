import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {GetCallerIdentityCommand} from "@aws-sdk/client-sts";
import {AwsConnectionError,getAwsLocalProfile,isAwsLocalProfileEnabled,registerCloudRoutes,verifyAwsLocalProfile} from "../cloudRoutes.js";
import {once} from "node:events";

const accountId="123456789012";
const sessionCredentials={accessKeyId:"temporary-access",secretAccessKey:"temporary-secret",sessionToken:"temporary-session"};

async function withApi(pool,verifyLocalProfile,callback,{enabled=()=>true}={}){
 const app=express();app.use(express.json());
 registerCloudRoutes(app,{pool,requireUser:(req,_res,next)=>{req.user={id:42};next()},verifyLocalProfile,localProfileEnabled:enabled});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 try{return await callback(`http://127.0.0.1:${server.address().port}`)}
 finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

test("local AWS profile uses SSO temporary credentials for an STS identity check only",async()=>{
 const seen=[];
 const result=await verifyAwsLocalProfile({profile:"dev-sso",region:"eu-north-1",credentialProviderFactory:name=>{assert.equal(name,"dev-sso");return async()=>sessionCredentials},stsClientFactory:config=>({send:async command=>{seen.push({client:"sts",config,command});assert.ok(command instanceof GetCallerIdentityCommand);return {Account:accountId}}})});
 assert.equal(result.accountId,accountId);assert.equal(result.profile,"dev-sso");assert.equal("regions" in result,false);
 assert.equal(seen.length,1);assert.ok(seen.every(call=>call.config.credentials===sessionCredentials));
 assert.ok(!seen.some(call=>call.command.constructor.name.includes("AssumeRole")));
});

test("profile verification requires a valid profile and short-lived session credentials",async()=>{
 await assert.rejects(()=>verifyAwsLocalProfile({profile:"bad profile",credentialProviderFactory:()=>async()=>sessionCredentials}),error=>error.code==="AWS_PROFILE_NOT_CONFIGURED");
 await assert.rejects(()=>verifyAwsLocalProfile({credentialProviderFactory:()=>async()=>({accessKeyId:"long-lived",secretAccessKey:"secret"})}),error=>error.code==="AWS_TEMPORARY_CREDENTIALS_REQUIRED");
});

test("profile verification reports expired SSO credentials clearly",async()=>{
 await assert.rejects(()=>verifyAwsLocalProfile({profile:"dev-sso",credentialProviderFactory:()=>async()=>{throw new Error("expired")}}),error=>error.code==="AWS_PROFILE_AUTH_FAILED"&&error.message.includes("aws sso login --profile dev-sso"));
});

test("profile verification enforces the saved account and does not require EC2 permissions",async()=>{
 const baseOptions={profile:"dev-sso",credentialProviderFactory:()=>async()=>sessionCredentials,stsClientFactory:()=>({send:async()=>({Account:accountId})})};
 await assert.rejects(()=>verifyAwsLocalProfile({...baseOptions,expectedAccountId:"999999999999"}),error=>error.code==="AWS_ACCOUNT_MISMATCH");
 const result=await verifyAwsLocalProfile({...baseOptions,stsClientFactory:config=>({send:async command=>{assert.ok(command instanceof GetCallerIdentityCommand);assert.equal(config.credentials,sessionCredentials);return {Account:accountId}}})});
 assert.equal(result.accountId,accountId);
});

test("local profile mode is enabled for development but disabled in production",()=>{
 assert.equal(isAwsLocalProfileEnabled({NODE_ENV:"development",AWS_LOCAL_PROFILE:"omnicloud-dev"}),true);
 assert.equal(isAwsLocalProfileEnabled({NODE_ENV:"development",AWS_LOCAL_PROFILE:"bad profile"}),false);
 assert.equal(isAwsLocalProfileEnabled({NODE_ENV:"development",AWS_LOCAL_PROFILE_MODE_ENABLED:"false"}),false);
 assert.equal(isAwsLocalProfileEnabled({NODE_ENV:"production",AWS_LOCAL_PROFILE_MODE_ENABLED:"true",AWS_LOCAL_PROFILE:"omnicloud-dev"}),false);
 assert.equal(getAwsLocalProfile({AWS_PROFILE:"omnicloud-dev"}),"omnicloud-dev");
});

test("connection check persists only the caller's account and safe status metadata",async()=>{
 const calls=[];const pool={execute:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith("SELECT id,role_arn"))return [[]];return [{affectedRows:1}]}};
 await withApi(pool,async()=>({accountId,credentials:sessionCredentials,profile:"omnicloud-dev"}),async base=>{
  const response=await fetch(`${base}/api/cloud-connections/aws/local-profile/connect`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const body=await response.json();assert.equal(response.status,201);assert.equal(body.connection.account_id,accountId);assert.equal(body.connection.status,"connected");
  assert.equal(body.connection.profile,"omnicloud-dev");assert.equal(JSON.stringify(body).includes(sessionCredentials.sessionToken),false);
  assert.equal(calls.length,3);assert.equal(calls[0].values[0],42);assert.match(calls[0].sql,/user_id=\?.*provider='aws'.*account_id=\?/);
  assert.equal(calls[1].values[1],42);assert.match(calls[1].sql,/provider='aws' AND status='setup'/);
  assert.deepEqual(calls[2].values.slice(0,3),[body.connection.id,42,accountId]);assert.match(calls[2].sql,/INSERT INTO cloud_connections/);assert.match(calls[2].sql,/NULL,NULL,'connected'/);
 });
});

test("existing account connection is updated without storing credentials or a role ARN",async()=>{
 const calls=[];const pool={execute:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith("SELECT id,role_arn"))return [[{id:"existing-id",role_arn:"legacy-role"}]];return [{affectedRows:1}]}};
 await withApi(pool,async()=>({accountId,credentials:sessionCredentials,profile:"omnicloud-dev"}),async base=>{
  const response=await fetch(`${base}/api/cloud-connections/aws/local-profile/connect`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const body=await response.json();assert.equal(response.status,201);assert.equal(body.connection.id,"existing-id");
  assert.equal(calls.length,3);assert.match(calls[2].sql,/role_arn=NULL,external_id=NULL,status='connected'/);assert.deepEqual(calls[2].values.slice(2),["existing-id",42]);
 });
});

test("failed STS verification does not create a cloud connection row",async()=>{
 let writes=0;const pool={execute:async()=>{writes++;return [[]]}};
 await withApi(pool,async()=>{throw new AwsConnectionError("AWS_PROFILE_AUTH_FAILED","AWS STS could not verify the local profile.")},async base=>{
  const response=await fetch(`${base}/api/cloud-connections/aws/local-profile/connect`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const body=await response.json();assert.equal(response.status,401);assert.equal(body.code,"AWS_PROFILE_AUTH_FAILED");assert.match(body.message,/STS/);assert.equal(writes,0);
 });
});

test("disabled local-profile mode cannot verify or persist an account",async()=>{
 let writes=0;const pool={execute:async()=>{writes++;return [[]]}};
 await withApi(pool,async()=>{throw new Error("must not call verifier")},async base=>{
  const response=await fetch(`${base}/api/cloud-connections/aws/local-profile/connect`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  assert.equal(response.status,503);assert.equal((await response.json()).code,"AWS_LOCAL_PROFILE_DISABLED");assert.equal(writes,0);
 },{enabled:()=>false});
});

test("connection listing exposes local mode but no credential material",async()=>{
 let query;const pool={execute:async(sql,values)=>{query={sql,values};return [[{id:"id",provider:"aws",account_id:accountId,status:"connected"}]]}};
 await withApi(pool,async()=>({}),async base=>{
  const response=await fetch(`${base}/api/cloud-connections`);const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.awsLocalProfile.enabled,true);assert.equal(body.awsLocalProfile.profile,getAwsLocalProfile());assert.equal(query.values[0],42);assert.match(query.sql,/WHERE user_id=\?/);
  assert.equal(JSON.stringify(body).includes("sessionToken"),false);
 });
});
