import {randomUUID} from "node:crypto";
import {GoogleAuth,Impersonated} from "google-auth-library";

const cloudPlatformScope="https://www.googleapis.com/auth/cloud-platform";
const projectIdPattern=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const serviceAccountEmailPattern=/^omnicloud-[0-9a-f]{8}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const callerEmailPattern=/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

export class GcpConnectionError extends Error{
 constructor(code,message,cause){super(message,{cause});this.name="GcpConnectionError";this.code=code;}
}

function httpStatus(error){return Number(error?.response?.status||error?.status||0)}
function errorText(error){return `${error?.response?.data?.error?.status||""} ${error?.response?.data?.error?.message||""} ${error?.message||""}`.toLowerCase()}

export function buildGcpSetupInstructions(projectId,serviceAccountEmail,omniCloudServiceAccountEmail){
 if(!projectIdPattern.test(projectId||""))throw new Error("Enter a valid Google Cloud project ID.");
 if(!serviceAccountEmailPattern.test(serviceAccountEmail||"")||!serviceAccountEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`))throw new Error("The generated customer service account email is invalid.");
 if(!callerEmailPattern.test(omniCloudServiceAccountEmail||""))throw new Error("The OmniCloud Google Cloud service account is not configured. Set OMNICLOUD_GCP_SERVICE_ACCOUNT_EMAIL on the backend.");
 const accountName=serviceAccountEmail.slice(0,serviceAccountEmail.indexOf("@"));
 return `set -euo pipefail
PROJECT_ID='${projectId}'
OMNICLOUD_SA_NAME='${accountName}'
OMNICLOUD_SA_EMAIL='${serviceAccountEmail}'
OMNICLOUD_CALLER='${omniCloudServiceAccountEmail}'

gcloud services enable iamcredentials.googleapis.com cloudresourcemanager.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts describe "$OMNICLOUD_SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1 || gcloud iam service-accounts create "$OMNICLOUD_SA_NAME" --project="$PROJECT_ID" --display-name="OmniCloud delegated access"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$OMNICLOUD_SA_EMAIL" --role="roles/browser"
gcloud iam service-accounts add-iam-policy-binding "$OMNICLOUD_SA_EMAIL" --project="$PROJECT_ID" --member="serviceAccount:$OMNICLOUD_CALLER" --role="roles/iam.serviceAccountTokenCreator"`;
}

export async function mintGcpImpersonatedToken(serviceAccountEmail,{authClientFactory=async()=>{
 const auth=new GoogleAuth({scopes:[cloudPlatformScope]});
 return auth.getClient();
}}={}){
 const sourceClient=await authClientFactory();
 const impersonated=new Impersonated({sourceClient,targetPrincipal:serviceAccountEmail,targetScopes:[cloudPlatformScope],lifetime:3600});
 const result=await impersonated.getAccessToken();
 if(!result?.token)throw new GcpConnectionError("GCP_TOKEN_MINT_FAILED","Google Cloud did not return an impersonated access token.");
 return result.token;
}

export async function verifyGcpConnection(projectId,serviceAccountEmail,{tokenFactory=mintGcpImpersonatedToken,fetchImpl=globalThis.fetch}={}){
 if(!projectIdPattern.test(projectId||""))throw new GcpConnectionError("INVALID_PROJECT_ID","Enter a valid Google Cloud project ID (6–30 lowercase letters, digits, or hyphens).");
 if(!serviceAccountEmailPattern.test(serviceAccountEmail||"")||!serviceAccountEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`))throw new GcpConnectionError("INVALID_SERVICE_ACCOUNT","The service account email does not match this OmniCloud setup.");
 let token;
 try{token=await tokenFactory(serviceAccountEmail)}catch(error){
  const status=httpStatus(error),text=errorText(error);
  if(status===401)throw new GcpConnectionError("GCP_BACKEND_AUTH_FAILED","OmniCloud could not verify Google Cloud access right now. Contact OmniCloud support; no changes to your project are needed.",error);
  if(status===403)throw new GcpConnectionError("GCP_TOKEN_CREATOR_REQUIRED","Google Cloud denied service account impersonation. Grant OmniCloud’s configured service account roles/iam.serviceAccountTokenCreator on the customer service account.",error);
  if(status===404&&text.includes("service_disabled"))throw new GcpConnectionError("GCP_IAM_CREDENTIALS_API_DISABLED","Enable the IAM Service Account Credentials API in the project and retry.",error);
  if(status===404)throw new GcpConnectionError("GCP_SERVICE_ACCOUNT_NOT_FOUND","The customer service account was not found. Run the generated setup commands in the selected project.",error);
  if(status===0&&/credential|auth|adc/.test(text))throw new GcpConnectionError("GCP_BACKEND_AUTH_FAILED","OmniCloud could not verify Google Cloud access right now. Contact OmniCloud support; no changes to your project are needed.",error);
  throw new GcpConnectionError("GCP_IMPERSONATION_FAILED","OmniCloud could not impersonate the customer service account. Check IAM Credentials API status and the Token Creator binding, then retry.",error);
 }
 let response;
 try{response=await fetchImpl(`https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})}catch(error){
  throw new GcpConnectionError("GCP_PROJECT_CHECK_FAILED","Google Cloud project access could not be checked right now. Retry in a few minutes or contact OmniCloud support.",error);
 }
 if(!response.ok){
  const status=response.status;
  if(status===403)throw new GcpConnectionError("GCP_PROJECT_ACCESS_DENIED","The service account was impersonated, but cannot read this project. Grant it roles/browser on the project and verify again.");
  if(status===404)throw new GcpConnectionError("GCP_PROJECT_NOT_FOUND","Google Cloud could not find this project. Check the project ID and that it is active.");
  if(status===401)throw new GcpConnectionError("GCP_TOKEN_REJECTED","Google Cloud rejected the short-lived token. Retry the connection check.");
  throw new GcpConnectionError("GCP_PROJECT_CHECK_FAILED","Google Cloud could not verify project access. Check API availability and retry.");
 }
 const project=await response.json();
 if(project.projectId!==projectId)throw new GcpConnectionError("GCP_PROJECT_MISMATCH","Google Cloud returned a different project than the one requested.");
 if(project.state&&project.state!=="ACTIVE")throw new GcpConnectionError("GCP_PROJECT_INACTIVE","This Google Cloud project is not active.");
 return {projectId,serviceAccountEmail,projectName:project.name||projectId,state:project.state||"ACTIVE"};
}

function safeGcpError(error){
 if(error instanceof GcpConnectionError)return {code:error.code,message:error.message};
 return {code:"GCP_VERIFY_FAILED",message:"Google Cloud could not verify this connection. Check the setup and try again."};
}

export function registerGcpRoutes(app,{pool,requireUser,verifyConnection=verifyGcpConnection,omniCloudServiceAccountEmail=()=>process.env.OMNICLOUD_GCP_SERVICE_ACCOUNT_EMAIL}={}){
 app.post("/api/cloud-connections/gcp/setup",requireUser,async(req,res,next)=>{try{
  const projectId=typeof req.body?.projectId==="string"?req.body.projectId.trim():"";
  if(!projectIdPattern.test(projectId))return res.status(400).json({code:"INVALID_PROJECT_ID",message:"Enter a valid Google Cloud project ID (6–30 lowercase letters, digits, or hyphens)."});
  const caller=omniCloudServiceAccountEmail();
  if(!callerEmailPattern.test(caller||""))return res.status(503).json({code:"GCP_NOT_CONFIGURED",message:"Google Cloud connections are temporarily unavailable. Contact OmniCloud support; no changes to your Google Cloud project are needed."});
  const id=randomUUID(),accountName=`omnicloud-${id.slice(0,8)}`,serviceAccountEmail=`${accountName}@${projectId}.iam.gserviceaccount.com`,now=Date.now();
  const instructions=buildGcpSetupInstructions(projectId,serviceAccountEmail,caller);
  await pool.execute("INSERT INTO cloud_connections(id,user_id,provider,account_id,role_arn,external_id,project_id,service_account_email,status,created_at,updated_at) VALUES(?,?,'gcp',NULL,NULL,NULL,?,?, 'setup',?,?)",[id,req.user.id,projectId,serviceAccountEmail,now,now]);
  res.status(201).json({setup:{id,projectId,serviceAccountEmail,instructions,status:"setup"}});
 }catch(error){next(error)}});

 app.get("/api/cloud-connections/gcp/setup/:setupId/instructions",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,project_id,service_account_email,status FROM cloud_connections WHERE id=? AND user_id=? AND provider='gcp'",[req.params.setupId,req.user.id]);
  if(!rows.length||rows[0].status!=="setup")return res.status(404).json({code:"SETUP_NOT_FOUND",message:"Google Cloud setup was not found or has already been completed."});
  const caller=omniCloudServiceAccountEmail();
  if(!callerEmailPattern.test(caller||""))return res.status(503).json({code:"GCP_NOT_CONFIGURED",message:"Google Cloud connections are temporarily unavailable. Contact OmniCloud support; no changes to your Google Cloud project are needed."});
  res.json({setup:{id:rows[0].id,projectId:rows[0].project_id,serviceAccountEmail:rows[0].service_account_email,instructions:buildGcpSetupInstructions(rows[0].project_id,rows[0].service_account_email,caller),status:rows[0].status}});
 }catch(error){next(error)}});

 app.post("/api/cloud-connections/gcp/setup/:setupId/verify",requireUser,async(req,res,next)=>{try{
  const [rows]=await pool.execute("SELECT id,project_id,service_account_email,status FROM cloud_connections WHERE id=? AND user_id=? AND provider='gcp'",[req.params.setupId,req.user.id]);
  if(!rows.length||rows[0].status!=="setup")return res.status(404).json({code:"SETUP_NOT_FOUND",message:"Google Cloud setup was not found or has already been completed."});
  const setup=rows[0];let result;
  try{result=await verifyConnection(setup.project_id,setup.service_account_email)}catch(error){const failure=safeGcpError(error);const status=failure.code==="INVALID_PROJECT_ID"||failure.code==="INVALID_SERVICE_ACCOUNT"?400:failure.code==="GCP_BACKEND_AUTH_FAILED"?503:409;return res.status(status).json(failure)}
  const now=Date.now();const [updated]=await pool.execute("UPDATE cloud_connections SET status='connected',updated_at=? WHERE id=? AND user_id=? AND provider='gcp' AND status='setup'",[now,req.params.setupId,req.user.id]);
  if(!updated.affectedRows)return res.status(409).json({code:"SETUP_ALREADY_COMPLETED",message:"This Google Cloud setup was completed in another request. Refresh the page."});
  res.json({connection:{id:setup.id,provider:"gcp",project_id:result.projectId,service_account_email:result.serviceAccountEmail,status:"connected",project_name:result.projectName}});
 }catch(error){next(error)}});
}
