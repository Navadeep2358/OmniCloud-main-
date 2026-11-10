import {readFile} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import mysql from "mysql2/promise";

const here=dirname(fileURLToPath(import.meta.url));

export function splitSchemaStatements(schemaSql){
 return schemaSql
  .replace(/^\s*--[^\r\n]*$/gm,"")
  .split(";")
  .map(statement=>statement.trim())
  .filter(statement=>statement&&!/^CREATE\s+DATABASE\b/i.test(statement)&&!/^USE\b/i.test(statement));
}

export function buildGcpColumnUpgrade(columns){
 const byName=new Map(columns.map(column=>[String(column.COLUMN_NAME).toLowerCase(),column]));
 const changes=[];
 const externalId=byName.get("external_id");
 if(!externalId)changes.push("ADD COLUMN external_id VARCHAR(96) NULL");
 else if(String(externalId.IS_NULLABLE).toUpperCase()!=="YES")changes.push("MODIFY COLUMN external_id VARCHAR(96) NULL");
 if(!byName.has("project_id"))changes.push("ADD COLUMN project_id VARCHAR(63) NULL");
 if(!byName.has("service_account_email"))changes.push("ADD COLUMN service_account_email VARCHAR(320) NULL");
 return changes;
}

export function buildAzureColumnUpgrade(columns){
 const byName=new Map(columns.map(column=>[String(column.COLUMN_NAME).toLowerCase(),column]));
 const changes=[];
 if(!byName.has("azure_subscription_id"))changes.push("ADD COLUMN azure_subscription_id CHAR(36) NULL");
 if(!byName.has("azure_tenant_id"))changes.push("ADD COLUMN azure_tenant_id CHAR(36) NULL");
 if(!byName.has("azure_resource_group"))changes.push("ADD COLUMN azure_resource_group VARCHAR(90) NULL");
 return changes;
}

export function buildAwsProfileColumnUpgrade(columns){
 const byName=new Set(columns.map(column=>String(column.COLUMN_NAME).toLowerCase()));
 const changes=[];
 if(!byName.has("aws_profile"))changes.push("ADD COLUMN aws_profile VARCHAR(64) NULL");
 if(!byName.has("aws_role_name"))changes.push("ADD COLUMN aws_role_name VARCHAR(128) NULL");
 return changes;
}

export function buildAwsSsoLoginColumnUpgrade(columns){
 const byName=new Set(columns.map(column=>String(column.COLUMN_NAME).toLowerCase()));
 return byName.has("message")?[]:["ADD COLUMN message VARCHAR(500) NULL"];
}

export function buildTerraformDeploymentColumnUpgrade(columns){
 const byName=new Map(columns.map(column=>[String(column.COLUMN_NAME).toLowerCase(),column]));
 const changes=[];
 if(!byName.has("resource_id"))changes.push("ADD COLUMN resource_id VARCHAR(128) NULL");
 if(!byName.has("config_json"))changes.push("ADD COLUMN config_json LONGTEXT NULL");
 if(!byName.has("outputs_json"))changes.push("ADD COLUMN outputs_json LONGTEXT NULL");
 return changes;
}

export function buildAppDeploymentColumnUpgrade(columns){
 const byName=new Set(columns.map(column=>String(column.COLUMN_NAME).toLowerCase()));
 const changes=[];
 if(!byName.has("source_git_url"))changes.push("ADD COLUMN source_git_url VARCHAR(512) NULL");
 if(!byName.has("source_branch"))changes.push("ADD COLUMN source_branch VARCHAR(128) NULL");
 return changes;
}

export async function initializeDatabaseSchema({
 databaseName=process.env.MYSQL_DATABASE||"omnicloud_auth",
 host=process.env.MYSQL_HOST||"127.0.0.1",
 port=Number(process.env.MYSQL_PORT||3306),
 user=process.env.MYSQL_USER||"root",
 password=process.env.MYSQL_PASSWORD||"",
 createDatabase=String(process.env.MYSQL_CREATE_DATABASE||"true").toLowerCase()!=="false",
 createConnection=mysql.createConnection,
 schemaPath=resolve(here,"schema.sql"),
}={}){
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(databaseName))throw new Error("MYSQL_DATABASE must be a simple MySQL database name containing only letters, numbers, underscores, or hyphens.");
 const connection=await createConnection({host,port,user,password,charset:"utf8mb4",...(String(process.env.MYSQL_SSL||"false").toLowerCase()==="true"?{ssl:{rejectUnauthorized:true}}:{}),...(!createDatabase?{database:databaseName}:{})});
 try{
  if(createDatabase){await connection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);await connection.changeUser({database:databaseName})}
  const schemaSql=await readFile(schemaPath,"utf8");
  for(const statement of splitSchemaStatements(schemaSql))await connection.query(statement);
  const [columns]=await connection.query("SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='cloud_connections'",[databaseName]);
  const changes=buildGcpColumnUpgrade(columns);
  if(changes.length)await connection.query(`ALTER TABLE cloud_connections ${changes.join(", ")}`);
  const [updatedColumns]=await connection.query("SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='cloud_connections'",[databaseName]);
  const azureChanges=buildAzureColumnUpgrade(updatedColumns);
  if(azureChanges.length)await connection.query(`ALTER TABLE cloud_connections ${azureChanges.join(", ")}`);
  const [awsColumns]=await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='cloud_connections'",[databaseName]);
  const awsChanges=buildAwsProfileColumnUpgrade(awsColumns);
  if(awsChanges.length)await connection.query(`ALTER TABLE cloud_connections ${awsChanges.join(", ")}`);
  const [awsLoginColumns]=await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='aws_sso_logins'",[databaseName]);
  const awsLoginChanges=buildAwsSsoLoginColumnUpgrade(awsLoginColumns);
  if(awsLoginChanges.length)await connection.query(`ALTER TABLE aws_sso_logins ${awsLoginChanges.join(", ")}`);
  const [deploymentColumns]=await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='terraform_deployments'",[databaseName]);
  const deploymentChanges=buildTerraformDeploymentColumnUpgrade(deploymentColumns);
  if(deploymentChanges.length)await connection.query(`ALTER TABLE terraform_deployments ${deploymentChanges.join(", ")}`);
  const [appDeploymentColumns]=await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='app_deployments'",[databaseName]);
  const appDeploymentChanges=buildAppDeploymentColumnUpgrade(appDeploymentColumns);
  if(appDeploymentChanges.length)await connection.query(`ALTER TABLE app_deployments ${appDeploymentChanges.join(", ")}`);
 }finally{
  await connection.end();
 }
}
