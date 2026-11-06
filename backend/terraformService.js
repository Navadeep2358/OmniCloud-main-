import {spawn} from "node:child_process";
import {mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {randomBytes,randomUUID} from "node:crypto";

const root=resolve(process.env.TERRAFORM_STATE_DIR||join(process.cwd(),".terraform-state","aws"));
const pluginCache=resolve(process.env.TERRAFORM_PLUGIN_CACHE_DIR||join(root,".plugin-cache"));
const templates=[
 {id:"private_s3_bucket",name:"Private S3 bucket",service:"Amazon S3",description:"Private bucket with public access blocked, encryption enabled, and bucket-owner enforced ownership."},
 {id:"ec2_instance",name:"EC2 instance",service:"Amazon EC2",description:"Linux instance in an existing subnet and security group, without a public IP."},
 {id:"rds_mysql_instance",name:"RDS MySQL database",service:"Amazon RDS",description:"Single-AZ encrypted MySQL micro instance with private networking and managed credentials."},
 {id:"dynamodb_table",name:"DynamoDB table",service:"Amazon DynamoDB",description:"Encrypted table using low provisioned capacity, with no indexes or point-in-time recovery."},
];
const safeSegment=value=>{const text=String(value??"");if(!/^[a-f0-9-]{1,80}$/i.test(text))throw new Error("Invalid Terraform state scope.");return text};
export const newDeploymentId=()=>randomUUID();
export const newOperationId=()=>randomUUID();
export const planExpiry=()=>Date.now()+15*60*1000;
export const newBucketName=account=>`omnicloud-${String(account).replace(/\D/g,"")}-${randomBytes(5).toString("hex")}`.slice(0,63);
export const getTerraformCatalog=()=>templates;

export function validateAwsDeployment({templateId,displayName,region,config={}}){
 if(typeof displayName!=="string"||displayName.trim().length<2||displayName.trim().length>64||/[\u0000-\u001f\u007f]/.test(displayName))throw new Error("Use a resource name between 2 and 64 characters.");
 if(typeof region!=="string"||!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region))throw new Error("Enter a valid AWS region.");
 if(templateId==="private_s3_bucket")return {displayName:displayName.trim(),region,config:{}};
 if(templateId==="dynamodb_table"){
  if(!config||typeof config!=="object"||Array.isArray(config))throw new Error("Enter valid DynamoDB configuration.");
  const partitionKey=String(config.partitionKey||"id");if(!/^[A-Za-z0-9_.-]{1,255}$/.test(partitionKey))throw new Error("Use a valid DynamoDB partition key name.");
  const readCapacity=Number(config.readCapacity??5),writeCapacity=Number(config.writeCapacity??5);
  if(readCapacity!==5||writeCapacity!==5)throw new Error("OmniCloud low-cost mode fixes DynamoDB capacity at 5 read and 5 write units.");
  return {displayName:displayName.trim(),region,config:{partitionKey,readCapacity,writeCapacity}};
 }
 if(templateId==="rds_mysql_instance"){
  if(!config||typeof config!=="object"||Array.isArray(config))throw new Error("Enter valid RDS configuration.");
  const subnetIds=[...new Set(config.subnetIds||[])],securityGroupId=config.securityGroupId;
  if(subnetIds.length<2||subnetIds.some(id=>typeof id!=="string"||!/^subnet-[a-f0-9]{8,17}$/i.test(id)))throw new Error("Choose at least two valid subnets in different Availability Zones for the RDS subnet group.");
  if(typeof securityGroupId!=="string"||!/^sg-[a-f0-9]{8,17}$/i.test(securityGroupId))throw new Error("Choose a valid existing security group.");
  const allocatedStorageGiB=Number(config.allocatedStorageGiB??20);if(allocatedStorageGiB!==20)throw new Error("OmniCloud low-cost RDS mode fixes encrypted storage at 20 GiB.");
  return {displayName:displayName.trim(),region,config:{subnetIds,securityGroupId,instanceClass:"db.t3.micro",allocatedStorageGiB}};
 }
 if(templateId!=="ec2_instance")throw new Error("Choose S3, EC2, RDS, or DynamoDB.");
 if(!config||typeof config!=="object"||Array.isArray(config))throw new Error("Enter valid EC2 configuration.");
 const {amiId="",subnetId,securityGroupId,instanceType="t3.micro",rootVolumeGiB=10,keyName=""}=config;
 if(amiId&& (typeof amiId!=="string"||!/^ami-[a-f0-9]{8,17}$/i.test(amiId)))throw new Error("Choose a valid image available in the selected region.");
 if(typeof subnetId!=="string"||!/^subnet-[a-f0-9]{8,17}$/i.test(subnetId))throw new Error("Enter a valid existing subnet ID.");
 if(typeof securityGroupId!=="string"||!/^sg-[a-f0-9]{8,17}$/i.test(securityGroupId))throw new Error("Enter a valid existing security group ID.");
 if(instanceType!=="t3.micro")throw new Error("OmniCloud free-tier mode only allows the t3.micro instance type.");
 const disk=Number(rootVolumeGiB);if(!Number.isInteger(disk)||disk<8||disk>30)throw new Error("Free-tier mode limits the root disk to 8–30 GiB.");
 if(keyName&&(!/^[A-Za-z0-9._-]{1,128}$/.test(keyName)))throw new Error("Key pair name contains unsupported characters.");
 return {displayName:displayName.trim(),region,config:{amiId,subnetId,securityGroupId,instanceType,rootVolumeGiB:disk,keyName}};
}

export function buildAwsTerraformConfig(deployment,action){
 const id=deployment.id;
 if(action==="destroy")return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}}};
 const tags={Name:deployment.display_name,ManagedBy:"OmniCloud",OmniCloudDeploymentId:id};
 if(deployment.template_id==="private_s3_bucket")return {
  terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},
  resource:{aws_s3_bucket:{managed:{bucket:deployment.bucket_name,force_destroy:false,tags}},
   aws_s3_bucket_public_access_block:{managed:{bucket:"${aws_s3_bucket.managed.id}",block_public_acls:true,block_public_policy:true,ignore_public_acls:true,restrict_public_buckets:true}},
   aws_s3_bucket_server_side_encryption_configuration:{managed:{bucket:"${aws_s3_bucket.managed.id}",rule:[{apply_server_side_encryption_by_default:{sse_algorithm:"AES256"}}]}},
   aws_s3_bucket_ownership_controls:{managed:{bucket:"${aws_s3_bucket.managed.id}",rule:[{object_ownership:"BucketOwnerEnforced"}]}}},
  output:{bucket_name:{value:"${aws_s3_bucket.managed.id}"},bucket_arn:{value:"${aws_s3_bucket.managed.arn}"},region:{value:deployment.region}}};
 if(deployment.template_id==="dynamodb_table"){
  const c=deployment.config;
  return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},resource:{aws_dynamodb_table:{managed:{name:deployment.bucket_name,billing_mode:"PROVISIONED",read_capacity:5,write_capacity:5,hash_key:c.partitionKey,attribute:[{name:c.partitionKey,type:"S"}],server_side_encryption:[{enabled:true}],point_in_time_recovery:[{enabled:false}],deletion_protection_enabled:false,tags}}},output:{table_name:{value:"${aws_dynamodb_table.managed.name}"},table_arn:{value:"${aws_dynamodb_table.managed.arn}"},region:{value:deployment.region}}};
 }
 if(deployment.template_id==="rds_mysql_instance"){
  const c=deployment.config;
  return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},resource:{aws_db_subnet_group:{managed:{name:deployment.bucket_name+"-subnets",subnet_ids:c.subnetIds,description:"Private OmniCloud RDS subnet group",tags}},aws_db_instance:{managed:{identifier:deployment.bucket_name,engine:"mysql",instance_class:"db.t3.micro",allocated_storage:20,storage_type:"gp3",storage_encrypted:true,db_name:"omnicloud",username:"omnicloudadmin",manage_master_user_password:true,db_subnet_group_name:"${aws_db_subnet_group.managed.name}",vpc_security_group_ids:[c.securityGroupId],publicly_accessible:false,multi_az:false,backup_retention_period:0,skip_final_snapshot:true,deletion_protection:false,auto_minor_version_upgrade:true,apply_immediately:true,tags}}},output:{db_identifier:{value:"${aws_db_instance.managed.identifier}"},db_endpoint:{value:"${aws_db_instance.managed.address}"},db_port:{value:"${aws_db_instance.managed.port}"},master_secret_arn:{value:"${aws_db_instance.managed.master_user_secret[0].secret_arn}"},region:{value:deployment.region}}};
 }
 const c=deployment.config;
 const instance={ami:c.amiId,instance_type:c.instanceType,subnet_id:c.subnetId,vpc_security_group_ids:[c.securityGroupId],associate_public_ip_address:false, ...(c.keyName?{key_name:c.keyName}:{}),
  metadata_options:[{http_endpoint:"enabled",http_tokens:"required",http_put_response_hop_limit:1}],root_block_device:[{volume_type:"gp3",volume_size:c.rootVolumeGiB,encrypted:true,delete_on_termination:true}],tags};
 return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},resource:{aws_instance:{managed:instance}},output:{instance_id:{value:"${aws_instance.managed.id}"},private_ip:{value:"${aws_instance.managed.private_ip}"},instance_type:{value:"${aws_instance.managed.instance_type}"},availability_zone:{value:"${aws_instance.managed.availability_zone}"}}};
}
function stateDir(userId,connectionId,deploymentId){return join(root,safeSegment(userId),safeSegment(connectionId),safeSegment(deploymentId))}
function terraform(command,args,{cwd,credentials,region,timeoutMs=10*60*1000}={}){
 const selectedRegion=region||"us-east-1";
 const env={...process.env,TF_IN_AUTOMATION:"1",TF_PLUGIN_CACHE_DIR:pluginCache,AWS_ACCESS_KEY_ID:credentials?.accessKeyId||"",AWS_SECRET_ACCESS_KEY:credentials?.secretAccessKey||"",AWS_SESSION_TOKEN:credentials?.sessionToken||"",AWS_DEFAULT_REGION:selectedRegion,AWS_REGION:selectedRegion};
 delete env.AWS_PROFILE;delete env.AWS_DEFAULT_PROFILE;delete env.AWS_SHARED_CREDENTIALS_FILE;delete env.AWS_CONFIG_FILE;delete env.AWS_WEB_IDENTITY_TOKEN_FILE;delete env.AWS_ROLE_ARN;delete env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
 const bin=process.env.TERRAFORM_BIN||"terraform";
 return new Promise((resolvePromise,reject)=>{const child=spawn(bin,[command,...args],{cwd,env,windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="",settled=false;const timer=setTimeout(()=>{if(process.platform==="win32"&&child.pid){const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.on("error",()=>child.kill())}else child.kill("SIGTERM");if(!settled){settled=true;reject(new Error(`Terraform ${command} timed out after ${Math.round(timeoutMs/60000)} minutes. Check available disk space, Terraform provider network access, and AWS permissions before retrying.`))}},timeoutMs);child.stdout.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-2_000_000)});child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-200_000)});child.on("error",error=>{clearTimeout(timer);if(!settled){settled=true;reject(new Error(error.code==="ENOENT"?"Terraform CLI was not found. Install Terraform and add it to PATH.":"Terraform could not start."))}});child.on("close",code=>{clearTimeout(timer);if(settled)return;settled=true;if(code!==0){const safe=stderr.split(/\r?\n/).filter(line=>/Error:|error:|AccessDenied|UnauthorizedOperation|Invalid[A-Za-z]+|already exists|BucketNotEmpty|does not exist|not found|timed out|ENOSPC|no space left/i.test(line)).slice(-5).join(" ").replace(/\s+/g," ").slice(0,600);reject(new Error(safe||`Terraform ${command} failed (exit ${code}).`));return}resolvePromise(stdout)})});
}
async function run({deployment,userId,connectionId,operationId,action,credentials}){
 const cwd=stateDir(userId,connectionId,deployment.id);await mkdir(cwd,{recursive:true,mode:0o700});await mkdir(pluginCache,{recursive:true,mode:0o700});
 const config=buildAwsTerraformConfig(deployment,action);await writeFile(join(cwd,"main.tf.json"),JSON.stringify(config,null,2),{mode:0o600});
 const path=join(cwd,`${safeSegment(operationId)}.tfplan`);
 try{
  await terraform("init",["-input=false","-no-color"],{cwd,credentials,region:deployment.region});
  await terraform("plan",["-input=false","-no-color","-out",path,...(action==="destroy"?["-destroy"]:[])],{cwd,credentials,region:deployment.region});
  const raw=await terraform("show",["-json",path],{cwd,credentials,region:deployment.region});let parsed;try{parsed=JSON.parse(raw)}catch{throw new Error("Terraform returned an unreadable plan.")}
  const resourceChanges=(parsed.resource_changes||[]).map(item=>({address:item.address,actions:item.change?.actions||[]}));
  return {summary:{resourceChanges,hasChanges:resourceChanges.some(item=>item.actions.some(a=>a!=="no-op")),resourceCount:resourceChanges.length},planPath:path};
 }catch(error){await rm(path,{force:true}).catch(()=>{});throw error}
}
export async function runPlan(args){return run(args)}
export async function applyPlan({operationId,userId,connectionId,deploymentId,credentials,region,action}){const cwd=stateDir(userId,connectionId,deploymentId),path=join(cwd,`${safeSegment(operationId)}.tfplan`);await terraform("apply",["-input=false","-no-color","-auto-approve",path],{cwd,credentials,region});if(action==="destroy")return {};const raw=await terraform("output",["-json"],{cwd,credentials,region});try{return Object.fromEntries(Object.entries(JSON.parse(raw)).map(([key,value])=>[key,value.value]))}catch{return {}}}
export async function removePlanFile(userId,connectionId,deploymentId,operationId){const path=join(stateDir(userId,connectionId,deploymentId),`${safeSegment(operationId)}.tfplan`);await rm(path,{force:true})}
export async function readOutputs(userId,connectionId,deploymentId){const cwd=stateDir(userId,connectionId,deploymentId);try{const outputs=JSON.parse(await readFile(join(cwd,"terraform.tfstate"),"utf8")).outputs||{};return Object.fromEntries(Object.entries(outputs).map(([key,item])=>[key,item&&typeof item==="object"&&"value" in item?item.value:item]))}catch{return {}}}
export async function removeDeploymentState(userId,connectionId,deploymentId){await rm(stateDir(userId,connectionId,deploymentId),{recursive:true,force:true})}
