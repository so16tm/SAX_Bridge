// 隔離した公式 Autocomplete++ と実 SAX 共有エディタを headless Edge で検証する。
// 第1引数は公式リポジトリ checkout、第2引数は Playwright パッケージのパス。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const official = path.resolve(process.argv[2] || path.join(root, 'work/sax-autocomplete-official-20261011'));
const { chromium } = require(process.argv[3] || process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const appStub = `export const app = window.app = {extensions:[], registerExtension(e){this.extensions.push(e)}, ui:{settings:{addSetting(){},getSettingValue(k,d){return d}}}, graph:{_nodes:[],links:{},setDirtyCanvas(){},getNodeById(){}}, canvas:{ds:{scale:1,offset:[0,0]},setDirty(){}}, extensionManager:{setting:{get(k,d){return d}}}};`;
const html = `<!doctype html><html><body><script type="module">
import { app } from '/scripts/app.js';
import { settingValues } from '/extensions/official/js/settings.js';
Object.assign(settingValues,{enableModels:false,loraManagerMode:'Disabled',autoFormatOnBlur:false,replaceUnderscore:false,animaArtistMode:'Disabled'});
await import('/extensions/official/js/main.js');
await app.extensions.find(e=>typeof e.setup==='function').setup(app);
const {openSharedEditor} = await import('/extensions/sax/js/sax_text_catalog_v2_editor.js');
window.session={document:{name:'検証',catalog:{items:[{id:'a',name:'本文',text:'',tags:[]}]},recipes:[]},status:'saved',mutate(ops){for(const op of ops)if(op.type==='item.put')this.document.catalog.items[0]=op.item},subscribe(){return()=>{}},async flush(){window.saved=this.document.catalog.items[0].text},undo(){},redo(){}};
window.closeEditor=openSharedEditor(window.session);
window.ready=true;
</script></body></html>`;
const server = http.createServer((req,res)=>{
 const url = new URL(req.url,'http://localhost');
 const send = (body,type='application/json')=>{res.setHeader('Content-Type',type);res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
 if(url.pathname==='/')return send(html,'text/html');
 if(url.pathname==='/scripts/app.js'||url.pathname==='/extensions/scripts/app.js')return send("export {app} from '/scripts/comfy-stub.js';",'text/javascript');
 if(url.pathname==='/scripts/comfy-stub.js')return send(appStub,'text/javascript');
 if(url.pathname==='/scripts/widgets.js')return send('export const ComfyWidgets={};','text/javascript');
 if(url.pathname==='/scripts/api.js'||url.pathname==='/extensions/scripts/api.js')return send('export const api={fetchApi:(p,o)=>fetch(p,o),addEventListener(){}};','text/javascript');
 if(url.pathname==='/autocomplete-plus-plus/tags/list')return send({tags:['danbooru.csv']});
 if(url.pathname.startsWith('/autocomplete-plus-plus/tags/file/'))return send('blue_eyes,0,1000,\nblue_hair,0,900,\nred_hair,0,800,\n','text/plain');
 if(url.pathname==='/autocomplete-plus-plus/user-data')return send({});
 if(url.pathname.startsWith('/autocomplete-plus-plus/'))return send([]);
 const base=url.pathname.startsWith('/extensions/official/')?path.join(official,'web'):url.pathname.startsWith('/extensions/sax/')?root:null;
 if(!base){res.statusCode=404;return res.end();}
 const rel=url.pathname.replace(/^\/extensions\/(official|sax)\//,'');
 const file=path.resolve(base,rel);
 if(!file.startsWith(base+path.sep)){res.statusCode=403;return res.end();}
 try{return send(fs.readFileSync(file),file.endsWith('.css')?'text/css':'text/javascript');}catch(e){console.error('missing:',file,e.message);res.statusCode=404;res.end();}
});
(async()=>{
 let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('browser:',e.message)});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.ready,{timeout:15000});
  await page.getByRole('button',{name:'本文を編集',exact:true}).click();
  const area=page.getByLabel('アイテム本文',{exact:true});
  await area.pressSequentially('blue_');
  await page.waitForFunction(()=>window.tagCompleteEngine.isVisible);
  const layering=await page.evaluate(()=>{const p=document.querySelector('#tagcomplete-popup-container');const r=p.getBoundingClientRect();return {z:getComputedStyle(p).zIndex,front:p.contains(document.elementFromPoint(r.x+10,r.y+10))};});
  assert.equal(layering.z,'10001');assert.equal(layering.front,true);
  await area.press('Enter');
  assert.match(await area.inputValue(),/^blue_eyes/);
  assert.match(await page.evaluate(()=>window.session.document.catalog.items[0].text),/^blue_eyes/);
  await area.fill('blue_'); await area.press('End');
  await page.waitForFunction(()=>window.tagCompleteEngine.isVisible);
  await area.press('Escape');
  assert.equal(await page.locator('.sax-shared-editor').count(),1);
  assert.equal(await area.count(),1);
  await area.fill('blue_'); await area.press('End');
  await page.waitForFunction(()=>window.tagCompleteEngine.isVisible);
  await page.evaluate(()=>window.closeEditor());
  await page.waitForFunction(()=>!window.tagCompleteEngine.isVisible&&window.saved!==undefined);
  assert.equal(await page.locator('.sax-shared-editor').count(),0);
  assert.match(await page.evaluate(()=>window.session.document.catalog.items[0].text),/^blue_/);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({official:path.basename(official),completion:true,enter:true,layering,escapePreservesEditor:true,closeCleansPopup:true,saved:await page.evaluate(()=>window.saved)}));
 } finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
