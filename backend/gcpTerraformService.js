import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdir,readFile,writeFile,stat,unlink} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const here=dirname(fileURLToPath(import.meta.url));
const stateRoot=resolve(process.env.TERRAFORM_STATE_DIR||resolve(here,".terraform-state"),"gcp");
const terraform=process.env.TERRAFORM_BIN||"terraform";
const planTtlMs=15*60*1000;
const machineTypes=new Set(["e2-micro","e2-small","e2-medium"]);

function directoryFor(userId,connectionId,deploymentId){
 if(!/^\d+$/.test(String(userId))||![connectionId,deploymentId].every(value=>/^[0-9a-f-]{36}$/i.test(value)))throw new Error("Invalid GCP Terraform workspace identity.");
 return resolve(stateRoot,String(userId),connectionId,deploymentId);
}

function safeTerraformEnvironment(accessToken){
 if(typeof accessToken!=="string"||accessToken.length<20)throw new Error("A short-lived Google Cloud access token is required for Terraform.");
 const env={...process.env,TF_IN_AUTOMATION:"1",TF_INPUT:"0",GOOGLE_OAUTH_ACCESS_TOKEN:accessToken};
 delete env.GOOGLE_APPLICATION_CREDENTIALS;
 delete env.GOOGLE_CREDENTIALS;
 delete env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
 delete env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT_DELEGATES;
 return env;
}

function run(args,cwd,accessToken){
 return new Promise((resolveRun,reject)=>{
  let child;
  try{child=spawn(terraform,args,{cwd,env:safeTerraformEnvironment(accessToken),windowsHide:true,stdio:["ignore","pipe","pipe"]})}
  catch{reject(new Error("Could not start Terraform."));return}
  let stdout="",stderr="",settled=false;
  const timer=setTimeout(()=>child.kill(),300000);
  child.stdout.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-24000)});
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-24000)});
  child.on("error",error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new Error(error.code==="ENOENT"?"Terraform CLI is not installed or TERRAFORM_BIN is invalid.":"Could not start Terraform."))});
  child.on("close",code=>{
   if(settled)return;settled=true;clearTimeout(timer);
   if(code!==0){const output=(stderr||stdout||`Terraform exited with code ${code}.`).trim().slice(-6000);reject(new Error(output.replaceAll(accessToken,"[redacted]")));}
   else resolveRun(stdout.trim());
  });
 });
}

export function buildGcpVmConfiguration(deployment){
 if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(deployment.project_id||""))throw new Error("Invalid Google Cloud project ID.");
 if(!/^[a-z]+-[a-z]+\d-[a-z]$/.test(deployment.zone||""))throw new Error("Choose a valid Google Cloud zone.");
 if(!machineTypes.has(deployment.machine_type))throw new Error("Choose a supported small Compute Engine machine type.");
 if(!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(deployment.instance_name||""))throw new Error("Invalid Compute Engine instance name.");
 return JSON.stringify({
  terraform:{required_providers:{google:{source:"hashicorp/google",version:"~> 7.0"}}},
  provider:{google:{project:deployment.project_id,zone:deployment.zone}},
  resource:{google_compute_instance:{vm:{
   name:deployment.instance_name,
   machine_type:deployment.machine_type,
   zone:deployment.zone,
   boot_disk:[{initialize_params:[{image:"debian-cloud/debian-12",size:10,type:"pd-standard"}],auto_delete:true}],
   network_interface:[{network:"default"}],
   shielded_instance_config:[{enable_secure_boot:true,enable_vtpm:true,enable_integrity_monitoring:true}],
   labels:{managed_by:"omnicloud",omnicloud_deployment:deployment.id.replaceAll("-","").slice(0,12)},
   tags:["omnicloud-managed"],
  }}},
  output:{instance_name:{value:"${google_compute_instance.vm.name}"},zone:{value:"${google_compute_instance.vm.zone}"},internal_ip:{value:"${google_compute_instance.vm.network_interface[0].network_ip}"}}
 },null,2);
}

export function getGcpTerraformCatalog(){
 return [{id:"gcp_compute_instance",name:"Compute Engine virtual machine",description:"A small Debian 12 VM with a 10 GB standard boot disk, Shielded VM protections, and no public IP by default.",regionRequired:false,costNotice:"Compute Engine, disk, and network charges may apply while the VM exists. This VM has no external IP. Review the plan and delete the VM when you no longer need it."}];
}

export const newGcpDeploymentId=()=>randomUUID();
export const newGcpOperationId=()=>randomUUID();
export const gcpPlanExpiry=()=>Date.now()+planTtlMs;

export async function runGcpPlan({deployment,userId,connectionId,operationId,action,accessToken}){
 const cwd=directoryFor(userId,connectionId,deployment.id);await mkdir(cwd,{recursive:true});
 await writeFile(resolve(cwd,"main.tf.json"),buildGcpVmConfiguration(deployment),{encoding:"utf8",mode:0o600});
 await run(["init","-input=false","-no-color"],cwd,accessToken);
 const planPath=resolve(cwd,`${operationId}.tfplan`);
 await run(["plan","-input=false","-no-color","-lock-timeout=30s","-out",planPath,...(action==="destroy"?["-destroy"]:[])],cwd,accessToken);
 const raw=await run(["show","-json",planPath],cwd,accessToken);let parsed;
 try{parsed=JSON.parse(raw)}catch{throw new Error("Terraform returned an unreadable Google Cloud plan.")}
 if(parsed.applyable!==true||parsed.complete!==true)throw new Error("Terraform produced a plan that cannot be applied. Check Compute Engine API status, project billing, and service-account permissions.");
 const changes=(parsed.resource_changes||[]).map(change=>({address:change.address,type:change.type,actions:change.change?.actions||[]}));
 return {summary:{formatVersion:parsed.format_version||"",resourceChanges:changes,applyable:true,complete:true,action}};
}

export async function applyGcpPlan({operationId,userId,connectionId,deploymentId,accessToken}){
 const cwd=directoryFor(userId,connectionId,deploymentId),expected=resolve(cwd,`${operationId}.tfplan`);
 const info=await stat(expected).catch(()=>null);if(!info?.isFile())throw new Error("Reviewed Terraform plan file is missing. Create a new plan.");
 await run(["apply","-input=false","-no-color","-lock-timeout=30s",expected],cwd,accessToken);
 const state=await readFile(resolve(cwd,"terraform.tfstate"),"utf8").catch(()=>"");
 if(!state)throw new Error("Terraform apply finished without a readable state file.");
 let parsed;try{parsed=JSON.parse(state)}catch{throw new Error("Terraform returned an unreadable state file.")}
 const outputs=parsed.outputs||{};
 return {instanceName:outputs.instance_name?.value||"",zone:outputs.zone?.value||"",internalIp:outputs.internal_ip?.value||""};
}

export async function removeGcpPlanFile(userId,connectionId,deploymentId,operationId){
 const path=resolve(directoryFor(userId,connectionId,deploymentId),`${operationId}.tfplan`);await unlink(path).catch(()=>{});
}
