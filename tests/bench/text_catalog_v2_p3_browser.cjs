// Text Catalog V2 使い勝手改善 P3（カタログ管理ノード・取り込み・タグ管理・確率表示・同名警告・行ホバー・1万件の検索）の実ブラウザ確認。
// SAX_PLAYWRIGHT_PATH に Playwright のインストール先を、SAX_BROWSER_PATH にブラウザ実行ファイルを指定できる。
const {chromium}=require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const makeDoc=(id,name,count=30)=>({version:3,id,name,revision:1,catalog:{items:Array.from({length:count},(_,i)=>({id:`${id}-i${i}`,name:`アイテム${i}`,text:`本文${i} `+'x'.repeat(40),tags:[`tag${i%10}`]}))},recipes:[
 {id:'s1',name:'旅人',groups:[{id:'g1',name:'人物',mode:'all',on:true,count:1,item_ids:[`${id}-i0`,`${id}-i1`]},{id:'g2',name:'背景',mode:'random',on:true,count:1,item_ids:[`${id}-i2`,`${id}-i3`,`${id}-i4`]}]},
 {id:'s2',name:'水彩',groups:[{id:'g3',name:'質感',mode:'all',on:true,count:1,item_ids:[`${id}-i0`]}]},
 {id:'s3',name:'水彩',groups:[]}]});
const big=(()=>{const d=makeDoc('big','巨大',0);d.catalog.items=Array.from({length:10000},(_,i)=>({id:`b${i}`,name:`素材${i%700}`,text:`本文 Masterpiece ${i} `+'あいうえお漢字 '.repeat(48),tags:[`tag${i%37}`,i%2?'style':'camera']}));d.recipes=[{id:'s1',name:'旅人',groups:[]}];return d})();
const log=[];
const docs=new Map([['one',makeDoc('one','カタログ1')],['two',makeDoc('two','カタログ2',5)],['big',big]]);
const archived=new Map();
const meta=d=>({id:d.id,name:d.name,revision:d.revision,items:d.catalog.items.length,recipes:d.recipes.length,updated_at:1760000000});
const appScript=`export const app={extensions:[],registerExtension(e){this.extensions.push(e)},graph:{_nodes:[],change(){}},canvas:{setDirty(){},ds:{scale:1}},async queuePrompt(){return []}};window.app=app;`;
const html=`<style>body{background:#18181b;color:#ddd;font:14px system-ui}button{padding:8px}canvas{display:block}</style><div id="controls"></div><canvas width="450" height="750"></canvas><script type="module">
import {app} from '/scripts/app.js'; import '/js/sax_text_catalog_v2.js'; import '/js/sax_text_catalog_manager.js'; import {sharedController} from '/js/sax_text_catalog_v2_shared.js';
const fake=(type,widgets)=>({type,comfyClass:type,widgets,size:[450,500],graph:app.graph,addWidget(t,name,value,callback,options){const w={type:t,name,value,callback,options};this.widgets.push(w);return w},addCustomWidget(w){this.widgets.push(w);return w},addDOMWidget(name,t,element,options){const w={name,type:t,element,options,onRemove(){element.remove()}};this.widgets.push(w);document.body.append(element);return w},setSize(s){this.size=s},computeSize(){return [450,500]},setDirtyCanvas(){}});
const Type=function(){}; const ext=app.extensions.find(e=>e.name==='SAX.TextCatalogV2');ext.beforeRegisterNodeDef(Type,{name:'SAX_Bridge_Text_Catalog_V2'});ext.setup();
const node=fake('SAX_Bridge_Text_Catalog_V2',[{name:'config_json',value:JSON.stringify({version:3,catalog_id:'one',rows:[{id:'r1',recipe_id:'s1',on:true},{id:'r2',recipe_id:'s2',on:true}]})},{name:'seed',value:123}]);
app.graph._nodes.push(node); Type.prototype.onNodeCreated.call(node);window.node=node;window.shared=()=>sharedController(node);
const Manager=function(){};app.extensions.find(e=>e.name==='SAX.TextCatalogManager').beforeRegisterNodeDef(Manager,{name:'SAX_Bridge_Text_Catalog_Manager'});
const manager=fake('SAX_Bridge_Text_Catalog_Manager',[]);app.graph._nodes.push(manager);Manager.prototype.onNodeCreated.call(manager);window.manager=manager;
window.config=()=>JSON.parse(node.widgets.find(w=>w.name==='config_json').value);
window.setConfig=ref=>{node.widgets.find(w=>w.name==='config_json').value=JSON.stringify(ref)};
window.ready=true;
</script>`;
const server=http.createServer(async(req,res)=>{
 try {
  const send=(v,status=200)=>{res.setHeader('Content-Type','application/json');res.statusCode=status;res.end(JSON.stringify(v))};
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return}
  if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return}
  if(req.url==='/scripts/app.js'){res.setHeader('Content-Type','text/javascript');res.end(appScript);return}
  if(req.url==='/scripts/api.js'){res.setHeader('Content-Type','text/javascript');res.end(`export const api={fetchApi:(url,opts)=>fetch(url,opts),getLoras:async()=>[],addEventListener(){}}`);return}
  if(req.url==='/autocomplete-plus-plus/wildcards/all-data'){send({success:true,wildcards:{}});return}
  if(req.url.startsWith('/sax/text-catalog/v2/archive')){
   const parts=req.url.split('/');
   if(req.method==='GET'){send({catalogs:[...archived.values()].map(meta)});return}
   const id=decodeURIComponent(parts.at(-2));let text='';for await(const c of req)text+=c;
   if(!archived.has(id)){send({error:'アーカイブにカタログが見つかりません'},400);return}
   docs.set(id,archived.get(id));archived.delete(id);log.push({type:'restore',id});send(meta(docs.get(id)));return}
  if(req.url.startsWith('/sax/text-catalog/v2/catalogs')){
   const id=decodeURIComponent(req.url.split('/').at(-1));
   if(req.method==='GET'){send(id==='catalogs'?{catalogs:[...docs.values()].map(meta)}:docs.get(id));return}
   let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
   if(req.url.endsWith('/duplicate')){const source=docs.get(decodeURIComponent(req.url.split('/').at(-2)));const copy=structuredClone(source);copy.id=`copy${docs.size}`;copy.name=body.name??`${source.name} コピー`;copy.revision=1;docs.set(copy.id,copy);log.push({type:'duplicate',from:source.id});send(meta(copy));return}
   if(req.url.endsWith('/archive')){const key=decodeURIComponent(req.url.split('/').at(-2));const doc=docs.get(key);if(!doc){send({error:'参照先の共有カタログが見つかりません'},400);return}docs.delete(key);archived.set(key,doc);log.push({type:'archive',id:key});send({id:key,name:doc.name});return}
   if(req.method==='POST'){const source=body.document??body;const created={version:3,id:`new${docs.size}`,name:source.name??'新しいカタログ',revision:1,catalog:source.catalog??{items:[]},recipes:source.recipes??[{id:'default',name:'テキストセット 1',groups:[]}]};docs.set(created.id,created);send(created);return}
   const doc=docs.get(id);log.push({type:'patch',id,operations:body.operations.length});const {applyOperations}=await import(require('node:url').pathToFileURL(path.resolve(root,'js/sax_text_catalog_v2_client.js')).href);applyOperations(doc,body.operations);doc.revision++;send({id:doc.id,revision:doc.revision});return;
  }
  const target=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!target.startsWith(root+path.sep)){res.statusCode=403;res.end();return}if(!fs.existsSync(target)){res.statusCode=404;res.end();return}res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':'text/plain');res.end(fs.readFileSync(target));
 }catch(e){console.error('test server error',e);res.statusCode=500;res.end(e.message)}
});
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 browser=await chromium.launch({headless:true,...(process.env.SAX_BROWSER_PATH?{executablePath:process.env.SAX_BROWSER_PATH,args:['--no-sandbox']}:{channel:'msedge'})});
 const page=await browser.newPage({viewport:{width:1280,height:950}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready&&window.shared()?.session);
 const editor=page.locator('.sax-shared-editor'),records=()=>page.locator('.se-record');
 const openEditor=async()=>{await page.evaluate(()=>{const btn=[...document.querySelectorAll('.sax-shared-catalog button')].find(b=>b.textContent==='アイテム');btn.click()});await editor.waitFor();await records().first().waitFor()};
 const settle=()=>page.waitForFunction(()=>shared().session.status==='saved');
 const docOne=()=>page.evaluate(()=>shared().session.document);
 const row=name=>records().filter({has:page.locator('.se-cell',{hasText:new RegExp(`^${name}$`)})}).first();
 const search=()=>page.getByPlaceholder('名前・本文・タグを検索',{exact:false});

 // 3-1 ノードの選択肢に件数と更新日時が出る。管理ノードで複製・アーカイブ・復元ができ、削除はしない。
 const options=await page.evaluate(()=>[...document.querySelectorAll('.sax-shared-catalog select option')].map(o=>o.textContent));
 assert.ok(options.some(o=>/^カタログ1 · アイテム30件・セット3件・更新 \d{4}-\d\d-\d\d \d\d:\d\d · one$/.test(o)),'選択肢にメタ情報: '+options.join('|'));
 await page.evaluate(()=>manager.widgets.find(w=>w.name==='カタログの一覧・複製・アーカイブ').callback());
 const dialog=page.locator('.sax-catalog-manager');await dialog.waitFor();
 await dialog.locator('.scm-entry[data-catalog-id="one"]').waitFor();
 assert.match(await dialog.locator('.scm-entry[data-catalog-id="one"]').innerText(),/アイテム30件・セット3件・更新 \d{4}-\d\d-\d\d/);
 await dialog.locator('.scm-entry[data-catalog-id="one"]').getByRole('button',{name:'複製'}).click();
 await dialog.locator('.scm-status').getByText('「カタログ1 コピー」を作成しました').waitFor();
 assert.equal(await dialog.locator('.scm-entry').count(),4);
 const confirm=page.locator('.__sax_confirm_dlg');
 await dialog.locator('.scm-entry[data-catalog-id="one"]').getByRole('button',{name:'アーカイブ'}).click();await confirm.waitFor();
 const message=await confirm.innerText();assert.match(message,/削除はされず/);assert.match(message,/1 個の Text Catalog V2 ノード/);assert.match(message,/他のワークフローは検出できません/);
 await confirm.getByRole('button',{name:'キャンセル'}).click();await confirm.waitFor({state:'detached'});assert.ok(docs.has('one'),'キャンセルでは何も起きない');
 await dialog.locator('.scm-entry[data-catalog-id="two"]').getByRole('button',{name:'アーカイブ'}).click();await confirm.waitFor();
 await confirm.getByRole('button',{name:'アーカイブ',exact:true}).click();
 await dialog.locator('.scm-status').getByText('「カタログ2」をアーカイブしました').waitFor();
 assert.equal(docs.has('two'),false);assert.equal(archived.has('two'),true,'削除ではなく移動');
 await dialog.locator('.scm-entry[data-catalog-id="two"]').waitFor({state:'detached'});
 await dialog.locator('.scm-status').getByRole('button',{name:'元に戻す'}).click();
 await dialog.locator('.scm-entry[data-catalog-id="two"]').waitFor();assert.equal(docs.has('two'),true,'元に戻すで復元');
 await dialog.locator('.scm-entry[data-catalog-id="two"]').getByRole('button',{name:'アーカイブ'}).click();await confirm.waitFor();await confirm.getByRole('button',{name:'アーカイブ',exact:true}).click();
 await dialog.locator('.scm-entry[data-catalog-id="two"]').waitFor({state:'detached'});
 await dialog.getByText(/^アーカイブ済み/).click();await dialog.locator('.scm-entry[data-archived-id="two"]').waitFor();
 await dialog.locator('.scm-entry[data-archived-id="two"]').getByRole('button',{name:'復元'}).click();
 await dialog.locator('.scm-entry[data-catalog-id="two"]').waitFor();assert.equal(docs.has('two'),true);
 await dialog.getByRole('button',{name:'閉じる'}).click();
 console.log('3-1 catalog manager passed');

 await openEditor();
 // 3-2 取り込み: 空行区切りテキスト。共通タグ・件数表示・上限超過・Undo 1回。
 const importButton=page.getByRole('button',{name:'取り込み',exact:true}),shared=page.locator('.sax-shared-dialog');
 await importButton.click();await shared.waitFor();
 const area=shared.getByLabel('取り込む内容'),submit=shared.getByRole('button',{name:'取り込む',exact:true});
 assert.equal(await submit.isDisabled(),true);
 await area.fill('masterpiece\n高品質\n\nsoft light\n\n\nbackground, city night');await shared.getByLabel('全件に付けるタグ').fill('取込, 共通');
 await shared.getByText('3件を追加します（現在30件 → 33件）').waitFor();
 await shared.getByLabel('取り込み形式').selectOption('line');await shared.getByText('4件を追加します（現在30件 → 34件）').waitFor();
 await shared.getByLabel('取り込み形式').selectOption('blank');
 await shared.getByLabel('全件に付けるタグ').fill('a,b,c,d,e,f,g,h,i');await shared.getByText(/タグは最大8件/).first().waitFor();assert.equal(await submit.isDisabled(),true);
 await shared.getByLabel('全件に付けるタグ').fill('取込, 共通');await shared.getByText('3件を追加します').waitFor();
 await shared.getByLabel('取り込み形式').selectOption('json');await area.fill('{');await shared.getByText(/JSONとして読み込めません/).waitFor();
 await area.fill(JSON.stringify({version:3,catalog:{items:[{id:'one-i0',name:'JSON由来',text:'json text',tags:['x']},'文字列だけのアイテム']},recipes:[{id:'zz',name:'無視',groups:[]}]}));
 await shared.getByText('2件を追加します').waitFor();assert.match(await shared.innerText(),/カタログのセット1件は取り込みません/);
 await shared.getByLabel('取り込み形式').selectOption('blank');await area.fill('masterpiece\n高品質\n\nsoft light\n\n\nbackground, city night');await shared.getByText('3件を追加します').waitFor();
 const before=(await docOne()).catalog.items.length;await submit.click();await shared.waitFor({state:'detached'});await settle();
 let items=(await docOne()).catalog.items;assert.equal(items.length,before+3);
 const added=items.slice(-3);assert.deepEqual(added.map(i=>i.name),['masterpiece','soft light','background, city night']);assert.deepEqual(added.map(i=>i.tags),[['取込','共通'],['取込','共通'],['取込','共通']]);assert.equal(new Set(items.map(i=>i.id)).size,items.length);
 assert.equal(added[0].text,'masterpiece\n高品質');
 assert.match(await page.locator('.se-notice').innerText(),/3件のアイテムを取り込みました/);
 await page.locator('.se-notice').getByRole('button',{name:'元に戻す'}).click();await settle();assert.equal((await docOne()).catalog.items.length,before,'1回の元に戻すで全件戻る');
 // 上限超過は全件拒否
 await importButton.click();await shared.waitFor();await shared.getByLabel('取り込み形式').selectOption('line');
 await page.evaluate(()=>{const t=document.querySelector('.sax-shared-dialog textarea');t.value=Array.from({length:10000},(_,i)=>`L${i}`).join('\n');t.dispatchEvent(new Event('input',{bubbles:true}))});
 await shared.getByText(/10000件以内にしてください（現在30件＋追加10000件）/).waitFor();assert.equal(await submit.isDisabled(),true);
 await page.keyboard.press('Escape');await shared.waitFor({state:'detached'});assert.equal(await editor.count(),1,'取り込み画面のEscでエディタまで閉じない');
 assert.equal((await docOne()).catalog.items.length,before);
 console.log('3-2 import passed');

 // 3-6 同名: 同名の注記とタグの併記。
 await search().fill('アイテム1');await page.waitForFunction(()=>document.querySelectorAll('.se-record').length>=10);
 await row('アイテム10').getByRole('button',{name:'名前を編集',exact:true}).click();
 const nameBox=page.getByRole('textbox',{name:'アイテム名',exact:true});await nameBox.fill('アイテム11');await page.keyboard.press('Enter');await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelectorAll('.se-dup-note').length===2);
 assert.match(await page.locator('.se-dup-note').first().innerText(),/⚠ 同名2件 · タグ: tag\d/);
 // 元に戻す・やり直しでも同名の注記が追従する（キャッシュが古いまま残らない）。
 await page.keyboard.press('Control+z');await page.waitForFunction(()=>document.querySelectorAll('.se-dup-note').length===0);
 await page.keyboard.press('Control+Shift+z');await page.waitForFunction(()=>document.querySelectorAll('.se-dup-note').length===2);
 console.log('3-6 duplicate names passed');
 await search().fill('');

 // 3-3 タグ管理: 統合は確認つき、1回の元に戻すで戻る。削除は確認つき。
 await page.getByRole('button',{name:'タグ管理',exact:true}).click();await shared.waitFor();
 const tag=name=>shared.locator(`.se-tag-entry[data-tag="${name}"]`);
 await tag('tag1').waitFor();assert.match(await tag('tag1').innerText(),/3件/);
 const snapshot=(await docOne()).catalog.items.map(i=>i.tags.join(','));
 await tag('tag1').getByRole('button',{name:/名前を変更または統合/}).click();
 const prompt=page.locator('.__sax_prompt_dlg');await prompt.waitFor();await prompt.locator('input').fill('a, b');await prompt.getByRole('button',{name:'変更'}).click();
 assert.match(await prompt.innerText(),/タグ名は1つだけ/);await prompt.locator('input').fill('tag2');await prompt.getByRole('button',{name:'変更'}).click();
 await confirm.waitFor();assert.match(await confirm.innerText(),/「tag1」を「tag2」に統合します（3件のアイテムを更新）/);await confirm.getByRole('button',{name:'統合'}).click();
 await shared.getByText(/「tag1」を「tag2」に統合しました（3件）/).waitFor();await settle();
 assert.equal((await docOne()).catalog.items.filter(i=>i.tags.includes('tag1')).length,0);assert.equal((await docOne()).catalog.items.filter(i=>i.tags.includes('tag2')).length,6);
 await shared.getByRole('button',{name:'元に戻す'}).click();await settle();assert.deepEqual((await docOne()).catalog.items.map(i=>i.tags.join(',')),snapshot,'統合も1回で戻る');
 await tag('tag3').getByRole('button',{name:/を削除/}).click();await confirm.waitFor();assert.match(await confirm.innerText(),/アイテムは削除されません/);await confirm.getByRole('button',{name:'キャンセル'}).click();
 assert.equal((await docOne()).catalog.items.filter(i=>i.tags.includes('tag3')).length,3);
 await tag('tag3').getByRole('button',{name:/を削除/}).click();await confirm.waitFor();await confirm.getByRole('button',{name:'削除'}).click();await settle();
 assert.equal((await docOne()).catalog.items.filter(i=>i.tags.includes('tag3')).length,0);
 await shared.getByRole('button',{name:'元に戻す'}).click();await settle();assert.equal((await docOne()).catalog.items.filter(i=>i.tags.includes('tag3')).length,3);
 await shared.getByRole('button',{name:'閉じる'}).click();
 console.log('3-3 tag manager passed');
 await page.getByRole('button',{name:'閉じる',exact:true}).click();await editor.waitFor({state:'detached'});

 // 3-5 確率: ランダム候補の重み欄の横に1件抽選時の確率。重みを変えると更新。
 await page.evaluate(()=>shared().open?.('sets'));
 await page.evaluate(()=>document.querySelector('.sax-shared-sets button.ssw-edit')?.click());
 await editor.waitFor();await page.locator('.se-layout').waitFor();
 await page.getByRole('button',{name:'候補アイテムの重みを編集'}).click();
 await page.locator('.se-prob').first().waitFor();
 assert.deepEqual(await page.locator('.se-prob').allTextContents(),['33.3%','33.3%','33.3%']);
 const weight=page.getByLabel('アイテム2の抽選重み');await weight.fill('3');await page.waitForFunction(()=>[...document.querySelectorAll('.se-prob')].map(e=>e.textContent).join()==='60%,20%,20%');
 await weight.fill('0');await page.waitForFunction(()=>[...document.querySelectorAll('.se-prob')].map(e=>e.textContent).join()==='0%,50%,50%');
 console.log('3-5 probability passed');
 await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});

 // 3-4 行ホバー: 直近の実行結果の先頭を行のtitleに出す。リロード後は復元しない。
 const rowTitle=id=>page.evaluate(i=>document.querySelector(`.sax-shared-sets .ssw-entry[data-row-id="${i}"]`)?.title,id);
 assert.equal(await rowTitle('r1'),'','実行前は出さない');
 // 保存待ちの編集（重みの変更）を流してから、画面が持つ改訂番号を使う。
 const revision=await page.evaluate(async()=>{await shared().session.flush();return shared().session.document.revision});
 const selectionAt=revision=>JSON.stringify({version:3,catalog_id:'one',revision,seed:7,rows:[
  {id:'r1',recipe_id:'s1',name:'旅人',on:true,groups:[{group_id:'g1',items:[{id:'one-i0',text:'本文0',output_position:1,output_text:'(本文0:1.2)'},{id:'one-i1',text:' 本文1 ',output_position:2}]}]},
  {id:'r2',recipe_id:'s2',name:'水彩',on:false,groups:[]}]});
 const executed=sel=>page.evaluate(sel=>{const Type=function(){};const ext=app.extensions.find(e=>e.name==='SAX.TextCatalogV2');ext.beforeRegisterNodeDef(Type,{name:'SAX_Bridge_Text_Catalog_V2'});Type.prototype.onExecuted.call(node,{text:['x'],selection_json:[sel]})},sel);
 await executed(selectionAt(revision));
 await page.waitForFunction(()=>document.querySelector('.sax-shared-sets .ssw-entry[data-row-id="r1"]')?.title.includes('本文1'));
 assert.equal(await rowTitle('r1'),'前回の実行（Seed 7）の出力:\n(本文0:1.2)\n本文1');
 assert.match(await rowTitle('r2'),/この行は無効のため出力なし/);
 await executed(selectionAt(revision-1));await page.waitForFunction(()=>document.querySelector('.sax-shared-sets .ssw-entry[data-row-id="r1"]').title.includes('実行後にカタログが更新されています'));
 console.log('3-4 row output passed');

 // 3-7 10,000件: 検索入力から一覧の描画までの時間（ブラウザ実測）。
 await page.evaluate(()=>{setConfig({version:3,catalog_id:'big',rows:[]});return shared().reload()});
 await page.waitForFunction(()=>shared().session?.document.id==='big');
 await openEditor();
 const timings=[];
 for(const query of ['素材12','tag3','','本文 Masterpiece 9999','style camera','素材7 tag5','masterpiece 漢字 tag3']){
  const ms=await page.evaluate(async q=>{const input=document.querySelector('.sax-shared-editor .se-filterbar input');const canvas=document.querySelector('.se-canvas');const before=canvas.style.height+document.querySelectorAll('.se-record').length+(canvas.firstChild?.dataset.key??'');
   const start=performance.now();input.value=q;input.dispatchEvent(new Event('input',{bubbles:true}));
   await new Promise(done=>{const poll=()=>{if(canvas.style.height+document.querySelectorAll('.se-record').length+(canvas.firstChild?.dataset.key??'')!==before)done();else requestAnimationFrame(poll)};poll();setTimeout(done,2000)});
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-start},query);
  timings.push([query,Math.round(ms)]);
 }
 console.log('3-7 search timings (ms, input→rendered):',JSON.stringify(timings));
 const warm=timings.map(([,ms])=>ms);assert.ok(Math.max(...warm)<=100*(process.env.SAX_SLOW_FACTOR?Number(process.env.SAX_SLOW_FACTOR):1),`検索の描画が100msを超えた: ${warm}`);
 await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:'ok',errors}));
}catch(error){console.error(error);process.exitCode=1}finally{await browser?.close();server.close()}})();
