import test from "node:test";
import assert from "node:assert/strict";
import {buildAzureColumnUpgrade,buildGcpColumnUpgrade,initializeDatabaseSchema,splitSchemaStatements} from "../schemaBootstrap.js";

test("schema parser skips database selection and returns table DDL",()=>{
 const statements=splitSchemaStatements("-- comment\nCREATE DATABASE IF NOT EXISTS demo;\nUSE demo;\nCREATE TABLE IF NOT EXISTS sample (id INT);\n");
 assert.deepEqual(statements,["CREATE TABLE IF NOT EXISTS sample (id INT)"]);
});

test("existing database GCP upgrade adds only missing columns and makes external ID nullable",()=>{
 const changes=buildGcpColumnUpgrade([
  {COLUMN_NAME:"external_id",IS_NULLABLE:"NO"},
  {COLUMN_NAME:"role_arn",IS_NULLABLE:"YES"},
 ]);
 assert.deepEqual(changes,[
  "MODIFY COLUMN external_id VARCHAR(96) NULL",
  "ADD COLUMN project_id VARCHAR(63) NULL",
  "ADD COLUMN service_account_email VARCHAR(320) NULL",
 ]);
});

test("existing database Azure upgrade adds only missing connection columns",()=>{
 assert.deepEqual(buildAzureColumnUpgrade([{COLUMN_NAME:"azure_subscription_id"},{COLUMN_NAME:"azure_tenant_id"}]),["ADD COLUMN azure_resource_group VARCHAR(90) NULL"]);
});

test("final schema is idempotently initialized without replaying AWS disconnect changes",async()=>{
 const queries=[];let changedDatabase=null,ended=false;
 const connection={
  query:async(sql,values)=>{
   queries.push({sql,values});
   if(sql.startsWith("SELECT COLUMN_NAME"))return [[
    {COLUMN_NAME:"external_id",IS_NULLABLE:"YES"},
    {COLUMN_NAME:"project_id",IS_NULLABLE:"YES"},
    {COLUMN_NAME:"service_account_email",IS_NULLABLE:"YES"},
    {COLUMN_NAME:"azure_subscription_id",IS_NULLABLE:"YES"},
    {COLUMN_NAME:"azure_tenant_id",IS_NULLABLE:"YES"},
    {COLUMN_NAME:"azure_resource_group",IS_NULLABLE:"YES"},
   ]];
   return [{affectedRows:0}];
  },
  changeUser:async(options)=>{changedDatabase=options.database},
  end:async()=>{ended=true},
 };
 await initializeDatabaseSchema({databaseName:"omnicloud_auth",createConnection:async()=>connection});
 assert.equal(changedDatabase,"omnicloud_auth");
 assert.ok(ended);
 assert.ok(queries.some(({sql})=>sql.startsWith("CREATE DATABASE IF NOT EXISTS `omnicloud_auth`")));
 assert.ok(queries.some(({sql})=>sql.startsWith("CREATE TABLE IF NOT EXISTS cloud_connections")));
 assert.ok(queries.some(({sql})=>sql.startsWith("CREATE TABLE IF NOT EXISTS gcp_terraform_deployments")));
 assert.ok(queries.some(({sql})=>sql.startsWith("CREATE TABLE IF NOT EXISTS gcp_terraform_operations")));
 assert.ok(queries.some(({sql})=>sql.startsWith("CREATE TABLE IF NOT EXISTS azure_terraform_deployments")));
 assert.ok(queries.some(({sql})=>sql.startsWith("CREATE TABLE IF NOT EXISTS azure_terraform_operations")));
 assert.ok(!queries.some(({sql})=>/UPDATE cloud_connections SET status='disconnected'/i.test(sql)));
 assert.ok(!queries.some(({sql})=>sql.startsWith("ALTER TABLE cloud_connections")));
});

test("database name is validated before SQL identifier interpolation",async()=>{
 let connected=false;
 await assert.rejects(()=>initializeDatabaseSchema({databaseName:"bad-name`; DROP DATABASE mysql;",createConnection:async()=>{connected=true}}),/MYSQL_DATABASE must be a simple MySQL database name/);
 assert.equal(connected,false);
});
