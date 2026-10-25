// Run with NODE_PATH pointing to jsdom.
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const dom = new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const key=JSON.stringify(['sku','A','Склад']);
const legacy=JSON.stringify(['sku','LEG']);
const props={[legacy]:true,[key]:true,[JSON.stringify(['name','Группа','Без артикула','Склад'])]:true};
const makeItem=(row,sku,name='Товар')=>({excelRow:row,sku,name,warehouse:'Склад',group:'Группа',supplier:'Поставщик',sumSalesLast12M:2,closingStock:1,salesSegment:1,finalOrderQty:0,purchasePrice:1,monthlySales:[]});
const env=(name,items)=>({report:{fileName:name,items,warehouses:[],groups:[],suppliers:[],periods:[],params:{}}});
let uploaded=env('new.xlsx',[makeItem(55,'A'),makeItem(56,'B'),makeItem(57,'','Без артикула')]);
let snapshots=0;
let importedProps=null;
w.fetch=async(path,options={})=>{if(path==='api/workbook/check')return {ok:true,json:async()=>({items:3,fileName:'new.xlsx',warehouses:[],duplicates:0,noPrices:0})};
 if(path==='api/properties/import') return {ok:true,json:async()=>({properties:importedProps})};
 if(path==='api/properties') {
  const req=options.body ? JSON.parse(options.body):{};
  for(const key of req.removeKeys || []) delete props[key];
  Object.assign(props,req.properties || {});
  if(req.save) snapshots++;
  return {ok:true,json:async()=>({properties:{...props},etalonLoaded:true,etalonProperties:{},fileName:'Свойства Номенклатуры.json',persisted:Boolean(req.persist || req.save),markedCount:Object.values(props).filter(Boolean).length,directory:'test-properties',savedAt:'2026-10-24T10:20:30+03:00',lastFileName:'Свойства Номенклатуры.json'})};
 }
 return {ok:true,json:async()=>path==='api/upload' ? uploaded : env('old.xlsx',[makeItem(8,'A'),{...makeItem(9,'A'),warehouse:'Другой склад'},makeItem(10,'B'),makeItem(11,'','Без артикула'),makeItem(12,'LEG'),{...makeItem(13,'LEG'),warehouse:'Другой склад'}])};
};
w.scrollTo=()=>{};
new w.MutationObserver(()=>{const box=d.getElementById('safetyDialog');if(box&&!box.classList.contains('hidden'))d.getElementById('safetyDialogYes').click();}).observe(d.body,{subtree:true,attributes:true,attributeFilter:['class']});
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
const checked=row=>d.querySelector(`[data-plus-row="${row}"]`).checked;
const load=async()=>{
 const input=d.getElementById('fileInput');
 Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['x'],'new.xlsx')]});
 input.dispatchEvent(new w.Event('change'));await tick();
 for(const id of ['btnSales12','btnRelevant'])for(let i=0;i<4;i++)d.getElementById(id).click();
};
(async()=>{
 await tick();for(const id of ['btnSales12','btnRelevant'])for(let i=0;i<4;i++)d.getElementById(id).click();
 assert.equal(checked(8),true);
 assert.equal(checked(9),false,'A mark on one warehouse must not affect another');
 const other=d.querySelector('[data-plus-row="9"]');other.checked=true;other.dispatchEvent(new w.Event('change',{bubbles:true}));
 await tick();
 assert.equal(checked(11),true,'Name/group fallback when SKU is absent');
 assert.ok(checked(12) && checked(13),'Legacy marks preserved during one-time warehouse migration');
 const legacyCheck=d.querySelector('[data-plus-row="12"]');legacyCheck.checked=false;legacyCheck.dispatchEvent(new w.Event('change',{bubbles:true}));
 await tick();
 assert.equal(checked(13),true,'Migrated warehouses become independent');
 assert.equal(Object.hasOwn(props,legacy),false,'Old shared key retired from server memory');
 const chk=d.querySelector('[data-plus-row="8"]');chk.checked=false;chk.dispatchEvent(new w.Event('change',{bubbles:true}));
 await tick();
 assert.equal(checked(9),true,'Removing a mark must not affect another warehouse');
 await load();
 assert.equal(checked(55),false,'Explicit removal survives new workbook and row changes');
 assert.equal(checked(57),true,'Fallback key survives row changes');
 const b=d.querySelector('[data-plus-row="56"]');b.checked=true;b.dispatchEvent(new w.Event('change',{bubbles:true}));
 await tick();
 assert.equal(d.getElementById('btnSaveProperties'),null,'Working properties persist automatically without a manual button');
 console.log('Independent nomenclature property tests passed');w.close();
})().catch(err=>{console.error(err);w.close();process.exitCode=1;});
