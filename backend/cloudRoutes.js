import {STSClient,GetCallerIdentityCommand} from "@aws-sdk/client-sts";
import {SSOClient,ListAccountsCommand,ListAccountRolesCommand} from "@aws-sdk/client-sso";
import {fromIni} from "@aws-sdk/credential-provider-ini";
import {spawn} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {getTerraformCatalog,newBucketName,newDeploymentId,newOperationId,planExpiry,runPlan,applyPlan,removePlanFile,removeDeploymentState,readOutputs,validateAwsDeployment} from "./terraformService.js";
import {loadAwsInventory,listAwsImages} from "./awsInventoryService.js";

const awsRegion=()=>process.env.AWS_REGION||"us-east-1";
const awsLoginSessions=new Map();
const safeProfile=value=>typeof value==="string"&&/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(value);
const awsConfigPath=()=>resolve(process.env.AWS_CONFIG_FILE||join(homedir(),".aws","config"));
function parseAwsIni(raw){const sections=new Map();let current="";for(const line of String(raw).split(/\r?\n/)){const section=line.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);if(section){current=section[1].trim();sections.set(current,new Map());continue}const setting=line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*(?:[#;].*)?$/);if(current&&setting)sections.get(current).set(setting[1].toLowerCase(),setting[2].trim())}return sections}
function getSsoProfileEntries(sections){const entries=[],used=new Set();for(const [section,values]of sections){const match=section.match(/^(?:profile\s+)?(.+)$/);if(!match||section.startsWith("sso-session ")||section.startsWith("services "))continue;const name=match[1];let start=values.get("sso_start_url"),ssoRegion=values.get("sso_region"),registrationScopes=values.get("sso_registration_scopes"),sessionName=values.get("sso_session");if(sessionName){const session=sections.get(`sso-session ${sessionName}`);start=session?.get("sso_start_url")||start;ssoRegion=session?.get("sso_region")||ssoRegion;registrationScopes=session?.get("sso_registration_scopes")||registrationScopes}if(start&&ssoRegion){entries.push({name,accountId:values.get("sso_account_id")||null,roleName:values.get("sso_role_name")||null,region:values.get("region")||awsRegion(),startUrl:start,ssoRegion,registrationScopes,sessionName:sessionName||null});if(sessionName)used.add(sessionName)}}for(const [section,values]of sections){const match=section.match(/^sso-session\s+(.+)$/);if(match&&!used.has(match[1])&&values.get("sso_start_url")&&values.get("sso_region"))entries.push({name:match[1],accountId:null,roleName:null,region:awsRegion(),startUrl:values.get("sso_start_url"),ssoRegion:values.get("sso_region"),registrationScopes:values.get("sso_registration_scopes"),sessionName:match[1]})}return entries}
async function loadAwsProfileCatalog(){try{const entries=getSsoProfileEntries(parseAwsIni(await readFile(awsConfigPath(),"utf8")));if(entries.length)return entries.map(({name,accountId,roleName,region})=>({name,accountId,roleName,region}));if(process.env.AWS_SSO_START_URL&&process.env.AWS_SSO_REGION)return[{name:"default",accountId:null,roleName:null,region:awsRegion()}];return[]}catch{if(process.env.AWS_SSO_START_URL&&process.env.AWS_SSO_REGION)return[{name:"default",accountId:null,roleName:null,region:awsRegion()}];return[]}}
async function createAwsUserProfile(userId,profile,selection={}){if(!safeProfile(profile))throw new AwsConnectionError("AWS_PROFILE_NOT_CONFIGURED","Choose a valid AWS IAM Identity Center portal.");let entries=[];try{entries=getSsoProfileEntries(parseAwsIni(await readFile(awsConfigPath(),"utf8")))}catch{}let source=entries.find(item=>item.name===profile);if(!source&&profile==="default"&&process.env.AWS_SSO_START_URL&&process.env.AWS_SSO_REGION)source={name:profile,startUrl:process.env.AWS_SSO_START_URL,ssoRegion:process.env.AWS_SSO_REGION,registrationScopes:"sso:account:access",region:awsRegion()};if(!source)throw new AwsConnectionError("AWS_PROFILE_NOT_CONFIGURED","That IAM Identity Center portal is not configured on the backend.");if((selection.accountId&&!/^\d{12}$/.test(selection.accountId))||(selection.roleName&&(typeof selection.roleName!=="string"||selection.roleName.length>128||/[\r\n]/.test(selection.roleName))))throw new AwsConnectionError("AWS_ACCOUNT_SELECTION_INVALID","Choose a valid AWS account and permission set.");const key=createHash("sha256").update(`${userId}:${profile}`).digest("hex"),sessionName=`omni-${key.slice(0,32)}`,credentialProfile=`omni-${key.slice(32,48)}`,directory=resolve(process.env.OMNICLOUD_AWS_USER_CONFIG_DIR||join(process.cwd(),".omnicloud-aws-users",key.slice(0,2),key)),configFile=join(directory,"config"),credentialsFile=join(directory,"credentials");await mkdir(directory,{recursive:true,mode:0o700});const profileBlock=selection.accountId&&selection.roleName?`[profile ${credentialProfile}]\nsso_session = ${sessionName}\nsso_account_id = ${selection.accountId}\nsso_role_name = ${selection.roleName}\nregion = ${selection.region||source.region||awsRegion()}\noutput = json\n\n`:"";const config=`${profileBlock}[sso-session ${sessionName}]\nsso_start_url = ${source.startUrl}\nsso_region = ${source.ssoRegion}\nsso_registration_scopes = ${source.registrationScopes||"sso:account:access"}\n`;await writeFile(configFile,config,{mode:0o600});await writeFile(credentialsFile,"",{mode:0o600});return{profile,credentialProfile,configFile,credentialsFile,accountId:selection.accountId||null,roleName:selection.roleName||null,region:selection.region||source.region||awsRegion(),sessionName,ssoRegion:source.ssoRegion}}
function ssoCachePath(sessionName){const root=join(homedir(),".aws","sso","cache");return join(root,`${createHash("sha1").update(sessionName).digest("hex")}.json`)}
async function readSsoAccessToken(userId,profile){const selected=await createAwsUserProfile(userId,profile);let cache;try{cache=JSON.parse(await readFile(ssoCachePath(selected.sessionName),"utf8"))}catch{throw new AwsConnectionError("AWS_PROFILE_AUTH_FAILED","AWS sign-in did not produce a user-specific SSO token. Start Integrate AWS again.")}if(!cache.accessToken)throw new AwsConnectionError("AWS_PROFILE_AUTH_FAILED","The AWS SSO token cache is missing its access token. Integrate AWS again.");return{selected,accessToken:cache.accessToken}}
async function listUserSsoAccounts(userId,profile){const{selected,accessToken}=await readSsoAccessToken(userId,profile),client=new SSOClient({region:selected.ssoRegion}),accounts=[];let nextToken;do{const page=await client.send(new ListAccountsCommand({accessToken,maxResults:100,...(nextToken?{nextToken}:{})}));accounts.push(...(page.accountList||[]));nextToken=page.nextToken}while(nextToken);const roles=[];for(const account of accounts){let roleToken;do{const page=await client.send(new ListAccountRolesCommand({accessToken,accountId:account.accountId,maxResults:100,...(roleToken?{nextToken:roleToken}:{})}));for(const role of page.roleList||[])roles.push({accountId:account.accountId,accountName:account.accountName,roleName:role.roleName});roleToken=page.nextToken}while(roleToken)}return roles}
async function startAwsSsoLogin(userId,profile){
 const existing=[...awsLoginSessions.values()].find(item=>item.userId===String(userId)&&["starting","waiting"].includes(item.status));if(existing)return existing;
 const session={id:randomUUID(),userId:String(userId),profile,status:"starting",verificationUri:null,userCode:null,message:"Starting AWS sign-in…",createdAt:Date.now(),child:null,timer:null,awsProfile:null};awsLoginSessions.set(session.id,session);
 try{session.awsProfile=await createAwsUserProfile(userId,profile);const binary=process.env.AWS_CLI_BIN||(process.platform==="win32"?"aws.exe":"aws"),child=spawn(binary,["sso","login","--sso-session",session.awsProfile.sessionName,"--use-device-code","--no-browser"],{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,AWS_CONFIG_FILE:session.awsProfile.configFile,AWS_SHARED_CREDENTIALS_FILE:session.awsProfile.credentialsFile}});session.child=child;session.status="waiting";
  const parseOutput=chunk=>{const output=String(chunk||"");const url=output.match(/https:\/\/[^\s"'<>]+/g)?.map(value=>value.replace(/[),.;]+$/,""))?.find(value=>{try{const host=new URL(value).hostname;return host.endsWith(".amazonaws.com")||host.endsWith(".awsapps.com")||host.endsWith(".api.aws")}catch{return false}});if(url)session.verificationUri=url;const code=output.match(/\b([A-Z0-9]{4,8}[- ][A-Z0-9 ]{3,8})\b/)?.[1]?.trim().replace(/\s+/g," ");if(code)session.userCode=code;if(session.verificationUri)session.message="Open the AWS verification page and approve this sign-in."};child.stdout.on("data",parseOutput);child.stderr.on("data",parseOutput);
  session.timer=setTimeout(()=>{if(session.status==="waiting"){session.status="failed";session.message="AWS sign-in timed out. Start the integration again.";child.kill() }},10*60*1000);session.timer.unref?.();
  child.on("error",error=>{clearTimeout(session.timer);session.status="failed";session.message=error.code==="ENOENT"?"AWS CLI was not found on the OmniCloud backend computer. Install AWS CLI v2 and retry.":"AWS sign-in could not start. Check the backend AWS CLI installation."});
  child.on("close",code=>{clearTimeout(session.timer);if(session.status!=="waiting")return;session.status=code===0?"authenticated":"failed";session.message=code===0?"AWS sign-in succeeded. Verifying the connected account…":"AWS sign-in was cancelled or failed. Try again."});
 }catch(error){session.status="failed";session.message=error.code==="ENOENT"?"AWS CLI was not found on the OmniCloud backend computer. Install AWS CLI v2 and retry.":error instanceof AwsConnectionError?error.message:"AWS sign-in could not start. Check the selected AWS SSO profile and backend configuration."}
 return session;
}

export class AwsConnectionError extends Error{
 constructor(code,message,cause){super(message,{cause});this.name="AwsConnectionError";this.code=code;}
}

export function isAwsLocalProfileEnabled(env=process.env){
 return env.AWS_LOCAL_PROFILE_MODE_ENABLED==="true"||(env.NODE_ENV!=="production"&&env.AWS_LOCAL_PROFILE_MODE_ENABLED!=="false"&&/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(env.AWS_LOCAL_PROFILE||env.AWS_PROFILE||""));
}

export function getAwsLocalProfile(env=process.env){return env.AWS_LOCAL_PROFILE||env.AWS_PROFILE||"default"}

export async function verifyAwsLocalProfile({profile=getAwsLocalProfile(),region=awsRegion(),expectedAccountId,credentialProviderFactory=name=>fromIni({profile:name}),stsClientFactory=config=>new STSClient(config),enabled=isAwsLocalProfileEnabled()}={}){
 if(!enabled)throw new AwsConnectionError("AWS_LOCAL_PROFILE_DISABLED","Local AWS CLI profile connections are disabled. Enable AWS_LOCAL_PROFILE_MODE_ENABLED and set AWS_LOCAL_PROFILE in the local backend environment, then restart it.");
 if(!profile||!/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(profile))throw new AwsConnectionError("AWS_PROFILE_NOT_CONFIGURED","Set AWS_LOCAL_PROFILE to the name of an AWS CLI profile in the local backend environment.");
 let credentials;
 try{credentials=await credentialProviderFactory(profile)()}catch(error){
  throw new AwsConnectionError("AWS_PROFILE_AUTH_FAILED",`Could not load AWS profile "${profile}". Select Integrate AWS in Cloud connections to complete the browser sign-in, then retry.`,error);
 }
 // Require a session token so this local-only feature never forwards long-lived keys to Terraform.
 if(!credentials?.accessKeyId||!credentials?.secretAccessKey||!credentials?.sessionToken)throw new AwsConnectionError("AWS_TEMPORARY_CREDENTIALS_REQUIRED",`Profile "${profile}" did not provide short-lived credentials. Configure this profile for AWS IAM Identity Center (SSO), then use Integrate AWS in Cloud connections.`);
 let identity;
 try{identity=await stsClientFactory({region,credentials}).send(new GetCallerIdentityCommand({}));}
 catch(error){throw new AwsConnectionError("AWS_PROFILE_AUTH_FAILED",`AWS rejected the credentials for profile "${profile}". Use Integrate AWS in Cloud connections to sign in again.`,error)}
 if(!/^\d{12}$/.test(identity?.Account||""))throw new AwsConnectionError("AWS_IDENTITY_INVALID","AWS returned an invalid account identity.");
 if(expectedAccountId&&identity.Account!==expectedAccountId)throw new AwsConnectionError("AWS_ACCOUNT_MISMATCH",`The configured AWS profile is signed in to account ${identity.Account}, but this connection is for account ${expectedAccountId}.`);
 return {accountId:identity.Account,credentials,profile};
}

export async function verifyAwsUserProfile({userId,profile,accountId,roleName,expectedAccountId,region=awsRegion(),stsClientFactory=config=>new STSClient(config),enabled=isAwsLocalProfileEnabled()}={}){
 if(!enabled)throw new AwsConnectionError("AWS_LOCAL_PROFILE_DISABLED","AWS account integration is disabled in this backend.");
 if(userId===undefined||userId===null)throw new AwsConnectionError("AWS_PROFILE_NOT_CONFIGURED","This AWS connection has no OmniCloud user profile. Reconnect it with an IAM Identity Center profile.");
 if(!accountId||!roleName)throw new AwsConnectionError("AWS_ACCOUNT_SELECTION_REQUIRED","Choose an AWS account and permission set to connect.");
 let selected;try{selected=await createAwsUserProfile(userId,profile,{accountId,roleName,region})}catch(error){throw error instanceof AwsConnectionError?error:new AwsConnectionError("AWS_PROFILE_NOT_CONFIGURED","The selected AWS IAM Identity Center portal could not be loaded from the backend configuration.",error)}
 const result=await verifyAwsLocalProfile({profile:selected.profile,region,expectedAccountId,enabled,credentialProviderFactory:()=>fromIni({profile:selected.credentialProfile,configFilepath:selected.configFile,filepath:selected.credentialsFile}),stsClientFactory});
 return{...result,region:selected.region};
}

function safeAwsError(error){
 if(error instanceof AwsConnectionError)return {code:error.code,message:error.message};
 const code=error?.name||"AWS_REQUEST_FAILED";
 if(["ExpiredToken","ExpiredTokenException","InvalidClientTokenId","UnrecognizedClientException","CredentialsProviderError"].includes(code))return {code:"AWS_PROFILE_AUTH_FAILED",message:"The local AWS profile is unavailable or expired. Refresh its SSO session and retry."};
 return {code:"AWS_REQUEST_FAILED",message:"AWS could not verify the configured local profile. Check the profile and try again."};
}

export function registerCloudRoutes(app,{pool,requireUser,verifyLocalProfile=verifyAwsUserProfile,localProfileEnabled=isAwsLocalProfileEnabled,disconnectAzure=async()=>{}}){
 app.get("/api/cloud-connections",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,provider,account_id,role_arn,aws_profile,aws_role_name,project_id,service_account_email,azure_subscription_id,azure_tenant_id,azure_resource_group,CASE WHEN status='setup' THEN external_id ELSE NULL END AS external_id,status,created_at,updated_at FROM cloud_connections WHERE user_id=? ORDER BY created_at DESC",[req.user.id]);
  const awsRows=rows.filter(item=>item.provider==="aws"&&item.status==="connected"&&!item.role_arn);
  if(awsRows.length){
   for(const connection of awsRows){let authError=null;try{if(!localProfileEnabled())throw new AwsConnectionError("AWS_LOCAL_PROFILE_DISABLED","AWS integration is disabled.");if(!connection.aws_profile)throw new AwsConnectionError("AWS_USER_PROFILE_REQUIRED","Reconnect this AWS account using your own IAM Identity Center profile.");await verifyLocalProfile({userId:req.user.id,profile:connection.aws_profile,accountId:connection.account_id,roleName:connection.aws_role_name,expectedAccountId:connection.account_id})}catch(error){authError=error}
    if(authError){await pool.execute("UPDATE cloud_connections SET status='disconnected',updated_at=? WHERE id=? AND user_id=? AND provider='aws' AND status='connected'",[Date.now(),connection.id,req.user.id]);connection.status="disconnected";connection.sessionStatus="disconnected";connection.sessionMessage=authError.message||"AWS session is unavailable. Integrate this AWS profile again."}else connection.sessionStatus="connected";
   }
  }
  res.json({connections:rows,awsLocalProfile:{enabled:localProfileEnabled(),profile:localProfileEnabled()?getAwsLocalProfile():null,profiles:localProfileEnabled()?await loadAwsProfileCatalog():[]}});
 }catch(e){next(e)}});

 app.post("/api/cloud-connections/:connectionId/disconnect",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,provider,status FROM cloud_connections WHERE id=? AND user_id=?",[req.params.connectionId,req.user.id]);
  if(!rows.length)return res.status(404).json({message:"Cloud connection not found."});
  const connection=rows[0],tableByProvider={aws:"terraform_deployments",gcp:"gcp_terraform_deployments",azure:"azure_terraform_deployments"},table=tableByProvider[connection.provider];
  if(table&&connection.status==="connected"){
   const [live]=await pool.execute(`SELECT COUNT(*) AS total FROM ${table} WHERE connection_id=? AND user_id=? AND status IN ('planning','planned','applying','active','attention')`,[connection.id,req.user.id]);
   if(Number(live[0]?.total||0)>0)return res.status(409).json({code:"CLOUD_RESOURCES_REMAIN",message:"This connection still has managed resources or an unfinished operation. Destroy those resources first, then disconnect."});
  }
  if(connection.provider==="azure"&&connection.status==="connected"){
   const [azureRows]=await pool.execute("SELECT id,azure_subscription_id,azure_tenant_id,azure_resource_group FROM cloud_connections WHERE id=? AND user_id=? AND provider='azure'",[connection.id,req.user.id]);
   try{await disconnectAzure({id:connection.id,subscriptionId:azureRows[0].azure_subscription_id,tenantId:azureRows[0].azure_tenant_id,resourceGroup:azureRows[0].azure_resource_group})}catch(error){return res.status(error.status||409).json({code:error.code||"AZURE_DELEGATION_REVOKE_FAILED",message:error.message||"Azure Lighthouse access could not be removed. The connection remains connected."})}
  }
  await pool.execute("UPDATE cloud_connections SET status='disconnected',external_id=NULL,updated_at=? WHERE id=? AND user_id=?",[Date.now(),connection.id,req.user.id]);
  const message=connection.provider==="aws"?"OmniCloud removed the saved AWS link. Your local AWS CLI profile remains configured; no AWS role or policy was changed.":connection.provider==="azure"
   ?connection.status==="setup"?"Pending Azure setup canceled in OmniCloud. If you already deployed its Lighthouse template, remove that delegation in the customer Azure portal.":"Azure Lighthouse delegation and OmniCloud connection have been disconnected."
   :"OmniCloud has disconnected this account. Revoke any provider-side delegated access separately if it is no longer needed.";
  res.json({connection:{id:connection.id,provider:connection.provider,status:"disconnected"},message});
 }catch(error){next(error)}});

 app.post("/api/cloud-connections/aws/local-profile/connect",requireUser,async(req,res,next)=>{try{
  if(!localProfileEnabled())return res.status(503).json({code:"AWS_LOCAL_PROFILE_DISABLED",message:"Local AWS profile connections are disabled. Enable the local profile mode in the backend environment and restart the backend."});
  const profile=typeof req.body?.profile==="string"?req.body.profile:getAwsLocalProfile(),accountId=req.body?.accountId,roleName=req.body?.roleName;let identity;
  try{identity=await verifyLocalProfile({userId:req.user.id,profile,accountId,roleName})}catch(error){const failure=safeAwsError(error);const status=failure.code==="AWS_PROFILE_AUTH_FAILED"?401:failure.code==="AWS_LOCAL_PROFILE_DISABLED"?503:409;return res.status(status).json(failure)}
  const [existing]=await pool.execute("SELECT id,role_arn FROM cloud_connections WHERE user_id=? AND provider='aws' AND account_id=? AND status IN ('connected','disconnected') ORDER BY (status='connected') DESC,created_at DESC LIMIT 1",[req.user.id,identity.accountId]);
  const now=Date.now(),id=existing[0]?.id||randomUUID();
  await pool.execute("UPDATE cloud_connections SET status='disconnected',external_id=NULL,updated_at=? WHERE user_id=? AND provider='aws' AND status='setup'",[now,req.user.id]);
  if(existing.length)await pool.execute("UPDATE cloud_connections SET account_id=?,role_arn=NULL,aws_profile=?,aws_role_name=?,external_id=NULL,status='connected',updated_at=? WHERE id=? AND user_id=?",[identity.accountId,profile,roleName,now,id,req.user.id]);
  else await pool.execute("INSERT INTO cloud_connections(id,user_id,provider,account_id,role_arn,aws_profile,aws_role_name,external_id,status,created_at,updated_at) VALUES(?,?,'aws',?,NULL,?,?,NULL,'connected',?,?)",[id,req.user.id,identity.accountId,profile,roleName,now,now]);
  res.status(201).json({connection:{id,provider:"aws",account_id:identity.accountId,role_arn:null,aws_profile:profile,aws_role_name:roleName,status:"connected"}});
 }catch(error){next(error)}});

 app.get("/api/cloud-connections/aws/local-profile/profiles",requireUser,async(_req,res)=>{if(!localProfileEnabled())return res.status(503).json({profiles:[],message:"AWS account integration is disabled in this backend."});res.json({profiles:await loadAwsProfileCatalog()})});

 app.post("/api/cloud-connections/aws/local-profile/login",requireUser,async(req,res)=>{
  if(!localProfileEnabled())return res.status(503).json({code:"AWS_LOCAL_PROFILE_DISABLED",message:"AWS local-profile integration is disabled. Enable it in the backend environment and restart OmniCloud."});
  const profile=typeof req.body?.profile==="string"?req.body.profile:getAwsLocalProfile();if(!profile)return res.status(400).json({code:"AWS_PROFILE_NOT_CONFIGURED",message:"Choose an AWS IAM Identity Center profile."});
  const session=await startAwsSsoLogin(req.user.id,profile);res.status(202).json({login:{id:session.id,status:session.status,message:session.message,profile:session.profile}});
 });

 app.get("/api/cloud-connections/aws/local-profile/login/:loginId",requireUser,async(req,res)=>{
  const session=awsLoginSessions.get(req.params.loginId);if(!session||session.userId!==String(req.user.id))return res.status(404).json({message:"AWS sign-in session was not found or has expired."});
  res.json({login:{id:session.id,status:session.status,message:session.message,verificationUri:session.verificationUri,userCode:session.userCode,profile:session.profile}});
 });

 app.get("/api/cloud-connections/aws/local-profile/login/:loginId/accounts",requireUser,async(req,res)=>{const session=awsLoginSessions.get(req.params.loginId);if(!session||session.userId!==String(req.user.id))return res.status(404).json({message:"AWS sign-in session was not found or has expired."});if(session.status!=="authenticated")return res.status(409).json({message:"Complete AWS portal sign-in before choosing an account."});try{res.json({accounts:await listUserSsoAccounts(req.user.id,session.profile)})}catch(error){const failure=safeAwsError(error);res.status(409).json(failure)}});

 app.delete("/api/cloud-connections/aws/local-profile/login/:loginId",requireUser,async(req,res)=>{
  const session=awsLoginSessions.get(req.params.loginId);if(!session||session.userId!==String(req.user.id))return res.status(404).json({message:"AWS sign-in session was not found or has expired."});
  if(session.status==="waiting"){session.status="cancelled";session.message="AWS sign-in cancelled.";clearTimeout(session.timer);session.child?.kill()}
  res.json({login:{id:session.id,status:session.status}});
 });

 app.get("/api/cloud-connections/:connectionId/terraform",requireUser,async(req,res,next)=>{try{
  const [connections]=await pool.execute("SELECT id,role_arn FROM cloud_connections WHERE id=? AND user_id=? AND provider='aws' AND status='connected'",[req.params.connectionId,req.user.id]);
  if(!connections.length)return res.status(404).json({message:"Connected AWS account not found."});
  if(connections[0].role_arn)return res.status(409).json({code:"AWS_LEGACY_CONNECTION",message:"This is an old role-based AWS connection. Destroy its managed resources, disconnect it, then connect again with the local AWS CLI profile."});
  const staleCutoff=Date.now()-12*60*1000;
  await pool.execute("UPDATE terraform_operations SET status='failed',updated_at=? WHERE connection_id=? AND user_id=? AND status='planning' AND updated_at<?",[Date.now(),req.params.connectionId,req.user.id,staleCutoff]);
  await pool.execute("UPDATE terraform_deployments SET status='failed',updated_at=? WHERE connection_id=? AND user_id=? AND status='planning' AND updated_at<?",[Date.now(),req.params.connectionId,req.user.id,staleCutoff]);
  const [applying]=await pool.execute("SELECT id,template_id,region FROM terraform_deployments WHERE connection_id=? AND user_id=? AND status='applying'",[req.params.connectionId,req.user.id]);
  for(const item of applying){const output=await readOutputs(req.user.id,req.params.connectionId,item.id),resourceId=output.bucket_name||output.instance_id||output.db_identifier||output.table_name;if(resourceId){await pool.execute("UPDATE terraform_deployments SET status='active',resource_id=?,outputs_json=?,updated_at=? WHERE id=? AND user_id=? AND status='applying'",[resourceId,JSON.stringify(output),Date.now(),item.id,req.user.id]);await pool.execute("UPDATE terraform_operations SET status='applied',updated_at=? WHERE deployment_id=? AND user_id=? AND status='applying'",[Date.now(),item.id,req.user.id]);}}
  const [staleApplies]=await pool.execute("SELECT id FROM terraform_deployments WHERE connection_id=? AND user_id=? AND status='applying' AND updated_at<?",[req.params.connectionId,req.user.id,staleCutoff]);
  for(const item of staleApplies){await pool.execute("UPDATE terraform_deployments SET status='attention',updated_at=? WHERE id=? AND user_id=? AND status='applying'",[Date.now(),item.id,req.user.id]);await pool.execute("UPDATE terraform_operations SET status='failed',updated_at=? WHERE deployment_id=? AND user_id=? AND status='applying'",[Date.now(),item.id,req.user.id]);}
  const [deployments]=await pool.execute("SELECT id,template_id,display_name,bucket_name,region,resource_id,config_json,outputs_json,status,created_at,updated_at FROM terraform_deployments WHERE connection_id=? AND user_id=? ORDER BY created_at DESC",[req.params.connectionId,req.user.id]);
  const [operations]=await pool.execute("SELECT id,deployment_id,action,status,plan_summary,expires_at,created_at FROM terraform_operations WHERE connection_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50",[req.params.connectionId,req.user.id]);
  const parse=value=>{try{return value?JSON.parse(value):null}catch{return null}};
  res.json({catalog:getTerraformCatalog(),deployments:deployments.map(d=>({...d,config:d.config_json?parse(d.config_json):{},outputs:d.outputs_json?parse(d.outputs_json):{}})),operations:operations.map(o=>({...o,plan_summary:parse(o.plan_summary)}))});
 }catch(e){next(e)}});

 app.get("/api/cloud-connections/:connectionId/aws-inventory",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,account_id,role_arn,aws_profile,aws_role_name FROM cloud_connections WHERE id=? AND user_id=? AND provider='aws' AND status='connected'",[req.params.connectionId,req.user.id]);if(!rows.length)return res.status(404).json({message:"Connected AWS account not found."});if(rows[0].role_arn)return res.status(409).json({code:"AWS_LEGACY_CONNECTION",message:"Reconnect AWS with your IAM Identity Center profile before loading inventory."});
  const region=typeof req.query.region==="string"&&/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(req.query.region)?req.query.region:awsRegion();let credentials;try{({credentials}=await verifyLocalProfile({userId:req.user.id,profile:rows[0].aws_profile,accountId:rows[0].account_id,roleName:rows[0].aws_role_name,expectedAccountId:rows[0].account_id,region}))}catch(error){return res.status(409).json(safeAwsError(error))}
  res.json(await loadAwsInventory({credentials,region}));
 }catch(error){next(error)}});

 app.get("/api/cloud-connections/:connectionId/aws-images",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT account_id,role_arn,aws_profile,aws_role_name FROM cloud_connections WHERE id=? AND user_id=? AND provider='aws' AND status='connected'",[req.params.connectionId,req.user.id]);if(!rows.length)return res.status(404).json({message:"Connected AWS account not found."});if(rows[0].role_arn)return res.status(409).json({code:"AWS_LEGACY_CONNECTION",message:"Reconnect AWS with your IAM Identity Center profile before loading images."});
  const region=typeof req.query.region==="string"&&/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(req.query.region)?req.query.region:awsRegion();let credentials;try{({credentials}=await verifyLocalProfile({userId:req.user.id,profile:rows[0].aws_profile,accountId:rows[0].account_id,roleName:rows[0].aws_role_name,expectedAccountId:rows[0].account_id,region}))}catch(error){return res.status(409).json(safeAwsError(error))}
  res.json({images:await listAwsImages({credentials,region})});
 }catch(error){const failure=safeAwsError(error);res.status(502).json({...failure,message:error?.name==="UnauthorizedOperation"?"The AWS profile needs ec2:DescribeImages to load available operating system images.":failure.message})}});

 app.delete("/api/cloud-connections/:connectionId/terraform/deployments/:deploymentId",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,status FROM terraform_deployments WHERE id=? AND connection_id=? AND user_id=?",[req.params.deploymentId,req.params.connectionId,req.user.id]);if(!rows.length)return res.status(404).json({message:"Managed deployment not found."});if(!["destroyed","failed"].includes(rows[0].status))return res.status(409).json({message:"Destroy the AWS resource before removing its OmniCloud record."});
  await pool.execute("DELETE FROM terraform_operations WHERE deployment_id=? AND connection_id=? AND user_id=?",[rows[0].id,req.params.connectionId,req.user.id]);await pool.execute("DELETE FROM terraform_deployments WHERE id=? AND connection_id=? AND user_id=?",[rows[0].id,req.params.connectionId,req.user.id]);await removeDeploymentState(req.user.id,req.params.connectionId,rows[0].id);res.json({deleted:true});
 }catch(error){next(error)}});

 app.post("/api/cloud-connections/:connectionId/terraform/plans",requireUser,async(req,res,next)=>{try{
  const {action,templateId,deploymentId,displayName,region,config}=req.body||{};
  if(!["create","update","destroy"].includes(action))return res.status(400).json({message:"Choose a supported create, update, or destroy action."});
  const [connections]=await pool.execute("SELECT id,account_id,role_arn,aws_profile,aws_role_name FROM cloud_connections WHERE id=? AND user_id=? AND provider='aws' AND status='connected'",[req.params.connectionId,req.user.id]);
  if(!connections.length)return res.status(404).json({message:"Connected AWS account not found."});
  const connection=connections[0];let deployment,isNewDeployment=false,credentials,previousStatus=null;
  if(connection.role_arn)return res.status(409).json({code:"AWS_LEGACY_CONNECTION",message:"This connection still uses the old IAM role flow. Destroy its managed resources, disconnect it, and reconnect with the local AWS CLI profile."});
  try{({credentials}=await verifyLocalProfile({userId:req.user.id,profile:connection.aws_profile,accountId:connection.account_id,roleName:connection.aws_role_name,expectedAccountId:connection.account_id}))}catch(e){const failure=safeAwsError(e);return res.status(409).json(failure)}
  if(action==="create"&&!deploymentId){
   let validated;try{validated=validateAwsDeployment({templateId,displayName,region,config})}catch(error){return res.status(400).json({code:"AWS_DEPLOYMENT_INVALID",message:error.message})}
   if(templateId==="ec2_instance"){try{const images=await listAwsImages({credentials,region:validated.region}),image=validated.config.amiId?images.find(item=>item.id===validated.config.amiId):images.find(item=>item.architecture==="x86_64"&&item.minimumRootVolumeGiB&&item.minimumRootVolumeGiB<=30);if(!image)return res.status(422).json({code:"AWS_AMI_UNAVAILABLE",message:"No supported x86_64 Linux image with a root disk of 30 GiB or less is available in this region. Choose another region or image."});if(!image.minimumRootVolumeGiB||image.minimumRootVolumeGiB>30)return res.status(422).json({code:"AWS_AMI_TOO_LARGE",message:`This image requires at least ${image.minimumRootVolumeGiB||"an unknown size"} GiB, above OmniCloud free-tier mode's 30 GiB disk limit. Choose a smaller image.`});validated.config.amiId=image.id;validated.config.rootVolumeGiB=Math.max(validated.config.rootVolumeGiB,image.minimumRootVolumeGiB)}catch(error){return res.status(502).json({code:"AWS_AMI_LOOKUP_FAILED",message:error?.name==="UnauthorizedOperation"?"AWS needs ec2:DescribeImages to choose and validate a default Linux image.":`Could not load a default Linux image for ${validated.region}. ${error.message}`})}}
   const id=newDeploymentId(),now=Date.now(),bucketName=templateId==="private_s3_bucket"?newBucketName(connection.account_id):templateId==="ec2_instance"?`ec2-${id.replaceAll("-","")}`:templateId==="rds_mysql_instance"?`omni-${connection.account_id.slice(-6)}-${id.replaceAll("-","").slice(0,16)}`:`omni_${connection.account_id.slice(-6)}_${id.replaceAll("-","").slice(0,16)}`;
   deployment={id,template_id:templateId,display_name:validated.displayName,bucket_name:bucketName,region:validated.region,config:validated.config,status:"planning"};isNewDeployment=true;
   await pool.execute("INSERT INTO terraform_deployments(id,user_id,connection_id,template_id,display_name,bucket_name,region,config_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'planning',?,?)",[id,req.user.id,connection.id,templateId,deployment.display_name,bucketName,region,JSON.stringify(validated.config),now,now]);
  }else{
   if(typeof deploymentId!=="string")return res.status(400).json({message:"Select a known deployment."});
   const [rows]=await pool.execute("SELECT id,template_id,display_name,bucket_name,region,config_json,status FROM terraform_deployments WHERE id=? AND user_id=? AND connection_id=?",[deploymentId,req.user.id,connection.id]);
   if(!rows.length)return res.status(404).json({message:"Deployment not found."});deployment=rows[0];
   try{deployment.config=deployment.config_json?JSON.parse(deployment.config_json):{}}catch{deployment.config={}}
   if(action==="create"){
    if(!["failed","planned"].includes(deployment.status))return res.status(409).json({message:"Only a failed or expired create can be retried. Refresh this deployment before trying again."});
    previousStatus=deployment.status;
   }
   if(action==="update"){
    if(!["active","attention"].includes(deployment.status))return res.status(409).json({message:"This deployment has another operation in progress. Refresh its status before trying again."});
    previousStatus=deployment.status;
    if(region&&region!==deployment.region)return res.status(400).json({code:"AWS_REGION_IMMUTABLE",message:"The AWS region cannot be changed after a resource is created. Create a new deployment in the desired region instead."});
    let validated;try{validated=validateAwsDeployment({templateId:deployment.template_id,displayName,region:deployment.region,config:config??deployment.config})}catch(error){return res.status(400).json({code:"AWS_DEPLOYMENT_INVALID",message:error.message})}
    deployment={...deployment,display_name:validated.displayName,region:validated.region,config:validated.config};
   }
   if(action==="destroy"){
    if(!["active","attention"].includes(deployment.status))return res.status(409).json({message:"This deployment has another operation in progress. Refresh its status before trying again."});
    previousStatus=deployment.status;
   }
  }
  if(!isNewDeployment){
   const [claimedDeployment]=await pool.execute("UPDATE terraform_deployments SET status='planning',updated_at=? WHERE id=? AND user_id=? AND connection_id=? AND status=?",[Date.now(),deployment.id,req.user.id,connection.id,previousStatus]);
   if(!claimedDeployment.affectedRows)return res.status(409).json({message:"This deployment changed while planning. Refresh the page and try again."});
  }
  const [oldPlans]=await pool.execute("SELECT id FROM terraform_operations WHERE deployment_id=? AND user_id=? AND status='planned'",[deployment.id,req.user.id]);
  await pool.execute("UPDATE terraform_operations SET status='superseded',updated_at=? WHERE deployment_id=? AND user_id=? AND status='planned'",[Date.now(),deployment.id,req.user.id]);
  await Promise.allSettled(oldPlans.map(item=>removePlanFile(req.user.id,connection.id,deployment.id,item.id)));
  const operationId=newOperationId(),expires=planExpiry(),now=Date.now();
  try{await pool.execute("INSERT INTO terraform_operations(id,user_id,connection_id,deployment_id,action,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'planning',?,?,?)",[operationId,req.user.id,connection.id,deployment.id,action,expires,now,now]);}
  catch(error){if(isNewDeployment)await pool.execute("UPDATE terraform_deployments SET status='failed',updated_at=? WHERE id=? AND user_id=?",[Date.now(),deployment.id,req.user.id]);else await pool.execute("UPDATE terraform_deployments SET status=?,updated_at=? WHERE id=? AND user_id=? AND status='planning'",[previousStatus,Date.now(),deployment.id,req.user.id]);throw error}
  try{
   const result=await runPlan({deployment,userId:req.user.id,connectionId:connection.id,operationId,action,credentials});
   const summary={...result.summary,desiredDisplayName:deployment.display_name,desiredRegion:deployment.region,desiredConfig:deployment.config||{},previousStatus:previousStatus||"failed"};
   await pool.execute("UPDATE terraform_operations SET status='planned',plan_summary=?,updated_at=? WHERE id=? AND user_id=? AND status='planning'",[JSON.stringify(summary),Date.now(),operationId,req.user.id]);
   await pool.execute("UPDATE terraform_deployments SET status='planned',updated_at=? WHERE id=? AND user_id=? AND connection_id=? AND status IN ('planning','planned')",[Date.now(),deployment.id,req.user.id,connection.id]);
   res.status(201).json({operation:{id:operationId,action,status:"planned",expiresAt:expires,summary},deployment});
  }catch(e){await pool.execute("UPDATE terraform_operations SET status='failed',updated_at=? WHERE id=? AND user_id=?",[Date.now(),operationId,req.user.id]);if(isNewDeployment)await pool.execute("UPDATE terraform_deployments SET status='failed',updated_at=? WHERE id=? AND user_id=?",[Date.now(),deployment.id,req.user.id]);else await pool.execute("UPDATE terraform_deployments SET status=?,updated_at=? WHERE id=? AND user_id=? AND status='planning'",[previousStatus,Date.now(),deployment.id,req.user.id]);console.error("Terraform plan failed:",e.message);const deniedAction=e.message.match(/no identity-based policy allows the\s+(ec2:[A-Za-z]+)\s+action/i)?.[1];return res.status(502).json({message:deniedAction?`AWS denied ${deniedAction}. Add the denied action to the AWS Identity Center permission set, wait for provisioning to complete, then refresh the AWS SSO session and retry.`:"Terraform could not create a plan. Check the local AWS profile permissions and selected resource configuration.",detail:e.message.slice(0,1200)})}
 }catch(e){next(e)}});

 app.post("/api/cloud-connections/:connectionId/terraform/operations/:operationId/apply",requireUser,async(req,res,next)=>{try{
  if(req.body?.confirm!==true)return res.status(400).json({message:"Explicit confirmation is required before Terraform can apply this reviewed plan."});
  const [rows]=await pool.execute("SELECT o.id,o.deployment_id,o.action,o.status,o.plan_summary,o.expires_at,d.status AS deployment_status,d.template_id,d.display_name,d.bucket_name,d.region,d.config_json,c.account_id,c.role_arn,c.aws_profile,c.aws_role_name FROM terraform_operations o JOIN terraform_deployments d ON d.id=o.deployment_id AND d.user_id=o.user_id AND d.connection_id=o.connection_id JOIN cloud_connections c ON c.id=o.connection_id AND c.user_id=o.user_id WHERE o.id=? AND o.user_id=? AND o.connection_id=? AND c.provider='aws' AND c.status='connected'",[req.params.operationId,req.user.id,req.params.connectionId]);
  if(!rows.length)return res.status(404).json({message:"Reviewed plan not found."});const operation=rows[0];
  if(operation.status!=="planned")return res.status(409).json({message:"This plan is no longer available. Create a fresh plan before applying."});
  if(operation.role_arn)return res.status(409).json({code:"AWS_LEGACY_CONNECTION",message:"This connection still uses the old IAM role flow. Reconnect with the local AWS CLI profile before applying."});
  if(operation.action==="create"&&operation.template_id==="ec2_instance"){let config={};try{config=JSON.parse(operation.config_json||"{}")}catch{}if(config.instanceType!=="t3.micro"||Number(config.rootVolumeGiB)>30)return res.status(409).json({code:"AWS_FREE_TIER_GUARDRAIL",message:"This saved EC2 plan is outside OmniCloud's free-tier guardrails. Create a fresh plan using t3.micro and a root disk of 30 GiB or less."})}
  if(operation.action==="create"&&operation.template_id==="rds_mysql_instance"){let config={};try{config=JSON.parse(operation.config_json||"{}")}catch{}if(config.instanceClass!=="db.t3.micro"||Number(config.allocatedStorageGiB)!==20||config.subnetIds?.length<2)return res.status(409).json({code:"AWS_LOW_COST_GUARDRAIL",message:"This saved RDS plan does not match OmniCloud's low-cost defaults. Create a fresh plan with db.t3.micro, 20 GiB storage, and two subnets."})}
  if(operation.action==="create"&&operation.template_id==="dynamodb_table"){let config={};try{config=JSON.parse(operation.config_json||"{}")}catch{}if(Number(config.readCapacity)!==5||Number(config.writeCapacity)!==5)return res.status(409).json({code:"AWS_LOW_COST_GUARDRAIL",message:"This saved DynamoDB plan does not match OmniCloud's low-cost capacity defaults. Create a fresh plan with 5 read and 5 write units."})}
  let credentials;try{({credentials}=await verifyLocalProfile({userId:req.user.id,profile:operation.aws_profile,accountId:operation.account_id,roleName:operation.aws_role_name,expectedAccountId:operation.account_id}))}catch(e){const failure=safeAwsError(e);return res.status(409).json(failure)}
  let planSummary={};try{planSummary=JSON.parse(operation.plan_summary||"{}")}catch{}
  if(Number(operation.expires_at)<Date.now()){
   await pool.execute("UPDATE terraform_operations SET status='expired',updated_at=? WHERE id=? AND status='planned'",[Date.now(),operation.id]);
   const restore=planSummary.previousStatus||"active";
   await pool.execute("UPDATE terraform_deployments SET status=?,updated_at=? WHERE id=? AND user_id=? AND connection_id=? AND status='planned'",[restore,Date.now(),operation.deployment_id,req.user.id,req.params.connectionId]);
   await removePlanFile(req.user.id,req.params.connectionId,operation.deployment_id,operation.id).catch(()=>{});
   return res.status(409).json({message:"This plan expired. Create and review a new plan."});
  }
  const [claimed]=await pool.execute("UPDATE terraform_operations SET status='applying',updated_at=? WHERE id=? AND user_id=? AND status='planned'",[Date.now(),operation.id,req.user.id]);
  if(!claimed.affectedRows)return res.status(409).json({message:"This plan is already being applied or is no longer available."});
  const [claimedDeployment]=await pool.execute("UPDATE terraform_deployments SET status='applying',updated_at=? WHERE id=? AND user_id=? AND connection_id=? AND status='planned'",[Date.now(),operation.deployment_id,req.user.id,req.params.connectionId]);
  if(!claimedDeployment.affectedRows){await pool.execute("UPDATE terraform_operations SET status='superseded',updated_at=? WHERE id=? AND user_id=? AND status='applying'",[Date.now(),operation.id,req.user.id]);return res.status(409).json({message:"The deployment is no longer waiting for this plan. Refresh and create a fresh plan."})}
  const desiredDisplayName=planSummary.desiredDisplayName||operation.display_name,desiredRegion=planSummary.desiredRegion||operation.region;
  let currentConfig={};try{currentConfig=operation.config_json?JSON.parse(operation.config_json):{}}catch{}
  const desiredConfig=planSummary.desiredConfig??currentConfig;
  const deployment={id:operation.deployment_id,template_id:operation.template_id,display_name:desiredDisplayName,bucket_name:operation.bucket_name,region:desiredRegion,config:desiredConfig};
  try{
   const outputs=await applyPlan({operationId:operation.id,userId:req.user.id,connectionId:req.params.connectionId,deploymentId:operation.deployment_id,credentials,region:desiredRegion,action:operation.action});
   const nextStatus=operation.action==="destroy"?"destroyed":"active";
   const resourceId=outputs?.bucket_name||outputs?.instance_id||outputs?.db_identifier||outputs?.table_name;
   await pool.execute("UPDATE terraform_deployments SET status=?,display_name=?,region=?,config_json=?,resource_id=?,outputs_json=?,updated_at=? WHERE id=? AND user_id=? AND connection_id=?",[nextStatus,operation.action==="destroy"?operation.display_name:desiredDisplayName,desiredRegion,JSON.stringify(operation.action==="destroy"?currentConfig:desiredConfig),operation.action==="destroy"?null:(resourceId||null),JSON.stringify(operation.action==="destroy"?{}:outputs||{}),Date.now(),operation.deployment_id,req.user.id,req.params.connectionId]);
   await pool.execute("UPDATE terraform_operations SET status='applied',updated_at=? WHERE id=? AND user_id=?",[Date.now(),operation.id,req.user.id]);
   await removePlanFile(req.user.id,req.params.connectionId,operation.deployment_id,operation.id);
   res.json({operation:{id:operation.id,status:"applied",action:operation.action},deployment:{...deployment,resource_id:resourceId||null,outputs:outputs||{},status:nextStatus}});
  }catch(e){await pool.execute("UPDATE terraform_operations SET status='failed',updated_at=? WHERE id=? AND user_id=?",[Date.now(),operation.id,req.user.id]);await pool.execute("UPDATE terraform_deployments SET status='attention',updated_at=? WHERE id=? AND user_id=?",[Date.now(),operation.deployment_id,req.user.id]);console.error("Terraform apply failed:",e.message);const deniedAction=e.message.match(/no identity-based policy allows the\s+([a-z0-9]+:[A-Za-z]+)\s+action/i)?.[1];return res.status(502).json({message:deniedAction?`AWS denied ${deniedAction}. Add the denied action to the AWS Identity Center permission set, wait for provisioning to complete, then refresh the AWS SSO session and retry.`:"Terraform apply did not complete successfully. Check AWS and Terraform state before retrying.",detail:e.message.slice(0,900)})}
 }catch(e){next(e)}});
}
