// 分離したComfyUIでネストの保存・Queue・結果編集を検証する。
const {chromium}=require(process.env.SAX_PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.SAX_COMFY_TEST_URL;
if(!base)throw new Error('分離ComfyUIのURLをSAX_COMFY_TEST_URLに指定してください');
const config={
  "version": 2,
  "catalog": {
    "items": [
      {
        "id": "quality",
        "name": "品質",
        "text": "high quality",
        "tags": [
          "品質"
        ]
      },
      {
        "id": "portrait-a",
        "name": "人物A",
        "text": "a traveler",
        "tags": [
          "人物"
        ]
      },
      {
        "id": "portrait-b",
        "name": "人物B",
        "text": "a painter",
        "tags": [
          "人物"
        ]
      },
      {
        "id": "beach",
        "name": "海辺背景",
        "text": "on a sunny beach",
        "tags": [
          "背景"
        ]
      },
      {
        "id": "city",
        "name": "街中背景",
        "text": "in a quiet city street",
        "tags": [
          "背景"
        ]
      }
    ]
  },
  "recipes": [
    {
      "id": "nested-example",
      "name": "ネストの例",
      "groups": [
        {
          "id": "quality-group",
          "name": "品質",
          "mode": "all",
          "count": 1,
          "on": true,
          "item_ids": [
            "quality"
          ]
        },
        {
          "id": "scene",
          "name": "シーンをランダム1件",
          "kind": "nested",
          "mode": "random",
          "count": 1,
          "on": true,
          "groups": [
            {
              "id": "beach-scene",
              "name": "海辺",
              "kind": "nested",
              "mode": "all",
              "count": 1,
              "on": true,
              "groups": [
                {
                  "id": "beach-person",
                  "name": "人物をランダム1件",
                  "mode": "random",
                  "count": 1,
                  "on": true,
                  "item_ids": [
                    "portrait-a",
                    "portrait-b"
                  ]
                },
                {
                  "id": "beach-background",
                  "name": "海辺背景",
                  "mode": "all",
                  "count": 1,
                  "on": true,
                  "item_ids": [
                    "beach"
                  ]
                }
              ]
            },
            {
              "id": "city-scene",
              "name": "街中",
              "kind": "nested",
              "mode": "all",
              "count": 1,
              "on": true,
              "groups": [
                {
                  "id": "city-person",
                  "name": "人物をすべて使用",
                  "mode": "all",
                  "count": 2,
                  "on": true,
                  "item_ids": [
                    "portrait-a",
                    "portrait-b"
                  ]
                },
                {
                  "id": "city-background",
                  "name": "街中背景",
                  "mode": "all",
                  "count": 1,
                  "on": true,
                  "item_ids": [
                    "city"
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "active_recipe_id": "nested-example"
}
;
const root=path.resolve(__dirname,'../..');
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 console.log('opening');await page.goto(base);console.log('loaded');await page.waitForFunction(()=>window.LiteGraph?.registered_node_types?.SAX_Bridge_Text_Catalog_V2,null,{timeout:60000});
 await page.waitForFunction(()=>window.comfyAPI.app.app.rootGraph?._nodes.length>0);
 console.log('registered');const sample=await page.evaluate(config=>{
  window.testApp=window.comfyAPI.app.app;testApp.graph.clear();
  window.testNode=LiteGraph.createNode('SAX_Bridge_Text_Catalog_V2');testNode.pos=[100,120];testApp.graph.add(testNode);
  testNode.widgets.find(w=>w.name==='config_json').value=JSON.stringify(config);testNode.onConfigure({});
  testNode.widgets.find(w=>w.name==='seed').value=123;testNode.widgets.find(w=>w.name==='control_after_generate').value='fixed';
  const debug=LiteGraph.createNode('SAX_Bridge_Debug_Text');debug.pos=[650,120];testApp.graph.add(debug);testNode.connect(0,debug,0);
  const note=LiteGraph.createNode('Note');note.pos=[100,600];note.size=[900,200];note.widgets[0].value='ネスト構成要素のサンプル。\n品質を出力し、シーンから海辺または街中をランダム1件選び、選ばれた子の人物・背景を解決します。\nそのままQueueできます。「共有カタログへ移行」後、セット編集から階層を編集できます。\n＋ ネストで作成、配置先やドラッグで階層移動、各階層ですべて使用／ランダム件数を指定します。';testApp.graph.add(note);
  return testApp.graph.serialize();
 },config);
 console.log('sample created');fs.writeFileSync(path.join(root,'work/text_catalog_v2_nested_sample.json'),JSON.stringify(sample,null,2)+'\n');
 // 埋め込みネストは描画・実行でき、編集の移行案内も開ける。
 await page.evaluate(()=>testNode.widgets.find(w=>w.name==='カタログを開く')?.callback());
 await page.evaluate(()=>{void testNode.widgets.find(w=>w.name==='共有カタログへ移行').callback()});
 console.log('migration dialog');await page.locator('.__sax_prompt_dlg').getByRole('textbox').fill('ネスト動作確認');await page.locator('.__sax_prompt_dlg').getByRole('button',{name:'OK',exact:true}).click();
 console.log('migration submitted');await page.waitForFunction(()=>JSON.parse(testNode.widgets.find(w=>w.name==='config_json').value).version===3);
 await page.evaluate(async()=>{const shared=await import('/extensions/SAX_Bridge/sax_text_catalog_v2_shared.js');window.testShared=()=>shared.sharedController(testNode)});
 await page.waitForFunction(()=>testShared()?.session);console.log('migrated');console.log('alerts',await page.locator('.__sax_alert_dlg').allTextContents());assert.equal(await page.locator('.__sax_alert_dlg').count(),0);
 await page.locator('.ssw-entry').first().getByRole('button',{name:/のセット編集/}).click();
 await page.waitForSelector('.se-card');assert.equal(await page.locator('.se-card').count(),8);
 await page.screenshot({path:path.join(root,'work/comfy-nested-editor.png')});
 await page.locator('.sax-shared-editor').getByRole('button',{name:'閉じる',exact:true}).click();
 console.log('queue');await page.evaluate(()=>testApp.queuePrompt(0,1));
 await page.waitForFunction(()=>testShared()?.result?.selection?.rows?.[0]?.groups?.[1]?.kind==='nested');
 console.log('result received');const first=await page.evaluate(()=>structuredClone(testShared().result));
 const scene=first.selection.rows[0].groups[1];assert.equal(scene.selected_group_ids.length,1);
 const chosen=scene.groups.find(g=>scene.selected_group_ids.includes(g.group_id));assert.equal(chosen.groups[0].items.length,1);assert.equal(chosen.groups[1].items.length,1);
 assert.equal(first.text.split('\n').length,3);
 await page.evaluate(()=>testNode.widgets.find(w=>w.name==='前回の実行結果').callback());
 await page.waitForSelector('.se-section');assert.equal(await page.locator('.se-section').count(),6);
 await page.locator('.se-section').nth(2).getByRole('button',{name:'候補を表示',exact:true}).click();
 assert.equal(await page.locator('.se-section').count(),9);
 await page.locator('.se-record').first().getByRole('button',{name:'本文を編集',exact:true}).click();
 await page.getByRole('textbox',{name:'アイテム本文',exact:true}).fill('edited quality');
 await page.locator('.sax-shared-editor').getByRole('button',{name:'閉じる',exact:true}).click();
 assert.equal(await page.evaluate(()=>testShared().result.text),first.text);
 console.log('queue');await page.evaluate(()=>testApp.queuePrompt(0,1));
 await page.waitForFunction(()=>testShared().result.text.startsWith('edited quality\n'));
 assert.ok(await page.evaluate(revision=>testShared().result.selection.revision>revision,first.selection.revision));
 assert.deepEqual(await page.evaluate(()=>testShared().result.selection.rows[0].groups[1].selected_group_ids),scene.selected_group_ids);
 const saved=await page.request.get(new URL('/sax/text-catalog/v2/catalogs/'+first.selection.catalog_id,base).href);assert.equal(saved.status(),200);
 assert.equal((await saved.json()).recipes[0].groups[1].kind,'nested');
 assert.deepEqual(errors,[]);console.log('PASS: 実ComfyUIで埋め込み移行・ネスト描画・各階層抽選・Queue・階層結果・候補展開・結果編集・改訂キャッシュ更新');
}finally{await browser?.close()}})().catch(error=>{console.error(error);process.exitCode=1});
