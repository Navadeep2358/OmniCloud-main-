import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";

const guidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const subscriptionPattern=/^[0-9a-f-]{36}$/i;
const resourceGroupPattern=/^[A-Za-z0-9_.()-]{1,90}$/;
const vmContributor="9980e02c-c2be-4d73-9c1b-2c244c2b7c2f";
const networkContributor="4d97b98b-1d4f-4787-a291-c67834d212e7";
const reader="acdd72a7-3385-48ef-bd42-f606fba81ae7";
const assignmentDelete="91c1777a-f3dc-4fae-b103-61d183457e46";

function derivedGuid(value){const bytes=createHash("sha256").update(value).digest().subarray(0,16);bytes[6]=(bytes[6]&0x0f)|0x50;bytes[8]=(bytes[8]&0x3f)|0x80;const hex=bytes.toString("hex");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}

export class AzureConnectionError extends Error{
 constructor(code,message,status=409,cause){super(message,{cause});this.name="AzureConnectionError";this.code=code;this.status=status;}
}

export function validateAzureSetup({subscriptionId,tenantId,resourceGroup}){
 if(!subscriptionPattern.test(subscriptionId||""))throw new AzureConnectionError("AZURE_INVALID_SUBSCRIPTION","Enter a valid Azure subscription ID.",400);
 if(!guidPattern.test(tenantId||""))throw new AzureConnectionError("AZURE_INVALID_TENANT","Enter a valid customer Microsoft Entra tenant ID.",400);
 if(!resourceGroupPattern.test(resourceGroup||""))throw new AzureConnectionError("AZURE_INVALID_RESOURCE_GROUP","Enter an existing resource group name using letters, numbers, periods, underscores, parentheses, or hyphens.",400);
}

function configuredIdentity(){
 const tenantId=process.env.OMNICLOUD_AZURE_TENANT_ID||"",principalId=process.env.OMNICLOUD_AZURE_PRINCIPAL_ID||"";
 if(!guidPattern.test(tenantId)||!guidPattern.test(principalId))throw new AzureConnectionError("AZURE_NOT_CONFIGURED","Azure connections are temporarily unavailable. Contact OmniCloud support; no changes to your Azure subscription are needed.",503);
 return {tenantId,principalId};
}

export function buildAzureLighthouseTemplate({setupId,subscriptionId,tenantId,resourceGroup,managementTenantId,principalId}){
 validateAzureSetup({subscriptionId,tenantId,resourceGroup});
 if(!guidPattern.test(setupId||""))throw new AzureConnectionError("AZURE_INVALID_SETUP","Invalid Azure setup identifier.",400);
 if(!guidPattern.test(managementTenantId||"")||!guidPattern.test(principalId||""))throw new AzureConnectionError("AZURE_NOT_CONFIGURED","Azure onboarding is not configured with valid OmniCloud tenant and principal IDs.",503);
 if(tenantId.toLowerCase()===managementTenantId.toLowerCase())throw new AzureConnectionError("AZURE_SAME_TENANT","The customer tenant must differ from OmniCloud's managing tenant.",400);
 const offerName=`OmniCloud-${setupId.slice(0,8)}`;
 return {
  "$schema":"https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#",
  contentVersion:"1.0.0.0",
  parameters:{},
  variables:{subscriptionDefinitionName:derivedGuid(`${setupId}:subscription-definition`),subscriptionAssignmentName:derivedGuid(`${setupId}:subscription-assignment`),resourceGroupDefinitionName:derivedGuid(`${setupId}:resource-group-definition`),resourceGroupAssignmentName:derivedGuid(`${setupId}:resource-group-assignment`),subscriptionOfferName:`${offerName}-Subscription`,resourceGroupOfferName:`${offerName}-ResourceGroup`},
  resources:[
   {type:"Microsoft.ManagedServices/registrationDefinitions",apiVersion:"2019-06-01",name:"[variables('subscriptionDefinitionName')]",properties:{registrationDefinitionName:"[variables('subscriptionOfferName')]",description:"Read-only subscription discovery and OmniCloud delegation removal.",managedByTenantId:managementTenantId,authorizations:[{principalId,principalIdDisplayName:"OmniCloud Azure subscription discovery",roleDefinitionId:reader},{principalId,principalIdDisplayName:"OmniCloud Azure delegation disconnect",roleDefinitionId:assignmentDelete}]}},
   {type:"Microsoft.ManagedServices/registrationAssignments",apiVersion:"2019-06-01",name:"[variables('subscriptionAssignmentName')]",dependsOn:["[resourceId('Microsoft.ManagedServices/registrationDefinitions', variables('subscriptionDefinitionName'))]"],properties:{registrationDefinitionId:"[resourceId('Microsoft.ManagedServices/registrationDefinitions', variables('subscriptionDefinitionName'))]"}},
   {type:"Microsoft.ManagedServices/registrationDefinitions",apiVersion:"2019-06-01",name:"[variables('resourceGroupDefinitionName')]",properties:{registrationDefinitionName:"[variables('resourceGroupOfferName')]",description:"Delegates only this resource group to OmniCloud for Terraform-managed virtual machines.",managedByTenantId:managementTenantId,authorizations:[{principalId,principalIdDisplayName:"OmniCloud Azure virtual machine manager",roleDefinitionId:vmContributor},{principalId,principalIdDisplayName:"OmniCloud Azure network manager",roleDefinitionId:networkContributor}]}},
   {type:"Microsoft.Resources/deployments",apiVersion:"2018-05-01",name:"OmniCloudResourceGroupAssignment",resourceGroup,dependsOn:["[resourceId('Microsoft.ManagedServices/registrationDefinitions', variables('resourceGroupDefinitionName'))]"],properties:{mode:"Incremental",parameters:{assignmentName:{value:"[variables('resourceGroupAssignmentName')]"},registrationDefinitionId:{value:"[resourceId('Microsoft.ManagedServices/registrationDefinitions', variables('resourceGroupDefinitionName'))]"}},template:{"$schema":"https://schema.management.azure.com/schemas/2015-01-01/deploymentTemplate.json#",contentVersion:"1.0.0.0",parameters:{assignmentName:{type:"string"},registrationDefinitionId:{type:"string"}},resources:[{type:"Microsoft.ManagedServices/registrationAssignments",apiVersion:"2019-06-01",name:"[parameters('assignmentName')]",properties:{registrationDefinitionId:"[parameters('registrationDefinitionId')]"}}]}}},
  ],
  outputs:{offerName:{type:"string",value:`${offerName}-Subscription and ${offerName}-ResourceGroup`},scope:{type:"string",value:`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`}},
 };
}

function runAz(args){
 return new Promise((resolve,reject)=>{
  let child;try{child=spawn(process.env.AZURE_CLI_BIN||"az",args,{shell:process.platform==="win32",windowsHide:true,stdio:["ignore","pipe","pipe"]})}catch{reject(new AzureConnectionError("AZURE_CLI_UNAVAILABLE","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503));return}
  let stdout="",stderr="";child.stdout.on("data",data=>stdout=(stdout+data).slice(-16000));child.stderr.on("data",data=>stderr=(stderr+data).slice(-4000));
  child.on("error",error=>reject(new AzureConnectionError("AZURE_CLI_UNAVAILABLE","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503,error)));
  child.on("close",code=>{if(code!==0)return reject(new AzureConnectionError("AZURE_CLI_AUTH_FAILED","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503,new Error(stderr||"Azure CLI authentication failed.")));try{resolve(JSON.parse(stdout).accessToken)}catch(error){reject(new AzureConnectionError("AZURE_TOKEN_INVALID","OmniCloud could not read its Azure access token. Contact OmniCloud support.",503,error))}});
 });
}

async function accessToken(tenantId,{fetchImpl=globalThis.fetch,cliRunner=runAz,env=process.env}={}){
 const mode=(env.OMNICLOUD_AZURE_AUTH_MODE||"cli").toLowerCase();
 if(mode==="cli")return cliRunner(["account","get-access-token","--tenant",tenantId,"--resource","https://management.azure.com/","--output","json"]);
 if(mode==="managed_identity"){
  const url=new URL("http://169.254.169.254/metadata/identity/oauth2/token");url.searchParams.set("api-version","2018-02-01");url.searchParams.set("resource","https://management.azure.com/");if(env.ARM_CLIENT_ID)url.searchParams.set("client_id",env.ARM_CLIENT_ID);
  let response;try{response=await fetchImpl(url,{headers:{Metadata:"true"},signal:AbortSignal.timeout(5000)})}catch(error){throw new AzureConnectionError("AZURE_MANAGED_IDENTITY_UNAVAILABLE","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503,error)}
  if(!response.ok)throw new AzureConnectionError("AZURE_MANAGED_IDENTITY_UNAVAILABLE","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503);
  const body=await response.json();if(!body.access_token)throw new AzureConnectionError("AZURE_TOKEN_INVALID","Azure managed identity returned no access token.",503);return body.access_token;
 }
 if(mode==="service_principal"||mode==="oidc"){
  const clientId=env.ARM_CLIENT_ID;if(!guidPattern.test(env.ARM_TENANT_ID||"")||env.ARM_TENANT_ID.toLowerCase()!==tenantId.toLowerCase()||!guidPattern.test(clientId||""))throw new AzureConnectionError("AZURE_BACKEND_AUTH_CONFIG_INVALID","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503);
  const form=new URLSearchParams({client_id:clientId,scope:"https://management.azure.com/.default",grant_type:"client_credentials"});
  if(mode==="service_principal"){if(!env.ARM_CLIENT_SECRET)throw new AzureConnectionError("AZURE_BACKEND_AUTH_CONFIG_INVALID","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503);form.set("client_secret",env.ARM_CLIENT_SECRET)}
  else{if(!env.ARM_OIDC_TOKEN)throw new AzureConnectionError("AZURE_BACKEND_AUTH_CONFIG_INVALID","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503);form.set("client_assertion_type","urn:ietf:params:oauth:client-assertion-type:jwt-bearer");form.set("client_assertion",env.ARM_OIDC_TOKEN)}
  let response;try{response=await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form})}catch(error){throw new AzureConnectionError("AZURE_TOKEN_REQUEST_FAILED","OmniCloud could not contact Microsoft identity services.",503,error)}
  const body=await response.json().catch(()=>({}));if(!response.ok||!body.access_token)throw new AzureConnectionError("AZURE_BACKEND_AUTH_FAILED","OmniCloud could not verify Azure access right now. Contact OmniCloud support; no changes to your Azure subscription are needed.",503);return body.access_token;
 }
 throw new AzureConnectionError("AZURE_AUTH_MODE_INVALID","OMNICLOUD_AZURE_AUTH_MODE must be cli, managed_identity, service_principal, or oidc.",503);
}

export async function verifyAzureConnection({subscriptionId,tenantId,resourceGroup},{fetchImpl=globalThis.fetch,tokenFactory=accessToken,identityProvider=configuredIdentity}={}){
 validateAzureSetup({subscriptionId,tenantId,resourceGroup});
 const identity=identityProvider();
 const token=await tokenFactory(identity.tenantId,{fetchImpl});
 const subscriptionUrl=`https://management.azure.com/subscriptions/${subscriptionId}?api-version=2022-12-01`;
 let subscriptionResponse;try{subscriptionResponse=await fetchImpl(subscriptionUrl,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})}catch(error){throw new AzureConnectionError("AZURE_SUBSCRIPTION_CHECK_FAILED","Azure subscription access could not be checked. Check OmniCloud backend network access and retry.",503,error)}
 if(subscriptionResponse.status===403)throw new AzureConnectionError("AZURE_SUBSCRIPTION_READER_REQUIRED","The OmniCloud principal needs read-only access to the customer subscription. Deploy the latest generated Azure Lighthouse template and retry.",409);
 if(subscriptionResponse.status===404)throw new AzureConnectionError("AZURE_SUBSCRIPTION_NOT_FOUND","Azure could not find this subscription under the provided tenant.",404);
 if(!subscriptionResponse.ok)throw new AzureConnectionError("AZURE_SUBSCRIPTION_CHECK_FAILED","Azure could not verify this subscription. Check that it is active and retry.",409);
 const subscription=await subscriptionResponse.json();
 if(subscription.tenantId&&subscription.tenantId.toLowerCase()!==tenantId.toLowerCase())throw new AzureConnectionError("AZURE_TENANT_MISMATCH","The subscription belongs to a different Microsoft Entra tenant than the tenant ID entered.",400);
 if(subscription.state&&subscription.state!=="Enabled")throw new AzureConnectionError("AZURE_SUBSCRIPTION_DISABLED","This Azure subscription is not enabled.",409);
 const url=`https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}?api-version=2021-04-01`;
 let response;try{response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})}catch(error){throw new AzureConnectionError("AZURE_RESOURCE_GROUP_CHECK_FAILED","Azure resource group access could not be checked. Check OmniCloud backend network access and retry.",503,error)}
 if(response.status===401)throw new AzureConnectionError("AZURE_TOKEN_REJECTED","Microsoft Azure rejected OmniCloud's short-lived access token. Reauthenticate the backend identity and retry.",503);
 if(response.status===403)throw new AzureConnectionError("AZURE_DELEGATION_REQUIRED","Azure denied access to this resource group. Confirm the customer deployed the OmniCloud Lighthouse template and allow time for delegation to propagate.",409);
 if(response.status===404)throw new AzureConnectionError("AZURE_RESOURCE_GROUP_NOT_FOUND","Azure could not find this resource group in the selected subscription.",404);
 if(!response.ok)throw new AzureConnectionError("AZURE_RESOURCE_GROUP_CHECK_FAILED","Azure could not verify this resource group. Check subscription status and retry.",409);
 const group=await response.json();
 if(group.id?.toLowerCase()!==`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}`.toLowerCase())throw new AzureConnectionError("AZURE_RESOURCE_GROUP_MISMATCH","Azure returned a different resource group than the one submitted.",409);
 return {subscriptionId,tenantId,resourceGroup,resourceGroupId:group.id,resourceGroupLocation:group.location||""};
}

export async function revokeAzureDelegation({id,subscriptionId,tenantId,resourceGroup},{fetchImpl=globalThis.fetch,tokenFactory=accessToken,identityProvider=configuredIdentity}={}){
 validateAzureSetup({subscriptionId,tenantId,resourceGroup});if(!guidPattern.test(id||""))throw new AzureConnectionError("AZURE_INVALID_SETUP","Invalid Azure connection identifier.",400);
 const identity=identityProvider(),token=await tokenFactory(identity.tenantId,{fetchImpl});
 const assignments=[
  `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ManagedServices/registrationAssignments/${derivedGuid(`${id}:resource-group-assignment`)}?api-version=2019-06-01`,
  `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.ManagedServices/registrationAssignments/${derivedGuid(`${id}:subscription-assignment`)}?api-version=2019-06-01`,
 ];
 for(const url of assignments){let response;try{response=await fetchImpl(url,{method:"DELETE",headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})}catch(error){throw new AzureConnectionError("AZURE_DELEGATION_REVOKE_FAILED","Azure could not remove the OmniCloud Lighthouse delegation. The connection has not been disconnected.",503,error)}if(![200,202,204,404].includes(response.status))throw new AzureConnectionError("AZURE_DELEGATION_REVOKE_FAILED","Azure denied removal of the OmniCloud Lighthouse delegation. The connection has not been disconnected.",409)}
}

export function registerAzureRoutes(app,{pool,requireUser,verifyConnection=verifyAzureConnection,identityProvider=configuredIdentity}={}){
 app.post("/api/cloud-connections/azure/setup",requireUser,async(req,res,next)=>{try{
  const input={subscriptionId:String(req.body?.subscriptionId||"").trim(),tenantId:String(req.body?.tenantId||"").trim(),resourceGroup:String(req.body?.resourceGroup||"").trim()};validateAzureSetup(input);
  const identity=identityProvider(),id=randomUUID(),now=Date.now();
  if(input.tenantId.toLowerCase()===identity.tenantId.toLowerCase())return res.status(400).json({code:"AZURE_SAME_TENANT",message:"The customer tenant must differ from OmniCloud's managing tenant."});
  await pool.execute("INSERT INTO cloud_connections(id,user_id,provider,azure_subscription_id,azure_tenant_id,azure_resource_group,status,created_at,updated_at) VALUES(?,?,'azure',?,?,?,'setup',?,?)",[id,req.user.id,input.subscriptionId,input.tenantId,input.resourceGroup,now,now]);
  res.status(201).json({setup:{id,...input,status:"setup"}});
 }catch(error){if(error instanceof AzureConnectionError)return res.status(error.status).json({code:error.code,message:error.message});next(error)}});

 app.get("/api/cloud-connections/azure/setup/:setupId/template",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,azure_subscription_id,azure_tenant_id,azure_resource_group,status FROM cloud_connections WHERE id=? AND user_id=? AND provider='azure'",[req.params.setupId,req.user.id]);
  if(!rows.length||rows[0].status!=="setup")return res.status(404).json({code:"AZURE_SETUP_NOT_FOUND",message:"Azure setup was not found or has already been completed."});
  const identity=identityProvider(),row=rows[0];const template=buildAzureLighthouseTemplate({setupId:row.id,subscriptionId:row.azure_subscription_id,tenantId:row.azure_tenant_id,resourceGroup:row.azure_resource_group,managementTenantId:identity.tenantId,principalId:identity.principalId});
  res.setHeader("Content-Type","application/json");res.setHeader("Content-Disposition",`attachment; filename="omnicloud-azure-${row.id}.json"`);res.send(JSON.stringify(template,null,2));
 }catch(error){if(error instanceof AzureConnectionError)return res.status(error.status).json({code:error.code,message:error.message});next(error)}});

 app.post("/api/cloud-connections/azure/setup/:setupId/verify",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,azure_subscription_id,azure_tenant_id,azure_resource_group,status FROM cloud_connections WHERE id=? AND user_id=? AND provider='azure'",[req.params.setupId,req.user.id]);
  if(!rows.length||rows[0].status!=="setup")return res.status(404).json({code:"AZURE_SETUP_NOT_FOUND",message:"Azure setup was not found or has already been completed."});
  const row=rows[0];let verified;try{verified=await verifyConnection({subscriptionId:row.azure_subscription_id,tenantId:row.azure_tenant_id,resourceGroup:row.azure_resource_group})}catch(error){const failure=error instanceof AzureConnectionError?error:new AzureConnectionError("AZURE_VERIFY_FAILED","Azure could not verify the connection. Check the setup and retry.");return res.status(failure.status).json({code:failure.code,message:failure.message})}
  const now=Date.now(),[updated]=await pool.execute("UPDATE cloud_connections SET account_id=?,status='connected',updated_at=? WHERE id=? AND user_id=? AND provider='azure' AND status='setup'",[row.azure_subscription_id,now,row.id,req.user.id]);
  if(!updated.affectedRows)return res.status(409).json({code:"AZURE_SETUP_ALREADY_COMPLETED",message:"This Azure setup was completed in another request. Refresh the page."});
  res.json({connection:{id:row.id,provider:"azure",subscription_id:verified.subscriptionId,tenant_id:verified.tenantId,resource_group:verified.resourceGroup,status:"connected"}});
 }catch(error){next(error)}});
}
