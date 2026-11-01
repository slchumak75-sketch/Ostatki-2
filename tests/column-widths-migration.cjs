// NODE_PATH=/tmp/ui-check/node_modules node tests/column-widths-migration.cjs
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.ResizeObserver=class{observe(){}};
w.scrollTo=()=>{};w.setInterval=()=>1;
const legacy=[140,90,120,80,260,50,60,32,60,70,80,90,70,60,80,120]; // 16 widths: up to the removed «Запас» column.
w.fetch=async(path,options={})=>{
  if(options&&options.body)calls.push({path,body:JSON.parse(options.body)});
  if(path==='api/column-widths')return {ok:true,json:async()=>({widths:{itemsTable:legacy,suppliersTable:[100,200]}})};
  if(path==='api/properties')return {ok:true,json:async()=>({properties:{}})};
  return {ok:true,json:async()=>({report:{items:[{excelRow:8,sku:'001',name:'Товар',warehouse:'Склад',group:'Группа',closingStock:5,sumSalesLast12M:3,salesSegment:2,monthlySales:[],autoOrderQty:0,finalOrderQty:0,purchasePrice:1}],params:{},warehouses:[],suppliers:[],groups:[],periods:[],fileName:'1C.xlsx'}})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 const cols=()=>d.querySelectorAll('#itemsTable > colgroup > col').length;
 assert.equal(d.querySelectorAll('#itemsTable thead th').length,15,'Statement has 15 columns now');
 assert.equal(cols(),14,'Legacy 16 widths must migrate (drop «Запас») and apply without the plus column');
 const savedCall=calls.filter(c=>c.path==='api/column-widths'&&c.body.widths&&Array.isArray(c.body.widths.itemsTable)).at(-1);
 assert.ok(savedCall,'Migrated widths must persist to the server');
 assert.equal(savedCall.body.widths.itemsTable.length,15);
 assert.deepEqual(savedCall.body.widths.itemsTable.slice(0,6),legacy.slice(0,6),'Widths before «Запас» stay in place');
 assert.deepEqual(savedCall.body.widths.itemsTable.slice(6),legacy.slice(7),'Widths after «Запас» shift left');
 await tick();
 assert.ok(!calls.some(c=>c.path==='api/column-widths'&&c.body?.widths&&c!==savedCall&&Array.isArray(c.body.widths.itemsTable)),'Migration must persist once');
 console.log('Column widths migration for the removed Запас column passed');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
