import test from "node:test";
import assert from "node:assert/strict";
import {buildAwsTerraformConfig,getTerraformCatalog,newBucketName,validateAwsDeployment} from "../terraformService.js";

test("AWS catalog exposes S3 and EC2 deployments",()=>{
 assert.deepEqual(getTerraformCatalog().map(item=>item.id),["private_s3_bucket","ec2_instance"]);
});

test("S3 Terraform config creates a private encrypted bucket",()=>{
 const config=buildAwsTerraformConfig({id:"deployment-id",template_id:"private_s3_bucket",display_name:"Storage",bucket_name:"omnicloud-123456789012-abcdef0123",region:"ap-south-1"},"create");
 assert.equal(config.resource.aws_s3_bucket.managed.bucket,"omnicloud-123456789012-abcdef0123");
 assert.equal(config.resource.aws_s3_bucket_public_access_block.managed.block_public_policy,true);
 assert.equal(config.resource.aws_s3_bucket_server_side_encryption_configuration.managed.rule[0].apply_server_side_encryption_by_default.sse_algorithm,"AES256");
 assert.equal(config.resource.aws_s3_bucket_ownership_controls.managed.rule[0].object_ownership,"BucketOwnerEnforced");
});

test("EC2 inputs validate and produce a private encrypted instance config",()=>{
 const validated=validateAwsDeployment({templateId:"ec2_instance",displayName:"Worker",region:"us-east-1",config:{amiId:"ami-0123456789abcdef0",subnetId:"subnet-0123456789abcdef0",securityGroupId:"sg-0123456789abcdef0"}});
 const config=buildAwsTerraformConfig({id:"deployment-id",template_id:"ec2_instance",display_name:validated.displayName,config:validated.config,region:validated.region},"create");
 const instance=config.resource.aws_instance.managed;
 assert.equal(instance.instance_type,"t3.micro");
 assert.equal(instance.associate_public_ip_address,false);
 assert.equal(instance.root_block_device[0].encrypted,true);
 assert.equal(instance.metadata_options[0].http_tokens,"required");
 assert.deepEqual(instance.vpc_security_group_ids,["sg-0123456789abcdef0"]);
});

test("AWS deployment validation rejects incomplete or unsafe EC2 inputs",()=>{
 assert.doesNotThrow(()=>validateAwsDeployment({templateId:"ec2_instance",displayName:"Worker",region:"us-east-1",config:{subnetId:"subnet-0123456789abcdef0",securityGroupId:"sg-0123456789abcdef0"}}));
 assert.throws(()=>validateAwsDeployment({templateId:"ec2_instance",displayName:"Worker",region:"us-east-1",config:{amiId:"ami-nope",subnetId:"subnet-0123456789abcdef0",securityGroupId:"sg-0123456789abcdef0"}}),/image available/);
 assert.throws(()=>validateAwsDeployment({templateId:"ec2_instance",displayName:"Worker",region:"us-east-1",config:{amiId:"ami-0123456789abcdef0",subnetId:"subnet-0123456789abcdef0",securityGroupId:"sg-0123456789abcdef0",instanceType:"t3.small"}}),/only allows the t3.micro/);
 assert.throws(()=>validateAwsDeployment({templateId:"ec2_instance",displayName:"Worker",region:"us-east-1",config:{amiId:"ami-0123456789abcdef0",subnetId:"subnet-0123456789abcdef0",securityGroupId:"sg-0123456789abcdef0",rootVolumeGiB:31}}),/8–30 GiB/);
});

test("generated bucket names fit S3 DNS naming constraints",()=>{
 const name=newBucketName("123456789012");
 assert.match(name,/^omnicloud-123456789012-[a-f0-9]{10}$/);
 assert.ok(name.length<=63);
});
