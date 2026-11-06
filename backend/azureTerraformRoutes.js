import {AzureConnectionError,verifyAzureConnection} from "./azureConnection.js";
import {getAzureTerraformCatalog,newAzureDeploymentId,newAzureOperationId,azurePlanExpiry,runAzurePlan,applyAzurePlan,removeAzurePlanFile} from "./azureTerraformService.js";

const uuidPattern=/^[0-9a-f-]{36}$/i;
const safeName=/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,63}$/;
const regionPattern=/^[a-z0-9-]{3,30}$/;
const sizes=new Set(["Standard_B1s","Standard_B2s","Standard_B2ms"]);
const sshKeyPattern=/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+(?: .*)?$/;

function terraformFailure(error){
 const detail=String(error?.message||""),text=detail.toLowerCase();
 if(text.includes("authorizationfailed")||text.includes("does not have authorization")||text.includes("forbidden"))return {code:"AZURE_ROLE_MISSING",message:"Azure denied this operation. Confirm the customer deployed the OmniCloud Azure Lighthouse template to this resource group, the configured OmniCloud principal matches the template, and the VM and Network Contributor roles are present."};
 if(text.includes("subscriptionnotregistered")||text.includes("resource provider")&&text.includes("not registered"))return {code:"AZURE_PROVIDER_NOT_REGISTERED",message:"The Azure resource providers are not registered. In the customer subscription, register Microsoft.Compute and Microsoft.Network, wait for both to finish, then create a fresh plan."};
 if(text.includes("quota")||text.includes("allocationfailed"))return {code:"AZURE_QUOTA_OR_CAPACITY",message:"Azure could not allocate this VM size in the selected region. Check subscription quota and regional capacity, then choose another supported region or size."};
 if(text.includes("subscriptiondisabled")||text.includes("billing"))return {code:"AZURE_SUBSCRIPTION_UNAVAILABLE",message:"Azure reports that this subscription is disabled or has a billing restriction. Check the subscription state in Azure Portal before retrying."};
 return {code:"AZURE_TERRAFORM_FAILED",message:"Azure Terraform did not complete successfully. Check the delegated resource-group access, registered resource providers, VM quota, region, and Terraform provider access."};
}

function connectionInput(row){return {subscriptionId:row.azure_subscription_id,tenantId:row.azure_tenant_id,resourceGroup:row.azure_resource_group}}

export function registerAzureTerraformRoutes(app,{
 pool,requireUser,verifyConnection=verifyAzureConnection,createPlan=runAzurePlan,applyPlan=applyAzurePlan,removePlan=removeAzurePlanFile,
 now=()=>Date.now(),deploymentId=newAzureDeploymentId,operationId=newAzureOperationId,expiry=azurePlanExpiry,
}={}){
 app.get("/api/cloud-connections/azure/:connectionId/terraform",requireUser,async(req,res,next)=>{try{
  const [connections]=await pool.execute("SELECT id,azure_subscription_id,azure_tenant_id,azure_resource_group FROM cloud_connections WHERE id=? AND user_id=? AND provider='azure' AND status='connected'",[req.params.connectionId,req.user.id]);
  if(!connections.length)return res.status(404).json({message:"Connected Azure subscription not found."});
  const [deployments]=await pool.execute("SELECT id,template_id,display_name,vm_name,location,machine_size,admin_username,status,outputs_json,created_at,updated_at FROM azure_terraform_deployments WHERE connection_id=? AND user_id=? ORDER BY created_at DESC",[req.params.connectionId,req.user.id]);
  const [operations]=await pool.execute("SELECT id,deployment_id,action,status,plan_summary,expires_at,created_at FROM azure_terraform_operations WHERE connection_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50",[req.params.connectionId,req.user.id]);
  res.json({subscriptionId:connections[0].azure_subscription_id,tenantId:connections[0].azure_tenant_id,resourceGroup:connections[0].azure_resource_group,catalog:getAzureTerraformCatalog(),deployments:deployments.map(item=>({...item,outputs:item.outputs_json?JSON.parse(item.outputs_json):null,outputs_json:undefined})),operations:operations.map(item=>({...item,plan_summary:item.plan_summary?JSON.parse(item.plan_summary):null}))});
 }catch(error){next(error)}});

 app.post("/api/cloud-connections/azure/:connectionId/terraform/plans",requireUser,async(req,res,next)=>{try{
  const {action,templateId,deploymentId:requestedId,displayName,location,machineSize,adminUsername,sshPublicKey}=req.body||{};
  if(!["create","destroy"].includes(action))return res.status(400).json({message:"Choose create or destroy for an Azure Linux VM."});
  if(requestedId&&!uuidPattern.test(requestedId))return res.status(400).json({message:"Select a valid OmniCloud VM deployment."});
  const [connections]=await pool.execute("SELECT id,azure_subscription_id,azure_tenant_id,azure_resource_group FROM cloud_connections WHERE id=? AND user_id=? AND provider='azure' AND status='connected'",[req.params.connectionId,req.user.id]);
  if(!connections.length)return res.status(404).json({message:"Connected Azure subscription not found."});
  const connection=connections[0];
  try{await verifyConnection(connectionInput(connection))}catch(error){const failure=error instanceof AzureConnectionError?error:new AzureConnectionError("AZURE_VERIFY_FAILED","Azure delegated access could not be verified.");return res.status(failure.status||409).json({code:failure.code,message:failure.message})}
  let deployment,isNew=false;
  if(action==="create"&&!requestedId){
   if(templateId!=="azure_linux_vm"||typeof displayName!=="string"||!safeName.test(displayName.trim())||typeof location!=="string"||!regionPattern.test(location)||!sizes.has(machineSize)||typeof adminUsername!=="string"||!/^[-a-zA-Z0-9_.@]{1,64}$/.test(adminUsername)||typeof sshPublicKey!=="string"||!sshKeyPattern.test(sshPublicKey.trim())||sshPublicKey.length>8192)return res.status(400).json({message:"Enter a valid VM label, Azure region, supported size, Linux username, and SSH public key. Never paste a private key."});
   const id=deploymentId(),nowValue=now();deployment={id,template_id:templateId,display_name:displayName.trim(),vm_name:`oc-${id.replaceAll("-","").slice(0,12)}`,location,machine_size:machineSize,admin_username:adminUsername.trim(),ssh_public_key:sshPublicKey.trim(),subscription_id:connection.azure_subscription_id,tenant_id:connection.azure_tenant_id,resource_group:connection.azure_resource_group,status:"planning"};isNew=true;
   await pool.execute("INSERT INTO azure_terraform_deployments(id,user_id,connection_id,template_id,display_name,vm_name,location,machine_size,admin_username,ssh_public_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'planning',?,?)",[id,req.user.id,connection.id,templateId,deployment.display_name,deployment.vm_name,location,machineSize,deployment.admin_username,deployment.ssh_public_key,nowValue,nowValue]);
  }else{
   if(typeof requestedId!=="string")return res.status(400).json({message:"Select a known VM deployment."});
   const [rows]=await pool.execute("SELECT id,template_id,display_name,vm_name,location,machine_size,admin_username,ssh_public_key,status FROM azure_terraform_deployments WHERE id=? AND user_id=? AND connection_id=?",[requestedId,req.user.id,connection.id]);
   if(!rows.length)return res.status(404).json({message:"Azure VM deployment not found."});deployment={...rows[0],subscription_id:connection.azure_subscription_id,tenant_id:connection.azure_tenant_id,resource_group:connection.azure_resource_group};
   if(action==="create"&&!['failed','attention','planned'].includes(deployment.status))return res.status(409).json({message:"This VM cannot be planned for creation in its current state."});
   if(action==="destroy"&&!['active','attention'].includes(deployment.status))return res.status(409).json({message:"Only an active VM can be planned for deletion."});
  }
  const timestamp=now(),expires=expiry();await pool.execute("UPDATE azure_terraform_operations SET status='superseded',updated_at=? WHERE deployment_id=? AND user_id=? AND status='planned'",[timestamp,deployment.id,req.user.id]);
  const opId=operationId();await pool.execute("INSERT INTO azure_terraform_operations(id,user_id,connection_id,deployment_id,action,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'planning',?,?,?)",[opId,req.user.id,connection.id,deployment.id,action,expires,timestamp,timestamp]);
  try{
   const result=await createPlan({deployment,userId:req.user.id,connectionId:connection.id,operationId:opId,action});const summary={...result.summary,desiredDisplayName:deployment.display_name};
   await pool.execute("UPDATE azure_terraform_operations SET status='planned',plan_summary=?,updated_at=? WHERE id=? AND user_id=? AND status='planning'",[JSON.stringify(summary),now(),opId,req.user.id]);
   if(isNew)await pool.execute("UPDATE azure_terraform_deployments SET status='planned',updated_at=? WHERE id=? AND user_id=?",[now(),deployment.id,req.user.id]);
   res.status(201).json({operation:{id:opId,action,status:"planned",expiresAt:expires,summary},deployment:{...deployment,status:isNew?"planned":deployment.status,ssh_public_key:undefined}});
  }catch(error){
   await pool.execute("UPDATE azure_terraform_operations SET status='failed',updated_at=? WHERE id=? AND user_id=?",[now(),opId,req.user.id]);if(isNew)await pool.execute("UPDATE azure_terraform_deployments SET status='failed',updated_at=? WHERE id=? AND user_id=?",[now(),deployment.id,req.user.id]);
   const failure=terraformFailure(error);console.error("Azure Terraform plan failed:",error.message);return res.status(502).json({...failure,detail:error.message.slice(0,900)});
  }
 }catch(error){next(error)}});

 app.post("/api/cloud-connections/azure/:connectionId/terraform/operations/:operationId/apply",requireUser,async(req,res,next)=>{try{
  if(req.body?.confirm!==true)return res.status(400).json({message:"Confirm the reviewed Terraform plan before it can be applied."});
  const [rows]=await pool.execute("SELECT o.id,o.deployment_id,o.action,o.status,o.expires_at,d.status AS deployment_status,d.vm_name,d.location,d.machine_size,c.azure_subscription_id,c.azure_tenant_id,c.azure_resource_group FROM azure_terraform_operations o JOIN azure_terraform_deployments d ON d.id=o.deployment_id AND d.user_id=o.user_id AND d.connection_id=o.connection_id JOIN cloud_connections c ON c.id=o.connection_id AND c.user_id=o.user_id WHERE o.id=? AND o.user_id=? AND o.connection_id=? AND c.provider='azure' AND c.status='connected'",[req.params.operationId,req.user.id,req.params.connectionId]);
  if(!rows.length)return res.status(404).json({message:"Reviewed Azure Terraform plan not found."});const operation=rows[0];
  if(operation.status!=="planned")return res.status(409).json({message:"This plan is no longer available. Create a fresh plan before applying."});
  if(Number(operation.expires_at)<now()){await pool.execute("UPDATE azure_terraform_operations SET status='expired',updated_at=? WHERE id=? AND user_id=? AND status='planned'",[now(),operation.id,req.user.id]);return res.status(409).json({message:"This plan expired. Create and review a new plan."});}
  try{await verifyConnection(connectionInput(operation))}catch(error){const failure=error instanceof AzureConnectionError?error:new AzureConnectionError("AZURE_VERIFY_FAILED","Azure delegated access could not be verified.");return res.status(failure.status||409).json({code:failure.code,message:failure.message})}
  const [claimed]=await pool.execute("UPDATE azure_terraform_operations SET status='applying',updated_at=? WHERE id=? AND user_id=? AND status='planned'",[now(),operation.id,req.user.id]);if(!claimed.affectedRows)return res.status(409).json({message:"This plan is already being applied or is no longer available."});
  try{
   const outputs=await applyPlan({operationId:operation.id,userId:req.user.id,connectionId:req.params.connectionId,deploymentId:operation.deployment_id});const nextStatus=operation.action==="destroy"?"destroyed":"active";
   await pool.execute("UPDATE azure_terraform_deployments SET status=?,outputs_json=?,updated_at=? WHERE id=? AND user_id=? AND connection_id=?",[nextStatus,operation.action==="destroy"?null:JSON.stringify(outputs),now(),operation.deployment_id,req.user.id,req.params.connectionId]);
   await pool.execute("UPDATE azure_terraform_operations SET status='applied',updated_at=? WHERE id=? AND user_id=?",[now(),operation.id,req.user.id]);await removePlan(req.user.id,req.params.connectionId,operation.deployment_id,operation.id);
   res.json({operation:{id:operation.id,status:"applied",action:operation.action},deployment:{id:operation.deployment_id,vm_name:operation.vm_name,location:operation.location,machine_size:operation.machine_size,status:nextStatus,outputs:operation.action==="destroy"?null:outputs}});
  }catch(error){
   await pool.execute("UPDATE azure_terraform_operations SET status='failed',updated_at=? WHERE id=? AND user_id=?",[now(),operation.id,req.user.id]);await pool.execute("UPDATE azure_terraform_deployments SET status='attention',updated_at=? WHERE id=? AND user_id=?",[now(),operation.deployment_id,req.user.id]);
   const failure=terraformFailure(error);console.error("Azure Terraform apply failed:",error.message);return res.status(502).json({...failure,detail:error.message.slice(0,900)});
  }
 }catch(error){next(error)}});
}
