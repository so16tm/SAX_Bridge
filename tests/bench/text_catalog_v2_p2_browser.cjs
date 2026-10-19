// Text Catalog V2 使い勝手改善 P2（使用数・セットへ追加・使用中表示・プレビュー・タグ補完・Tab 移動）の実ブラウザ確認。ノード行のピッカーは text_catalog_v2_widget_browser.cjs。
// SAX_PLAYWRIGHT_PATH に Playwright のインストール先を、SAX_BROWSER_PATH にブラウザ実行ファイルを指定できる。
const {chromium}=require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const makeDoc=(id,name,count=30)=>({version:3,id,name,revision:1,catalog:{items:Array.from({length:count},(_,i)=>({id:`${id}-i${i}`,name:`アイテム${i}`,text:`本文${i} `+'x'.repeat(40),tags:[`tag${i%10}`]}))},recipes:[
 {id:'s1',name:'旅人',groups:[{id:'g1',name:'人物',mode:'all',on:true,count:1,item_ids:[`${id}-i0`,`${id}-i1`]},{id:'g2',name:'背景',mode:'random',on:true,count:2,item_ids:[`${id}-i2`,`${id}-i3`,`${id}-i4`]}]},
 {id:'s2',name:'水彩',groups:[{id:'g3',name:'質感',mode:'all',on:true,count:1,item_ids:[`${id}-i0`]}]},
 {id:'full',name:'満杯',groups:Array.from({length:31},(_,i)=>({id:`f${i}`,name:`枠${i}`,mode:'all',on:true,count:1,item_ids:[`${id}-i29`]}))}]});
const log=[];
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
   if(req.url.endsWith('/preview')){const pid=decodeURIComponent(req.url.split('/').at(-2));const doc=docs.get(pid);log.push({type:'preview',body,name:doc.recipes.find(r=>r.id===body.recipe_id)?.groups[0]?.name,revision:doc.revision});
    if(body.seed===77)await new Promise(r=>setTimeout(r,700));
    if(body.seed===13){send({error:'SAX Text Catalog V2 / count: 選択数が有効かつ正の重みを持つ候補数を超えています'},400);return}
    send({text:`seed=${body.seed}\n`+doc.recipes.find(r=>r.id===body.recipe_id).groups.map(g=>g.name).join('/'),revision:doc.revision,seed:body.seed});return}
   if(req.method==='POST'){const source=body.document??body;const created={version:3,id:`new${docs.size}`,name:source.name??'新しいカタログ',revision:1,catalog:source.catalog??{items:[]},recipes:source.recipes??[{id:'default',name:'テキストセット 1',groups:[]}]};docs.set(created.id,created);send(created);return}
   const doc=docs.get(id);log.push({type:'patch',operations:body.operations.map(o=>o.type)});const {applyOperations}=await import(require('node:url').pathToFileURL(path.resolve(root,'js/sax_text_catalog_v2_client.js')).href);applyOperations(doc,body.operations);doc.revision++;send({id:doc.id,revision:doc.revision});return;
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

 const row=name=>records().filter({has:page.locator('.se-cell',{hasText:new RegExp(`^${name}$`)})}).first();
 const picker=page.locator('.sax-picker-dialog');
 const docOne=()=>page.evaluate(()=>shared().session.document);

 // 2-1 使用数: 「使用 N」が出て、クリックで使用セットを選び、そのセットの編集へ移る。数は削除確認と一致する。
 await openItems();
 const search=page.getByPlaceholder('名前・本文・タグを検索',{exact:false});
 await search.fill('アイテム0');await page.waitForFunction(()=>document.querySelectorAll('.se-record').length>=1);
 const usage0=row('アイテム0').getByRole('button',{name:/使用/});assert.equal((await usage0.textContent()).trim(),'使用 2');
 await row('アイテム0').getByRole('button',{name:'削除',exact:true}).click();
 assert.match(await page.locator('.__sax_confirm_dlg').innerText(),/使用中の構成要素 2件・セット 2件/);await page.getByRole('button',{name:'キャンセル',exact:true}).click();
 await usage0.click();await picker.waitFor();
 assert.match(await picker.innerText(),/使用中の構成要素 2件・セット 2件/);
 assert.deepEqual(await picker.getByRole('option').allTextContents(),['旅人','水彩'].map(n=>n).sort((a,b)=>a.localeCompare(b,'ja')).map(n=>n));
 await page.keyboard.press('Escape');await picker.waitFor({state:'detached'});assert.equal(await editor.count(),1,'ピッカーのEscでエディタまで閉じない');
 // 編集中に「使用 N」を開いて閉じても、編集欄が管理外のまま残らない（残ると次の入力で消える）。
 await row('アイテム0').getByRole('button',{name:'名前を編集',exact:true}).click();await page.locator('.se-record input:not([type=checkbox])').first().waitFor();
 await page.locator('.se-record:has(input:not([type=checkbox]))').getByRole('button',{name:/使用/}).click();await picker.waitFor();await page.keyboard.press('Escape');await picker.waitFor({state:'detached'});
 await page.waitForTimeout(300);assert.equal(await page.locator('.se-record input:not([type=checkbox])').count(),0,'使用先ピッカーを閉じたあとに編集欄が残らない');
 await usage0.click();await picker.getByRole('option',{name:'水彩'}).click();
 await page.locator('.se-layout').waitFor();assert.equal(await page.locator('.se-picker[aria-label="編集するテキストセット"]').getAttribute('data-value'),'s2','選んだセットの編集へ移る');
 await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await records().first().waitFor();
 await search.fill('アイテム10');await page.waitForFunction(()=>[...document.querySelectorAll('.se-record')].some(r=>r.querySelector('.se-cell').textContent==='アイテム10'));
 assert.equal(await row('アイテム10').getByRole('button',{name:/使用/}).isDisabled(),true,'未使用は押せない');assert.equal((await row('アイテム10').getByRole('button',{name:/使用/}).textContent()).trim(),'使用 0');
 console.log('2-1 usage passed');

 // 2-2 一括バーの「セットへ追加」: アイテムごとに分けて追加。上限超過は全件拒否して選択を保持する。
 await search.fill('アイテム1');await page.waitForFunction(()=>document.querySelectorAll('.se-record').length>=10);
 await row('アイテム10').getByRole('checkbox').check();await row('アイテム11').getByRole('checkbox').check();
 await page.getByRole('button',{name:'セットへ追加',exact:true}).click();
 const addDialog=page.locator('.sax-shared-dialog');await addDialog.waitFor();
 await addDialog.getByRole('option',{name:'満杯'}).click();await addDialog.getByLabel('構成要素の追加方法').selectOption('separate');
 const beforeFull=(await docOne()).recipes.find(r=>r.id==='full').groups.length;
 await addDialog.getByRole('button',{name:'追加',exact:true}).click();
 assert.match(await addDialog.locator('.se-error').innerText(),/./,'上限超過のエラーがダイアログに出る');
 assert.equal((await docOne()).recipes.find(r=>r.id==='full').groups.length,beforeFull,'全件拒否');
 assert.equal(await addDialog.count(),1);
 await addDialog.getByRole('option',{name:'水彩'}).click();
 await addDialog.getByRole('button',{name:'追加',exact:true}).click();await addDialog.waitFor({state:'detached'});await settle();
 const water=(await docOne()).recipes.find(r=>r.id==='s2');assert.deepEqual(water.groups.slice(1).map(g=>g.item_ids),[['one-i10'],['one-i11']]);assert.deepEqual(water.groups.slice(1).map(g=>g.name),['アイテム10','アイテム11']);
 assert.match(await page.locator('.se-notice').innerText(),/「水彩」に2件をアイテムごとの構成要素として追加しました/);
 assert.match(await page.locator('.se-selectionbar, .se-filterbar').first().textContent(),/./);
 // まとめて・ランダム・重複警告
 await row('アイテム10').getByRole('checkbox').check();await row('アイテム11').getByRole('checkbox').check();
 await page.getByRole('button',{name:'セットへ追加',exact:true}).click();await addDialog.waitFor();
 await addDialog.getByRole('option',{name:'水彩'}).click();assert.match(await addDialog.locator('.se-warning').innerText(),/2件はこのセットで既に使用中/);
 await addDialog.getByLabel('追加する構成要素の選択方式').selectOption('random');await addDialog.getByLabel('追加する構成要素のランダム件数').fill('3');
 await addDialog.getByRole('button',{name:'追加',exact:true}).click();assert.equal(await addDialog.getByLabel('追加する構成要素のランダム件数').getAttribute('aria-invalid'),'true','件数が候補数を超える');
 await addDialog.getByLabel('追加する構成要素のランダム件数').fill('1～2');await addDialog.getByRole('button',{name:'追加',exact:true}).click();await addDialog.waitFor({state:'detached'});await settle();
 const combined=(await docOne()).recipes.find(r=>r.id==='s2').groups.at(-1);assert.deepEqual([combined.mode,combined.count_min,combined.count,combined.item_ids],['random',1,2,['one-i10','one-i11']]);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();await settle();
 console.log('2-2 add to set passed');

 // 2-3 セット画面の候補: 使用中の印と「未使用のみ」。
 await page.getByRole('button',{name:'テキストセット',exact:true}).click();await page.locator('.se-layout').waitFor();
 await page.locator('.se-picker[aria-label="編集するテキストセット"]').click();await picker.getByRole('option',{name:'旅人'}).click();
 await page.waitForFunction(()=>document.querySelector('.se-picker[aria-label="編集するテキストセット"]').dataset.value==='s1');
 await page.waitForFunction(()=>document.querySelectorAll('.se-candidate').length>3);
  const badgeState=()=>page.locator('.se-candidate').evaluateAll(rows=>rows.map(r=>[r.dataset.itemId,Boolean(r.querySelector('.se-used-badge'))]));
 const used=new Set(['one-i0','one-i1','one-i2','one-i3','one-i4']);
 let state=await badgeState();assert.ok(state.some(([,badge])=>badge)&&state.some(([,badge])=>!badge));assert.ok(state.every(([id,badge])=>badge===used.has(id)),'使用中の印はこのセットの候補だけ');
 await page.getByLabel('未使用のみ').check();
 await page.waitForFunction(()=>![...document.querySelectorAll('.se-candidate')].some(r=>r.querySelector('.se-used-badge')));assert.ok(await page.locator('.se-candidate').count()>3);
 await page.getByLabel('未使用のみ').uncheck();
 // 重複追加は確認ではなく警告
 await page.locator('.se-candidate[data-item-id="one-i0"]').click();assert.match(await page.locator('.se-selectionbar').innerText(),/1件選択[\s\S]*うち使用中1件/);
 await page.getByRole('button',{name:'選んだアイテムを追加',exact:true}).click();await settle();
 assert.match(await page.locator('.se-notice').innerText(),/うち1件はこのセットで既に使用中/);assert.equal((await docOne()).recipes.find(r=>r.id==='s1').groups.length,3);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();await settle();
 console.log('2-3 used badge passed');

 // 2-4 プレビュー: 未保存の編集を先に保存し、Seed 指定で実行と同じ API を呼ぶ。エラーは欄に出て編集を止めない。
 await page.getByRole('button',{name:'プレビュー',exact:true}).click();await page.locator('.se-preview').waitFor();
 assert.match(await page.locator('.se-preview').innerText(),/展開前の本文/);
 const groupName=page.getByRole('textbox',{name:'構成要素 1の名前',exact:true});await groupName.fill('人物改');
 const mark=log.length;
 await page.getByLabel('プレビューのSeed').fill('42');await page.getByRole('button',{name:'試行',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.se-preview textarea').value.includes('seed=42'));
 const events=log.slice(mark);assert.deepEqual(events.map(e=>e.type),['patch','preview'],'保存してからプレビューする');
 assert.deepEqual([events[1].body.recipe_id,events[1].body.seed,events[1].name],['s1',42,'人物改'],'保存済みの内容でプレビューされる');
 assert.match(await page.locator('.se-preview textarea').inputValue(),/人物改\/背景/);
 await groupName.fill('人物改2');await settle();assert.match(await page.locator('.se-preview').innerText(),/編集後はまだ更新していません/);
 await page.getByLabel('プレビューのSeed').fill('13');await page.getByRole('button',{name:'試行',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.se-preview .se-error')?.textContent.includes('候補数を超えています'));
 assert.equal(await page.locator('.se-preview textarea').inputValue(),'');await groupName.fill('人物');await settle();
 await page.getByLabel('プレビューのSeed').fill('-1');await page.getByRole('button',{name:'試行',exact:true}).click();
 assert.equal(await page.getByLabel('プレビューのSeed').getAttribute('aria-invalid'),'true');assert.equal(log.filter(e=>e.type==='preview').length,2,'不正なSeedではAPIを呼ばない');
 // 応答待ちの間にセットを切り替えても、前のセットの結果を表示しない。
 await page.getByLabel('プレビューのSeed').fill('77');await page.getByRole('button',{name:'試行',exact:true}).click();
 await page.locator('.se-picker[aria-label="編集するテキストセット"]').click();await picker.getByRole('option',{name:'水彩'}).click();
 await page.waitForFunction(()=>document.querySelector('.se-picker[aria-label="編集するテキストセット"]').dataset.value==='s2');
 assert.equal(await page.getByRole('button',{name:'試行',exact:true}).isDisabled(),false,'切り替え後の「試行」は前の要求を待たない');
 await page.waitForTimeout(1000);assert.equal(await page.locator('.se-preview textarea').inputValue(),'','切り替え前のセットの結果を表示しない');
 await page.locator('.se-picker[aria-label="編集するテキストセット"]').click();await picker.getByRole('option',{name:'旅人'}).click();
 await page.waitForFunction(()=>document.querySelector('.se-picker[aria-label="編集するテキストセット"]').dataset.value==='s1');
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'編集するテキストセット','ピッカーで選んだあとも位置を保つ');
 console.log('2-4 preview passed');

 // 2-6 タグ補完: 編集欄と一括操作欄。↑↓+Enterで入り、Escは候補だけ閉じる。
 await page.getByRole('button',{name:'アイテム',exact:true}).first().click();await records().first().waitFor();
 await search.fill('');await page.waitForFunction(()=>document.querySelectorAll('.se-record').length>5);
 await records().first().getByRole('button',{name:'タグを編集',exact:true}).click();
 const tagBox=page.getByRole('textbox',{name:'アイテムタグ',exact:true});
 await tagBox.fill('tag1');await page.keyboard.press('Control+a');await page.keyboard.type('tag, ');
 await page.locator('.se-record .se-suggest-option').first().waitFor();assert.ok(await page.locator('.se-record .se-suggest-option').count()>1);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.se-record .se-suggest').isHidden(),true,'Escで候補だけ閉じる');assert.equal(await tagBox.count(),1,'Escで編集は終わらない');
 await tagBox.fill('ta');await page.locator('.se-record .se-suggest-option').first().waitFor();
 await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');const second=await page.locator('.se-suggest-option[aria-selected=true] span').first().textContent();
 await page.keyboard.press('Enter');assert.equal(await tagBox.inputValue(),`${second}, `);assert.equal(await tagBox.count(),1,'候補を決定してもEnterで編集は終わらない');
 await page.keyboard.press('Escape');
 await page.locator('.se-selectionbar, .se-selection-tools').first().waitFor();await row('アイテム2').getByRole('checkbox').check();
 const bulkTag=page.getByPlaceholder('一括操作するタグ');await bulkTag.focus();await page.locator('.se-filterbar .se-suggest-option').first().waitFor();
 await page.locator('.se-filterbar .se-suggest-option').first().click();assert.match(await bulkTag.inputValue(),/, $/);
 console.log('2-6 tag suggest passed');

 // 2-7 Tab／Shift+Tab: 名前→本文→タグ→次の行の名前。入力内容を失わない。Ctrl+Enterで確定。
 await row('アイテム2').getByRole('button',{name:'名前を編集',exact:true}).click();
 const nameBox=page.getByRole('textbox',{name:'アイテム名',exact:true});await nameBox.fill('アイテム2改');
 await page.keyboard.press('Tab');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='アイテム本文');
 await page.keyboard.type('追記本文');await page.keyboard.press('Tab');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='アイテムタグ');
 await page.keyboard.press('Tab');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='アイテム名');
 const nextName=await page.evaluate(()=>document.activeElement.value);assert.notEqual(nextName,'アイテム2改');
 await page.keyboard.press('Shift+Tab');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='アイテムタグ');
 await page.keyboard.press('Shift+Tab');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='アイテム本文');
 assert.match(await page.evaluate(()=>document.activeElement.value),/追記本文$/,'本文の入力内容を失わない');
 await page.keyboard.press('Control+Enter');await page.waitForFunction(()=>!document.activeElement||document.activeElement.getAttribute('aria-label')!=='アイテム本文');await settle();
 const edited=(await docOne()).catalog.items.find(i=>i.name==='アイテム2改');assert.ok(edited&&edited.text.endsWith('追記本文'),'名前と本文が保存される');
 // IME変換中のTabは移動しない
 await row('アイテム2改').getByRole('button',{name:'名前を編集',exact:true}).click();
 await page.evaluate(()=>{const e=document.activeElement;e.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',isComposing:true,keyCode:229,bubbles:true,cancelable:true}))});
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'アイテム名','IME変換中のTabでは移動しない');
 await page.keyboard.press('Escape');
 console.log('2-7 tab navigation passed');
 await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:'ok',errors}));
}catch(error){console.error(error);process.exitCode=1}finally{await browser?.close();server.close()}})();
