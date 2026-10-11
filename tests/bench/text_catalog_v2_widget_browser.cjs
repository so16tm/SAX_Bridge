// 本番の共有ウィジェットを、ComfyUI APIを模したサーバーで確認する。
const { chromium } = require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const docs = ['one', 'two'].map(id => ({ version: 3, id, name: `カタログ${id}`, revision: 1,
    catalog: { items: [{ id: 'z', name: 'Z アイテム', text: '乙の本文', tags: ['共通','背景'] }, { id: 'a', name: 'A アイテム', text: '甲の本文', tags: ['共通','風景'] }] },
    recipes: [{ id: 's', name: 'テキストセット', groups: [{id:'g',name:'構成要素',mode:'all',on:true,count:2,item_ids:['z','a']},{id:'single',name:'単一',mode:'random',on:true,count:0,item_ids:['z']}] }] }));
const html = `<meta charset="utf-8"><style>body{background:#181818;color:#ddd;font:12px sans-serif}#host{width:350px;background:#353535;padding:8px}#host>button,#host>.native{display:block;box-sizing:border-box;width:100%;height:24px;margin:4px 0}h3{font-size:12px;margin:4px}</style><div id="host"></div><script type="module">
import {installSharedControls,sharedController} from '/js/sax_text_catalog_v2_shared.js';
const host=document.querySelector('#host');
window.node={widgets:[{name:'config_json',value:JSON.stringify({version:3,catalog_id:'one',rows:[{id:'r',recipe_id:'s',on:true}]})},{name:'seed',value:123},{name:'control_after_generate',value:'fixed'}],size:[350,500],
 addWidget(type,name,value,callback,options){const w={type,name,value,callback,options};this.widgets.push(w);return w},
 addCustomWidget(w){this.widgets.push(w);return w},addDOMWidget(name,type,element,options){const w={name,type,element,options,onRemove(){element.remove()}};this.widgets.push(w);return w},setDirtyCanvas(){}};
installSharedControls(node);window.shared=()=>sharedController(node);
for(const w of node.widgets){if(w.name==='config_json')continue;if(w.element){host.append(w.element);continue}const e=document.createElement(w.name.endsWith('_heading')?'h3':w.callback?'button':'div');e.textContent=w.name==='__sax_execution_heading'?'実行設定':w.name==='__sax_catalog_heading'?'カタログ管理':w.name;e.className='native';e.dataset.widgetName=w.name;if(w.callback)e.onclick=()=>w.callback();host.append(e)}
</script>`;
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    if (url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (url === '/scripts/app.js') { res.end('export const app={};'); return; }
    if (url === '/scripts/api.js') { res.end('export const api={fetchApi:(url,options)=>fetch(url,options),getLoras:async()=>[]};'); return; }
    if (url.startsWith('/sax/text-catalog/v2/catalogs')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(url.endsWith('catalogs') ? { catalogs: docs } : docs.find(d => d.id === url.split('/').at(-1)))); return;
    }
    const file = path.resolve(root, '.' + url);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.end(fs.readFileSync(file));
});
(async () => {
    let browser;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        browser = await chromium.launch({ headless: true, channel: 'msedge' });
        const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.shared()?.session);
        const positions = () => page.evaluate(() => Object.fromEntries(['seed', 'control_after_generate', '前回の実行結果', '__sax_catalog_heading'].map(name => [name, document.querySelector('[data-widget-name="' + name + '"]').getBoundingClientRect().top])));
        const before = await positions();
        assert.ok(before.seed < before['前回の実行結果'] && before['前回の実行結果'] < before.__sax_catalog_heading);
        await page.evaluate(() => { const w=node.widgets[0],ref=JSON.parse(w.value);ref.rows=Array.from({length:25},(_,i)=>({id:'r'+i,recipe_id:'s',on:true}));w.value=JSON.stringify(ref);shared().setWidget.refresh(); });
        await page.waitForFunction(() => document.querySelectorAll('.ssw-entry').length === 25);
        assert.deepEqual(await positions(), before);
        assert.equal(await page.locator('.sax-shared-catalog select').inputValue(), 'one');
        await page.locator('.sax-shared-catalog').getByRole('button', { name: 'カタログ作成・入出力', exact: true }).click();
        await page.getByRole('button', { name: '新しいカタログ', exact: true }).waitFor();
        await page.mouse.click(2, 2);
        await page.locator('.sax-shared-catalog').getByRole('button', { name: 'アイテム', exact: true }).click();
        await page.locator('.se-record').first().waitFor();
        assert.equal(await page.getByRole('combobox', { name: 'アイテムの並び順' }).inputValue(), 'name');
        const itemOrder = () => page.locator('.se-record').evaluateAll(rows => rows.slice().sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)).map(row=>row.dataset.key));
        // 登録順と名前順が異なるデータで、全画面が同じ比較規則を使うことを確認する。
        const nameOrder = docs[0].catalog.items.slice().sort((a,b)=>a.name.localeCompare(b.name,'ja')).map(i=>i.id);
        assert.deepEqual(await itemOrder(), nameOrder);
        await page.locator('.se-tag-filter summary').click();
        await page.getByRole('checkbox',{name:'共通で絞り込み',exact:true}).check();
        assert.equal(await page.locator('.se-record').count(),2);
        await page.getByRole('checkbox',{name:'背景で絞り込み',exact:true}).check();
        assert.deepEqual(await itemOrder(),['z']);
        await page.getByPlaceholder('絞り込みタグを検索').fill('背景');
        assert.equal(await page.getByRole('checkbox',{name:'共通で絞り込み',exact:true}).isVisible(),false);
        await page.getByRole('button',{name:'閉じる',exact:true}).click();
        await page.locator('.sax-shared-catalog').getByRole('button',{name:'アイテム',exact:true}).click();
        await page.locator('.se-tag-filter summary').click();
        assert.equal(await page.getByRole('checkbox',{name:'共通で絞り込み',exact:true}).isChecked(),true);
        assert.equal(await page.getByRole('checkbox',{name:'背景で絞り込み',exact:true}).isChecked(),true);
        assert.deepEqual(await itemOrder(),['z']);
        await page.getByRole('button',{name:'タグ絞り込みを解除',exact:true}).click();
        await page.getByRole('checkbox',{name:'背景で絞り込み',exact:true}).check();
        await page.locator('.se-tag-filter summary').click();
        await page.getByPlaceholder('名前・本文を検索').fill('甲');
        await page.waitForFunction(()=>document.querySelectorAll('.se-record').length===0);
        await page.getByPlaceholder('名前・本文を検索').fill('');
        await page.waitForFunction(()=>document.querySelectorAll('.se-record').length===1);
        await page.locator('.se-tag-filter summary').click();
        await page.getByRole('button',{name:'タグ絞り込みを解除',exact:true}).click();
        await page.locator('.se-tag-filter summary').click();
        await page.getByRole('combobox', { name: 'アイテムの並び順' }).selectOption('catalog');
        assert.deepEqual(await itemOrder(), ['z','a']);
        await page.getByRole('combobox', { name: 'アイテムの並び順' }).selectOption('tags');
        assert.deepEqual(await itemOrder(), ['z','a']);
        await page.getByRole('button', { name: 'テキストセット', exact: true }).click();
        assert.equal(await page.getByRole('combobox', { name: 'アイテムの並び順' }).inputValue(), 'tags');
        assert.deepEqual(await page.locator('.se-candidate').evaluateAll(rows=>rows.slice().sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)).map(row=>row.dataset.key)),['z','a']);
        await page.getByRole('combobox', { name: 'アイテムの並び順' }).selectOption('name');
        assert.deepEqual(await page.locator('.se-candidate').evaluateAll(rows=>rows.slice().sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)).map(row=>row.dataset.key)),nameOrder);
        const singleCard = page.locator('.se-card[data-single=true]');
        for (const card of await page.locator('.se-card').all()) {
            assert.equal(await card.locator(':scope > .se-row').first().getByRole('button', {name:'候補を変更',exact:true}).textContent(),'✎');
            assert.equal(await card.getByRole('button', {name:'候補を変更',exact:true}).count(),1);
        }
        assert.equal(await singleCard.locator(':scope > .se-row').count(), 1);
        assert.ok(await singleCard.evaluate(e => e.offsetHeight <= 44 && e.scrollWidth <= e.clientWidth));
        await page.setViewportSize({width:600,height:1000});
        assert.ok(await singleCard.evaluate(e => e.offsetHeight <= 44 && e.scrollWidth <= e.clientWidth));
        await page.setViewportSize({width:1000,height:1000});
        assert.equal(await singleCard.getByText('ランダム0件', {exact:true}).count(), 1);
        assert.equal(await singleCard.getByRole('button', {name:'出力順',exact:true}).count(), 0);
        assert.deepEqual(await page.evaluate(()=>shared().session.document.recipes[0].groups[1]),{id:'single',name:'単一',mode:'random',on:true,count:0,item_ids:['z']});
        await singleCard.getByRole('button', {name:'候補を変更',exact:true}).click();
        assert.equal(await page.getByRole('checkbox', {name:'選択済みだけ',exact:true}).isChecked(),true);
        await page.getByRole('checkbox', {name:'選択済みだけ',exact:true}).uncheck();
        await page.getByRole('button', {name:'一覧を全選択',exact:true}).click();
        await page.getByRole('button', {name:'候補を更新',exact:true}).click();
        assert.equal(await page.locator('.se-card[data-single=true]').count(),0);
        assert.equal(await page.locator('.se-card').last().locator(':scope > .se-row').count(),2);
        await page.getByRole('button', { name: '閉じる', exact: true }).click();
        await page.evaluate(() => { const d=shared().session.document;shared().result={text:'保存済み出力',selection:{rows:[{name:'セット',on:true,groups:[{name:'構成要素',on:true,mode:'all',item_ids:['z','a'],candidate_ids:['z','a'],items:[...d.catalog.items]}]}]}}; });
        await page.getByRole('button', { name: '前回の実行結果', exact: true }).click();
        assert.equal(await page.getByRole('combobox', { name: 'アイテムの並び順' }).inputValue(), 'name');
        assert.deepEqual(await page.locator('.se-record').evaluateAll(rows=>rows.slice().sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)).map(row=>row.dataset.itemId)),nameOrder);
        await page.locator('.se-tag-filter summary').click();
        await page.getByRole('checkbox',{name:'共通で絞り込み',exact:true}).check();
        await page.getByRole('checkbox',{name:'背景で絞り込み',exact:true}).check();
        assert.deepEqual(await page.locator('.se-record').evaluateAll(rows=>rows.map(row=>row.dataset.itemId)),['z']);
        await page.getByRole('button',{name:'タグ絞り込みを解除',exact:true}).click();
        await page.locator('.se-tag-filter summary').click();
        await page.getByRole('combobox', { name: 'アイテムの並び順' }).selectOption('tags');
        assert.deepEqual(await page.locator('.se-record').evaluateAll(rows=>rows.slice().sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)).map(row=>row.dataset.itemId)),['z','a']);
        assert.deepEqual(await page.evaluate(()=>shared().result.selection.rows[0].groups[0].items.map(i=>i.id)),['z','a']);
        await page.getByRole('button', { name: '閉じる', exact: true }).click();
        await page.locator('.sax-shared-catalog select').selectOption('two');
        await page.waitForFunction(() => shared().session?.document.id === 'two');
        assert.equal(await page.locator('.ssw-entry').count(), 0);
        const controls = await page.locator('.sax-shared-catalog').evaluate(e => [...e.querySelectorAll('select,button')].map(n => n.getBoundingClientRect().top));
        assert.ok(controls.every(y => y === controls[0]));
        await page.evaluate(() => { document.querySelector('#host').style.width='250px'; });
        assert.ok(await page.locator('.sax-shared-catalog').evaluate(e => e.scrollWidth <= e.clientWidth));
        assert.deepEqual(errors, []);
        await page.evaluate(() => shared().dispose());
        assert.equal(await page.locator('.sax-shared-catalog,.sax-shared-sets').count(), 0);
        console.log('PASS: 実行設定の位置固定、25セット、カタログ1行、管理・アイテム・選択、狭幅、DOM解除');
    } finally { await browser?.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
