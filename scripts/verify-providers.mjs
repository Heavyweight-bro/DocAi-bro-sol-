import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const temp=await mkdtemp(path.join(tmpdir(),'docai-providers-'));
process.env.LOCAL_SETTINGS_DIR=temp;
for(const name of ['OPENAI_API_KEY','GEMINI_API_KEY','GEMINI_API_KEY1','ANTHROPIC_API_KEY'])process.env[name]='';
const {updateSettings,publicSettings,connection}=await import('../server/settings.ts');
const {extractDocument,parseJsonOutput,checkConnection}=await import('../server/providers.ts');
const originalFetch=globalThis.fetch;
try {
  for(const provider of ['openai','gemini','anthropic'])updateSettings({connection:{provider,key:'test-only-secret-'+provider}});
  const serialized=JSON.stringify(publicSettings());
  assert(!serialized.includes('test-only-secret'));
  assert(!(await readFile(path.join(temp,'connections.enc'),'utf8')).includes('test-only-secret'));
  assert.equal((await readFile(path.join(temp,'master.key'))).length,32);
  const requests=[];
  globalThis.fetch=async (url,options)=>{
    const address=typeof url==='string'?url:url.url || url.toString();
    const body=JSON.parse(options?.body || '{}'); requests.push({address,body});
    let data;
    if(address.includes('generativelanguage'))data={candidates:[{content:{parts:[{text:'{"total":120}'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:4}};
    else if(address.includes('openai'))data={id:'resp_test',object:'response',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"total":120}',annotations:[]}]}],usage:{input_tokens:10,output_tokens:4,total_tokens:14}};
    else data={stop_reason:'end_turn',content:[{type:'text',text:'{"total":120}'}],usage:{input_tokens:10,output_tokens:4}};
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  for(const provider of ['openai','gemini','anthropic']){
    const result=await extractDocument(provider,{text:'',prompt:'Return JSON',filename:'invoice.pdf',inlineData:{mimeType:'application/pdf',data:'cGRm'}});
    assert.equal(result.data.total,120);assert.equal(result.inputTokens,10);
  }
  assert.equal(requests.length,3);
  assert.equal(requests[0].body.input[0].content[1].type,'input_file');
  assert.equal(requests[0].body.store,false);
  assert.equal(requests[1].body.contents[0].parts[0].inlineData.mimeType,'application/pdf');
  assert.equal(requests[2].body.messages[0].content[0].type,'document');
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'test-only-secret-openai'}}),{status:401,headers:{'content-type':'application/json'}});
  await assert.rejects(extractDocument('openai',{text:'x',prompt:'x',filename:'x.txt'}),e=>!e.message.includes('test-only-secret') && e.message.includes('ключ'));
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{id:'example-model'}]}),{status:200,headers:{'content-type':'application/json'}});
  assert.deepEqual((await checkConnection('anthropic')).models,['example-model']);
  assert.throws(()=>parseJsonOutput('[]'));
  assert.throws(()=>parseJsonOutput('{bad JSON'));
  assert.deepEqual(parseJsonOutput('```json\n{"a":1}\n```'),{a:1});
  updateSettings({connection:{provider:'openai',removeKey:true}});assert.equal(connection('openai').key,'');
  console.log('PASS: encrypted settings, secret redaction, all three provider adapters with mocked API responses, native PDF payloads, error sanitization, model list, output validation and key removal. No live AI requests.');
}finally{globalThis.fetch=originalFetch;await rm(temp,{recursive:true,force:true});}
