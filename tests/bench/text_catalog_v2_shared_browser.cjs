// SAX_PLAYWRIGHT_PATH に Playwright のインストール先を指定できる。
const {chromium}=require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'); let doc,fail=false,conflict=false,calls=[];
const fixture=(count=10000,size=100)=>({version:3,id:'browser-test',name:'共通カタログ',revision:1,catalog:{items:Array.from({length:count},(_,i)=>({id:`i${i}`,name:`アイテム${i}`,text:`本文${i} `+'x'.repeat(size),tags:[`tag${i%10}`]}))},recipes:[{id:'s1',name:'旅人',groups:[{id:'g1',name:'人物',mode:'all',on:true,count:1,item_ids:['i0','i1']},{id:'g2',name:'背景',mode:'random',on:true,count:2,item_ids:['i2','i3','i4']}]},{id:'s2',name:'水彩',groups:[{id:'g3',name:'質感',mode:'all',on:true,count:1,item_ids:['i5']}]}]});
doc=fixture();
const appScript=`export const app={extensions:[],registerExtension(e){this.extensions.push(e)},graph:{_nodes:[],change(){}},canvas:{setDirty(){},ds:{scale:1}},async queuePrompt(){window.queued=(window.queued||0)+1;return this.graph._nodes.map(n=>n.widgets.find(w=>w.name==='config_json').value)}};window.app=app;`;
const html=`<style>body{background:#18181b;color:#ddd;font:14px system-ui}button{padding:8px}canvas{display:block}</style><div id="controls"></div><canvas width="450" height="750"></canvas><script type="module">
import {app} from '/scripts/app.js'; import '/js/sax_text_catalog_v2.js'; import {sharedController} from '/js/sax_text_catalog_v2_shared.js';
const Type=function(){}; const ext=app.extensions.find(e=>e.name==='SAX.TextCatalogV2');ext.beforeRegisterNodeDef(Type,{name:'SAX_Bridge_Text_Catalog_V2'});ext.setup();
const node={type:'SAX_Bridge_Text_Catalog_V2',comfyClass:'SAX_Bridge_Text_Catalog_V2',widgets:[{name:'config_json',value:JSON.stringify({version:3,catalog_id:'browser-test',rows:[{id:'r1',recipe_id:'s1',on:true},{id:'r2',recipe_id:'s2',on:true}]})},{name:'seed',value:123}],size:[450,500],graph:app.graph,addWidget(type,name,value,callback,options){const w={type,name,value,callback,options};this.widgets.push(w);return w},addCustomWidget(w){this.widgets.push(w);return w},setSize(s){this.size=s},computeSize(){return [450,500]},setDirtyCanvas(){window.draw?.()}};
app.graph._nodes.push(node); Type.prototype.onNodeCreated.call(node);window.node=node;window.Type=Type;window.shared=()=>sharedController(node);window.draw=()=>{const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,450,750);node.widgets.find(w=>w.name==='__sax_shared_sets').draw(ctx,node,450,10)};
for(const name of ['アイテム','前回の実行結果','＋ テキストセットを追加','カタログ作成・入出力']){const b=document.createElement('button');b.textContent=name;b.onclick=()=>node.widgets.find(w=>w.name===name).callback();document.querySelector('#controls').append(b)}window.ready=true;
</script>`;
const server=http.createServer(async(req,res)=>{
 try {
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return}
  if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return}
  if(req.url==='/scripts/app.js'){res.setHeader('Content-Type','text/javascript');res.end(appScript);return}
  if(req.url==='/scripts/api.js'){res.setHeader('Content-Type','text/javascript');res.end(`export const api={fetchApi:(url,opts)=>fetch(url,opts),getLoras:async()=>[],addEventListener(){}}`);return}
  if(req.url==='/autocomplete-plus-plus/wildcards/all-data'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,wildcards:{'people/traveler':['traveler'],'style/watercolor':['watercolor']}}));return}
  if(req.url.startsWith('/sax/text-catalog/v2/catalogs')){
   res.setHeader('Content-Type','application/json');const send=(v,status=200)=>{res.statusCode=status;res.end(JSON.stringify(v))};
   if(req.method==='GET'){send(req.url.endsWith('catalogs')?{catalogs:[{id:doc.id,name:doc.name,revision:doc.revision}]}:doc);return}
   let text='';for await(const c of req)text+=c;const body=JSON.parse(text);calls.push({bytes:Buffer.byteLength(text),body});
   if(fail){send({error:'保存失敗'},500);return}if(conflict||body.base_revision!==doc.revision){conflict=false;doc.revision++;send({error:'別の画面で更新',current:doc},409);return}
   const {applyOperations}=await import(require('node:url').pathToFileURL(path.resolve(root,'js/sax_text_catalog_v2_client.js')).href);applyOperations(doc,body.operations);doc.revision++;send({id:doc.id,revision:doc.revision});return;
  }
  const target=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!target.startsWith(root+path.sep)){res.statusCode=403;res.end();return}if(!fs.existsSync(target)){res.statusCode=404;res.end();return}res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':'text/plain');res.end(fs.readFileSync(target));
 }catch(e){console.error('test server error',e);res.statusCode=500;res.end(e.message)}
});
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1280,height:950}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.setDefaultTimeout(10000);await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready&&window.shared()?.session);await page.evaluate(()=>draw());
 console.log('ready');await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await page.waitForSelector('.se-record');assert.ok(await page.locator('.se-record').count()<40);
 const compact=await page.locator('.sax-shared-editor').evaluate(e=>({height:e.querySelector('.se-scroll').clientHeight,header:e.querySelector('.se-header').clientHeight}));assert.ok(compact.height>740,JSON.stringify(compact));assert.ok(compact.header<=32,JSON.stringify(compact));assert.equal(await page.getByPlaceholder('一括操作するタグ').isVisible(),false);
 console.log('list visible');await page.locator('.se-record').first().getByRole('button',{name:'本文を編集',exact:true}).click();console.log('edit opened');const edit=page.getByRole('textbox',{name:'アイテム本文',exact:true});await edit.fill('更新された本文');console.log('filled');await page.evaluate(()=>{window.firstQueue=app.queuePrompt()});console.log('queue started');await page.waitForFunction(()=>shared().session.status==='saved'||shared().session.error);const saveError=await page.evaluate(()=>shared().session.error?.message);if(saveError)throw new Error(saveError);console.log('saved');await page.evaluate(()=>window.firstQueue);assert.equal(doc.catalog.items[0].text,'更新された本文');assert.ok(calls.at(-1).bytes<400);
 await page.evaluate(()=>{const s=document.querySelector('.se-scroll');s.scrollTop=s.scrollHeight;s.dispatchEvent(new Event('scroll'))});assert.ok(await page.locator('.se-record').count()<40);assert.equal(await edit.inputValue(),'更新された本文');await page.getByRole('button',{name:'閉じる',exact:true}).click();
 // 一覧で選択範囲へ挿入。ファイル検索中も編集中の行とカーソルを保持する。
 await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await page.locator('.se-record').first().getByRole('button',{name:'本文を編集',exact:true}).click();
 const wcArea=page.getByRole('textbox',{name:'アイテム本文',exact:true});await wcArea.fill('alpha SELECT omega');await wcArea.evaluate(e=>e.setSelectionRange(6,12));
 await page.getByRole('button',{name:'＋ ワイルドカード',exact:true}).click();await page.getByPlaceholder('ファイル名・フォルダー名を検索…').fill('people/traveler');await page.waitForFunction(()=>[...document.querySelectorAll('.__sax_text_catalog_v2_wc_picker button')].filter(e=>e.textContent==='Select').length===1);await page.getByRole('button',{name:'Select',exact:true}).click();
 assert.equal(await wcArea.inputValue(),'alpha __people/traveler__ omega');assert.equal(await wcArea.evaluate(e=>document.activeElement===e),true);await page.evaluate(()=>app.queuePrompt());assert.equal(doc.catalog.items[0].text,'alpha __people/traveler__ omega');
 await page.getByRole('button',{name:'＋ ワイルドカード',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await wcArea.inputValue(),'alpha __people/traveler__ omega');await wcArea.evaluate(e=>e.blur());

 await page.getByRole('button',{name:'一覧を全選択',exact:true}).click();
 assert.equal(await page.locator('.se-selection-tools .se-muted').textContent(),'10000件選択');
 await page.getByPlaceholder('名前・本文・タグを検索').fill('アイテム9999');
 await page.waitForFunction(()=>document.querySelectorAll('.se-record').length===1);
 await page.getByRole('button',{name:'一覧の選択を解除',exact:true}).click();
 assert.equal(await page.locator('.se-selection-tools .se-muted').textContent(),'9999件選択');
 await page.getByPlaceholder('名前・本文・タグを検索').fill('');
 await page.getByRole('button',{name:'すべて解除',exact:true}).click();
 // 全選択と選択解除に応じて一括操作を表示・収納する。
 await page.getByRole('checkbox',{name:'表示中のアイテムを全選択',exact:true}).check();assert.equal(await page.getByPlaceholder('一括操作するタグ').isVisible(),true);await page.getByRole('button',{name:'すべて解除',exact:true}).click();assert.equal(await page.getByPlaceholder('一括操作するタグ').isVisible(),false);
 // 拡大編集でも同じ検索ピッカーを使う。
 await page.locator('.se-record').first().getByRole('button',{name:'拡大',exact:true}).click();const large=page.getByRole('textbox',{name:'アイテム本文（拡大）',exact:true});await large.fill('');await page.getByRole('button',{name:'＋ ワイルドカード',exact:true}).click();await page.getByPlaceholder('ファイル名・フォルダー名を検索…').fill('style/watercolor');await page.waitForFunction(()=>[...document.querySelectorAll('.__sax_text_catalog_v2_wc_picker button')].filter(e=>e.textContent==='Select').length===1);await page.getByRole('button',{name:'Select',exact:true}).click();assert.equal(await large.inputValue(),'__style/watercolor__');await page.getByRole('button',{name:'閉じる',exact:true}).last().click();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 console.log('inline/wildcard/compact header passed'); // 行のアイテム編集は候補全件で絞り込まれる。
 await page.evaluate(()=>{const w=node.widgets.find(w=>w.name==='__sax_shared_sets');w.mouse({type:'pointerdown'},[170,48])});await page.waitForSelector('.se-record');assert.equal(await page.locator('.se-record').count(),5);
 await page.getByRole('button',{name:'閉じる',exact:true}).click();
 console.log('filter passed'); // セット編集と本文編集は分離されている。
 await page.evaluate(()=>{const w=node.widgets.find(w=>w.name==='__sax_shared_sets');w.mouse({type:'pointerdown'},[75,48])});await page.waitForSelector('.se-card');assert.equal(await page.locator('.se-card').count(),2);assert.equal(await page.locator('textarea').count(),0);
 const cardSize=await page.locator('.se-card').first().evaluate(e=>({height:e.offsetHeight,overflow:e.scrollWidth>e.clientWidth}));assert.ok(cardSize.height<=80&&!cardSize.overflow,JSON.stringify(cardSize));
 assert.ok(await page.locator('.se-candidate').count()<30);assert.equal(await page.locator('.se-candidate-copy>.se-muted').first().textContent(),doc.catalog.items[0].text);
 const originalRecipe=await page.evaluate(()=>structuredClone(shared().session.document.recipes[0]));
 await page.getByRole('combobox',{name:'構成要素の追加方法',exact:true}).selectOption('separate');
 await page.getByPlaceholder('名前・本文・タグを検索').fill('アイテム99');
 await page.getByRole('button',{name:'一覧を全選択',exact:true}).click();
 await page.getByRole('button',{name:'選んだアイテムを追加',exact:true}).click();
 assert.equal(await page.evaluate(()=>shared().session.document.recipes[0].groups.length),2);
 assert.equal(await page.locator('.se-selectionbar strong').textContent(),'111件選択');
 await page.getByRole('button',{name:'すべて解除',exact:true}).click();
 await page.getByPlaceholder('名前・本文・タグを検索').fill('');
 await page.locator('.se-candidate input').nth(0).click();await page.locator('.se-candidate input').nth(1).click();
 await page.getByRole('button',{name:'選んだアイテムを追加',exact:true}).click();
 assert.equal(await page.locator('.se-card').count(),4);
 assert.equal(await page.evaluate(()=>{const d=shared().session.document,g=d.recipes[0].groups.slice(-2);return g.every(x=>x.item_ids.length===1&&x.mode==='all'&&x.count===1&&x.name===d.catalog.items.find(i=>i.id===x.item_ids[0]).name)&&g[0].id!==g[1].id;}),true);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal(await page.locator('.se-card').count(),2);
 await page.getByRole('button',{name:'やり直す',exact:true}).click();assert.equal(await page.locator('.se-card').count(),4);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();
 await page.getByRole('combobox',{name:'構成要素の追加方法',exact:true}).selectOption('combined');

 await page.locator('.se-candidate input').nth(0).click();await page.locator('.se-candidate input').nth(4).click({modifiers:['Shift']});assert.equal(await page.locator('.se-selectionbar strong').textContent(),'5件選択');
 await page.getByRole('checkbox',{name:'選択済みだけ',exact:true}).check();assert.equal(await page.locator('.se-candidate').count(),5);
 await page.getByRole('button',{name:'一覧の選択を解除',exact:true}).click();assert.equal(await page.locator('.se-candidate').count(),0);assert.equal(await page.locator('.se-selectionbar strong').textContent(),'0件選択');
 await page.getByRole('checkbox',{name:'選択済みだけ',exact:true}).uncheck();await page.getByPlaceholder('名前・本文・タグを検索').fill('アイテム99');
 await page.getByRole('button',{name:'一覧を全選択',exact:true}).click();assert.equal(await page.locator('.se-selectionbar strong').textContent(),'111件選択');
 await page.getByPlaceholder('名前・本文・タグを検索').fill('アイテム0');assert.equal(await page.locator('.se-selectionbar strong').textContent(),'111件選択');
 await page.getByRole('button',{name:'選んだアイテムを追加',exact:true}).click();assert.equal(await page.locator('.se-card').count(),3);
 assert.equal(await page.evaluate(()=>{const d=shared().session.document,g=d.recipes[0].groups.at(-1);return g.name===d.catalog.items.find(i=>i.id===g.item_ids[0]).name;}),true);
 assert.equal(await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).item_ids.length),111);
 const addedIds=await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).item_ids.slice());
 await page.locator('.se-card').last().getByRole('button',{name:'出力順',exact:true}).click();
 assert.ok(await page.locator('.se-order-item').count()<40);
 await page.locator('.se-order-item').first().getByRole('button',{name:'アイテムを下へ',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).item_ids.slice(0,2)),[addedIds[1],addedIds[0]]);
 await page.locator('.se-order-item input').first().fill('111');await page.locator('.se-order-item input').first().press('Enter');
 assert.equal(await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).item_ids.at(-1)),addedIds[1]);
 const dragFirst=await page.locator('.se-order-item').first().getAttribute('data-item-id');
 await page.locator('.se-order-handle').first().dragTo(page.locator('.se-order-item').nth(2));
 assert.equal(await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).item_ids[2]),dragFirst);
 await page.locator('.se-order-handle').nth(2).focus();await page.keyboard.press('ArrowUp');
 assert.equal(await page.evaluate(()=>document.activeElement.closest('.se-order-item')?.dataset.itemId),dragFirst);
 const orderedIds=await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).item_ids.slice());
 await page.locator('.se-card').last().getByRole('button',{name:'候補を変更',exact:true}).click();assert.equal(await page.getByRole('checkbox',{name:'選択済みだけ',exact:true}).isChecked(),true);assert.equal(await page.locator('.se-selectionbar strong').textContent(),'111件選択');
 const removedId=await page.locator('.se-candidate').first().getAttribute('data-item-id');await page.locator('.se-candidate input').first().click();await page.getByRole('button',{name:'候補を更新',exact:true}).click();assert.deepEqual(await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).item_ids),orderedIds.filter(id=>id!==removedId));
 await page.screenshot({path:path.join(root,'work/shared-v2-compact-sets.png')});
 // ネスト作成、既存leafの階層移動、折りたたみ、直下の子をランダム選択。
 await page.getByRole('button',{name:'＋ ネスト',exact:true}).click();
 const nestedId=await page.evaluate(()=>shared().session.document.recipes[0].groups.at(-1).id);
 await page.locator('[data-group-id="g1"]').getByRole('button',{name:'候補を変更',exact:true}).click();
 await page.getByRole('combobox',{name:'構成要素の配置先',exact:true}).selectOption(nestedId);
 await page.getByRole('button',{name:'候補を更新',exact:true}).click();
 assert.equal(await page.locator('[data-group-id="g1"]').getAttribute('data-depth'),'1');
 const nestedCard=page.locator(`[data-group-id="${nestedId}"]`);
 await nestedCard.getByRole('button',{name:'子の構成要素を開閉',exact:true}).click();
 assert.equal(await page.locator('[data-group-id="g1"]').count(),0);
 await nestedCard.getByRole('button',{name:'子の構成要素を開閉',exact:true}).click();
 await page.locator('[data-group-id="g2"]>.se-row').first().locator('span').first().dragTo(nestedCard,{targetPosition:{x:30,y:35}});
 assert.deepEqual(await page.evaluate(id=>shared().session.document.recipes[0].groups.find(g=>g.id===id).groups.map(g=>g.id),nestedId),['g1','g2']);
 await page.locator('[data-group-id="g2"]>.se-row').first().locator('span').first().dragTo(page.locator('[data-group-id="g1"]'),{targetPosition:{x:30,y:68}});
 assert.deepEqual(await page.evaluate(id=>shared().session.document.recipes[0].groups.find(g=>g.id===id).groups.map(g=>g.id),nestedId),['g1','g2']);
 await nestedCard.locator('select').selectOption('random');
 await nestedCard.getByRole('spinbutton').fill('1'); await nestedCard.getByRole('spinbutton').dispatchEvent('change');
 assert.equal(await page.evaluate(id=>shared().session.document.recipes[0].groups.find(g=>g.id===id).mode,nestedId),'random');
 await nestedCard.getByRole('button',{name:'候補を変更',exact:true}).click();
 assert.equal(await page.getByRole('combobox',{name:'ネストの配置先',exact:true}).locator(`option[value="${nestedId}"]`).count(),0);
 await page.getByRole('button',{name:'ここにアイテムを追加',exact:true}).click();
 await page.getByRole('button',{name:'＋ ネスト',exact:true}).click();
 const childId=await page.evaluate(id=>shared().session.document.recipes[0].groups.find(g=>g.id===id).groups.at(-1).id,nestedId);
 assert.equal(await page.locator(`[data-group-id="${childId}"]`).getAttribute('data-depth'),'1');
 await nestedCard.getByRole('button',{name:'候補を変更',exact:true}).click();
 assert.equal(await page.getByRole('combobox',{name:'ネストの配置先',exact:true}).locator(`option[value="${childId}"]`).count(),0);
 await page.getByRole('button',{name:'閉じる',exact:true}).last().click();
 await page.screenshot({path:path.join(root,'work/shared-v2-nested-sets.png')});
 console.log('nested create/move/drag/collapse/random/cycle protection passed');

 await page.evaluate(recipe=>shared().session.mutate([{type:'recipe.put',recipe}]),originalRecipe);await page.getByRole('button',{name:'閉じる',exact:true}).click();
 console.log('sets passed'); // 全行表示と並び替え、有効切替。
 const rows=await page.evaluate(()=>{const w=node.widgets.find(w=>w.name==='__sax_shared_sets');w.mouse({type:'pointerdown',clientY:100},[45,25]);window.dispatchEvent(new PointerEvent('pointerup',{clientY:152}));w.mouse({type:'pointerdown'},[20,25]);return JSON.parse(node.widgets[0].value).rows});assert.equal(rows[0].recipe_id,'s2');assert.equal(rows[0].on,false);
 await page.evaluate(()=>{const g=shared().session.document.recipes[0].groups;Type.prototype.onExecuted.call(node,{text:['実行時出力'],selection_json:[JSON.stringify({version:3,catalog_id:'browser-test',revision:1,seed:123,rows:[{id:'r1',recipe_id:'s1',name:'旅人',on:true,groups:g.map(v=>({...v,group_id:v.id,candidate_ids:v.item_ids,item_ids:v.item_ids.slice(0,2),items:v.item_ids.slice(0,2).map(id=>({id,name:'実行時'+id,text:'実行時本文',tags:[]}))}))}]})]})});
 await page.getByRole('button',{name:'前回の実行結果',exact:true}).first().click();await page.waitForSelector('.se-section');assert.equal(await page.locator('.se-section').count(),3);await page.locator('.se-record').first().getByRole('button',{name:'本文を編集',exact:true}).click();await page.getByRole('textbox',{name:'アイテム本文',exact:true}).fill('結果から修正');await page.evaluate(()=>app.queuePrompt());assert.equal(doc.catalog.items[0].text,'結果から修正');await page.getByRole('button',{name:'出力テキスト',exact:true}).click();assert.equal(await page.locator('.se-result-text').inputValue(),'実行時出力');await page.getByRole('button',{name:'閉じる',exact:true}).click();
 console.log('results passed'); // 保存失敗時はQueueしない。未保存本文を保持する。
 fail=true;const queued=await page.evaluate(()=>window.queued);await page.evaluate(()=>shared().session.mutate([{type:'item.put',item:{...shared().session.document.catalog.items[0],text:'未保存'}}]));
 await page.evaluate(()=>{window.failedQueue=app.queuePrompt().catch(()=>{})});await page.getByRole('button',{name:'OK',exact:true}).click();await page.evaluate(()=>window.failedQueue);assert.equal(await page.evaluate(()=>window.queued),queued);assert.equal(await page.evaluate(()=>shared().session.document.catalog.items[0].text),'未保存');fail=false;await page.evaluate(()=>shared().session.retry());
 // 狭い画面でも本文欄を表示。正常保存時には競合欄を表示しない。
 await page.setViewportSize({width:600,height:900});await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await page.waitForSelector('.se-record');assert.equal(await page.locator('.se-conflict').isVisible(),false);fs.mkdirSync(path.join(root,'work'),{recursive:true});await page.screenshot({path:root+'/work/shared-v2-mobile.png'});await page.setViewportSize({width:1400,height:950});await page.screenshot({path:root+'/work/shared-v2-desktop.png'});await page.getByRole('button',{name:'閉じる',exact:true}).click();

 // 複製は最新の編集中本文を取り込み、独立したIDを作る。セット参照は変更しない。
 doc=fixture(10);await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await page.waitForSelector('.se-record');
 const beforeDuplicate=await page.evaluate(()=>structuredClone(shared().session.document));
 await page.locator('.se-record[data-item-id="i0"]').getByRole('button',{name:'本文を編集',exact:true}).click();
 await page.getByRole('textbox',{name:'アイテム本文',exact:true}).fill('複製直前の本文');
 await page.locator('.se-record[data-item-id="i0"]').getByRole('button',{name:'複製',exact:true}).click();
 const copied=await page.evaluate(()=>shared().session.document.catalog.items.at(-1));
 assert.notEqual(copied.id,'i0');assert.equal(copied.name,'アイテム0 コピー');assert.equal(copied.text,'複製直前の本文');assert.deepEqual(copied.tags,['tag0']);
 assert.deepEqual(await page.evaluate(()=>shared().session.document.recipes),beforeDuplicate.recipes);
 assert.equal(await page.getByRole('textbox',{name:'アイテム名',exact:true}).inputValue(),copied.name);
 await page.getByRole('textbox',{name:'アイテム名',exact:true}).press('Enter');
 const actions=page.locator(`[data-item-id="${copied.id}"] .se-item-actions`);
 assert.ok(await actions.evaluate(e=>{const [a,b]=e.children;return a.offsetTop===b.offsetTop&&e.scrollWidth<=e.clientWidth}));
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal(await page.evaluate(id=>shared().session.document.catalog.items.some(i=>i.id===id),copied.id),false);
 await page.getByRole('button',{name:'やり直す',exact:true}).click();
 await page.locator(`[data-item-id="${copied.id}"]`).getByRole('button',{name:'本文を編集',exact:true}).click();await page.getByRole('textbox',{name:'アイテム本文',exact:true}).fill('コピーだけ変更');await page.evaluate(()=>app.queuePrompt());
 assert.equal(doc.catalog.items.find(i=>i.id==='i0').text,'複製直前の本文');assert.equal(doc.catalog.items.find(i=>i.id===copied.id).text,'コピーだけ変更');
 await page.getByRole('button',{name:'閉じる',exact:true}).click();console.log('duplicate latest text/independent ID/tags/references/Undo/Redo/save passed');
 const measurements=[];
 await page.setViewportSize({width:1280,height:950});
 for (const [count,size] of [[1000,100],[10000,100],[10000,2000]]) {
  doc=fixture(count,size);const started=performance.now();
  await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await page.waitForSelector('.se-record');
  await page.getByRole('combobox',{name:'テキストセットで絞り込み',exact:true}).selectOption('');
  const nodes=await page.locator('.se-record').count();assert.ok(nodes<40);
  const opened=performance.now();await page.locator('.se-record').first().getByRole('button',{name:'本文を編集',exact:true}).click();
  await page.getByRole('textbox',{name:'アイテム本文',exact:true}).fill('性能確認の本文');await page.evaluate(()=>app.queuePrompt());
  const finished=performance.now(),referenceBytes=await page.evaluate(()=>new TextEncoder().encode(node.widgets.find(w=>w.name==='config_json').value).length);assert.ok(referenceBytes<500);
  measurements.push({count,textChars:size,openMs:Math.round(opened-started),editAndQueueMs:Math.round(finished-opened),visibleRows:nodes,workflowReferenceBytes:referenceBytes,patchBytes:calls.at(-1).bytes});
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
 }
 await page.evaluate(()=>{const legacy={...node,widgets:[{name:'config_json',value:JSON.stringify({version:2,catalog:{items:[{id:'a',name:'A',text:'本文',tags:['共通','背景']},{id:'b',name:'B',text:'別',tags:['共通']}]},recipes:[{id:'s',name:'セット',groups:[]}],active_recipe_id:'s'})},{name:'seed',value:1}]};Type.prototype.onNodeCreated.call(legacy);legacy.widgets.find(w=>w.name==='管理・編集'||w.name==='カタログを開く').callback();});
 await page.locator('.cv2-filter summary').click();
 await page.getByRole('checkbox',{name:'共通で絞り込み',exact:true}).check();await page.getByRole('checkbox',{name:'背景で絞り込み',exact:true}).check();
 assert.equal(await page.locator('.cv2-item').count(),1);
 await page.getByPlaceholder('名前・本文・タグを検索').click();assert.equal(await page.locator('.cv2-filter').evaluate(n=>n.open),false);
 await page.getByRole('button',{name:'閉じる',exact:true}).click();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:'Edge',checks:'inline/queue/filter/set/result/drag/failure/mobile/embedded-multi-tag',measurements,patchBytes:calls.map(c=>c.bytes),errors}));
 }finally{await browser?.close();server.close()}})().catch(e=>{console.error(e);process.exitCode=1});
