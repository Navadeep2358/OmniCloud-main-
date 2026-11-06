import {useEffect,useState} from "react";
import {Check,Copy,ShieldCheck,Unplug} from "lucide-react";

const API="/api/cloud-connections/gcp/";

export default function GcpConnection({onChange=()=>{}}){
 const [connections,setConnections]=useState([]),[setup,setSetup]=useState(null),[projectId,setProjectId]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[copied,setCopied]=useState(false);
 async function load(){
  const response=await fetch("/api/cloud-connections",{credentials:"same-origin"});
  const body=await response.json();
  if(!response.ok)throw Error(body.message||"Could not load cloud connections.");
  const gcp=(body.connections||[]).filter(connection=>connection.provider==="gcp");
  setConnections(gcp);
  const pending=gcp.find(connection=>connection.status==="setup");
  if(pending){
   const instructionsResponse=await fetch(`${API}setup/${encodeURIComponent(pending.id)}/instructions`,{credentials:"same-origin"});
   const instructionBody=await instructionsResponse.json();
   if(!instructionsResponse.ok)throw Error(instructionBody.message||"Could not load setup instructions.");
   setSetup(instructionBody.setup);
  }else setSetup(null);
 }
 useEffect(()=>{let alive=true;fetch("/api/cloud-connections",{credentials:"same-origin"}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.message);if(!alive)return;const gcp=(body.connections||[]).filter(connection=>connection.provider==="gcp");setConnections(gcp);const pending=gcp.find(connection=>connection.status==="setup");if(pending){const r=await fetch(`${API}setup/${encodeURIComponent(pending.id)}/instructions`,{credentials:"same-origin"}),d=await r.json();if(!r.ok)throw Error(d.message);if(alive)setSetup(d.setup)}}).catch(error=>{if(alive)setMessage(error.message)});return()=>{alive=false}},[]);
 async function start(event){event.preventDefault();setBusy(true);setMessage("");try{const response=await fetch(`${API}setup`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:projectId.trim()})}),body=await response.json();if(!response.ok)throw Error(body.message);setSetup(body.setup);await load()}catch(error){setMessage(error.message)}finally{setBusy(false)}}
 async function verify(){if(!setup)return;setBusy(true);setMessage("");try{const response=await fetch(`${API}setup/${encodeURIComponent(setup.id)}/verify`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"}),body=await response.json();if(!response.ok)throw Error(body.message);setSetup(null);setProjectId("");setMessage(`Google Cloud project ${body.connection.project_id} connected and access verified.`);await load()}catch(error){setMessage(error.message)}finally{setBusy(false)}}
 async function disconnect(connection){if(!window.confirm("Disconnect this Google Cloud project from OmniCloud? This disconnects app access only. Remove OmniCloud's service-account access in Google Cloud IAM as well to revoke its cloud-side permission."))return;setBusy(true);setMessage("");try{const response=await fetch(`/api/cloud-connections/${encodeURIComponent(connection.id)}/disconnect`,{method:"POST",credentials:"same-origin"}),body=await response.json();if(!response.ok)throw Error(body.message);setMessage(body.message);await load();onChange()}catch(error){setMessage(error.message)}finally{setBusy(false)}}
 async function copyInstructions(){try{await navigator.clipboard.writeText(setup.instructions);setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{setMessage("Clipboard access is unavailable. Select and copy the setup commands manually.")}}
 const connected=connections.filter(connection=>connection.status==="connected");
 return <section className="oc-card oc-gcp-card">
  <div className="oc-cloud-title"><img src="/google%20cloud%20logo.png" alt="Google Cloud logo"/><div><h2>Google Cloud Platform</h2><p>Connect with short-lived service-account impersonation. OmniCloud never asks for a service-account key.</p></div>{!setup&&!connected.length&&<span className="oc-status disconnected">Not connected</span>}</div>
  {message&&<div className="oc-message" role="status">{message}</div>}
  {!setup&&<form className="oc-gcp-form" onSubmit={start}><label>Google Cloud project ID<input required minLength={6} maxLength={30} pattern="[a-z][a-z0-9-]{4,28}[a-z0-9]" value={projectId} onChange={event=>setProjectId(event.target.value)} placeholder="my-cloud-project-123"/><small>Enter the project you want to connect. Compute Engine setup is separate and optional.</small></label><button className="primary" disabled={busy}>{busy?"Preparing setup…":"Start Google Cloud setup"}</button></form>}
  {setup&&<div className="oc-gcp-setup"><span className="oc-status pending">Setup in progress</span><h3>1. Grant OmniCloud delegated access</h3><p>Open Google Cloud Shell in project <b>{setup.projectId}</b> and run these commands. They create a per-connection service account, grant project read access for verification, and let OmniCloud impersonate that service account. Service permissions are configured separately under Cloud services.</p><div className="oc-setup-value"><b>Customer service account</b><code>{setup.serviceAccountEmail}</code></div><pre>{setup.instructions}</pre><button type="button" className="oc-copy" onClick={copyInstructions}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?"Copied":"Copy setup commands"}</button><h3>2. Verify the connection</h3><p>OmniCloud mints a short-lived token, then checks that the service account can read this project. No token or key is stored.</p><button type="button" className="primary" disabled={busy} onClick={verify}>{busy?"Verifying Google Cloud access…":"Verify and connect"}</button></div>}
  {connected.map(connection=><div className="oc-gcp-connected" key={connection.id}><div className="oc-connection-row"><b><ShieldCheck size={16}/> Connected</b><span className="oc-status connected">Connected</span><button type="button" className="oc-copy danger" disabled={busy} onClick={()=>disconnect(connection)}><Unplug size={15}/>Disconnect</button></div><span>Google Cloud project {connection.project_id} · {connection.service_account_email}</span></div>)}
  {connections.filter(connection=>connection.status==="disconnected").map(connection=><div className="oc-connection-summary" key={connection.id}><div className="oc-connection-row"><b>Disconnected</b><span className="oc-status disconnected">Disconnected</span></div><span>Google Cloud project {connection.project_id}</span></div>)}
 </section>;
}
