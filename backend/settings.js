const defaults={preferences:{theme:"light",timezone:"UTC",language:"English"},notifications:{deployments:true,security:true,costAlerts:true,productUpdates:false},cloudPreferences:{defaultProvider:"none",defaultRegion:""}};
const json=(x,f)=>{try{return typeof x==="string"?JSON.parse(x):x}catch{return f}};
export function registerSettingsRoutes(app,{pool,requireUser}){
 app.get("/api/settings",requireUser,async(req,res,next)=>{try{
 const [[rows]]=[await pool.execute("SELECT name,mobile_number FROM users WHERE id=?",[req.user.id])];
 const [saved]=await pool.execute("SELECT preferences,notifications,cloud_preferences FROM user_settings WHERE user_id=?",[req.user.id]);
 const row=saved[0]||{};
 res.json({settings:{profile:{name:rows[0].name,mobileNumber:rows[0].mobile_number,email:req.user.email},preferences:{...defaults.preferences,...json(row.preferences,{})},notifications:{...defaults.notifications,...json(row.notifications,{})},cloudPreferences:{...defaults.cloudPreferences,...json(row.cloud_preferences,{})}}});
 }catch(e){next(e)}});
 app.put("/api/settings",requireUser,async(req,res,next)=>{try{
 const b=req.body||{},p=b.profile||{},prefs=b.preferences||{},notes=b.notifications||{},cloud=b.cloudPreferences||{};
 if(Object.hasOwn(b,"email")||Object.hasOwn(p,"email"))return res.status(400).json({message:"Email address cannot be changed."});
 const name=typeof p.name==="string"?p.name.trim():"",mobile=typeof p.mobileNumber==="string"?p.mobileNumber.trim().replace(/[\s().-]/g,""):"";
 if(name.length<2||name.length>120||/[\u0000-\u001f]/.test(name))return res.status(400).json({message:"Enter a valid name."});
 if(!/^\+?[1-9]\d{6,14}$/.test(mobile))return res.status(400).json({message:"Enter a valid mobile number with country code."});
 const theme=prefs.theme||"light",timezone=prefs.timezone||"UTC",language=prefs.language||"English",provider=cloud.defaultProvider||"none",region=cloud.defaultRegion||"";
 if(!["light","dark"].includes(theme)||typeof timezone!=="string"||timezone.length>80||language!=="English"||!["none","aws","azure","gcp"].includes(provider)||typeof region!=="string"||region.length>80)return res.status(400).json({message:"One or more settings are invalid."});
 for(const k of ["deployments","security","costAlerts","productUpdates"])if(typeof notes[k]!=="boolean")return res.status(400).json({message:"Notification preferences are invalid."});
 await pool.execute("UPDATE users SET name=?,mobile_number=? WHERE id=?",[name,mobile,req.user.id]);
 await pool.execute("INSERT INTO user_settings(user_id,preferences,notifications,cloud_preferences,updated_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE preferences=VALUES(preferences),notifications=VALUES(notifications),cloud_preferences=VALUES(cloud_preferences),updated_at=VALUES(updated_at)",[req.user.id,JSON.stringify({theme,timezone,language}),JSON.stringify(notes),JSON.stringify({defaultProvider:provider,defaultRegion:region}),Date.now()]);
 res.json({settings:{profile:{name,mobileNumber:mobile,email:req.user.email},preferences:{theme,timezone,language},notifications:notes,cloudPreferences:{defaultProvider:provider,defaultRegion:region}}});
 }catch(e){if(e.code==="ER_DUP_ENTRY")return res.status(409).json({message:"That mobile number is already registered."});next(e)}});
}