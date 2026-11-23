const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар ноль',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4},{excelRow:9,sku:'002',name:'Товар запас',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:7,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:2,finalOrderQty:2}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:2,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:2,orderItems:2,totalOrderQty:6,totalOrderCost:12}],groups:[]};
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
 // CSS-контракт: только овал в «Заказ», бледно-жёлтый; построчной заливки нет.
 const css=fs.readFileSync('internal/server/web/styles.css','utf8');
 assert.ok(css.includes('#itemsTable .qty-input.zero-order-hl { background: #fceff3;'),'Б81: очень бледный розовый овал только в столбце «Заказ»');
 assert.ok(!css.includes('#fbf3cf'),'Б80: прежний жёлтый заменён розовым');
 assert.ok(!css.includes('tr.zero-stock-hl'),'Б79: построчная заливка нулей убрана');
 const zero=d.getElementById('btnHighlightZero');
 const input8=()=>d.querySelector('input[data-qty-row="8"]'),input9=()=>d.querySelector('input[data-qty-row="9"]');
 assert.ok(input8()&&input9(),'строки отрисованы');
 assert.ok(!input8().classList.contains('zero-order-hl'),'по умолчанию овала нет');
 zero.click();await tick();
 assert.ok(input8().classList.contains('zero-order-hl'),'Б79: остаток 0 — жёлтый овал в «Заказ»');
 assert.ok(!input9().classList.contains('zero-order-hl'),'Б79: остаток 7 — без овала');
 assert.ok(!d.querySelector('tr[data-row="8"]').className.includes('zero'),'Б79: класс строки не используется');
 // Стандартная подсветка (цвет склада) имеет приоритет над жёлтым овалом.
 d.getElementById('btnHighlightOrder').click();await tick();
 assert.ok(input8().classList.contains('order-highlighted'),'Б79: стандартная подсветка включилась');
 assert.ok(!input8().classList.contains('zero-order-hl'),'Б79: складской овал вместо жёлтого');
 console.log('BATCH-79: zero stock pale-yellow oval in order column only: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
