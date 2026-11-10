import {useEffect,useState} from "react";
import {ShieldCheck} from "lucide-react";
import AwsTerraformManager from "./AwsTerraformManager.jsx";
import {SimulatedCloud} from "./SimulatedCloud.jsx";

export default function Resources(){
 const [connections,setConnections]=useState([]),[message,setMessage]=useState("");
 const load=()=>fetch("/api/cloud-connections",{credentials:"same-origin"}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.message||"Could not load connected cloud accounts.");setConnections(body.connections||[])}).catch(error=>setMessage(error.message));
 useEffect(()=>{let alive=true;fetch("/api/cloud-connections",{credentials:"same-origin"}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.message||"Could not load connected cloud accounts.");if(alive)setConnections(body.connections||[])}).catch(error=>{if(alive)setMessage(error.message)});return()=>{alive=false}},[]);
 const aws=connections.filter(connection=>connection.provider==="aws"&&connection.status==="connected");
 return <div className="oc-page"><div className="oc-heading"><div><small>CLOUD RESOURCES</small><h1>Connected resources</h1><p>Manage resources across your connected cloud providers.</p></div></div>{message&&<div className="oc-message error" role="alert">{message}</div>}
  {!aws.length?<section className="oc-card"><div className="oc-empty"><b>No AWS account connection</b><span>Open Cloud connections to sign in with AWS IAM Identity Center.</span></div></section>:aws.map(connection=><section className="oc-card" key={connection.id}><div className="oc-cloud-title"><img src="/aws%20logo.png" alt="AWS logo"/><div><h2>Amazon Web Services</h2><p><ShieldCheck size={15}/> Connected account {connection.account_id} · IAM Identity Center</p></div></div><AwsTerraformManager connection={connection}/></section>)}
  <SimulatedCloud provider="gcp" connections={connections} onChange={load}/><SimulatedCloud provider="azure" connections={connections} onChange={load}/>
 </div>;
}
