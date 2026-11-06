import {randomUUID} from "node:crypto";
import {mintGcpImpersonatedToken,GcpConnectionError} from "./gcpConnection.js";
import {getGcpTerraformCatalog,newGcpDeploymentId,newGcpOperationId,gcpPlanExpiry,runGcpPlan,applyGcpPlan,removeGcpPlanFile} from "./gcpTerraformService.js";

const zonePattern=/^[a-z]+-[a-z]+\d-[a-z]$/;
const safeNamePattern=/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/;
const machineTypes=new Set(["e2-micro","e2-small","e2-medium"]);
const uuidPattern=/^[0-9a-f-]{36}$/i;

function tokenFailure(error){
 if(error instanceof GcpConnectionError)return {code:error.code,message:error.message};
 const status=Number(error?.response?.status||error?.status||0);
 if(status===401)return {code:"GCP_BACKEND_AUTH_FAILED",message:"OmniCloud could not authenticate to Google Cloud. Check the backend Application Default Credentials and retry."};
 if(status===403)return {code:"GCP_TOKEN_CREATOR_REQUIRED",message:"Google Cloud denied service-account impersonation. Re-run the OmniCloud GCP setup commands and confirm the configured backend service account has Token Creator on this connection's service account."};
 if(status===404)return {code:"GCP_SERVICE_ACCOUNT_NOT_FOUND",message:"The delegated service account or IAM Credentials API was not found. Check that the setup commands completed in the connected project."};
 return {code:"GCP_IMPERSONATION_FAILED",message:"OmniCloud could not obtain temporary Google Cloud credentials. Check the delegated service-account binding and retry."};
}

async function temporaryToken(connection,tokenFactory){
 try{return await tokenFactory(connection.service_account_email)}
 catch(error){const failure=tokenFailure(error);const wrapped=new Error(failure.message);wrapped.code=failure.code;wrapped.status=failure.code==="GCP_BACKEND_AUTH_FAILED"?503:409;throw wrapped}
}

function terraformFailure(error,phase){
 const detail=String(error?.message||"");
 const normalized=detail.toLowerCase();
 if((normalized.includes("billing")||normalized.includes("ureq_project_billing_not_open"))&&(/not open|disabled|not enabled|billing-enabled|billing must be enabled|linked/.test(normalized)))return {code:"GCP_BILLING_REQUIRED",message:"This Google Cloud project is not linked to an open billing account. Link or reopen billing in Google Cloud Console, then enable the Compute Engine API and retry. Compute Engine resources can incur charges."};
 if(normalized.includes("service_disabled")||normalized.includes("compute.googleapis.com has not been used"))return {code:"GCP_COMPUTE_API_DISABLED",message:"The Compute Engine API is disabled in this project. After billing is linked to an open account, run the generated setup commands in Cloud Shell, wait for the API to finish enabling, then create a new plan."};
 if(normalized.includes("compute.instances.create")||normalized.includes("permission_denied")||normalized.includes("does not have permission"))return {code:"GCP_COMPUTE_PERMISSION_DENIED",message:"The connected service account lacks Compute Engine permissions. Grant it roles/compute.instanceAdmin.v1 on this project, then create a new plan."};
 return {code:"GCP_TERRAFORM_FAILED",message:phase==="plan"?"Terraform could not create a Google Cloud VM plan. Check the Compute Engine API, project billing, connected service-account permissions, and Terraform provider access.":"Google Cloud Terraform did not complete successfully. Check the VM and Terraform state before retrying."};
}

export function registerGcpTerraformRoutes(app,{
 pool,requireUser,
 tokenFactory=serviceAccountEmail=>mintGcpImpersonatedToken(serviceAccountEmail),
 createPlan=runGcpPlan,applyPlan=applyGcpPlan,removePlan=removeGcpPlanFile,
 now=()=>Date.now(),deploymentId=newGcpDeploymentId,operationId=newGcpOperationId,expiry=gcpPlanExpiry,
}={}){
 app.get("/api/cloud-connections/gcp/:connectionId/terraform",requireUser,async(req,res,next)=>{try{
  const [connections]=await pool.execute("SELECT id,project_id FROM cloud_connections WHERE id=? AND user_id=? AND provider='gcp' AND status='connected'",[req.params.connectionId,req.user.id]);
  if(!connections.length)return res.status(404).json({message:"Connected Google Cloud project not found."});
  const [deployments]=await pool.execute("SELECT id,template_id,display_name,instance_name,zone,machine_type,status,outputs_json,created_at,updated_at FROM gcp_terraform_deployments WHERE connection_id=? AND user_id=? ORDER BY created_at DESC",[req.params.connectionId,req.user.id]);
  const [operations]=await pool.execute("SELECT id,deployment_id,action,status,plan_summary,expires_at,created_at FROM gcp_terraform_operations WHERE connection_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50",[req.params.connectionId,req.user.id]);
  res.json({projectId:connections[0].project_id,catalog:getGcpTerraformCatalog(),deployments:deployments.map(item=>({...item,outputs:item.outputs_json?JSON.parse(item.outputs_json):null,outputs_json:undefined})),operations:operations.map(item=>({...item,plan_summary:item.plan_summary?JSON.parse(item.plan_summary):null}))});
 }catch(error){next(error)}});

 app.post("/api/cloud-connections/gcp/:connectionId/terraform/plans",requireUser,async(req,res,next)=>{try{
  const {action,templateId,deploymentId:requestedDeploymentId,displayName,zone,machineType}=req.body||{};
  if(!["create","destroy"].includes(action))return res.status(400).json({message:"Choose create or destroy for a Compute Engine VM."});
  if(requestedDeploymentId&&!uuidPattern.test(requestedDeploymentId))return res.status(400).json({message:"Select a valid OmniCloud deployment."});
  const [connections]=await pool.execute("SELECT id,project_id,service_account_email FROM cloud_connections WHERE id=? AND user_id=? AND provider='gcp' AND status='connected'",[req.params.connectionId,req.user.id]);
  if(!connections.length)return res.status(404).json({message:"Connected Google Cloud project not found."});
  const connection=connections[0];let token;
  try{token=await temporaryToken(connection,tokenFactory)}catch(error){return res.status(error.status||409).json({code:error.code||"GCP_IMPERSONATION_FAILED",message:error.message})}
  let deployment,isNew=false;
  if(action==="create"&&!requestedDeploymentId){
   if(templateId!=="gcp_compute_instance"||typeof displayName!=="string"||!safeNamePattern.test(displayName.trim())||typeof zone!=="string"||!zonePattern.test(zone)||!machineTypes.has(machineType))return res.status(400).json({message:"Enter a VM name, a valid zone (for example asia-south1-a), and choose e2-micro, e2-small, or e2-medium."});
   const id=deploymentId(),nowValue=now();
   deployment={id,template_id:templateId,display_name:displayName.trim(),instance_name:`omnicloud-${id.replaceAll("-","").slice(0,12)}`,zone,machine_type:machineType,project_id:connection.project_id,status:"planning"};isNew=true;
   await pool.execute("INSERT INTO gcp_terraform_deployments(id,user_id,connection_id,template_id,display_name,instance_name,zone,machine_type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'planning',?,?)",[id,req.user.id,connection.id,templateId,deployment.display_name,deployment.instance_name,zone,machineType,nowValue,nowValue]);
  }else{
   if(typeof requestedDeploymentId!=="string")return res.status(400).json({message:"Select a known VM deployment."});
   const [rows]=await pool.execute("SELECT id,template_id,display_name,instance_name,zone,machine_type,status FROM gcp_terraform_deployments WHERE id=? AND user_id=? AND connection_id=?",[requestedDeploymentId,req.user.id,connection.id]);
   if(!rows.length)return res.status(404).json({message:"Google Cloud VM deployment not found."});deployment={...rows[0],project_id:connection.project_id};
   if(action==="create"&&!['failed','attention','planned'].includes(deployment.status))return res.status(409).json({message:"This VM cannot be planned for creation in its current state."});
   if(action==="destroy"&&!['active','attention'].includes(deployment.status))return res.status(409).json({message:"Only an active VM can be planned for deletion."});
  }
  const timestamp=now(),expires=expiry();
  await pool.execute("UPDATE gcp_terraform_operations SET status='superseded',updated_at=? WHERE deployment_id=? AND user_id=? AND status='planned'",[timestamp,deployment.id,req.user.id]);
  const opId=operationId();
  await pool.execute("INSERT INTO gcp_terraform_operations(id,user_id,connection_id,deployment_id,action,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'planning',?,?,?)",[opId,req.user.id,connection.id,deployment.id,action,expires,timestamp,timestamp]);
  try{
   const result=await createPlan({deployment,userId:req.user.id,connectionId:connection.id,operationId:opId,action,accessToken:token});
   const summary={...result.summary,desiredDisplayName:deployment.display_name};
   await pool.execute("UPDATE gcp_terraform_operations SET status='planned',plan_summary=?,updated_at=? WHERE id=? AND user_id=? AND status='planning'",[JSON.stringify(summary),now(),opId,req.user.id]);
   if(isNew)await pool.execute("UPDATE gcp_terraform_deployments SET status='planned',updated_at=? WHERE id=? AND user_id=?",[now(),deployment.id,req.user.id]);
   res.status(201).json({operation:{id:opId,action,status:"planned",expiresAt:expires,summary},deployment:{...deployment,status:isNew?"planned":deployment.status}});
  }catch(error){
   await pool.execute("UPDATE gcp_terraform_operations SET status='failed',updated_at=? WHERE id=? AND user_id=?",[now(),opId,req.user.id]);
   if(isNew)await pool.execute("UPDATE gcp_terraform_deployments SET status='failed',updated_at=? WHERE id=? AND user_id=?",[now(),deployment.id,req.user.id]);
   const failure=terraformFailure(error,"plan");
   console.error("Google Cloud Terraform plan failed:",error.message);
   return res.status(502).json({...failure,detail:error.message.slice(0,900)});
  }
 }catch(error){next(error)}});

 app.post("/api/cloud-connections/gcp/:connectionId/terraform/operations/:operationId/apply",requireUser,async(req,res,next)=>{try{
  if(req.body?.confirm!==true)return res.status(400).json({message:"Confirm the reviewed Terraform plan before it can be applied."});
  const [rows]=await pool.execute("SELECT o.id,o.deployment_id,o.action,o.status,o.plan_summary,o.expires_at,d.status AS deployment_status,d.template_id,d.display_name,d.instance_name,d.zone,d.machine_type,c.project_id,c.service_account_email FROM gcp_terraform_operations o JOIN gcp_terraform_deployments d ON d.id=o.deployment_id AND d.user_id=o.user_id AND d.connection_id=o.connection_id JOIN cloud_connections c ON c.id=o.connection_id AND c.user_id=o.user_id WHERE o.id=? AND o.user_id=? AND o.connection_id=? AND c.provider='gcp' AND c.status='connected'",[req.params.operationId,req.user.id,req.params.connectionId]);
  if(!rows.length)return res.status(404).json({message:"Reviewed Google Cloud Terraform plan not found."});
  const operation=rows[0];
  if(operation.status!=="planned")return res.status(409).json({message:"This plan is no longer available. Create a fresh plan before applying."});
  if(Number(operation.expires_at)<now()){await pool.execute("UPDATE gcp_terraform_operations SET status='expired',updated_at=? WHERE id=? AND user_id=? AND status='planned'",[now(),operation.id,req.user.id]);return res.status(409).json({message:"This plan expired. Create and review a new plan."});}
  let token;try{token=await temporaryToken(operation,tokenFactory)}catch(error){return res.status(error.status||409).json({code:error.code||"GCP_IMPERSONATION_FAILED",message:error.message})}
  const [claimed]=await pool.execute("UPDATE gcp_terraform_operations SET status='applying',updated_at=? WHERE id=? AND user_id=? AND status='planned'",[now(),operation.id,req.user.id]);
  if(!claimed.affectedRows)return res.status(409).json({message:"This plan is already being applied or is no longer available."});
  try{
   const outputs=await applyPlan({operationId:operation.id,userId:req.user.id,connectionId:req.params.connectionId,deploymentId:operation.deployment_id,accessToken:token});
   const nextStatus=operation.action==="destroy"?"destroyed":"active";
   await pool.execute("UPDATE gcp_terraform_deployments SET status=?,outputs_json=?,updated_at=? WHERE id=? AND user_id=? AND connection_id=?",[nextStatus,operation.action==="destroy"?null:JSON.stringify(outputs),now(),operation.deployment_id,req.user.id,req.params.connectionId]);
   await pool.execute("UPDATE gcp_terraform_operations SET status='applied',updated_at=? WHERE id=? AND user_id=?",[now(),operation.id,req.user.id]);
   await removePlan(req.user.id,req.params.connectionId,operation.deployment_id,operation.id);
   res.json({operation:{id:operation.id,status:"applied",action:operation.action},deployment:{id:operation.deployment_id,instance_name:operation.instance_name,zone:operation.zone,machine_type:operation.machine_type,status:nextStatus,outputs:operation.action==="destroy"?null:outputs}});
  }catch(error){
   await pool.execute("UPDATE gcp_terraform_operations SET status='failed',updated_at=? WHERE id=? AND user_id=?",[now(),operation.id,req.user.id]);
   await pool.execute("UPDATE gcp_terraform_deployments SET status='attention',updated_at=? WHERE id=? AND user_id=?",[now(),operation.deployment_id,req.user.id]);
   const failure=terraformFailure(error,"apply");
   console.error("Google Cloud Terraform apply failed:",error.message);
   return res.status(502).json({...failure,detail:error.message.slice(0,900)});
  }
 }catch(error){next(error)}});
}
