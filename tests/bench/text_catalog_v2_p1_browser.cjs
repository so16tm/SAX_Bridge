// Text Catalog V2 使い勝手改善 P1（Esc/Undo・カタログ切替確認・新規名前選択・1件削除・検索保持と正規化・欄近傍エラー・初期行）の実ブラウザ確認。
// SAX_PLAYWRIGHT_PATH に Playwright のインストール先を、SAX_BROWSER_PATH にブラウザ実行ファイルを指定できる。
const {chromium}=require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const makeDoc=(id,name,count=30)=>({version:3,id,name,revision:1,catalog:{items:Array.from({length:count},(_,i)=>({id:`${id}-i${i}`,name:`アイテム${i}`,text:`本文${i} `+'x'.repeat(40),tags:[`tag${i%10}`]}))},recipes:[
 {id:'s1',name:'旅人',groups:[{id:'g1',name:'人物',mode:'all',on:true,count:1,item_ids:[`${id}-i0`,`${id}-i1`]},{id:'g2',name:'背景',mode:'random',on:true,count:2,item_ids:[`${id}-i2`,`${id}-i3`,`${id}-i4`]}]},
 {id:'s2',name:'水彩',groups:[{id:'g3',name:'質感',mode:'all',on:true,count:1,item_ids:[`${id}-i0`]}]}]});
const docs=new Map([['one',makeDoc('one','カタログ1')],['two',makeDoc('two','カタログ2')]]);
const appScript=`export const app={extensions:[],registerExtension(e){this.extensions.push(e)},graph:{_nodes:[],change(){}},canvas:{setDirty(){},ds:{scale:1}},async queuePrompt(){return []}};window.app=app;`;
const html=`<style>body{background:#18181b;color:#ddd;font:14px system-ui}button{padding:8px}canvas{display:block}</style><div id="controls"></div><canvas width="450" height="750"></canvas><script type="module">
import {app} from '/scripts/app.js'; import '/js/sax_text_catalog_v2.js'; import {sharedController} from '/js/sax_text_catalog_v2_shared.js';
const Type=function(){}; const ext=app.extensions.find(e=>e.name==='SAX.TextCatalogV2');ext.beforeRegisterNodeDef(Type,{name:'SAX_Bridge_Text_Catalog_V2'});ext.setup();
const node={type:'SAX_Bridge_Text_Catalog_V2',comfyClass:'SAX_Bridge_Text_Catalog_V2',widgets:[{name:'config_json',value:JSON.stringify({version:3,catalog_id:'one',rows:[{id:'r1',recipe_id:'s1',on:true},{id:'r2',recipe_id:'s2',on:true}]})},{name:'seed',value:123}],size:[450,500],graph:app.graph,addWidget(type,name,value,callback,options){const w={type,name,value,callback,options};this.widgets.push(w);return w},addCustomWidget(w){this.widgets.push(w);return w},setSize(s){this.size=s},computeSize(){return [450,500]},setDirtyCanvas(){}};
app.graph._nodes.push(node); Type.prototype.onNodeCreated.call(node);window.node=node;window.shared=()=>sharedController(node);
window.config=()=>JSON.parse(node.widgets.find(w=>w.name==='config_json').value);
window.setConfig=ref=>{node.widgets.find(w=>w.name==='config_json').value=JSON.stringify(ref)};
window.ready=true;
</script>`;
const server=http.createServer(async(req,res)=>{
 try {
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return}
  if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return}
  if(req.url==='/scripts/app.js'){res.setHeader('Content-Type','text/javascript');res.end(appScript);return}
  if(req.url==='/scripts/api.js'){res.setHeader('Content-Type','text/javascript');res.end(`export const api={fetchApi:(url,opts)=>fetch(url,opts),getLoras:async()=>[],addEventListener(){}}`);return}
  if(req.url==='/autocomplete-plus-plus/wildcards/all-data'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,wildcards:{}}));return}
  if(req.url.startsWith('/sax/text-catalog/v2/catalogs')){
   res.setHeader('Content-Type','application/json');const send=(v,status=200)=>{res.statusCode=status;res.end(JSON.stringify(v))};
   const id=decodeURIComponent(req.url.split('/').at(-1));
   if(req.method==='GET'){send(id==='catalogs'?{catalogs:[...docs.values()].map(({id,name,revision})=>({id,name,revision}))}:docs.get(id));return}
   let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
   if(req.method==='POST'){const source=body.document??body;const created={version:3,id:`new${docs.size}`,name:source.name??'新しいカタログ',revision:1,catalog:source.catalog??{items:[]},recipes:source.recipes??[{id:'default',name:'テキストセット 1',groups:[]}]};docs.set(created.id,created);send(created);return}
   const doc=docs.get(id);const {applyOperations}=await import(require('node:url').pathToFileURL(path.resolve(root,'js/sax_text_catalog_v2_client.js')).href);applyOperations(doc,body.operations);doc.revision++;send({id:doc.id,revision:doc.revision});return;
  }
  const target=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!target.startsWith(root+path.sep)){res.statusCode=403;res.end();return}if(!fs.existsSync(target)){res.statusCode=404;res.end();return}res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':'text/plain');res.end(fs.readFileSync(target));
 }catch(e){console.error('test server error',e);res.statusCode=500;res.end(e.message)}
});
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 browser=await chromium.launch({headless:true,...(process.env.SAX_BROWSER_PATH?{executablePath:process.env.SAX_BROWSER_PATH,args:['--no-sandbox']}:{channel:'msedge'})});
 const page=await browser.newPage({viewport:{width:1280,height:950}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready&&window.shared()?.session);
 const editor=page.locator('.sax-shared-editor'),records=()=>page.locator('.se-record');
 const openItems=async()=>{await page.evaluate(()=>window.shared().session&&node.widgets.find(w=>w.name==='アイテム').callback());await editor.waitFor();await records().first().waitFor()};
 const settle=()=>page.waitForFunction(()=>shared().session.status==='saved');
 const names=()=>records().evaluateAll(rows=>rows.map(r=>r.querySelector('.se-cell').textContent));

 // 1-1 Esc: 入力欄外で閉じる。インライン編集・タグ展開・確認ダイアログ・IME変換中は一番上だけが反応する。
 await openItems();
 await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});
 await openItems();
 await records().first().getByRole('button',{name:'名前を編集',exact:true}).click();
 await page.keyboard.press('Escape');assert.equal(await editor.count(),1,'インライン編集のEscでエディタまで閉じない');
 assert.equal(await page.getByRole('textbox',{name:'アイテム名',exact:true}).count(),0);
 await page.locator('.se-tag-filter > summary').click();assert.equal(await page.locator('.se-tag-filter[open]').count(),1);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.se-tag-filter[open]').count(),0);assert.equal(await editor.count(),1,'タグ絞り込みのEscでエディタまで閉じない');
 await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true})));assert.equal(await editor.count(),1,'IME変換中のEscでは閉じない');
 await records().first().getByRole('button',{name:'削除',exact:true}).click();
 await page.getByRole('button',{name:'キャンセル',exact:true}).waitFor();
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'キャンセル',exact:true}).count(),0,'確認ダイアログが閉じる');assert.equal(await editor.count(),1,'確認ダイアログのEscでエディタまで閉じない');
 await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});
 console.log('1-1 Esc passed');

 // 1-1 Undo/Redo: 入力欄の外だけ。入力欄内はブラウザ標準の履歴のまま。
 await openItems();
 await records().first().getByRole('button',{name:'複製',exact:true}).click();
 await page.getByRole('textbox',{name:'アイテム名',exact:true}).press('Enter');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='アイテム本文');await page.keyboard.press('Escape');
 await settle();const added=(await page.evaluate(()=>shared().session.document.catalog.items.length));assert.equal(added,31);
 await page.locator('.se-header').click({position:{x:5,y:5}});
 await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>shared().session.document.catalog.items.length),30,'Ctrl+Zで複製が戻る');
 await page.keyboard.press('Control+Shift+Z');await settle();assert.equal(await page.evaluate(()=>shared().session.document.catalog.items.length),31,'Ctrl+Shift+Zでやり直す');
 await page.keyboard.press('Control+z');await settle();await page.keyboard.press('Control+y');await settle();assert.equal(await page.evaluate(()=>shared().session.document.catalog.items.length),31,'Ctrl+Yでやり直す');
 const search=page.getByPlaceholder('名前・本文・タグを検索',{exact:false});await search.fill('アイテム');await search.press('Control+z');await settle();assert.equal(await page.evaluate(()=>shared().session.document.catalog.items.length),31,'検索欄のCtrl+Zはエディタの元に戻すを動かさない');
 await search.fill('');await page.getByRole('button',{name:'元に戻す',exact:true}).click();await settle();
 console.log('1-1 Undo/Redo passed');

 // 1-3 新規アイテム: 名前が全選択され、Enterで本文編集へ進む。
 await page.getByRole('button',{name:'＋ アイテム',exact:true}).click();
 const nameBox=page.getByRole('textbox',{name:'アイテム名',exact:true});await nameBox.waitFor();
 assert.deepEqual(await nameBox.evaluate(e=>[e.selectionStart,e.selectionEnd]),[0,'新しいアイテム'.length],'名前が全選択される');
 await page.keyboard.type('ABC');assert.equal(await nameBox.inputValue(),'ABC');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='アイテム本文');await page.keyboard.press('Escape');
 await settle();assert.ok(await page.evaluate(()=>shared().session.document.catalog.items.some(i=>i.name==='ABC')));
 console.log('1-3 new item passed');

 // 1-4 行から1件削除: 確認文に使用中の構成要素数とセット数。キャンセルで変化なし、削除後はUndoで参照も復元。
 await search.fill('アイテム0');
 await page.waitForFunction(()=>document.querySelectorAll('.se-record').length>=1);
 const row0=records().filter({has:page.locator('.se-cell',{hasText:/^アイテム0$/})}).first();
 await row0.getByRole('button',{name:'削除',exact:true}).click();
 const dialogText=await page.locator('.__sax_confirm_dlg').innerText();assert.match(dialogText,/「アイテム0」を削除します/);assert.match(dialogText,/使用中の構成要素 2件・セット 2件から外れます/);
 await page.getByRole('button',{name:'キャンセル',exact:true}).click();assert.ok(await page.evaluate(()=>shared().session.document.catalog.items.some(i=>i.id==='one-i0')));
 await row0.getByRole('button',{name:'削除',exact:true}).click();await page.locator('.__sax_confirm_dlg').getByRole('button',{name:'削除',exact:true}).click();
 await settle();assert.equal(await page.evaluate(()=>shared().session.document.catalog.items.some(i=>i.id==='one-i0')),false);
 assert.equal(await page.evaluate(()=>shared().session.document.recipes.flatMap(r=>r.groups).some(g=>g.item_ids.includes('one-i0'))),false);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();await settle();
 assert.equal(await page.evaluate(()=>shared().session.document.recipes[0].groups[0].item_ids.includes('one-i0')&&shared().session.document.recipes[1].groups[0].item_ids.includes('one-i0')),true,'Undoで参照も復元');
 console.log('1-4 delete passed');

 // 1-6 検索: 空白区切りAND、全角半角・大文字小文字を区別しない。
 await search.fill('ｱｲﾃﾑ1  ＴＡＧ1');
 await page.waitForFunction(()=>document.querySelectorAll('.se-record').length===2);
 assert.deepEqual((await names()).sort(),['アイテム1','アイテム11']);
 console.log('1-6 search passed');

 // 1-5 検索語・タグ・スクロール位置はモードを切り替えても保持される。
 await search.fill('アイテム');
 await page.locator('.se-tag-filter > summary').click();await page.getByRole('checkbox',{name:'tag1で絞り込み',exact:true}).check();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'テキストセット',exact:true}).click();await page.locator('.se-layout').waitFor();
 await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await records().first().waitFor();
 assert.equal(await search.inputValue(),'アイテム');assert.match(await page.locator('.se-tag-filter > summary').textContent(),/tag1/);
 await page.locator('.se-tag-filter > summary').click();await page.getByRole('button',{name:'タグ絞り込みを解除',exact:true}).click();await page.keyboard.press('Escape');await search.fill('');
 await page.waitForFunction(()=>document.querySelectorAll('.se-record').length>5);
 await page.evaluate(()=>{const s=document.querySelector('.se-scroll');s.scrollTop=150;s.dispatchEvent(new Event('scroll'))});
 await page.getByRole('button',{name:'テキストセット',exact:true}).click();await page.locator('.se-layout').waitFor();
 await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await records().first().waitFor();
 assert.equal(await page.evaluate(()=>document.querySelector(".se-scroll").scrollTop),150,'スクロール位置が戻る');
 console.log('1-5 persistence passed');

 // 1-7 欄近傍のエラー: ランダム件数・タグ。
 await page.getByRole('button',{name:'テキストセット',exact:true}).click();await page.locator('.se-card').first().waitFor();
 const count=page.getByRole('textbox',{name:/ランダム件数/}).first();await count.fill('99');
 assert.equal(await count.getAttribute('aria-invalid'),'true');assert.match(await count.evaluate(e=>e.parentElement.nextElementSibling.textContent),/上限/);
 await count.fill('1');assert.equal(await count.getAttribute('aria-invalid'),null);assert.equal(await page.locator('.se-field-error').count(),0);
 await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await records().first().waitFor();
 await records().first().getByRole('button',{name:'タグを編集',exact:true}).click();
 const tags=page.getByRole('textbox',{name:'アイテムタグ',exact:true});await tags.fill('a,b,c,d,e,f,g,h,i');
 assert.equal(await tags.getAttribute('aria-invalid'),'true');assert.match(await page.locator('.se-field-error').innerText(),/最大8件/);
 await tags.fill('a,b,c');assert.equal(await page.locator('.se-field-error').count(),0);await page.keyboard.press('Escape');
 console.log('1-7 field errors passed');
 await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});

 // 1-2 / 1-8 カタログ切替・新規・インポートの確認と初期行。
 const label=id=>`${docs.get(id).name} · ${id.slice(0,8)}`;
 const callSwitch=id=>page.evaluate(l=>node.widgets.find(w=>w.name==='カタログ').callback(l),label(id));
 const before=await page.evaluate(()=>node.widgets[0].value);
 const switching=callSwitch('two');await page.locator('.__sax_confirm_dlg').waitFor();assert.match(await page.locator('.__sax_confirm_dlg').innerText(),/2行/);
 await page.locator('.__sax_confirm_dlg').getByRole('button',{name:'キャンセル',exact:true}).click();await switching;
 assert.equal(await page.evaluate(()=>node.widgets[0].value),before,'キャンセルで参照も行も変わらない');
 await callSwitch('one');assert.equal(await page.evaluate(()=>node.widgets[0].value),before,'同じカタログを選んでも行は消えない');
 const accepted=callSwitch('two');await page.locator('.__sax_confirm_dlg').getByRole('button',{name:'切り替え',exact:true}).click();await accepted;
 assert.deepEqual(await page.evaluate(()=>config().rows),[]);assert.equal(await page.evaluate(()=>config().catalog_id),'two');
 await callSwitch('one');await page.waitForFunction(()=>config().catalog_id==='one'); // 行が0件のときは確認なし
 await page.evaluate(()=>setConfig({version:3,catalog_id:'one',rows:[{id:'r1',recipe_id:'s1',on:true}]}));
 const manage=async()=>{await page.evaluate(()=>node.widgets.find(w=>w.name==='カタログ作成・入出力').callback())};
 await manage();await page.getByRole('button',{name:'新しいカタログ',exact:true}).click();
 await page.locator('.__sax_confirm_dlg').getByRole('button',{name:'キャンセル',exact:true}).click();assert.equal(docs.size,2,'キャンセルではカタログを作らない');
 await page.getByRole('button',{name:'新しいカタログ',exact:true}).click();await page.locator('.__sax_confirm_dlg').getByRole('button',{name:'作成',exact:true}).click();
 await page.locator('.__sax_prompt_dlg input').fill('作成テスト');await page.locator('.__sax_prompt_dlg').getByRole('button',{name:'OK',exact:true}).click();
 await page.waitForFunction(()=>config().catalog_id!=='one');
 const created=await page.evaluate(()=>config());assert.equal(created.rows.length,1,'新規カタログは既定セットが1行目');assert.equal(created.rows[0].recipe_id,'default');assert.equal(created.rows[0].on,true);
 const importFile=async(doc)=>{await manage();await page.locator('input[type=file]').setInputFiles({name:'import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))})};
 await page.evaluate(()=>setConfig({...config(),rows:[]}));
 await importFile({version:3,name:'単一',catalog:{items:[]},recipes:[{id:'only',name:'唯一',groups:[]}]});
 await page.waitForFunction(()=>config().rows.length===1);assert.equal(await page.evaluate(()=>config().rows[0].recipe_id),'only','セットが1件のインポートは1行目に追加');
 await page.evaluate(()=>setConfig({...config(),rows:[]}));
 await importFile({version:3,name:'複数',catalog:{items:[]},recipes:[{id:'a',name:'A',groups:[]},{id:'b',name:'B',groups:[]}]});
 await page.waitForFunction(id=>config().catalog_id.startsWith('new')&&config().catalog_id!==id,created.catalog_id);assert.deepEqual(await page.evaluate(()=>config().rows),[],'セットが複数のインポートは行を追加しない');
 console.log('1-2/1-8 catalog switch passed');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:'ok',errors}));
}catch(error){console.error(error);process.exitCode=1}finally{await browser?.close();server.close()}})();
