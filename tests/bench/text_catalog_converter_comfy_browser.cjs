// ユーザーのワークフローから分離したComfyUIでのみ実行する。
const {chromium}=require(process.env.SAX_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const base=process.env.SAX_COMFY_TEST_URL;
if(!base)throw new Error('隔離ComfyUIのURLをSAX_COMFY_TEST_URLへ指定してください');
const payload={version:1,catalog:{items:[{id:'a',name:'A',text:'alpha',tags:['tag']},{id:'b',name:'B',text:'beta',tags:[]},{id:'unused',name:'未使用',text:'unused',tags:[]}],tag_definitions:['tag'],favorite_tags:[]},relations:[{item_id:'b',on:true},{item_id:'a',on:false},{item_id:'b',on:true},{item_id:null,on:true}]};
(async()=>{
 let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>window.LiteGraph?.registered_node_types?.SAX_Bridge_Text_Catalog_Converter,null,{timeout:60000});
  await page.waitForFunction(()=>window.comfyAPI.app.app.rootGraph?._nodes.length>0);
  const count=async()=>{const response=await page.request.get(new URL('/sax/text-catalog/v2/catalogs',base).href);return(await response.json()).catalogs.length};const before=await count();
  await page.evaluate(payload=>{
   window.testApp=window.comfyAPI.app.app;testApp.graph.clear();
   window.source=LiteGraph.createNode('SAX_Bridge_Text_Catalog');source.pos=[150,200];testApp.graph.add(source);source.widgets.find(w=>w.name==='items_json').value=JSON.stringify(payload);source.onConfigure?.({});
   window.converter=LiteGraph.createNode('SAX_Bridge_Text_Catalog_Converter');converter.pos=[600,200];testApp.graph.add(converter);
   const debug=LiteGraph.createNode('SAX_Bridge_Debug_Text');testApp.graph.add(debug);source.connect(0,debug,0);window.originalLink=source.outputs[0].links[0];
   converter.widgets.find(w=>w.name==='V1ノードから読み込む').callback();
  },payload);
  await page.getByRole('button',{name:/SAX Text Catalog · #/}).click();
  assert.deepEqual(await page.evaluate(()=>JSON.parse(converter.widgets.find(w=>w.name==='v1_json').value)),payload);
  const sample=await page.evaluate(()=>{
   const note=LiteGraph.createNode('Note');note.pos=[150,550];note.size=[800,180];note.widgets[0].value='1. Converterの「V1ノードから読み込む」で元ノードを選択します。\n2. catalog_nameを指定し、「共有カタログへ登録・V2ノードを追加」をクリックします。\n3. 未使用アイテムも登録され、OFFと重複を含むV1の行順が「V1の選択」セットへ保存されます。\n4. 追加されたV2のtextをDebug Textへ接続してQueueするとbeta改行betaを出力します。元V1の接続は維持されます。\n5. Converterのcatalog_json端子はインポート可能なJSONを出力し、Queueでは共有カタログを新規作成しません。';testApp.graph.add(note);
   return testApp.graph.serialize();
  });
  fs.writeFileSync(path.resolve(__dirname,'../../work/text_catalog_converter_sample.json'),JSON.stringify(sample,null,2)+'\n');
  await page.evaluate(async()=>converter.widgets.find(w=>w.name==='共有カタログへ登録・V2ノードを追加').callback());
  await page.waitForFunction(()=>testApp.graph._nodes.some(n=>n.type==='SAX_Bridge_Text_Catalog_V2'));
  const id=await page.evaluate(()=>converter.properties.saxConvertedCatalog.id),document=await(await page.request.get(new URL('/sax/text-catalog/v2/catalogs/'+id,base).href)).json();
  assert.equal(await count(),before+1);assert.deepEqual(document.catalog.items,payload.catalog.items);assert.deepEqual(document.recipes[0].groups.map(g=>g.on),[true,false,true,true]);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(source.widgets.find(w=>w.name==='items_json').value)),payload);
  assert.equal(await page.evaluate(()=>source.outputs[0].links[0]===originalLink),true);
  await page.evaluate(async()=>{
   window.target=testApp.graph._nodes.find(n=>n.type==='SAX_Bridge_Text_Catalog_V2');const module=await import('/extensions/SAX_Bridge/sax_text_catalog_v2_shared.js');window.targetShared=()=>module.sharedController(target);
   const text=LiteGraph.createNode('SAX_Bridge_Debug_Text');testApp.graph.add(text);target.connect(0,text,0);
   const json=LiteGraph.createNode('SAX_Bridge_Debug_Text');testApp.graph.add(json);converter.connect(0,json,0);
   await testApp.queuePrompt(0,1);
  });
  await page.waitForFunction(()=>targetShared()?.result?.text==='beta\nbeta');assert.equal(await count(),before+1);
  await page.evaluate(async()=>converter.widgets.find(w=>w.name==='共有カタログへ登録・V2ノードを追加').callback());await page.getByRole('button',{name:'OK',exact:true}).click();assert.equal(await count(),before+1);
  // 同じV1を既存カタログへ追加。元データ保持、ID衝突回避、新V2は追加セットのみ使用。
  await page.evaluate(()=>converter.widgets.find(w=>w.name==='V1ノードから読み込む').callback());await page.getByRole('button',{name:/SAX Text Catalog · #/}).click();
  await page.evaluate(async()=>{converter.widgets.find(w=>w.name==='登録先').callback('既存カタログに追加');await converter.widgets.find(w=>w.name.startsWith('追加先')).callback()});
  await page.getByRole('button',{name:`${document.name} · ${id.slice(0,8)}`,exact:true}).click();
  assert.equal(await page.evaluate(()=>converter.widgets.find(w=>w.name==='catalog_name')._saxHidden),true);
  await page.evaluate(async()=>converter.widgets.find(w=>w.name==='共有カタログへ登録・V2ノードを追加').callback());
  const combined=await(await page.request.get(new URL('/sax/text-catalog/v2/catalogs/'+id,base).href)).json();
  assert.equal(await count(),before+1);assert.equal(combined.name,document.name);assert.equal(combined.catalog.items.length,6);assert.equal(combined.recipes.length,2);
  assert.deepEqual(combined.catalog.items.slice(0,3),document.catalog.items);assert.deepEqual(combined.recipes[0],document.recipes[0]);
  assert.ok(combined.catalog.items.slice(3).every(i=>!document.catalog.items.some(old=>old.id===i.id)));
  const added=await page.evaluate(()=>JSON.parse(testApp.graph._nodes.filter(n=>n.type==='SAX_Bridge_Text_Catalog_V2').at(-1).widgets.find(w=>w.name==='config_json').value));
  assert.equal(added.catalog_id,id);assert.deepEqual(added.rows.map(r=>r.recipe_id),[combined.recipes[1].id]);
  const conflict=await page.request.post(new URL('/sax/text-catalog/v2/catalogs/convert-v1',base).href,{data:{v1_json:JSON.stringify(payload),catalog_name:'追加',destination:'existing',target_catalog_id:id,base_revision:document.revision}});assert.equal(conflict.status(),409);
  assert.deepEqual(await(await page.request.get(new URL('/sax/text-catalog/v2/catalogs/'+id,base).href)).json(),combined);
  const bad=await page.request.post(new URL('/sax/text-catalog/v2/catalogs/convert-v1',base).href,{data:{v1_json:'{}',catalog_name:'不正'}});assert.equal(bad.status(),400);assert.equal(await count(),before+1);
  assert.deepEqual(errors,[]);console.log('PASS: 新規/既存登録先・既存データ保持・ID衝突回避・追加セットのみ使用・競合時無変更・V1選択・OFF/重複/順序・元リンク維持・Queue');
 }finally{await browser?.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
