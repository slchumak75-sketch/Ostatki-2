const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
// Б81: розовый овал остатков 0 — в три раза бледнее (#fceff3 вместо #fadce5).
const css=fs.readFileSync('internal/server/web/styles.css','utf8');
assert.ok(css.includes('#itemsTable .qty-input.zero-order-hl { background: #fceff3;'),'Б81: овал #fceff3');
assert.ok(!css.includes('#fadce5')&&!css.includes('#fbf3cf'),'Б81: прежние розовый/жёлтый убраны');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:1,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:1,orderItems:1,totalOrderQty:4,totalOrderCost:8}],groups:[]};
w.fetch=async(path)=>{
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/column-widths')return {ok:true,json:async()=>({widths:{}})};
 if(path==='api/orders/sent-marks')return {ok:true,json:async()=>({sent:[]})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,90));
(async()=>{try{
 await tick();await tick();
 d.getElementById('btnHighlightZero').click();await tick();
 assert.ok(d.querySelector('input[data-qty-row="8"]').classList.contains('zero-order-hl'),'Б81: бледно-розовый овал ставится на остаток 0');
 console.log('BATCH-81: zero oval three times paler pink: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
