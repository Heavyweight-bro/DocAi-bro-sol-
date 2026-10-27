import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const temp=await mkdtemp(path.join(tmpdir(),'docai-providers-'));
process.env.LOCAL_SETTINGS_DIR=temp;
for(const name of ['OPENAI_API_KEY','GEMINI_API_KEY','GEMINI_API_KEY1','ANTHROPIC_API_KEY'])process.env[name]='';
const {updateSettings,publicSettings,connection}=await import('../server/settings.ts');
const {extractDocument,parseJsonOutput,checkConnection,wantsJsonOutput,normalizeModelOutput}=await import('../server/providers.ts');
const originalFetch=globalThis.fetch;
try {
  assert.equal(wantsJsonOutput('Поверни JSON з полями total'), true);
  assert.equal(wantsJsonOutput('Переклади документ українською'), false);
  assert.equal(wantsJsonOutput('Зроби summary документа'), false);
  assert.equal(normalizeModelOutput('{"a":1}', true).format, 'json');
  assert.equal(normalizeModelOutput('Привіт світ', false).format, 'text');
  assert.equal(normalizeModelOutput('Привіт світ', false).data.content, 'Привіт світ');

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
    const result=await extractDocument(provider,{text:'',prompt:'Return JSON with total',filename:'invoice.pdf',inlineData:{mimeType:'application/pdf',data:'cGRm'}});
    assert.equal(result.data.total,120);assert.equal(result.format,'json');assert.equal(result.inputTokens,10);
  }
  assert.equal(requests.length,3);
  assert.equal(requests[0].body.input[0].content[1].type,'input_file');
  assert.equal(requests[0].body.store,false);
  assert.equal(requests[0].body.text.format.type,'json_object');
  assert.equal(requests[1].body.contents[0].parts[0].inlineData.mimeType,'application/pdf');
  assert.equal(requests[2].body.messages[0].content[0].type,'document');

  // Text / translation mode: no forced json_object; prose stored as { format, content }
  requests.length=0;
  globalThis.fetch=async (url,options)=>{
    const address=typeof url==='string'?url:url.url || url.toString();
    const body=options?.body ? JSON.parse(options.body) : {}; requests.push({address,body});
    if(address.includes('openai'))return new Response(JSON.stringify({id:'resp_text',object:'response',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Перекладений текст',annotations:[]}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5}}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('generativelanguage'))return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'Перекладений текст'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:'Перекладений текст'}],usage:{input_tokens:3,output_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const translated=await extractDocument('openai',{text:'Hello',prompt:'Переклади документ українською',filename:'note.txt'});
  assert.equal(translated.format,'text');
  assert.equal(translated.data.content,'Перекладений текст');
  assert.equal(requests[0].body.text,undefined);

  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'test-only-secret-openai'}}),{status:401,headers:{'content-type':'application/json'}});
  await assert.rejects(extractDocument('openai',{text:'x',prompt:'Return JSON',filename:'x.txt'}),e=>!e.message.includes('test-only-secret') && e.message.includes('ключ'));
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{id:'claude-example-model'}]}),{status:200,headers:{'content-type':'application/json'}});
  const listed=(await checkConnection('anthropic')).models;
  assert.deepEqual(listed,['claude-example-model']);
  assert.throws(()=>parseJsonOutput('[]'));
  assert.throws(()=>parseJsonOutput('{bad JSON'));
  assert.deepEqual(parseJsonOutput('```json\n{"a":1}\n```'),{a:1});
  updateSettings({connection:{provider:'openai',removeKey:true}});assert.equal(connection('openai').key,'');
  console.log('PASS: template-first prompts, JSON vs text output modes, encrypted settings, adapters, model list. No live AI requests.');
}finally{globalThis.fetch=originalFetch;await rm(temp,{recursive:true,force:true});}
