import {it,expect} from 'vitest';
import {config as dotenv} from 'dotenv';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNode,catalog} from '@forge/connectors';
import {AISettingsSchema} from '@forge/contracts';
dotenv({path:'.env',quiet:true});
const providers=['google','telegram','smtp','imap','http','gemini','openai','microsoft','slack','discord','notion','mysql','postgres'];
// These tests are deliberately inert unless the operator supplies nominated test accounts/destinations.
it.skipIf(process.env.RUN_PROVIDER_TESTS!=='1').each(providers)('opt-in real %s connection and nominated actions',async(kind)=>{
 const file=process.env.LIVE_PROVIDER_FIXTURES;
 if(!file)throw new Error('Set LIVE_PROVIDER_FIXTURES to a private JSON fixture file.');
 const fixtures=JSON.parse(await readFile(file,'utf8'));
 const fixture=fixtures[kind];
 if(!fixture)throw new Error(`Provide a ${kind} test fixture, or run a single provider using the test-name filter.`);
 const url=new URL(process.env.TEST_DATABASE_URL??process.env.DATABASE_URL!);if(!process.env.TEST_DATABASE_URL)url.pathname='/forge_test';if(!url.pathname.endsWith('_test'))throw new Error('Live provider fixtures require an isolated _test database.');
 process.env.DATABASE_URL=url.toString();
 const {Database}=await import('../apps/backend/dist/database.js');const {config}=await import('../apps/backend/dist/config.js');
 const {Connections}=await import('../apps/backend/dist/connections.js');const {Operations}=await import('../apps/backend/dist/operations.js');const {LocalAI}=await import('../apps/backend/dist/ai.js');const {passwordHash}=await import('../apps/backend/dist/security.js');
 const db=new Database(),root=await mkdtemp(join(tmpdir(),'forge-live-provider-')),priorStorage=config.workspaceStorage;config.workspaceStorage=root;
 let user:any,ai:any;
 try{
  user=await db.user.create({data:{username:`live_${randomUUID().slice(0,8)}`,displayName:'Provider fixture',passwordHash:passwordHash(randomUUID())}});
  const workspace=await db.workspace.create({data:{name:'Opt-in provider test',ownerId:user.id,settings:{timezone:'UTC',model:'qwen3:4b',retentionDays:1,retainAIDetails:false}}});
  await db.withWorkspace(workspace.id,async()=>{
   const connections=new Connections(db);ai=new LocalAI(db);const operations=new Operations(db,connections,ai);
   const connection=await connections.save('Nominated provider test',kind as any,fixture.secret);
   expect((await connections.test(connection.id)).ok).toBe(true);
   if(kind==='gemini'||kind==='openai'){
    const choice=AISettingsSchema.parse({provider:kind,connectionId:connection.id,model:fixture.secret.model,dataPolicy:'public-demo'});
    const result=await ai.chat('Summarize synthetic demonstration data only.','A fictional team completed a demo task.',undefined,undefined,choice);expect(result.text.length).toBeGreaterThan(0);
   }
   for(const action of fixture.actions??[]){
    const definition=catalog.find(n=>n.type===action.type);if(!definition)throw new Error(`Unknown fixture action ${action.type}`);
    if(definition.effect==='write'&&action.allowWrites!==true)throw new Error('Nominated write tests require allowWrites:true on that action.');
    const node=createNode(action.type,'fixture');node.config={...node.config,...action.config,connectionId:connection.id};
    const result=await operations.execute(node,action.input??{},{workspaceId:workspace.id,runId:'live-fixture',key:randomUUID(),preview:false,signal:AbortSignal.timeout(60000),timezone:'UTC',predecessors:[]});
    expect(result).toBeTypeOf('object');
   }
  });
 }finally{await ai?.onModuleDestroy();if(user)await db.user.delete({where:{id:user.id}});await db.$disconnect();config.workspaceStorage=priorStorage;await rm(root,{recursive:true,force:true});}
},120000);
