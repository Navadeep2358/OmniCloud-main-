import {useEffect,useState} from "react";
import {Check,Copy,Info} from "lucide-react";
import {AlertCircle,CheckCircle2,LoaderCircle} from "lucide-react";
import ReviewDialog from "./ReviewDialog.jsx";

const API="/api/cloud-connections/gcp/";

export default function GcpTerraformManager({connection}){
 const [data,setData]=useState({catalog:[],deployments:[],operations:[]});
 const [displayName,setDisplayName]=useState("OmniCloud VM");
 const [zone,setZone]=useState("asia-south1-a");
 const [machineType,setMachineType]=useState("e2-micro");
 const [busy,setBusy]=useState(false);
 const [notice,setNotice]=useState("");
 const [copied,setCopied]=useState(false);
 const [review,setReview]=useState(null),[applyProgress,setApplyProgress]=useState(null);

 async function load(){
  const response=await fetch(`${API}${encodeURIComponent(connection.id)}/terraform`,{credentials:"same-origin"});
  const body=await response.json();
  if(!response.ok)throw Error(body.message||"Could not load Google Cloud VM deployments.");
  setData(body);
 }
 useEffect(()=>{let alive=true;fetch(`${API}${encodeURIComponent(connection.id)}/terraform`,{credentials:"same-origin"}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.message);if(alive)setData(body)}).catch(error=>{if(alive)setNotice(error.message)});return()=>{alive=false}},[connection.id]);

 async function requestPlan(action,deployment){
  setBusy(true);setNotice("");
  try{
   const payload=deployment?{action,deploymentId:deployment.id}:{action,templateId:"gcp_compute_instance",displayName,zone,machineType};
   const response=await fetch(`${API}${encodeURIComponent(connection.id)}/terraform/plans`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
   const body=await response.json();
   if(!response.ok)throw Error(body.message+(body.detail?` ${body.detail}`:""));
   setNotice("Terraform plan is ready. Review its changes; it expires in 15 minutes.");
   await load();
  }catch(error){setNotice(error.message);await load().catch(()=>{})}finally{setBusy(false)}
 }
 async function apply(operation,deployment){
  const changes=(operation.plan_summary?.resourceChanges||[]).map(change=>`${change.address}: ${change.actions.join(", ")}`).join("\n")||"No resource changes";
  const action=operation.action==="destroy"?"delete":"create";
  const notice=operation.action==="destroy"?"Deleting this VM also deletes its boot disk. It will not reverse charges already incurred.":"Compute, disk, and network usage may incur Google Cloud charges. This VM has no public IP address.";
  setReview({operation,deployment,changes:changes.split("\n"),cost:notice,title:`${action==="delete"?"Delete":"Create"} ${deployment.instance_name}`,summary:`Review the Google Cloud Compute Engine plan in zone ${deployment.zone}.`});
 }
 async function confirmApply(){if(!review)return;const {operation,deployment}=review;setReview(null);setBusy(true);setNotice("");setApplyProgress({stage:"applying",resource:deployment.instance_name});
  try{
   await new Promise(resolve=>setTimeout(resolve,850));
   const response=await fetch(`${API}${encodeURIComponent(connection.id)}/terraform/operations/${encodeURIComponent(operation.id)}/apply`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});
   const body=await response.json();
   if(!response.ok)throw Error(body.message+(body.detail?` ${body.detail}`:""));
   setApplyProgress({stage:"refreshing",resource:deployment.instance_name});
   setNotice(operation.action==="destroy"?"Terraform deleted the Google Cloud VM.":"Terraform created the Google Cloud VM.");
   await load();
   setApplyProgress({stage:"complete",resource:deployment.instance_name});setTimeout(()=>setApplyProgress(null),2300);
  }catch(error){setNotice(error.message);setApplyProgress({stage:"failed",resource:deployment.instance_name});await load().catch(()=>{});setTimeout(()=>setApplyProgress(null),3500)}finally{setBusy(false)}
 }
 const permissionCommands=`gcloud services enable compute.googleapis.com --project=${data.projectId||connection.project_id}\ngcloud projects add-iam-policy-binding ${data.projectId||connection.project_id} --member=serviceAccount:${connection.service_account_email} --role=roles/compute.instanceAdmin.v1`;
 async function copyPermissionCommands(){try{await navigator.clipboard.writeText(permissionCommands);setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{setNotice("Clipboard access is unavailable. Select and copy the commands manually.")}}
 const pendingFor=id=>data.operations.find(operation=>operation.deployment_id===id&&operation.status==="planned"&&Number(operation.expires_at)>Date.now());

 return <section className="oc-card oc-terraform">
  <h2>Terraform managed Google Cloud VMs</h2>
  <p>Create a Debian 12 Compute Engine VM in this connected project. OmniCloud creates a reviewed plan before it can change your project.</p>
  <p className="oc-cost-notice">Compute Engine and boot disk charges may apply while the VM exists. The VM has no public IP by default. Review each plan and delete the VM when it is no longer needed.</p>
  <details className="oc-gcp-permissions"><summary>One-time setup for VM provisioning</summary><p>Run these commands in Cloud Shell for this connected project. They enable the Compute Engine API and grant its OmniCloud service account VM management permissions.</p><pre>{permissionCommands}</pre><button type="button" className="oc-copy" onClick={copyPermissionCommands}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?"Copied":"Copy commands"}</button></details>
  <div className="oc-terraform-create">
   <label>VM name<input value={displayName} maxLength={63} onChange={event=>setDisplayName(event.target.value)}/></label>
   <label>Zone<input value={zone} maxLength={32} onChange={event=>setZone(event.target.value)} placeholder="asia-south1-a"/></label>
   <label>Machine type<select value={machineType} onChange={event=>setMachineType(event.target.value)}><option value="e2-micro">e2-micro · smallest</option><option value="e2-small">e2-small</option><option value="e2-medium">e2-medium</option></select></label>
   <button className="primary" disabled={busy} onClick={()=>requestPlan("create")}>{busy?"Building plan…":"Create VM plan"}</button>
  </div>
  {notice&&<div className="oc-toast" role="status"><Info size={19}/><span>{notice}</span><button aria-label="Dismiss message" onClick={()=>setNotice("")}>×</button></div>}
  {applyProgress&&<div className={`oc-apply-progress ${applyProgress.stage}`} role="status"><span className="oc-progress-icon">{applyProgress.stage==="complete"?<CheckCircle2 size={22}/>:applyProgress.stage==="failed"?<AlertCircle size={22}/>:<LoaderCircle size={22} className="oc-spin"/>}</span><div className="oc-progress-copy"><b>{applyProgress.stage==="applying"?"Applying your reviewed plan":applyProgress.stage==="refreshing"?"Checking Google Cloud resource":applyProgress.stage==="complete"?"All done":"Apply needs attention"}</b><span>{applyProgress.stage==="applying"?`Terraform is updating ${applyProgress.resource} in Google Cloud.`:applyProgress.stage==="refreshing"?"Refreshing the project deployment status.":applyProgress.stage==="complete"?"Resource status is up to date.":"The action did not finish. Check its status before retrying."}</span><div className="oc-progress-track"><i/></div><div className="oc-progress-steps"><span className={applyProgress.stage!=="applying"&&applyProgress.stage!=="failed"?"done":"active"}>Plan applied</span><span className={applyProgress.stage==="refreshing"?"active":applyProgress.stage==="complete"?"done":""}>Cloud checked</span><span className={applyProgress.stage==="complete"?"done":""}>Status ready</span></div></div></div>}
  <ReviewDialog review={review} onCancel={()=>setReview(null)} onConfirm={confirmApply} busy={busy}/>
  {!data.deployments.length?<div className="oc-empty"><b>No Google Cloud VM deployments</b><span>Create a Terraform plan to review the first VM.</span></div>:<div className="oc-deployments">{data.deployments.map(deployment=>{
   const operation=pendingFor(deployment.id),outputs=deployment.outputs;
   return <article key={deployment.id}>
    <div><strong>{deployment.display_name}</strong><span>{deployment.instance_name} · {deployment.zone} · {deployment.machine_type} · {deployment.status}</span>{outputs?.internalIp&&<span>Internal IP: {outputs.internalIp}</span>}</div>
    {operation&&<div className="oc-review-plan"><b>Plan ready · {operation.action}</b>{(operation.plan_summary?.resourceChanges||[]).map(change=><code key={change.address}>{change.address}: {change.actions.join(", ")}</code>)}<button className="primary" disabled={busy} onClick={()=>apply(operation,deployment)}>Apply reviewed plan</button></div>}
    {["planned","failed"].includes(deployment.status)&&!operation&&<button className="oc-copy" disabled={busy} onClick={()=>requestPlan("create",deployment)}>Refresh plan</button>}
    {["active","attention"].includes(deployment.status)&&<><button className="oc-copy" disabled={busy} onClick={()=>requestPlan("destroy",deployment)}>Plan VM deletion</button>{deployment.status==="attention"&&<button className="oc-copy" disabled={busy} onClick={()=>requestPlan("create",deployment)}>Create recovery plan</button>}</>}
   </article>;
  })}</div>}
  <small className="oc-terraform-footnote">The initial VM uses Debian 12, a 10 GB standard boot disk, Shielded VM protections, and the project's default VPC. No ingress firewall rule or external IP is created by this workflow.</small>
 </section>;
}
