import { useEffect, useState } from "react";
import { Cloud, Boxes, Rocket, Activity, Settings, LogOut, Moon, Sun, UserRound, Cable, BookOpen } from "lucide-react";
import Dashboard from "./dashboard/Dashboard";
import CloudConnections from "./dashboard/CloudConnections";
import CloudServices from "./dashboard/CloudServices";
import Deployments from "./dashboard/Deployments";
import Monitoring from "./dashboard/Monitoring";
import Guide from "./dashboard/Guide";
import SettingsPage from "./dashboard/SettingsPage";
import "./dashboard/style.css";
import "./dashboard/workspace-layout.css";
const nav = [["Dashboard",Cloud],["Cloud connections",Cable],["Cloud services",Boxes],["Deployments",Rocket],["Monitoring",Activity],["Guide",BookOpen],["Settings",Settings]];
export default function WorkspacePage() {
 const [user,setUser]=useState(null), [page,setPage]=useState(()=>new URLSearchParams(window.location.search).has("awsSsoLogin")?"Cloud connections":"Dashboard"), [theme,setTheme]=useState(localStorage.getItem("omnicloud-theme")||"light");
 const navigate=target=>{const match=nav.find(([label])=>label.toLowerCase()===String(target).trim().toLowerCase());setPage(match?.[0]||"Dashboard")};
 useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem("omnicloud-theme",theme)},[theme]);
 useEffect(()=>{fetch("/api/auth/me",{credentials:"same-origin"}).then(r=>r.ok?r.json():Promise.reject()).then(d=>setUser(d.user)).catch(()=>location.replace("/"))},[]);
 if(!user)return <main className="oc-loading">Loading workspace…</main>;
 return <div className="oc-shell"><aside className="oc-sidebar"><a className="oc-brand" href="/workspace" aria-label="OmniCloud dashboard"><span className="oc-brand-icon"><Cloud size={24}/></span><span className="oc-brand-name">Omni<span>Cloud</span></span></a><small>WORKSPACE</small>{nav.map(([n,I])=><button className={page===n?"active":""} onClick={()=>navigate(n)} key={n}><I size={17}/>{n}</button>)}<button className="oc-signout" onClick={async()=>{await fetch("/api/auth/logout",{method:"POST"});location.assign("/")}}><LogOut size={17}/>Sign out</button></aside><main className="oc-main"><header className="oc-topbar"><span>Workspace / <b>{page}</b></span><div><button onClick={()=>setTheme(theme==="light"?"dark":"light")}>{theme==="light"?<Moon size={16}/>:<Sun size={16}/>} Theme</button><span className="oc-user-chip"><UserRound size={17}/>{user.name}</span></div></header><section className="oc-content">{page==="Dashboard"?<Dashboard user={user} navigate={navigate}/>:page==="Cloud connections"?<CloudConnections/>:page==="Cloud services"?<CloudServices navigate={navigate}/>:page==="Deployments"?<Deployments navigate={navigate}/>:page==="Monitoring"?<Monitoring/>:page==="Guide"?<Guide navigate={navigate}/>:page==="Settings"?<SettingsPage user={user} updateUser={setUser} theme={theme} setTheme={setTheme}/>:<Dashboard user={user} navigate={navigate}/>}</section></main></div>;
}
