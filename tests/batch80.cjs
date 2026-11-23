const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,copied=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:async t=>{copied.push(t);}}});
const items=[{excelRow:8,sku:'ART-1',barcode:'0460001234567',name:'Товар',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4},{excelRow:9,sku:'ART-2',barcode:'',name:'Товар 2',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:7,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:2,finalOrderQty:2}];
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
 // Б80: ячейка «Артикул» — два поля без разделителя: артикул сверху, штрихкод снизу.
 const cell=d.querySelector('tr[data-row="8"] td.sku-cell');
 assert.ok(cell,'ячейка артикула отрисована');
 assert.equal(cell.querySelector('.sku-main').textContent,'ART-1','артикул сверху');
 assert.equal(cell.querySelector('.sku-barcode').textContent,'0460001234567','штрихкод снизу');
 const css=fs.readFileSync('internal/server/web/styles.css','utf8');
 assert.match(css,/\.sku-cell \.sku-main\s*\{\s*display: block;\s*font-size: 10\.5px;/,'артикул чуть мельче, верхнее поле');
 assert.match(css,/\.sku-cell \.sku-barcode\s*\{\s*display: block;\s*font-size: 8px;/,'штрихкод шрифтом как «Группа» (8px)');
 // Клик по артикулу/штрихкоду — копирование в буфер, без выбора строки.
 const row9=d.querySelector('tr[data-row="9"]');
 assert.ok(!row9.classList.contains('selected-row'));
 row9.querySelector('.sku-main').click();await tick();
 assert.deepEqual(copied,['ART-2'],'клик по артикулу копирует артикул');
 assert.ok(!row9.classList.contains('selected-row'),'клик по артикулу не выбирает строку');
 assert.match(d.getElementById('toast').textContent,/Артикул скопирован/);
 cell.querySelector('.sku-barcode').click();await tick();
 assert.deepEqual(copied,['ART-2','0460001234567'],'клик по штрихкоду копирует штрихкод');
 assert.match(d.getElementById('toast').textContent,/Штрихкод скопирован/);
 // Пустой штрихкод: клик ничего не копирует.
 const before=copied.length;
 row9.querySelector('.sku-barcode').click();await tick();
 assert.equal(copied.length,before,'пустой штрихкод не копируется');
 // Б80: розовый овал нулей.
 assert.ok(css.includes('#itemsTable .qty-input.zero-order-hl { background: #fceff3;'),'бледно-розовый овал #fceff3');
 console.log('BATCH-80: sku+barcode cell, copy on click, pink zero oval: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
