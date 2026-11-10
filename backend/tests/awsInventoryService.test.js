import test from "node:test";
import assert from "node:assert/strict";
import {DescribeImagesCommand,DescribeInstancesCommand,DescribeKeyPairsCommand,DescribeSecurityGroupsCommand,DescribeSubnetsCommand} from "@aws-sdk/client-ec2";
import {DescribeDBInstancesCommand} from "@aws-sdk/client-rds";
import {DescribeTableCommand,ListTablesCommand} from "@aws-sdk/client-dynamodb";
import {ListBucketsCommand} from "@aws-sdk/client-s3";
import {GetCostAndUsageCommand,GetCostForecastCommand} from "@aws-sdk/client-cost-explorer";
import {listAwsImages,loadAwsInventory} from "../awsInventoryService.js";

test("AWS account inventory returns EC2 choices, buckets, and cost forecast",async()=>{
 const clients={ec2:{send:async command=>{
  if(command instanceof DescribeInstancesCommand)return {Reservations:[{Instances:[{InstanceId:"i-1",State:{Name:"running"},InstanceType:"t3.micro",Tags:[{Key:"Name",Value:"worker"},{Key:"OmniCloudDeploymentId",Value:"managed-id"}]}]}]};
  if(command instanceof DescribeSubnetsCommand)return {Subnets:[{SubnetId:"subnet-1",VpcId:"vpc-1",AvailabilityZone:"ap-south-1a",CidrBlock:"10.0.1.0/24",State:"available"}]};
  if(command instanceof DescribeSecurityGroupsCommand)return {SecurityGroups:[{GroupId:"sg-1",GroupName:"default",VpcId:"vpc-1"}]};
  if(command instanceof DescribeKeyPairsCommand)return {KeyPairs:[{KeyName:"deploy",KeyPairId:"key-1",KeyType:"ed25519"}]};
  throw new Error(command.constructor.name);
 }},rds:{send:async command=>{assert.ok(command instanceof DescribeDBInstancesCommand);return {DBInstances:[{DBInstanceIdentifier:"sample-db",DBInstanceStatus:"available",Engine:"mysql"}]}}},dynamodb:{send:async command=>{if(command instanceof ListTablesCommand)return {TableNames:["sample-table"]};assert.ok(command instanceof DescribeTableCommand);return {Table:{TableName:"sample-table",TableStatus:"ACTIVE"}}}},s3:{send:async command=>{assert.ok(command instanceof ListBucketsCommand);return {Buckets:[{Name:"sample-bucket"}]}}},cost:{send:async command=>{if(command instanceof GetCostAndUsageCommand)return {ResultsByTime:[]};assert.ok(command instanceof GetCostForecastCommand);return {Total:{Amount:"123.45",Unit:"USD"}}}}};
 const result=await loadAwsInventory({credentials:{},region:"ap-south-1",now:new Date("2026-11-05T00:00:00Z"),clients});
 assert.equal(result.instances[0].managedDeploymentId,"managed-id");assert.equal(result.subnets[0].id,"subnet-1");assert.equal(result.securityGroups[0].id,"sg-1");assert.equal(result.keyPairs[0].name,"deploy");assert.equal(result.buckets[0].name,"sample-bucket");assert.equal(result.rdsInstances[0].id,"sample-db");assert.equal(result.dynamodbTables[0].name,"sample-table");assert.equal(result.costForecast.amount,123.45);assert.equal(result.costForecast.scope,"AWS account forecast");assert.deepEqual(result.serviceErrors,{});
});

test("inventory returns partial results when a permission is missing",async()=>{
 const clients={ec2:{send:async command=>{if(command instanceof DescribeSubnetsCommand)throw Object.assign(new Error("denied"),{name:"UnauthorizedOperation"});if(command instanceof DescribeInstancesCommand)return {Reservations:[]};if(command instanceof DescribeSecurityGroupsCommand)return {SecurityGroups:[]};return {KeyPairs:[]}}},s3:{send:async()=>({Buckets:[]})},cost:{send:async()=>({Total:{Amount:"0",Unit:"USD"}})}};
 const result=await loadAwsInventory({credentials:{},region:"us-east-1",clients});assert.equal(result.serviceErrors.subnets.code,"UnauthorizedOperation");assert.equal(result.serviceErrors.subnets.permission,"ec2:DescribeSubnets");assert.deepEqual(result.subnets,[]);assert.equal(result.buckets.length,0);
});

test("available images are filtered to supported current Linux images",async()=>{
 const result=await listAwsImages({credentials:{},region:"us-east-1",client:{send:async command=>{assert.ok(command instanceof DescribeImagesCommand);return {Images:[{ImageId:"ami-old",Name:"windows-old",CreationDate:"2026-01-01",Architecture:"x86_64"},{ImageId:"ami-ml",Name:"Deep Learning Base AMI with Single CUDA (Amazon Linux 2023)",CreationDate:"2026-11-02",Architecture:"x86_64"},{ImageId:"ami-al2023",Name:"al2023-ami-2023.7.20261101.0-kernel-6.1-x86_64",CreationDate:"2026-11-02",Architecture:"x86_64",RootDeviceName:"/dev/xvda",BlockDeviceMappings:[{DeviceName:"/dev/xvda",Ebs:{VolumeSize:8,SnapshotId:"snap-small"}}]},{ImageId:"ami-new",Name:"ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261101",CreationDate:"2026-11-01",Architecture:"x86_64",RootDeviceName:"/dev/sda1",BlockDeviceMappings:[{DeviceName:"/dev/sda1",Ebs:{VolumeSize:75,SnapshotId:"snap-test"}}]}]}}}});
 assert.deepEqual(result.map(image=>image.id),["ami-al2023","ami-new"]);
 assert.equal(result[0].minimumRootVolumeGiB,8);
 assert.equal(result[1].minimumRootVolumeGiB,75);
});
