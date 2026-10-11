// 分離したComfyUIで実行。モデル不要のText Catalog → Debug TextをQueueする。
const {chromium}=require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.SAX_COMFY_TEST_URL;
if (!base) throw new Error('分離したテスト用ComfyUIのURLをSAX_COMFY_TEST_URLに指定してください');
const output=path.resolve(__dirname,'../../work');fs.mkdirSync(output,{recursive:true});
let browser;
(async()=>{try{
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>window.comfyAPI?.app?.app?.graph&&window.LiteGraph?.registered_node_types?.SAX_Bridge_Text_Catalog_V2,{},{timeout:60000});
 await page.waitForFunction(()=>window.comfyAPI.app.app.rootGraph?._nodes?.length>0,null,{timeout:20000});
 const response=await page.request.post(new URL('/sax/text-catalog/v2/catalogs',base).href,{data:{name:'UI確認カタログ',catalog:{items:[{id:'a',name:'旅人',text:'a traveler',tags:[]},{id:'b',name:'水彩',text:'watercolor',tags:[]}]},recipes:[{id:'portrait',name:'旅人のポートレート',groups:[{id:'fixed',name:'人物',mode:'all',on:true,count:1,item_ids:['a']}]},{id:'watercolor',name:'水彩の風景',groups:[{id:'style',name:'質感',mode:'all',on:true,count:1,item_ids:['b']}]}]}});assert.equal(response.status(),200);const doc=await response.json();
 await page.evaluate(async doc=>{
  window.testApp=window.comfyAPI.app.app;testApp.graph.clear();const node=LiteGraph.createNode('SAX_Bridge_Text_Catalog_V2');testApp.graph.add(node);node.pos=[200,180];node.widgets.find(w=>w.name==='config_json').value=JSON.stringify({version:3,catalog_id:doc.id,rows:[{id:'r1',recipe_id:'portrait',on:true},{id:'r2',recipe_id:'watercolor',on:true}]});node.onConfigure({});window.testNode=node;window.testCatalog=doc;
  const shared=await import('/extensions/SAX_Bridge/sax_text_catalog_v2_shared.js');window.testShared=()=>shared.sharedController(node);testApp.canvas.ds.scale=1;testApp.canvas.ds.offset=[0,0];testApp.canvas.setDirty(true,true);
 },doc);await page.waitForFunction(()=>document.querySelector('.sax-shared-sets select:not(:disabled)'),null,{timeout:10000}).catch(async error=>{console.log('diagnostics',await page.evaluate(()=>({controller:!!testShared(),widgets:testNode.widgets.map(w=>w.name)})),errors);await page.screenshot({path:path.join(output,'comfy-widget-error.png')});throw error});
 assert.equal(await page.locator('.sax-shared-sets').count(),1);
 const rowLayout = await page.locator('.ssw-entry').first().evaluate(row => {
  const select = row.querySelector('select'), buttons = [...row.querySelectorAll('.ssw-edit')];
  return { height: row.offsetHeight, selectX: select.offsetLeft, selectRight: select.offsetLeft+select.offsetWidth, buttons: buttons.map(b=>({x:b.offsetLeft,y:b.offsetTop,title:b.title,text:b.textContent,icon:!!b.querySelector('svg')})), selectY:select.offsetTop };
 });
 assert.ok(rowLayout.height<=40,JSON.stringify(rowLayout));assert.equal(rowLayout.buttons.length,2);
 assert.deepEqual(rowLayout.buttons.map(b=>b.title),['セット編集','アイテム編集']);
 assert.ok(rowLayout.buttons.every(b=>b.x>=rowLayout.selectRight && b.y===rowLayout.selectY && b.text==='' && b.icon),JSON.stringify(rowLayout));
 const originalHeight=await page.evaluate(()=>testNode.size[1]);await page.evaluate(()=>{testApp.canvas.ds.scale=.65;testShared().setWidget.refresh();testApp.canvas.setDirty(true,true)});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>testNode.size[1]),originalHeight);await page.evaluate(()=>{testApp.canvas.ds.scale=1;testApp.canvas.setDirty(true,true)});
 await page.evaluate(()=>Object.defineProperty(globalThis.crypto,'randomUUID',{value:undefined,configurable:true}));
 await page.getByRole('button',{name:'＋ テキストセットを追加',exact:true}).click();
 assert.equal(await page.evaluate(()=>JSON.parse(testNode.widgets.find(w=>w.name==='config_json').value).rows.length),2);
 await page.locator('.ssw-entry').last().locator('select').selectOption('portrait');
 const added=await page.evaluate(()=>JSON.parse(testNode.widgets.find(w=>w.name==='config_json').value).rows.at(-1));assert.match(added.id,/^v2_/);assert.equal(added.recipe_id,'portrait');
 await page.locator('.ssw-entry').first().locator('select').selectOption('watercolor');
 assert.equal(await page.locator('.sax-shared-editor').count(),0);
 await page.locator('[data-row-id="r1"] .ssw-handle').focus();await page.keyboard.press('ArrowDown');
 assert.equal(await page.evaluate(()=>JSON.parse(testNode.widgets.find(w=>w.name==='config_json').value).rows[1].id),'r1');
 await page.locator('[data-row-id="r1"] input').uncheck();
 await page.locator('.ssw-entry').last().getByRole('button',{name:'旅人のポートレートのアイテム編集',exact:true}).click();await page.waitForSelector('.se-record');assert.equal(await page.locator('.se-record').count(),1);
 await page.getByRole('button',{name:'本文を編集',exact:true}).click();await page.getByRole('textbox',{name:'アイテム本文',exact:true}).fill('a traveler, edited');await page.locator('.sax-shared-editor').getByRole('button',{name:'閉じる',exact:true}).click();
 await page.locator('.ssw-entry').last().getByRole('button',{name:'旅人のポートレートのセット編集',exact:true}).click();await page.waitForSelector('.se-card');assert.equal(await page.locator('.se-card').count(),1);await page.locator('.sax-shared-editor').getByRole('button',{name:'閉じる',exact:true}).click();
 await page.evaluate(async()=>{const debug=LiteGraph.createNode('SAX_Bridge_Debug_Text');testApp.graph.add(debug);debug.pos=[700,180];testNode.connect(0,debug,0);testNode.widgets.find(w=>w.name==='control_after_generate').value='fixed';await testApp.queuePrompt(0,1)});
 await page.waitForFunction(()=>testShared()?.result?.text?.includes('a traveler, edited'),null,{timeout:20000});
 assert.equal(await page.evaluate(()=>testShared().result.text),'watercolor\na traveler, edited');
 await page.evaluate(()=>testApp.canvas.setDirty(true,true));await page.screenshot({path:path.join(output,'comfy-widget-after.png')});
 await page.evaluate(()=>testNode.onConfigure({}));await page.waitForFunction(()=>testShared()?.session);assert.equal(await page.locator('.sax-shared-sets').count(),1);assert.equal(await page.locator('.ssw-entry').count(),3);
 await page.locator('.ssw-entry').last().locator('.ssw-remove').click();assert.equal(await page.locator('.ssw-entry').count(),2);
 await page.evaluate(async()=>{testShared().session.mutate([{type:'recipe.delete',id:'portrait'},{type:'recipe.delete',id:'watercolor'}]);await testShared().session.flush();const ref=JSON.parse(testNode.widgets.find(w=>w.name==='config_json').value);ref.rows=[];testNode.widgets.find(w=>w.name==='config_json').value=JSON.stringify(ref);testShared().setWidget.refresh()});
 await page.getByRole('button',{name:'＋ テキストセットを追加',exact:true}).click();await page.waitForSelector('.sax-shared-editor');assert.equal(await page.locator('.sax-shared-editor').getByRole('button',{name:'＋ 作成',exact:true}).count(),1);await page.locator('.sax-shared-editor').getByRole('button',{name:'閉じる',exact:true}).click();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({stage:'PASS actual ComfyUI',checks:'missing randomUUID/inline select/edit buttons/reorder/ON/actual Queue/configure no ghosts/remove',text:await page.evaluate(()=>testNode.widgets.find(w=>w.name==='config_json').value),errors}));
 }finally{await browser?.close()}})().catch(e=>{console.error(e);process.exitCode=1});
