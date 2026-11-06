import test from "node:test";
import assert from "node:assert/strict";
import {buildAzureLighthouseTemplate,revokeAzureDelegation,validateAzureSetup,verifyAzureConnection} from "../azureConnection.js";

const setupId="12345678-1234-4234-8234-123456789012";
const input={setupId,subscriptionId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",tenantId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",resourceGroup:"omnicloud-test",managementTenantId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",principalId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"};

test("Azure Lighthouse template delegates only the specified resource group roles to the configured principal",()=>{
 const template=buildAzureLighthouseTemplate(input);
 const subscriptionDefinition=template.resources.find(resource=>resource.type==="Microsoft.ManagedServices/registrationDefinitions");
 const rgAssignment=template.resources.find(resource=>resource.type==="Microsoft.Resources/deployments");
 const resourceGroupDefinition=template.resources.filter(resource=>resource.type==="Microsoft.ManagedServices/registrationDefinitions")[1];
 assert.equal(subscriptionDefinition.properties.managedByTenantId,input.managementTenantId);
 assert.deepEqual(subscriptionDefinition.properties.authorizations.map(item=>item.roleDefinitionId),["acdd72a7-3385-48ef-bd42-f606fba81ae7","91c1777a-f3dc-4fae-b103-61d183457e46"]);
 assert.deepEqual(resourceGroupDefinition.properties.authorizations.map(item=>item.roleDefinitionId),["9980e02c-c2be-4d73-9c1b-2c244c2b7c2f","4d97b98b-1d4f-4787-a291-c67834d212e7"]);
 assert.equal(rgAssignment.resourceGroup,input.resourceGroup);
 assert.ok(rgAssignment.properties.template.resources.some(resource=>resource.type==="Microsoft.ManagedServices/registrationAssignments"));
 assert.equal(template.outputs.scope.value,`/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}`);
});

test("Azure setup validation rejects invalid IDs, same-tenant onboarding, and injection-like group names",()=>{
 assert.throws(()=>validateAzureSetup({...input,subscriptionId:"not-a-subscription"}),/valid Azure subscription/);
 assert.throws(()=>buildAzureLighthouseTemplate({...input,tenantId:input.managementTenantId}),/must differ/);
 assert.throws(()=>buildAzureLighthouseTemplate({...input,resourceGroup:"rg;delete"}),/existing resource group/);
});

test("Azure verification uses the managing identity token and checks the target resource group",async()=>{
 const requested=[];
 const result=await verifyAzureConnection({subscriptionId:input.subscriptionId,tenantId:input.tenantId,resourceGroup:input.resourceGroup},{identityProvider:()=>({tenantId:input.managementTenantId,principalId:input.principalId}),tokenFactory:async tenantId=>{assert.equal(tenantId,input.managementTenantId);return "ephemeral-token"},fetchImpl:async(url,options)=>{requested.push(url);assert.equal(options.headers.Authorization,"Bearer ephemeral-token");return {ok:true,status:200,json:async()=>requested.length===1?({tenantId:input.tenantId,state:"Enabled"}):({id:`/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}`,location:"centralindia"})}}});
 assert.match(requested[0],/subscriptions\/.*api-version=2022-12-01/);assert.match(requested[1],/resourceGroups\/.*api-version=2021-04-01/);assert.equal(result.resourceGroupLocation,"centralindia");
});

test("Azure verification reports a missing Lighthouse delegation clearly",async()=>{
 await assert.rejects(()=>verifyAzureConnection({subscriptionId:input.subscriptionId,tenantId:input.tenantId,resourceGroup:input.resourceGroup},{identityProvider:()=>({tenantId:input.managementTenantId,principalId:input.principalId}),tokenFactory:async()=>"ephemeral-token",fetchImpl:async()=>({ok:false,status:403})}),error=>error.code==="AZURE_SUBSCRIPTION_READER_REQUIRED");
});

test("Azure disconnect removes only this connection's two assignments, resource-group first",async()=>{
 const template=buildAzureLighthouseTemplate(input),urls=[];
 await revokeAzureDelegation({id:setupId,subscriptionId:input.subscriptionId,tenantId:input.tenantId,resourceGroup:input.resourceGroup},{identityProvider:()=>({tenantId:input.managementTenantId,principalId:input.principalId}),tokenFactory:async()=>"ephemeral-token",fetchImpl:async(url,options)=>{urls.push(url);assert.equal(options.method,"DELETE");return {status:204}}});
 assert.equal(urls.length,2);assert.match(urls[0],/resourceGroups\/omnicloud-test\/providers\/Microsoft.ManagedServices\/registrationAssignments/);assert.match(urls[0],new RegExp(template.variables.resourceGroupAssignmentName));assert.match(urls[1],new RegExp(template.variables.subscriptionAssignmentName));
});
