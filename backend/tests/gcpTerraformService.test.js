import test from "node:test";
import assert from "node:assert/strict";
import {buildGcpVmConfiguration,getGcpTerraformCatalog} from "../gcpTerraformService.js";

const deployment={id:"12345678-1234-1234-1234-123456789012",project_id:"omnicloud-sandbox-123",instance_name:"omnicloud-123456789012",zone:"asia-south1-a",machine_type:"e2-micro"};

test("GCP VM configuration creates a small Debian Shielded VM without a public IP",()=>{
 const config=JSON.parse(buildGcpVmConfiguration(deployment));
 assert.equal(config.provider.google.project,deployment.project_id);
 assert.equal(config.resource.google_compute_instance.vm.machine_type,"e2-micro");
 assert.equal(config.resource.google_compute_instance.vm.boot_disk[0].initialize_params[0].image,"debian-cloud/debian-12");
 assert.equal(config.resource.google_compute_instance.vm.boot_disk[0].initialize_params[0].size,10);
 assert.equal(config.resource.google_compute_instance.vm.shielded_instance_config[0].enable_secure_boot,true);
 assert.equal(config.resource.google_compute_instance.vm.network_interface[0].network,"default");
 assert.equal("access_config" in config.resource.google_compute_instance.vm.network_interface[0],false);
 assert.match(config.output.internal_ip.value,/network_ip/);
});

test("GCP catalog describes initial Compute Engine resource and its cost notice",()=>{
 const [item]=getGcpTerraformCatalog();
 assert.equal(item.id,"gcp_compute_instance");
 assert.match(item.costNotice,/charges/i);
 assert.match(item.description,/no public IP/i);
});

test("GCP VM configuration rejects invalid project IDs, zones, machines, and names",()=>{
 assert.throws(()=>buildGcpVmConfiguration({...deployment,project_id:"bad"}),/project ID/);
 assert.throws(()=>buildGcpVmConfiguration({...deployment,zone:"nowhere"}),/zone/);
 assert.throws(()=>buildGcpVmConfiguration({...deployment,machine_type:"n2-highmem-128"}),/machine type/);
 assert.throws(()=>buildGcpVmConfiguration({...deployment,instance_name:"bad_name"}),/instance name/);
});
