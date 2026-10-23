// Run with NODE_PATH pointing to jsdom.
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const dom = new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const key=JSON.stringify(['sku','A']);
const props={[key]:true,[JSON.stringify(['name','Группа','Без артикула'])]:true};
const makeItem=(row,sku,name='Товар')=>({excelRow:row,sku,name,warehouse:'Склад',group:'Группа',supplier:'Поставщик',sumSalesLast12M:2,closingStock:1,salesSegment:1,finalOrderQty:0,purchasePrice:1,monthlySales:[]});
const env=(name,items)=>({report:{fileName:name,items,warehouses:[],groups:[],suppliers:[],periods:[],params:{}}});
let uploaded=env('new.xlsx',[makeItem(55,'A'),makeItem(56,'B'),makeItem(57,'','Без артикула')]);
let snapshots=0;
w.fetch=async(path,options={})=>{
 if(path==='api/properties') {
  const req=options.body ? JSON.parse(options.body):{};
  Object.assign(props,req.properties || {});
  if(req.save) snapshots++;
  return {ok:true,json:async()=>({properties:{...props},fileName:'Свойства Номенклатуры.json'})};
 }
 return {ok:true,json:async()=>path==='api/upload' ? uploaded : env('old.xlsx',[makeItem(8,'A'),makeItem(9,'A'),makeItem(10,'B'),makeItem(11,'','Без артикула')])};
};
w.scrollTo=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
const checked=row=>d.querySelector(`[data-plus-row="${row}"]`).checked;
const load=async()=>{
 const input=d.getElementById('fileInput');
 Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['x'],'new.xlsx')]});
 input.dispatchEvent(new w.Event('change'));await tick();
};
(async()=>{
 await tick();
 assert.ok(checked(8) && checked(9),'SKU properties restored across warehouse rows');
 assert.equal(checked(11),true,'Name/group fallback when SKU is absent');
 const chk=d.querySelector('[data-plus-row="8"]');chk.checked=false;chk.dispatchEvent(new w.Event('change',{bubbles:true}));
 await tick();
 assert.equal(checked(9),false,'One nomenclature property applies to duplicate SKU');
 await load();
 assert.equal(checked(55),false,'Explicit removal survives new workbook and row changes');
 assert.equal(checked(57),true,'Fallback key survives row changes');
 const b=d.querySelector('[data-plus-row="56"]');b.checked=true;b.dispatchEvent(new w.Event('change',{bubbles:true}));
 await tick();
 d.getElementById('btnSaveProperties').click();await tick();
 assert.equal(snapshots,1);
 uploaded=env('newer.xlsx',[makeItem(100,'B'),makeItem(101,'C')]);
 await load();
 assert.equal(checked(100),true,'Checkmark follows SKU rather than Excel row');
 assert.equal(checked(101),false,'Unknown SKU is not checked');
 assert.equal(props[JSON.stringify(['sku','B'])],true);
 console.log('Independent nomenclature property tests passed');w.close();
})().catch(err=>{console.error(err);w.close();process.exitCode=1;});
