import test from "node:test";
import assert from "node:assert/strict";
import {buildAzureVmConfiguration,getAzureTerraformCatalog} from "../azureTerraformService.js";

const deployment={id:"12345678-1234-4234-8234-123456789012",subscription_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",managing_tenant_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",resource_group:"omnicloud-test",vm_name:"oc-123456789abc",location:"centralindia",machine_size:"Standard_B1s",admin_username:"omniadmin",ssh_public_key:"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTest sample"};

test("Azure VM configuration builds only private-network, SSH-key Linux infrastructure in the selected resource group",()=>{
 const configuration=JSON.parse(buildAzureVmConfiguration(deployment,{authMode:"managed_identity"}));
 assert.equal(configuration.provider.azurerm.subscription_id,deployment.subscription_id);
 assert.equal(configuration.provider.azurerm.tenant_id,deployment.managing_tenant_id);
 assert.equal(configuration.provider.azurerm.use_msi,true);
 assert.equal(configuration.resource.azurerm_linux_virtual_machine.vm.size,"Standard_B1s");
 assert.equal(configuration.resource.azurerm_linux_virtual_machine.vm.disable_password_authentication,true);
 assert.equal(configuration.resource.azurerm_linux_virtual_machine.vm.admin_ssh_key[0].public_key,deployment.ssh_public_key);
 assert.equal(configuration.resource.azurerm_network_interface.vm.ip_configuration[0].public_ip_address_id,undefined);
 assert.deepEqual(configuration.output.private_ip,{value:"${azurerm_network_interface.vm.private_ip_address}"});
 assert.equal(configuration.data.azurerm_resource_group.target.name,deployment.resource_group);
});

test("Azure auth mode selects CLI locally and rejects unsupported auth methods",()=>{
 const cli=JSON.parse(buildAzureVmConfiguration(deployment,{authMode:"cli"}));assert.equal(cli.provider.azurerm.use_cli,true);
 assert.throws(()=>buildAzureVmConfiguration(deployment,{authMode:"unknown"}),/OMNICLOUD_AZURE_AUTH_MODE/);
});

test("Azure VM config rejects invalid scopes, region, size, names, and private keys",()=>{
 for(const invalid of [{subscription_id:"x"},{tenant_id:"x"},{managing_tenant_id:"x"},{resource_group:"rg;rm"},{location:"bad region"},{machine_size:"Standard_D8s_v5"},{vm_name:"BAD NAME"},{ssh_public_key:"-----BEGIN PRIVATE KEY-----"}])assert.throws(()=>buildAzureVmConfiguration({...deployment,...invalid}),/Invalid|Choose|Enter|Azure/);
});

test("Azure catalog explains the service and conservative network defaults",()=>{
 const [service]=getAzureTerraformCatalog();assert.equal(service.id,"azure_linux_vm");assert.match(service.description,/no public IP/i);assert.match(service.costNotice,/charges may apply/i);
});
