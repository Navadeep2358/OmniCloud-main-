import {spawn} from "node:child_process";
import {mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {randomBytes,randomUUID} from "node:crypto";

const root=resolve(process.env.TERRAFORM_STATE_DIR||join(process.cwd(),".terraform-state","aws"));
const pluginCache=resolve(process.env.TERRAFORM_PLUGIN_CACHE_DIR||join(root,".plugin-cache"));
export function createTerraformInitQueue(){let queue=Promise.resolve();return initialize=>{const current=queue.then(initialize,initialize);queue=current.catch(()=>{});return current}}
const withTerraformInitLock=createTerraformInitQueue();
const templates=[
 {id:"private_s3_bucket",name:"Private S3 bucket",service:"Amazon S3",description:"Private bucket with public access blocked, encryption enabled, and bucket-owner enforced ownership."},
 {id:"ec2_instance",name:"EC2 instance",service:"Amazon EC2",description:"Linux instance in an existing subnet and security group, without a public IP."},
 {id:"rds_mysql_instance",name:"RDS MySQL database",service:"Amazon RDS",description:"Single-AZ encrypted MySQL micro instance with private networking and managed credentials."},
 {id:"dynamodb_table",name:"DynamoDB table",service:"Amazon DynamoDB",description:"Encrypted table using low provisioned capacity, with no indexes or point-in-time recovery."},
 {id:"lambda_function",name:"Lambda function",service:"AWS Lambda",description:"Node.js 22 function with a managed execution role and CloudWatch logging."},
 {id:"ebs_volume",name:"EBS volume",service:"Amazon EBS",description:"Encrypted gp3 block volume in a selected Availability Zone."},
 {id:"efs_file_system",name:"EFS file system",service:"Amazon EFS",description:"Encrypted file system with a secure NFS mount target."},
 {id:"vpc_network",name:"Private VPC",service:"Amazon VPC",description:"Isolated VPC and private subnet without internet routing."},
 {id:"application_load_balancer",name:"Application Load Balancer",service:"Elastic Load Balancing",description:"Internal load balancer with a working HTTP health response."},
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
 if(!config||typeof config!=="object"||Array.isArray(config))throw new Error("Enter valid AWS service configuration.");
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
 if(templateId==="lambda_function")return {displayName:displayName.trim(),region,config:{}};
 if(templateId==="ebs_volume"){const availabilityZone=String(config.availabilityZone||"");if(!/^[a-z]{2}(?:-gov)?-[a-z]+-\d[a-z]$/.test(availabilityZone)||!availabilityZone.startsWith(region))throw new Error("Choose an Availability Zone in the selected AWS region.");const sizeGiB=Number(config.sizeGiB??8);if(!Number.isInteger(sizeGiB)||sizeGiB<1||sizeGiB>64)throw new Error("EBS volumes must be between 1 and 64 GiB.");return {displayName:displayName.trim(),region,config:{availabilityZone,sizeGiB}};}
 if(templateId==="efs_file_system"){const subnetId=config.subnetId,clientSecurityGroupId=config.clientSecurityGroupId||config.securityGroupId;if(typeof subnetId!=="string"||!/^subnet-[a-f0-9]{8,17}$/i.test(subnetId)||typeof clientSecurityGroupId!=="string"||!/^sg-[a-f0-9]{8,17}$/i.test(clientSecurityGroupId))throw new Error("Choose a valid subnet and client security group for EFS NFS access.");return {displayName:displayName.trim(),region,config:{subnetId,clientSecurityGroupId}};}
 if(templateId==="vpc_network"){const cidr=String(config.cidr||"10.40.0.0/16");if(!/^10\.(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])\.0\.0\/16$/.test(cidr))throw new Error("Choose a private 10.x.0.0/16 network range.");return {displayName:displayName.trim(),region,config:{cidr}};}
 if(templateId==="application_load_balancer"){const subnetIds=[...new Set(config.subnetIds||[])],clientSecurityGroupId=config.clientSecurityGroupId||config.securityGroupId;if(subnetIds.length<2||subnetIds.some(id=>typeof id!=="string"||!/^subnet-[a-f0-9]{8,17}$/i.test(id)))throw new Error("Choose two valid subnets in different Availability Zones.");if(typeof clientSecurityGroupId!=="string"||!/^sg-[a-f0-9]{8,17}$/i.test(clientSecurityGroupId))throw new Error("Choose a valid client security group for HTTP access.");return {displayName:displayName.trim(),region,config:{subnetIds,clientSecurityGroupId,scheme:"internal"}};}
 if(templateId!=="ec2_instance")throw new Error("Choose S3, EC2, RDS, DynamoDB, Lambda, EBS, EFS, VPC, or Elastic Load Balancing.");
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

export function buildAwsTerraformConfig(deployment,action,{workDir}={}){
 const id=deployment.id;
 if(action==="destroy")return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}}};
 const tags={Name:deployment.display_name,ManagedBy:"OmniCloud",OmniCloudDeploymentId:id,...((deployment.owner_user_id??deployment.user_id)!=null?{OmniCloudUserId:String(deployment.owner_user_id??deployment.user_id)}:{})};
 const aws={aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}},base={terraform:{required_providers:aws},provider:{aws:{region:deployment.region}}},c=deployment.config||{};
 if(deployment.template_id==="private_s3_bucket")return {
  terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},
  resource:{aws_s3_bucket:{managed:{bucket:deployment.bucket_name,force_destroy:false,tags}},
   aws_s3_bucket_public_access_block:{managed:{bucket:"${aws_s3_bucket.managed.id}",block_public_acls:true,block_public_policy:true,ignore_public_acls:true,restrict_public_buckets:true}},
   aws_s3_bucket_server_side_encryption_configuration:{managed:{bucket:"${aws_s3_bucket.managed.id}",rule:[{apply_server_side_encryption_by_default:{sse_algorithm:"AES256"}}]}},
   aws_s3_bucket_ownership_controls:{managed:{bucket:"${aws_s3_bucket.managed.id}",rule:[{object_ownership:"BucketOwnerEnforced"}]}}},
  output:{bucket_name:{value:"${aws_s3_bucket.managed.id}"},bucket_arn:{value:"${aws_s3_bucket.managed.arn}"},region:{value:deployment.region}}};
 if(deployment.template_id==="lambda_function")return {...base,terraform:{required_providers:{...aws,archive:{source:"hashicorp/archive",version:">= 2.0, < 3.0"}}},data:{archive_file:{function:{type:"zip",source_file:join(workDir||".","lambda.js"),output_path:join(workDir||".","function.zip")}}},resource:{aws_iam_role:{lambda:{name:deployment.bucket_name+"-role",assume_role_policy:JSON.stringify({Version:"2012-10-17",Statement:[{Action:"sts:AssumeRole",Effect:"Allow",Principal:{Service:"lambda.amazonaws.com"}}]}),tags}},aws_iam_role_policy_attachment:{logs:{role:"${aws_iam_role.lambda.name}",policy_arn:"arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"}},aws_lambda_function:{managed:{function_name:deployment.bucket_name,role:"${aws_iam_role.lambda.arn}",runtime:"nodejs22.x",handler:"lambda.handler",filename:"${data.archive_file.function.output_path}",source_code_hash:"${data.archive_file.function.output_base64sha256}",timeout:5,memory_size:128,tags}}},output:{function_name:{value:"${aws_lambda_function.managed.function_name}"},function_arn:{value:"${aws_lambda_function.managed.arn}"}}};
 if(deployment.template_id==="ebs_volume")return {...base,resource:{aws_ebs_volume:{managed:{availability_zone:c.availabilityZone,size:c.sizeGiB,type:"gp3",encrypted:true,tags}}},output:{volume_id:{value:"${aws_ebs_volume.managed.id}"},availability_zone:{value:"${aws_ebs_volume.managed.availability_zone}"},size_gib:{value:"${aws_ebs_volume.managed.size}"}}};
 if(deployment.template_id==="efs_file_system")return {...base,data:{aws_subnet:{selected:{id:c.subnetId}}},resource:{aws_security_group:{efs:{name:deployment.bucket_name+"-efs",description:"OmniCloud EFS NFS access",vpc_id:"${data.aws_subnet.selected.vpc_id}",ingress:[{description:"NFS from selected client security group",from_port:2049,to_port:2049,protocol:"tcp",cidr_blocks:[],ipv6_cidr_blocks:[],prefix_list_ids:[],security_groups:[c.clientSecurityGroupId||c.securityGroupId],self:false}],egress:[{from_port:0,to_port:0,protocol:"-1",cidr_blocks:["0.0.0.0/0"],ipv6_cidr_blocks:[],prefix_list_ids:[],security_groups:[],self:false}],tags}},aws_efs_file_system:{managed:{creation_token:id,encrypted:true,performance_mode:"generalPurpose",throughput_mode:"bursting",tags}},aws_efs_mount_target:{managed:{file_system_id:"${aws_efs_file_system.managed.id}",subnet_id:c.subnetId,security_groups:["${aws_security_group.efs.id}"]}}},output:{file_system_id:{value:"${aws_efs_file_system.managed.id}"},mount_target_ip:{value:"${aws_efs_mount_target.managed.ip_address}"},mount_target_dns_name:{value:"${aws_efs_mount_target.managed.dns_name}"},mount_target_security_group_id:{value:"${aws_security_group.efs.id}"}}};
 if(deployment.template_id==="vpc_network")return {...base,resource:{aws_vpc:{managed:{cidr_block:c.cidr,enable_dns_support:true,enable_dns_hostnames:true,instance_tenancy:"default",tags}},aws_subnet:{private:{vpc_id:"${aws_vpc.managed.id}",cidr_block:c.cidr.replace(/\.0\.0\/16$/,".1.0/24"),map_public_ip_on_launch:false,tags:{...tags,Name:deployment.display_name+" private subnet"}}}},output:{vpc_id:{value:"${aws_vpc.managed.id}"},subnet_id:{value:"${aws_subnet.private.id}"},cidr_block:{value:"${aws_vpc.managed.cidr_block}"}}};
 if(deployment.template_id==="application_load_balancer"){const lbName=deployment.bucket_name.replace(/_/g,"-").slice(0,32);return {...base,data:{aws_subnet:{selected:{id:c.subnetIds[0]}}},resource:{aws_security_group:{alb:{name:lbName+"-web",description:"OmniCloud internal ALB HTTP access",vpc_id:"${data.aws_subnet.selected.vpc_id}",ingress:[{description:"HTTP from selected client security group",from_port:80,to_port:80,protocol:"tcp",cidr_blocks:[],ipv6_cidr_blocks:[],prefix_list_ids:[],security_groups:[c.clientSecurityGroupId||c.securityGroupId],self:false}],egress:[{from_port:0,to_port:0,protocol:"-1",cidr_blocks:["0.0.0.0/0"],ipv6_cidr_blocks:[],prefix_list_ids:[],security_groups:[],self:false}],tags}},aws_lb:{managed:{name:lbName,internal:true,load_balancer_type:"application",security_groups:["${aws_security_group.alb.id}"],subnets:c.subnetIds,enable_deletion_protection:false,tags}},aws_lb_listener:{http:{load_balancer_arn:"${aws_lb.managed.arn}",port:80,protocol:"HTTP",default_action:[{type:"fixed-response",fixed_response:[{content_type:"text/plain",message_body:"OmniCloud load balancer is running.",status_code:"200"}]}]}}},output:{load_balancer_arn:{value:"${aws_lb.managed.arn}"},dns_name:{value:"${aws_lb.managed.dns_name}"},url:{value:"http://${aws_lb.managed.dns_name}"},security_group_id:{value:"${aws_security_group.alb.id}"}}};}
 if(deployment.template_id==="dynamodb_table"){
  return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},resource:{aws_dynamodb_table:{managed:{name:deployment.bucket_name,billing_mode:"PROVISIONED",read_capacity:5,write_capacity:5,hash_key:c.partitionKey,attribute:[{name:c.partitionKey,type:"S"}],server_side_encryption:[{enabled:true}],point_in_time_recovery:[{enabled:false}],deletion_protection_enabled:false,tags}}},output:{table_name:{value:"${aws_dynamodb_table.managed.name}"},table_arn:{value:"${aws_dynamodb_table.managed.arn}"},region:{value:deployment.region}}};
 }
 if(deployment.template_id==="rds_mysql_instance"){
  const c=deployment.config;
  return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},resource:{aws_db_subnet_group:{managed:{name:deployment.bucket_name+"-subnets",subnet_ids:c.subnetIds,description:"Private OmniCloud RDS subnet group",tags}},aws_db_instance:{managed:{identifier:deployment.bucket_name,engine:"mysql",instance_class:"db.t3.micro",allocated_storage:20,storage_type:"gp3",storage_encrypted:true,db_name:"omnicloud",username:"omnicloudadmin",manage_master_user_password:true,db_subnet_group_name:"${aws_db_subnet_group.managed.name}",vpc_security_group_ids:[c.securityGroupId],publicly_accessible:false,multi_az:false,backup_retention_period:0,skip_final_snapshot:true,deletion_protection:false,auto_minor_version_upgrade:true,apply_immediately:true,tags}}},output:{db_identifier:{value:"${aws_db_instance.managed.identifier}"},db_endpoint:{value:"${aws_db_instance.managed.address}"},db_port:{value:"${aws_db_instance.managed.port}"},master_secret_arn:{value:"${aws_db_instance.managed.master_user_secret[0].secret_arn}"},region:{value:deployment.region}}};
 }
 const instance={ami:c.amiId,instance_type:c.instanceType,subnet_id:c.subnetId,vpc_security_group_ids:[c.securityGroupId],associate_public_ip_address:false, ...(c.keyName?{key_name:c.keyName}:{}),
  metadata_options:[{http_endpoint:"enabled",http_tokens:"required",http_put_response_hop_limit:1}],root_block_device:[{volume_type:"gp3",volume_size:c.rootVolumeGiB,encrypted:true,delete_on_termination:true}],tags};
 return {terraform:{required_providers:{aws:{source:"hashicorp/aws",version:">= 5.0, < 7.0"}}},provider:{aws:{region:deployment.region}},resource:{aws_instance:{managed:instance}},output:{instance_id:{value:"${aws_instance.managed.id}"},private_ip:{value:"${aws_instance.managed.private_ip}"},instance_type:{value:"${aws_instance.managed.instance_type}"},availability_zone:{value:"${aws_instance.managed.availability_zone}"}}};
}
function stateDir(userId,connectionId,deploymentId){return join(root,safeSegment(userId),safeSegment(connectionId),safeSegment(deploymentId))}
function terraform(command,args,{cwd,credentials,region,timeoutMs=10*60*1000,context={}}={}){
 const selectedRegion=region||"us-east-1";
 const env={...process.env,TF_IN_AUTOMATION:"1",TF_PLUGIN_CACHE_DIR:pluginCache,AWS_ACCESS_KEY_ID:credentials?.accessKeyId||"",AWS_SECRET_ACCESS_KEY:credentials?.secretAccessKey||"",AWS_SESSION_TOKEN:credentials?.sessionToken||"",AWS_DEFAULT_REGION:selectedRegion,AWS_REGION:selectedRegion};
 delete env.AWS_PROFILE;delete env.AWS_DEFAULT_PROFILE;delete env.AWS_SHARED_CREDENTIALS_FILE;delete env.AWS_CONFIG_FILE;delete env.AWS_WEB_IDENTITY_TOKEN_FILE;delete env.AWS_ROLE_ARN;delete env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
 const bin=process.env.TERRAFORM_BIN||"terraform";
 const startedAt=Date.now();console.info("Terraform command started",{...context,command});
 return new Promise((resolvePromise,reject)=>{const child=spawn(bin,[command,...args],{cwd,env,windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="",settled=false;const timer=setTimeout(()=>{if(process.platform==="win32"&&child.pid){const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.on("error",()=>child.kill())}else child.kill("SIGTERM");if(!settled){settled=true;const error=new Error(`Terraform ${command} timed out after ${Math.round(timeoutMs/60000)} minutes. Check available disk space, Terraform provider network access, and AWS permissions before retrying.`);console.error("Terraform command failed",{...context,command,durationMs:Date.now()-startedAt,exitCode:null,diagnostic:error.message});reject(error)}},timeoutMs);child.stdout.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-2_000_000)});child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-200_000)});child.on("error",error=>{clearTimeout(timer);if(!settled){settled=true;const message=error.code==="ENOENT"?"Terraform CLI was not found. Install Terraform and add it to PATH.":"Terraform could not start.";console.error("Terraform command failed",{...context,command,durationMs:Date.now()-startedAt,exitCode:null,diagnostic:message});reject(new Error(message))}});child.on("close",code=>{clearTimeout(timer);if(settled)return;settled=true;const durationMs=Date.now()-startedAt;if(code!==0){const diagnosticLines=[...stdout.split(/\r?\n/),...stderr.split(/\r?\n/)].filter(line=>/Error:|error:|Required plugins are not installed|following required plugins|Plugin reinitialization required|inconsistent dependency lock|Failed to (install|query)|Could not retrieve|AccessDenied|UnauthorizedOperation|Invalid[A-Za-z]+|already exists|BucketNotEmpty|does not exist|not found|timed out|timeout|ENOSPC|no space left/i.test(line)).slice(-8);const safe=diagnosticLines.join(" ").replace(/\s+/g," ").slice(0,1000)||`Terraform ${command} failed (exit ${code}).`;console.error("Terraform command failed",{...context,command,durationMs,exitCode:code,diagnostic:safe});const error=new Error(safe);error.terraformCommand=command;error.terraformExitCode=code;reject(error);return}console.info("Terraform command completed",{...context,command,durationMs,exitCode:code});resolvePromise(stdout)})});
}
function initializeTerraform(options){return withTerraformInitLock(()=>terraform("init",["-input=false","-no-color","-reconfigure"],options))}
const hasMissingProviderError=error=>/required plugins are not installed|plugin reinitialization required/i.test(String(error?.message||""));
async function run({deployment,userId,connectionId,operationId,action,credentials}){
 const cwd=stateDir(userId,connectionId,deployment.id),context={deploymentId:deployment.id,operationId,action,templateId:deployment.template_id,region:deployment.region};await mkdir(cwd,{recursive:true,mode:0o700});await mkdir(pluginCache,{recursive:true,mode:0o700});
 if(action!=="destroy"&&deployment.template_id==="lambda_function")await writeFile(join(cwd,"lambda.js"),'exports.handler = async () => ({ statusCode: 200, body: "Hello from OmniCloud Lambda" });\n',{mode:0o600});
 const config=buildAwsTerraformConfig(deployment,action,{workDir:cwd});await writeFile(join(cwd,"main.tf.json"),JSON.stringify(config,null,2),{mode:0o600});
 const path=join(cwd,`${safeSegment(operationId)}.tfplan`);
 try{
  const terraformOptions={cwd,credentials,region:deployment.region,context};await initializeTerraform(terraformOptions);
  const planArgs=["-input=false","-no-color","-out",path,...(action==="destroy"?["-destroy"]:[])];
  try{await terraform("plan",planArgs,terraformOptions)}catch(error){if(!hasMissingProviderError(error))throw error;console.warn("Terraform reported missing provider plugins after initialization; clearing only the generated .terraform directory and retrying initialization once.",{...context});await rm(join(cwd,".terraform"),{recursive:true,force:true});await initializeTerraform(terraformOptions);await terraform("plan",planArgs,terraformOptions)}
  const raw=await terraform("show",["-json",path],terraformOptions);let parsed;try{parsed=JSON.parse(raw)}catch{throw new Error("Terraform returned an unreadable plan.")}
  const resourceChanges=(parsed.resource_changes||[]).map(item=>({address:item.address,actions:item.change?.actions||[]}));
  return {summary:{resourceChanges,hasChanges:resourceChanges.some(item=>item.actions.some(a=>a!=="no-op")),resourceCount:resourceChanges.length},planPath:path};
 }catch(error){await rm(path,{force:true}).catch(()=>{});throw error}
}
export async function runPlan(args){return run(args)}
export async function applyPlan({operationId,userId,connectionId,deploymentId,credentials,region,action}){const cwd=stateDir(userId,connectionId,deploymentId),path=join(cwd,`${safeSegment(operationId)}.tfplan`);await terraform("apply",["-input=false","-no-color","-auto-approve",path],{cwd,credentials,region});if(action==="destroy")return {};const raw=await terraform("output",["-json"],{cwd,credentials,region});try{return Object.fromEntries(Object.entries(JSON.parse(raw)).map(([key,value])=>[key,value.value]))}catch{return {}}}
export async function removePlanFile(userId,connectionId,deploymentId,operationId){const path=join(stateDir(userId,connectionId,deploymentId),`${safeSegment(operationId)}.tfplan`);await rm(path,{force:true})}
export async function readOutputs(userId,connectionId,deploymentId){const cwd=stateDir(userId,connectionId,deploymentId);try{const outputs=JSON.parse(await readFile(join(cwd,"terraform.tfstate"),"utf8")).outputs||{};return Object.fromEntries(Object.entries(outputs).map(([key,item])=>[key,item&&typeof item==="object"&&"value" in item?item.value:item]))}catch{return {}}}
export async function removeDeploymentState(userId,connectionId,deploymentId){await rm(stateDir(userId,connectionId,deploymentId),{recursive:true,force:true})}
