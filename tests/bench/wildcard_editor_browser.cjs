// 多数のワイルドカードの階層表示・編集・保存を実ブラウザーで確認する。
const { chromium } = require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const expanderPath = process.env.SAX_AUTOCOMPLETE_EXPANDER_PATH;
const autocompleteMainPath = process.env.SAX_AUTOCOMPLETE_MAIN_PATH;
const formatterPath = process.env.SAX_AUTOCOMPLETE_FORMATTER_PATH;
const mainSource = autocompleteMainPath ? fs.readFileSync(autocompleteMainPath,'utf8') : null;
const exclusionSource = mainSource ? mainSource.slice(mainSource.indexOf('function isExcludedTarget('),mainSource.indexOf('function syncWidgetValue(')) : "function isExcludedTarget(area){const n=getNodeForElement(area);if(n)return n.properties.ac_enabled===false;return !!area.closest('[role=dialog]')&&area.dataset.acKeepUnderscores!=='true';}";
const roots = [{id:'comfy',label:'ComfyUI/wildcards'},{id:'addon',label:'custom_nodes/addon/wildcards'},{id:'empty',label:'empty/wildcards'}];
const files = Array.from({length:10000},(_,i)=>({root_id:'comfy',name:`batch/dir${Math.floor(i/100)}/item${i}`}));
files.push({root_id:'addon',name:'batch/dir99/item9999',shadowed:true});
let text = 'alpha\r\nbeta\r\ngamma\r\ndelta', sha = '1', failSave = false, failDelete = false, failReload = false, writes = 0;
const html = `<meta charset="utf-8"><style>body{background:#222;color:#ddd}</style><button id="launch">編集</button><script type="module">
import {app} from '/scripts/app.js';
import {isKeepUnderscoresTextarea,formatTagUnderscores,buildUnderscoreExclusionSet,getEffectiveFormattingSettings} from '/extensions/ComfyUI-Autocomplete-Plus-Plus/js/auto-formatter.js';
import {openWildcardEditor} from '/js/sax_wildcard_editor.js';
window.wildcardNode={id:42,type:'SAX_Bridge_Wildcard_Editor',properties:{},widgets:[]};app.graph._nodes.push(wildcardNode);document.querySelector('#launch').onclick=()=>openWildcardEditor(wildcardNode);
const isDictionariesControllerTextarea=()=>false,getNodeForElement=el=>app.graph.getNodeById(Number(el.closest('[node-id]')?.getAttribute('node-id'))),isOverriddenTarget=el=>getNodeForElement(el)?.properties.ac_enabled===true,isNodeOverridden=()=>false,isNodeEffectivelyExcluded=n=>n.properties.ac_enabled===false;
${exclusionSource}
// Autocomplete++ と同じく、後から挿入された本文欄をDOM observerで検出する。
const popup=document.createElement('div');popup.id='tagcomplete-popup-container';popup.style.cssText='position:fixed;top:300px;left:650px;z-index:9999;background:#444';popup.hidden=true;
const choice=document.createElement('button');choice.textContent='blue_hair';popup.append(choice);document.body.append(popup);
window.tagCompleteEngine={target:null,wildcards:['legacy'],wildcardCache:new Map([['legacy',['old']]]),hide(){popup.hidden=true;window.completionHides=(window.completionHides||0)+1;}};
choice.onclick=()=>{const target=tagCompleteEngine.target;const fmt=getEffectiveFormattingSettings();let text='blue_hair';if(fmt.replaceUnderscore&&!isKeepUnderscoresTextarea(target))text=formatTagUnderscores(text,buildUnderscoreExclusionSet(fmt.formatKeepUnderscoresList));target.value=text+(fmt.autoInsertComma?', ':'');target.dispatchEvent(new Event('input',{bubbles:true}));tagCompleteEngine.hide();};
new MutationObserver(()=>{for(const area of document.querySelectorAll('.sax-wc-text:not([data-autocomplete])')){area.dataset.autocomplete='true';area.addEventListener('input',e=>{tagCompleteEngine.target=area;popup.hidden=isExcludedTarget(area)||!area.value.startsWith('blue_h');if(isOverriddenTarget(area))e.stopImmediatePropagation();},true);area.addEventListener('keydown',e=>{if(e.key==='Escape'&&!popup.hidden){e.preventDefault();tagCompleteEngine.hide();}});}}).observe(document.body,{childList:true,subtree:true});
</script>`;
const server = http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','text/javascript; charset=utf-8');
  const url = new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  if(url.pathname==='/scripts/app.js'){res.end('export const app={graph:{_nodes:[],getNodeById(id){return this._nodes.find(n=>n.id===id);}},registerExtension(){}};');return;}
  if(url.pathname==='/scripts/api.js'){res.end('export const api={fetchApi:(url,options)=>fetch(url,options)};');return;}
  if(url.pathname==='/extensions'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(['/extensions/ComfyUI-Autocomplete-Plus-Plus/js/prompt-expander.js?v=test']));return;}
  if(url.pathname==='/extensions/ComfyUI-Autocomplete-Plus-Plus/js/prompt-expander.js'){res.end(expanderPath?fs.readFileSync(expanderPath,'utf8')+'\nwindow.expansionCache=wildcardContentMap;':"export const wildcardContentMap=new Map([['legacy',['old']]]);window.expansionCache=wildcardContentMap;");return;}
  if(url.pathname==='/extensions/ComfyUI-Autocomplete-Plus-Plus/js/settings.js'){res.end('export const settingValues={replaceUnderscore:true,autoInsertComma:true};window.acSettings=settingValues;export const logDebug=()=>{};');return;}
  if(url.pathname==='/extensions/ComfyUI-Autocomplete-Plus-Plus/js/main.js'){res.end('export const getActiveControllerNode=()=>null;export const notifyControllerInteracted=()=>{};');return;}
  if(url.pathname==='/extensions/ComfyUI-Autocomplete-Plus-Plus/js/auto-formatter.js'){res.end(formatterPath?fs.readFileSync(formatterPath,'utf8'):"import {settingValues} from './settings.js';export const isKeepUnderscoresTextarea=n=>n.dataset.acKeepUnderscores==='true';export const getEffectiveFormattingSettings=()=>settingValues;export const buildUnderscoreExclusionSet=s=>new Set((s||'').split(','));export const formatTagUnderscores=(s,keep)=>keep?.has(s)?s:s.replaceAll('_',' ');");return;}
  if(url.pathname==='/autocomplete-plus-plus/wildcards/all-data'){
    res.setHeader('Content-Type','application/json');if(failReload){res.statusCode=500;res.end(JSON.stringify({error:'取得失敗'}));return;}
    const wildcards={};for(const file of files)if(!Object.hasOwn(wildcards,file.name))wildcards[file.name]=text.split(/\r?\n/);
    res.end(JSON.stringify({success:true,wildcards}));return;
  }
  if(url.pathname==='/sax/wildcards'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({roots,files}));return;}
  if(url.pathname==='/sax/wildcards/file'){
    res.setHeader('Content-Type','application/json');
    if(req.method==='DELETE'){
      if(failDelete){res.statusCode=409;res.end(JSON.stringify({error:'削除時の競合'}));return;}
      const index=files.findIndex(f=>f.root_id===url.searchParams.get('root_id')&&f.name===url.searchParams.get('name'));
      assert.ok(index>=0);files.splice(index,1);res.end(JSON.stringify({deleted:true}));return;
    }
    if(req.method==='PUT'){
      let body='';for await(const chunk of req)body+=chunk;
      const value=JSON.parse(body);await new Promise(resolve=>setTimeout(resolve,100));
      if(failSave){res.statusCode=409;res.end(JSON.stringify({error:'他の編集による競合'}));return;}
      writes++;text=value.content;sha=String(Number(sha)+1);if(!files.some(f=>f.root_id===value.root_id&&f.name===value.name))files.push({root_id:value.root_id,name:value.name});res.end(JSON.stringify({...value,sha}));return;
    }
    res.end(JSON.stringify({root_id:url.searchParams.get('root_id'),name:url.searchParams.get('name'),content:text,sha}));return;
  }
  const file=path.resolve(root,'.'+url.pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(fs.readFileSync(file));
});
(async()=>{
  let browser;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    browser=await chromium.launch({headless:true,channel:'msedge'});
    const page=await browser.newPage({viewport:{width:1280,height:960}});page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#launch').click();
    await page.getByText('ファイル一覧 · 10001件',{exact:true}).waitFor();
    const tree=page.getByRole('tree',{name:'ワイルドカードファイル'});
    assert.equal(await tree.locator('[data-key="root:empty"]').count(),0);
    assert.equal(await page.getByRole('combobox',{name:'保存先',exact:true}).locator('option').count(),3);
    await tree.locator('[data-key="folder:comfy:batch"]').click();
    assert.equal(await tree.locator('[data-key="folder:comfy:batch"]').getAttribute('aria-expanded'),'true');
    assert.ok(await tree.getByRole('treeitem').count()<50);
    await page.getByRole('button',{name:'すべて開く',exact:true}).click();
    assert.ok(await tree.getByRole('treeitem').count()<50);
    await tree.getByRole('treeitem').first().focus();await page.keyboard.press('End');
    assert.ok(await tree.getByRole('treeitem').count()<50);
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.key),'file:addon:batch/dir99/item9999');
    await page.getByRole('button',{name:'折りたたむ',exact:true}).click();assert.equal(await tree.getByRole('treeitem').count(),2);
    const search=page.getByRole('textbox',{name:'ファイル・フォルダーを検索',exact:true});await search.fill('item9999');
    await tree.locator('[data-key="file:comfy:batch/dir99/item9999"]').waitFor();
    assert.equal(await tree.getByRole('treeitem').count(),8);
    await tree.locator('[data-key="file:comfy:batch/dir99/item9999"]').click();
    const editor=page.getByRole('textbox',{name:'ワイルドカード本文',exact:true});await editor.waitFor();
    await page.waitForFunction(()=>document.querySelector('.sax-wc-text').value==='alpha\nbeta\ngamma\ndelta');
    assert.equal(await tree.locator('[data-key="file:comfy:batch/dir99/item9999"]').getAttribute('aria-selected'),'true');
    assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isEnabled(),false);
    assert.equal(await editor.getAttribute('data-ac-keep-underscores'),null);
    await page.locator('.sax-wc-modal').evaluate(n=>n.removeAttribute('node-id'));await editor.fill('blue_h');assert.equal(await page.locator('#tagcomplete-popup-container').isVisible(),false);
    await page.locator('.sax-wc-modal').evaluate(n=>n.setAttribute('node-id','42'));
    await editor.fill('blue_h');await page.locator('#tagcomplete-popup-container').waitFor({state:'visible'});
    assert.ok(await page.evaluate(()=>Number(getComputedStyle(document.querySelector('#tagcomplete-popup-container')).zIndex)>Number(getComputedStyle(document.querySelector('.sax-wc-root')).zIndex)));
    await page.getByRole('button',{name:'blue_hair',exact:true}).click();assert.equal(await editor.inputValue(),'blue hair, ');
    await page.evaluate(()=>{acSettings.replaceUnderscore=false;acSettings.autoInsertComma=false;});await editor.fill('blue_h');await page.getByRole('button',{name:'blue_hair',exact:true}).click();assert.equal(await editor.inputValue(),'blue_hair');
    await page.evaluate(()=>{acSettings.replaceUnderscore=true;acSettings.formatKeepUnderscoresList='blue_hair';wildcardNode.properties.ac_enabled=true;});await editor.fill('blue_h');await page.getByRole('button',{name:'blue_hair',exact:true}).click();assert.equal(await editor.inputValue(),'blue_hair');assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isEnabled(),true);
    await page.evaluate(()=>{delete wildcardNode.properties.ac_enabled;acSettings.formatKeepUnderscoresList='';});
    if(formatterPath){
      await editor.fill('blue_hair\n__wildcard_file__');
      await page.evaluate(async()=>{const m=await import('/extensions/ComfyUI-Autocomplete-Plus-Plus/js/auto-formatter.js');m.formatTextareaOnBlur(document.querySelector('.sax-wc-text'),{autoFormatOnBlur:true,formatReplaceUnderscore:true});});
      assert.equal(await editor.inputValue(),'blue hair\n__wildcard_file__');
    }
    await editor.fill('blue_h');await editor.press('Escape');assert.equal(await page.locator('#tagcomplete-popup-container').isVisible(),false);assert.equal(await page.locator('.sax-wc-modal').count(),1);
    await editor.fill('alpha\nbeta\ngamma\ndelta');
    await editor.evaluate(n=>{n.focus();n.setSelectionRange(6,17);});
    await page.getByRole('button',{name:'選択行を上へ',exact:true}).click();assert.equal(await editor.inputValue(),'beta\ngamma\nalpha\ndelta');
    await page.getByRole('button',{name:'選択行を下へ',exact:true}).click();assert.equal(await editor.inputValue(),'alpha\nbeta\ngamma\ndelta');
    await page.getByRole('button',{name:'＋ 候補',exact:true}).click();assert.equal(await editor.inputValue(),'alpha\nbeta\ngamma\nnew item\ndelta');
    await page.getByRole('button',{name:'選択行を削除',exact:true}).click();assert.equal(await editor.inputValue(),'alpha\nbeta\ngamma\ndelta');
    await editor.fill('変更した本文\n2行目');await editor.press('Control+s');
    await page.waitForFunction(()=>document.querySelector('.sax-wc-text').disabled);
    await page.waitForFunction(()=>!document.querySelector('.sax-wc-text').disabled);assert.equal(writes,1);assert.equal(text,'変更した本文\r\n2行目');
    assert.deepEqual(await page.evaluate(()=>expansionCache.get('batch/dir99/item9999')),['変更した本文','2行目']);
    assert.equal(await page.evaluate(()=>tagCompleteEngine.wildcardCache.size),0);assert.equal(await page.evaluate(()=>tagCompleteEngine.wildcards.includes('batch/dir99/item9999')),true);
    failSave=true;await editor.fill('未保存の内容');await editor.press('Control+s');await page.getByRole('alert').filter({hasText:'競合'}).waitFor();
    assert.equal(await editor.inputValue(),'未保存の内容');assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isEnabled(),true);
    failSave=false;await editor.press('Control+s');await page.waitForFunction(()=>document.querySelector('.sax-wc-tip').textContent.includes('保存済み'));
    await page.waitForFunction(()=>!document.querySelector('.sax-wc-text').disabled);
    failReload=true;await editor.fill('展開未更新の本文');await editor.press('Control+s');await page.getByRole('alert').filter({hasText:'展開データを更新できませんでした'}).waitFor();
    assert.equal(text,'展開未更新の本文');assert.deepEqual(await page.evaluate(()=>expansionCache.get('batch/dir99/item9999')),['未保存の内容']);
    failReload=false;await page.getByRole('button',{name:'一覧更新',exact:true}).click();await page.waitForFunction(()=>window.expansionCache.get('batch/dir99/item9999')?.[0]==='展開未更新の本文');
    await search.fill('');await page.getByRole('button',{name:'一覧更新',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.sax-wc-files').textContent.includes('item9999') || document.querySelectorAll('.sax-wc-tree-item').length>8);
    await page.screenshot({path:path.join(root,'work/wildcard-editor-tree.png')});
    await search.fill('item9999');await tree.locator('[data-key="file:addon:batch/dir99/item9999"]').click();
    await page.waitForFunction(()=>!document.querySelector('.sax-wc-text').disabled);
    await editor.fill('削除前の未保存内容');
    await page.getByRole('button',{name:'ファイルを削除',exact:true}).click();
    const confirm=page.locator('.__sax_confirm_dlg');await confirm.getByText(/custom_nodes\/addon\/wildcards\/batch\/dir99\/item9999.txt/).waitFor();
    await confirm.getByRole('button',{name:'キャンセル',exact:true}).click();assert.equal(files.length,10001);assert.equal(await editor.inputValue(),'削除前の未保存内容');
    failDelete=true;await page.getByRole('button',{name:'ファイルを削除',exact:true}).click();await confirm.getByRole('button',{name:'削除する',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'削除時の競合'}).waitFor();assert.equal(files.length,10001);assert.equal(await editor.inputValue(),'削除前の未保存内容');
    failDelete=false;await page.getByRole('button',{name:'ファイルを削除',exact:true}).click();await confirm.getByRole('button',{name:'削除する',exact:true}).click();
    await page.getByText('ファイル一覧 · 10000件',{exact:true}).waitFor();assert.equal(await tree.locator('[data-key="root:addon"]').count(),0);
    assert.equal(await editor.inputValue(),'');assert.equal(await page.getByRole('button',{name:'ファイルを削除',exact:true}).isEnabled(),false);
    assert.equal(await tree.locator('[data-key="file:comfy:batch/dir99/item9999"]').count(),1);
    await page.waitForFunction(()=>!document.querySelector('.sax-wc-text').disabled);
    await page.getByRole('button',{name:'＋ 新規作成',exact:true}).click();await page.getByRole('combobox',{name:'保存先',exact:true}).selectOption('comfy');
    await page.getByRole('textbox',{name:'ファイル名',exact:true}).fill('newly/created');await editor.fill('new content');await editor.press('Control+s');
    await page.waitForFunction(()=>!document.querySelector('.sax-wc-text').disabled&&window.expansionCache.has('newly/created'));
    assert.deepEqual(await page.evaluate(()=>expansionCache.get('newly/created')),['new content']);assert.equal(await page.evaluate(()=>tagCompleteEngine.wildcards.includes('newly/created')),true);
    if(expanderPath)assert.equal(await page.evaluate(async()=>{const m=await import('/extensions/ComfyUI-Autocomplete-Plus-Plus/js/prompt-expander.js');return m.expandPromptString('__newly/created__',{rng:()=>0});}),'new content');
    await page.getByRole('button',{name:'ファイルを削除',exact:true}).click();await confirm.getByRole('button',{name:'削除する',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.sax-wc-text').disabled&&!window.expansionCache.has('newly/created'));
    assert.equal(await page.evaluate(()=>tagCompleteEngine.wildcards.includes('newly/created')),false);
    if(expanderPath)assert.equal(await page.evaluate(async()=>{const m=await import('/extensions/ComfyUI-Autocomplete-Plus-Plus/js/prompt-expander.js');return m.expandPromptString('__newly/created__',{rng:()=>0});}),'');
    await page.setViewportSize({width:600,height:800});assert.ok(await page.locator('.sax-wc-modal').evaluate(n=>n.scrollWidth<=n.clientWidth));
    await editor.press('Escape');await page.locator('.sax-wc-modal').waitFor({state:'detached'});
    assert.ok(await page.evaluate(()=>window.completionHides>=3));
    assert.deepEqual(errors,[]);console.log('PASS: 10001ファイルの階層・開閉・検索・仮想表示・キー操作・複数行編集・保存・競合保持・狭幅');
  }finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
