const {JSDOM}=require('jsdom');const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window,d=w.document;w.scrollTo=()=>{};w.setInterval=()=>1;
const clone=value=>JSON.parse(JSON.stringify(value));
const items=Array.from({length:1200},(_,i)=>({excelRow:i+8,name:'Товар '+i,sku:String(i),warehouse:'Склад',supplier:'Поставщик',group:'Группа',closingStock:3,sumSalesLast12M:3,salesSegment:3,monthlySales:[],autoOrderQty:2,finalOrderQty:0,purchasePrice:1}));
let data={workbookId:1,params:{budgetCap:0},overrides:{},properties:{},suppliers:[],selectionActive:false};let writes=0;
const report=()=>({fileName:'Тест.xlsx',items:items.map(it=>({...it,finalOrderQty:data.overrides[it.excelRow]||0,manualOverride:data.overrides[it.excelRow]??null})),params:data.params,periods:[],warehouses:[],groups:[],suppliers:[]});
const envelope=()=>({historyWorkbookId:1,report:report(),overrides:data.overrides,selectedSuppliers:data.suppliers});
w.fetch=async(path,options={})=>{if(path==='api/action-history'){if(options.method==='POST'){writes++;data=clone(JSON.parse(options.body));return {ok:true,json:async()=>clone({state:envelope(),properties:data.properties,nomenclature:{}})};}return {ok:true,json:async()=>clone(data)};}if(path==='api/properties')return {ok:true,json:async()=>({properties:{}})};if(path==='api/override'){const body=JSON.parse(options.body);data.overrides[body.excelRow]=body.value;}return {ok:true,json:async()=>clone(envelope())};};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__historyTest={state,refreshExcelTable,recordActionHistory,scheduleActionHistory};bootstrap();'));
const tick=(ms=600)=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 await tick(1400);const {state,refreshExcelTable}=w.__historyTest;
 // Стрелки отмены/повтора убраны с верхней плашки: действий-кнопок больше нет в DOM.
 assert.equal(d.getElementById('btnUndoAction'),null,'Undo arrow must be removed from the top bar');
 assert.equal(d.getElementById('btnRedoAction'),null,'Redo arrow must be removed from the top bar');
 // Current top row survives removal of relevance filtering even when earlier rows reappear.
 for(let i=0;i<500;i+=2)state.staryoRows.add(i+8);state.unmarkedOnly=true;refreshExcelTable();const scroll=d.getElementById('tableScrollContainer');scroll.scrollTop=2400+5;scroll.dispatchEvent(new w.Event('scroll'));await tick(30);const before=state.filteredItems[100].excelRow;
 for(let i=0;i<4;i++)d.getElementById('btnRelevant').click();assert.equal(state.unmarkedOnly,false);const index=state.filteredItems.findIndex(it=>it.excelRow===before);assert.equal(scroll.scrollTop,index*24+5);assert.ok(d.querySelector(`[data-row="${before}"]`),'Anchored row must be rendered after virtual scrolling');
 console.log('History arrows removed from the top bar; relevance viewport anchoring passed');
}finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
