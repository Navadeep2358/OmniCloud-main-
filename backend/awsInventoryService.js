import {EC2Client,DescribeImagesCommand,DescribeInstancesCommand,DescribeKeyPairsCommand,DescribeSecurityGroupsCommand,DescribeSubnetsCommand} from "@aws-sdk/client-ec2";
import {RDSClient,DescribeDBInstancesCommand} from "@aws-sdk/client-rds";
import {DynamoDBClient,DescribeTableCommand,ListTablesCommand} from "@aws-sdk/client-dynamodb";
import {S3Client,ListBucketsCommand} from "@aws-sdk/client-s3";
import {CostExplorerClient,GetCostAndUsageCommand,GetCostForecastCommand} from "@aws-sdk/client-cost-explorer";

async function collectPages(client,Command,input,property,{requestToken="NextToken",responseToken="NextToken"}={}){
 const items=[];let token;
 do{const page=await client.send(new Command({...input,...(token?{[requestToken]:token}:{})}));items.push(...(page[property]||[]));token=page[responseToken]}while(token);
 return items;
}
async function mapConcurrent(items,limit,mapper){
 const result=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;result[index]=await mapper(items[index],index)}}));
 return result;
}
const dateString=date=>date.toISOString().slice(0,10);
const monthString=value=>String(value||"").slice(0,7);
const costNumber=value=>Number(value||0);

function serviceCostName(name){
 const normalized=String(name||"").toLowerCase();
 if(normalized.includes("relational database service"))return "rds";
 if(normalized.includes("dynamodb"))return "dynamodb";
 if(normalized.includes("simple storage service"))return "s3";
 if(normalized.includes("elastic compute cloud"))return "ec2";
 return "other";
}

async function loadCostData(cost,now){
 const today=dateString(now),startDate=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-5,1)),start=dateString(startDate),tomorrow=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)),end=dateString(tomorrow),forecastEnd=dateString(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+31)));
 const historyPromise=cost.send(new GetCostAndUsageCommand({TimePeriod:{Start:start,End:today},Granularity:"MONTHLY",Metrics:["UnblendedCost"],GroupBy:[{Type:"DIMENSION",Key:"SERVICE"}]}));
 const forecastPromise=cost.send(new GetCostForecastCommand({TimePeriod:{Start:today,End:forecastEnd},Metric:"UNBLENDED_COST",Granularity:"MONTHLY"}));
 const rdsForecastPromise=cost.send(new GetCostForecastCommand({TimePeriod:{Start:today,End:forecastEnd},Metric:"UNBLENDED_COST",Granularity:"MONTHLY",Filter:{Dimensions:{Key:"SERVICE",Values:["Amazon Relational Database Service"]}}}));
 const dynamoForecastPromise=cost.send(new GetCostForecastCommand({TimePeriod:{Start:today,End:forecastEnd},Metric:"UNBLENDED_COST",Granularity:"MONTHLY",Filter:{Dimensions:{Key:"SERVICE",Values:["Amazon DynamoDB"]}}}));
 const [historyResult,forecastResult,rdsResult,dynamoResult]=await Promise.allSettled([historyPromise,forecastPromise,rdsForecastPromise,dynamoForecastPromise]);
 if(historyResult.status==="rejected"&&forecastResult.status==="rejected")throw historyResult.reason;
 const costHistory=historyResult.status==="fulfilled"?(historyResult.value.ResultsByTime||[]).map(period=>{
  const services={ec2:0,s3:0,rds:0,dynamodb:0,other:0};
  for(const group of period.Groups||[]){const service=serviceCostName(group.Keys?.[0]);services[service]+=costNumber(group.Metrics?.UnblendedCost?.Amount)}
  return {month:monthString(period.TimePeriod?.Start),start:period.TimePeriod?.Start,end:period.TimePeriod?.End,services,total:Object.values(services).reduce((sum,value)=>sum+value,0),unit:period.Groups?.[0]?.Metrics?.UnblendedCost?.Unit||"USD"};
 }):[];
 const total=forecastResult.status==="fulfilled"?forecastResult.value.Total:null;
 return {costHistory,costForecast:total?{amount:costNumber(total.Amount),unit:total.Unit||"USD",start:today,end:forecastEnd,scope:"AWS account forecast",services:{rds:rdsResult.status==="fulfilled"?{amount:costNumber(rdsResult.value.Total?.Amount),unit:rdsResult.value.Total?.Unit||total.Unit||"USD"}:null,dynamodb:dynamoResult.status==="fulfilled"?{amount:costNumber(dynamoResult.value.Total?.Amount),unit:dynamoResult.value.Total?.Unit||total.Unit||"USD"}:null}}:null,costError:forecastResult.status==="rejected"?forecastResult.reason:historyResult.status==="rejected"?historyResult.reason:null,end};
}

export async function loadAwsInventory({credentials,region,now=new Date(),clients={}}){
 const ec2=clients.ec2||new EC2Client({region,credentials}),rds=clients.rds||new RDSClient({region,credentials}),dynamodb=clients.dynamodb||new DynamoDBClient({region,credentials}),s3=clients.s3||new S3Client({region,credentials}),cost=clients.cost||new CostExplorerClient({region:"us-east-1",credentials});
 const settled=await Promise.allSettled([
  collectPages(ec2,DescribeInstancesCommand,{},"Reservations"),
  collectPages(ec2,DescribeSubnetsCommand,{},"Subnets"),
  collectPages(ec2,DescribeSecurityGroupsCommand,{},"SecurityGroups"),
  collectPages(ec2,DescribeKeyPairsCommand,{},"KeyPairs"),
  collectPages(s3,ListBucketsCommand,{MaxBuckets:1000},"Buckets",{requestToken:"ContinuationToken",responseToken:"NextContinuationToken"}),
  collectPages(rds,DescribeDBInstancesCommand,{},"DBInstances",{requestToken:"Marker",responseToken:"Marker"}),
  collectPages(dynamodb,ListTablesCommand,{},"TableNames",{requestToken:"ExclusiveStartTableName",responseToken:"LastEvaluatedTableName"})
 ]);
 const value=(index,fallback)=>settled[index].status==="fulfilled"?settled[index].value:fallback;
 const serviceActions={ec2:"ec2:DescribeInstances",subnets:"ec2:DescribeSubnets",securityGroups:"ec2:DescribeSecurityGroups",keyPairs:"ec2:DescribeKeyPairs",s3:"s3:ListAllMyBuckets",rds:"rds:DescribeDBInstances",dynamodb:"dynamodb:ListTables"},serviceErrors={};
 Object.entries(serviceActions).forEach(([key,permission],index)=>{if(settled[index].status==="rejected")serviceErrors[key]={code:settled[index].reason?.name||"AccessDenied",permission}});
 const instances=value(0,[]).flatMap(item=>item.Instances||[]).filter(item=>! ["terminated","shutting-down"].includes(item.State?.Name)).map(item=>({id:item.InstanceId,state:item.State?.Name,type:item.InstanceType,region,launchTime:item.LaunchTime,subnetId:item.SubnetId,securityGroupIds:(item.SecurityGroups||[]).map(group=>group.GroupId),name:(item.Tags||[]).find(tag=>tag.Key==="Name")?.Value||item.InstanceId,managedDeploymentId:(item.Tags||[]).find(tag=>tag.Key==="OmniCloudDeploymentId")?.Value||null}));
 const buckets=value(4,[]).map(item=>({name:item.Name,created:item.CreationDate||null}));
 const dbInstances=value(5,[]).filter(item=>! ["deleting","deleted"].includes(String(item.DBInstanceStatus||"").toLowerCase())).map(item=>({id:item.DBInstanceIdentifier,status:item.DBInstanceStatus,engine:item.Engine,engineVersion:item.EngineVersion,instanceClass:item.DBInstanceClass,region,endpoint:item.Endpoint?.Address||null,port:item.Endpoint?.Port||null,storageGiB:item.AllocatedStorage||null,availabilityZone:item.AvailabilityZone,multiAz:item.MultiAZ===true,publiclyAccessible:item.PubliclyAccessible===true,managedDeploymentId:(item.TagList||[]).find(tag=>tag.Key==="OmniCloudDeploymentId")?.Value||null}));
 let dynamoTables=[];
 if(settled[6].status==="fulfilled")try{dynamoTables=await mapConcurrent(value(6,[]),5,async tableName=>{const response=await dynamodb.send(new DescribeTableCommand({TableName:tableName})),table=response.Table||{};return {name:table.TableName||tableName,status:table.TableStatus||"unknown",itemCount:table.ItemCount??null,sizeBytes:table.TableSizeBytes??null,billingMode:table.BillingModeSummary?.BillingMode||"PROVISIONED",region,managedDeploymentId:(table.Tags||[]).find(tag=>tag.Key==="OmniCloudDeploymentId")?.Value||null}})}catch(error){serviceErrors.dynamodb={code:error?.name||"AccessDenied",permission:"dynamodb:DescribeTable"};dynamoTables=value(6,[]).map(name=>({name,status:"unknown",region,managedDeploymentId:null}))}
 let costHistory=[],costForecast=null;
 try{const costData=await loadCostData(cost,now);costHistory=costData.costHistory;costForecast=costData.costForecast;if(costData.costError)serviceErrors.cost={code:costData.costError?.name||"Unavailable",permission:"ce:GetCostAndUsage / ce:GetCostForecast"}}catch(error){serviceErrors.cost={code:error?.name||"Unavailable",permission:"ce:GetCostAndUsage and ce:GetCostForecast"}}
 return {region,instances,subnets:value(1,[]).map(item=>({id:item.SubnetId,vpcId:item.VpcId,availabilityZone:item.AvailabilityZone,cidr:item.CidrBlock,state:item.State,defaultForAz:item.DefaultForAz===true})),securityGroups:value(2,[]).map(item=>({id:item.GroupId,name:item.GroupName,vpcId:item.VpcId,description:item.Description})),keyPairs:value(3,[]).map(item=>({name:item.KeyName,id:item.KeyPairId,keyType:item.KeyType})),buckets,rdsInstances:dbInstances,dynamodbTables:dynamoTables,costHistory,costForecast,serviceErrors};
}

export async function listAwsImages({credentials,region,client=new EC2Client({region,credentials})}){
 const result=await client.send(new DescribeImagesCommand({Owners:["amazon","099720109477"],Filters:[{Name:"state",Values:["available"]},{Name:"architecture",Values:["x86_64","arm64"]},{Name:"root-device-type",Values:["ebs"]},{Name:"virtualization-type",Values:["hvm"]}]}));
 return (result.Images||[]).filter(image=>/^(?:al2023-ami-2023\.|ubuntu\/images\/hvm-ssd-gp3\/ubuntu-(?:noble|jammy)-)/i.test(image.Name||"")).sort((a,b)=>String(b.CreationDate||"").localeCompare(String(a.CreationDate||""))).slice(0,40).map(image=>{const root=image.BlockDeviceMappings?.find(device=>device.DeviceName===image.RootDeviceName)?.Ebs;return {id:image.ImageId,name:image.Name,description:image.Description,architecture:image.Architecture,ownerId:image.OwnerId,creationDate:image.CreationDate,minimumRootVolumeGiB:Number(root?.VolumeSize)||null}});
}
