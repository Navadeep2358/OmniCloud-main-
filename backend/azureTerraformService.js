import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdir,readFile,writeFile,stat,unlink} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const here=dirname(fileURLToPath(import.meta.url));
const stateRoot=resolve(process.env.TERRAFORM_STATE_DIR||resolve(here,".terraform-state"),"azure");
const terraform=process.env.TERRAFORM_BIN||"terraform";
const planTtlMs=15*60*1000;
const machineSizes=new Set(["Standard_B1s","Standard_B2s","Standard_B2ms"]);
const authModes=new Set(["cli","managed_identity","service_principal","oidc"]);

function directoryFor(userId,connectionId,deploymentId){
 if(!/^\d+$/.test(String(userId))||![connectionId,deploymentId].every(value=>/^[0-9a-f-]{36}$/i.test(value)))throw new Error("Invalid Azure Terraform workspace identity.");
 return resolve(stateRoot,String(userId),connectionId,deploymentId);
}

function validateDeployment(deployment){
 if(!/^[0-9a-f-]{36}$/i.test(deployment.subscription_id||""))throw new Error("Invalid Azure subscription ID.");
 if(!/^[0-9a-f-]{36}$/i.test(deployment.tenant_id||""))throw new Error("Invalid Azure tenant ID.");
 if(!/^[0-9a-f-]{36}$/i.test(deployment.managing_tenant_id||""))throw new Error("Azure managing tenant ID is not configured.");
 if(!/^[A-Za-z0-9_.()-]{1,90}$/.test(deployment.resource_group||""))throw new Error("Invalid Azure resource group.");
 if(!/^[a-z0-9-]{3,30}$/.test(deployment.location||""))throw new Error("Choose a valid Azure region.");
 if(!machineSizes.has(deployment.machine_size))throw new Error("Choose a supported small Azure VM size.");
 if(!/^[a-z][a-z0-9-]{3,14}$/.test(deployment.vm_name||""))throw new Error("Invalid Azure VM name.");
 if(typeof deployment.ssh_public_key!=="string"||!/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+(?: .*)?$/.test(deployment.ssh_public_key.trim())||deployment.ssh_public_key.length>8192)throw new Error("Enter a valid SSH public key. Never enter a private key.");
 if(!/^[-a-zA-Z0-9_.@]{1,64}$/.test(deployment.admin_username||""))throw new Error("Enter a valid Linux admin username.");
}

function providerAuth(authMode){
 if(!authModes.has(authMode))throw new Error("OMNICLOUD_AZURE_AUTH_MODE must be cli, managed_identity, service_principal, or oidc.");
 const mode=authMode;
 const auth={use_cli:mode==="cli",use_msi:mode==="managed_identity",use_oidc:mode==="oidc"};
 if(mode==="service_principal"||mode==="oidc")auth.client_id=process.env.ARM_CLIENT_ID||"";
 return auth;
}

export function buildAzureVmConfiguration(deployment,{authMode=process.env.OMNICLOUD_AZURE_AUTH_MODE||"cli"}={}){
 validateDeployment(deployment);
 const key=deployment.ssh_public_key.trim();
 const networkName=`${deployment.vm_name}-vnet`.slice(0,64),subnetName=`${deployment.vm_name}-subnet`.slice(0,80),nsgName=`${deployment.vm_name}-nsg`.slice(0,80),nicName=`${deployment.vm_name}-nic`.slice(0,80);
 return JSON.stringify({
  terraform:{required_providers:{azurerm:{source:"hashicorp/azurerm",version:"~> 4.0"}}},
  provider:{azurerm:{subscription_id:deployment.subscription_id,tenant_id:deployment.managing_tenant_id,features:[{}],...providerAuth(authMode)}},
  data:{azurerm_resource_group:{target:{name:deployment.resource_group}}},
  resource:{
   azurerm_virtual_network:{vm:{name:networkName,location:deployment.location,resource_group_name:"${data.azurerm_resource_group.target.name}",address_space:["10.40.0.0/16"],tags:{managed_by:"omnicloud",omnicloud_deployment:deployment.id.replaceAll("-","").slice(0,12)}}},
   azurerm_subnet:{vm:{name:subnetName,resource_group_name:"${data.azurerm_resource_group.target.name}",virtual_network_name:"${azurerm_virtual_network.vm.name}",address_prefixes:["10.40.1.0/24"]}},
   azurerm_network_security_group:{vm:{name:nsgName,location:deployment.location,resource_group_name:"${data.azurerm_resource_group.target.name}",tags:{managed_by:"omnicloud",omnicloud_deployment:deployment.id.replaceAll("-","").slice(0,12)}}},
   azurerm_network_interface:{vm:{name:nicName,location:deployment.location,resource_group_name:"${data.azurerm_resource_group.target.name}",ip_configuration:[{name:"internal",subnet_id:"${azurerm_subnet.vm.id}",private_ip_address_allocation:"Dynamic"}],tags:{managed_by:"omnicloud",omnicloud_deployment:deployment.id.replaceAll("-","").slice(0,12)}}},
   azurerm_network_interface_security_group_association:{vm:{network_interface_id:"${azurerm_network_interface.vm.id}",network_security_group_id:"${azurerm_network_security_group.vm.id}"}},
   azurerm_linux_virtual_machine:{vm:{name:deployment.vm_name,resource_group_name:"${data.azurerm_resource_group.target.name}",location:deployment.location,size:deployment.machine_size,admin_username:deployment.admin_username,disable_password_authentication:true,network_interface_ids:["${azurerm_network_interface.vm.id}"],admin_ssh_key:[{username:deployment.admin_username,public_key:key}],os_disk:[{caching:"ReadWrite",storage_account_type:"Standard_LRS",disk_size_gb:30}],source_image_reference:[{publisher:"Canonical",offer:"0001-com-ubuntu-server-jammy",sku:"22_04-lts-gen2",version:"latest"}],tags:{managed_by:"omnicloud",omnicloud_deployment:deployment.id.replaceAll("-","").slice(0,12)}}},
  },
  output:{vm_name:{value:"${azurerm_linux_virtual_machine.vm.name}"},private_ip:{value:"${azurerm_network_interface.vm.private_ip_address}"},location:{value:"${azurerm_linux_virtual_machine.vm.location}"},resource_group:{value:"${data.azurerm_resource_group.target.name}"}},
 },null,2);
}

export function getAzureTerraformCatalog(){return [{id:"azure_linux_vm",name:"Azure Linux virtual machine",description:"Ubuntu 22.04 VM with SSH public-key authentication, private networking, a deny-by-default inbound network security group, and no public IP.",costNotice:"Azure compute, managed disk, and networking charges may apply while resources exist. No public IP is created. Review each plan and destroy the VM when it is no longer needed."}]}
export const newAzureDeploymentId=()=>randomUUID();
export const newAzureOperationId=()=>randomUUID();
export const azurePlanExpiry=()=>Date.now()+planTtlMs;

function safeEnvironment(){
 const env={...process.env,TF_IN_AUTOMATION:"1",TF_INPUT:"0"};
 env.ARM_SUBSCRIPTION_ID=env.ARM_SUBSCRIPTION_ID||"";
 return env;
}
function redact(text){let safe=String(text||"");for(const secret of [process.env.ARM_CLIENT_SECRET,process.env.ARM_OIDC_TOKEN].filter(value=>typeof value==="string"&&value.length>0))safe=safe.replaceAll(secret,"[redacted]");return safe}
function run(args,cwd){
 return new Promise((resolveRun,reject)=>{
  let child;try{child=spawn(terraform,args,{cwd,env:safeEnvironment(),windowsHide:true,stdio:["ignore","pipe","pipe"]})}catch{reject(new Error("Could not start Terraform."));return}
  let stdout="",stderr="",settled=false;const timer=setTimeout(()=>child.kill(),300000);
  child.stdout.on("data",chunk=>stdout=(stdout+chunk.toString()).slice(-24000));child.stderr.on("data",chunk=>stderr=(stderr+chunk.toString()).slice(-24000));
  child.on("error",error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new Error(error.code==="ENOENT"?"Terraform CLI is not installed or TERRAFORM_BIN is invalid.":"Could not start Terraform."))});
  child.on("close",code=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)reject(new Error(redact((stderr||stdout||`Terraform exited with code ${code}.`).trim().slice(-6000))));else resolveRun(stdout.trim())});
 });
}

export async function runAzurePlan({deployment,userId,connectionId,operationId,action}){
 const cwd=directoryFor(userId,connectionId,deployment.id);await mkdir(cwd,{recursive:true});
 const configuration={...deployment,managing_tenant_id:process.env.OMNICLOUD_AZURE_TENANT_ID};
 await writeFile(resolve(cwd,"main.tf.json"),buildAzureVmConfiguration(configuration),{encoding:"utf8",mode:0o600});
 await run(["init","-input=false","-no-color"],cwd);
 const planPath=resolve(cwd,`${operationId}.tfplan`);
 await run(["plan","-input=false","-no-color","-lock-timeout=30s","-out",planPath,...(action==="destroy"?["-destroy"]:[])],cwd);
 const raw=await run(["show","-json",planPath],cwd);let parsed;try{parsed=JSON.parse(raw)}catch{throw new Error("Terraform returned an unreadable Azure plan.")}
 if(parsed.applyable!==true||parsed.complete!==true)throw new Error("Terraform produced a plan that cannot be applied. Check the Azure role delegation, provider registration, subscription, region, and VM quota.");
 return {summary:{formatVersion:parsed.format_version||"",resourceChanges:(parsed.resource_changes||[]).map(change=>({address:change.address,type:change.type,actions:change.change?.actions||[]})),applyable:true,complete:true,action}};
}

export async function applyAzurePlan({operationId,userId,connectionId,deploymentId}){
 const cwd=directoryFor(userId,connectionId,deploymentId),plan=resolve(cwd,`${operationId}.tfplan`),info=await stat(plan).catch(()=>null);if(!info?.isFile())throw new Error("Reviewed Terraform plan is missing. Create a new plan.");
 await run(["apply","-input=false","-no-color","-lock-timeout=30s",plan],cwd);
 const state=await readFile(resolve(cwd,"terraform.tfstate"),"utf8").catch(()=>"");if(!state)throw new Error("Terraform apply finished without a readable state file.");let parsed;try{parsed=JSON.parse(state)}catch{throw new Error("Terraform returned an unreadable state file.")};const outputs=parsed.outputs||{};
 return {vmName:outputs.vm_name?.value||"",privateIp:outputs.private_ip?.value||"",location:outputs.location?.value||"",resourceGroup:outputs.resource_group?.value||""};
}
export async function removeAzurePlanFile(userId,connectionId,deploymentId,operationId){await unlink(resolve(directoryFor(userId,connectionId,deploymentId),`${operationId}.tfplan`)).catch(()=>{})}
