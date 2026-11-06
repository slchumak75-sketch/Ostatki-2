const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const item=(row,stock,rating,sales)=>({excelRow:row,sku:'00'+row,name:'Товар '+row,warehouse:'Склад',group:'Группа',supplier:'Поставщик',closingStock:stock,salesSegment:rating,sumSalesLast12M:sales,monthlySales:[],finalOrderQty:1,purchasePrice:10});
const items=[item(8,11,4,10),item(9,10,0,0),item(10,11,3,5),item(11,-1,2,0),item(12,10,2,0),item(13,10,4,0),item(14,999,4,0)];
const props={};for(const row of [8,11,13,14])props[JSON.stringify(['sku','00'+row,'Склад'])]=true;
const comparison=[{excelRow:8,etalonStock:10,etalonRating:4,currentRating:4,stockIncreased:true,etalonChecked:true,reason:'Остаток вырос: 10 → 11'},{excelRow:9,etalonStock:20,etalonRating:1,currentRating:0,ratingDropped:true,etalonChecked:true,reason:'Рейтинг снизился: 1 → 0'},{excelRow:10,etalonStock:10,etalonRating:3,currentRating:3},{excelRow:11,etalonStock:-2,etalonRating:5,currentRating:0,stockIncreased:true,etalonChecked:true,ratingDropped:true,reason:'Остаток вырос: -2 → -1; Рейтинг снизился: 5 → 0'},{excelRow:12,etalonStock:20,etalonRating:2,currentRating:0,ratingDropped:true,etalonChecked:true,reason:'Рейтинг снизился: 2 → 0'},{excelRow:13,etalonStock:10,etalonRating:0,currentRating:0}].map(row=>({...row,matches:[8,9,11,12].includes(row.excelRow)}));
comparison.push({excelRow:14,isNew:true,matches:true,currentRating:4,reason:'новый товар'});
let deferred=null,fail=false;
w.fetch=async(path,opts={})=>{
 calls.push(path);
 if(path==='api/properties')return {ok:true,json:async()=>({properties:props,etalonProperties:{...props},etalonLoaded:true,persisted:true,lastFileName:'Свойства.json',savedAt:'2026-10-24T10:20:30+03:00',directory:'C:\\Users\\hidden\\',etalonLoaded:true,etalonFileName:'Эталон, 20.10.2026.xlsx',etalonSavedAt:'2026-10-24T09:10:11+03:00'})};
 if(path==='api/etalon/compare'){
  if(deferred)await deferred;
  return {ok:!fail,json:async()=>fail?{error:'Нет эталона'}:{rows:comparison}};
 }
 if(path==='api/column-widths')return {ok:true,json:async()=>({widths:{}})};
 return {ok:true,json:async()=>({report:{fileName:'1C.xlsx',items,params:{},warehouses:[],suppliers:[],groups:[],periods:[]}})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
const rows=()=>[...d.querySelectorAll('#tableBody tr[data-row]')].map(tr=>Number(tr.dataset.row)).sort((a,b)=>a-b);
(async()=>{
 await tick();
 const compare=d.getElementById('btnCompareEtalon');
 assert.deepEqual(rows(),[10],'Both protected filters start enabled');
 assert.equal(d.getElementById('propertiesActions'),null);
 assert.equal(d.getElementById('etalonStorageHint'),null,'Duplicated etalon info line is removed');
 for(const id of ['propertiesStorageHint']){
  const text=d.getElementById(id).textContent;assert.match(text,/\.\w+.*\d{2}\.\d{2}\.\d{4}.*\d{2}:\d{2}:\d{2}/);assert.ok(!text.includes('Users')&&!text.includes('Папка'));
 }
 const budget=d.getElementById('kpiOrderCost').textContent;
 const search=d.getElementById('inpSearch');search.value='нет совпадений';search.dispatchEvent(new w.Event('input',{bubbles:true}));
 compare.click();await tick();assert.deepEqual(rows(),[],'Name search narrows comparison results too');
 search.value='Товар 9';search.dispatchEvent(new w.Event('input',{bubbles:true}));await tick();
 assert.deepEqual(rows(),[9],'Search filters the comparison union');
 search.value='';search.dispatchEvent(new w.Event('input',{bubbles:true}));await tick();
 compare.click();await tick();assert.deepEqual(rows(),[8,9,11,12,14],'Union bypasses both protected filters');
 assert.equal(compare.getAttribute('aria-pressed'),'true');
 assert.match(d.querySelector('tr[data-row="14"] .comparison-reason').textContent,/новый товар/);
 assert.equal(d.querySelector('#tableBody tr[data-row="9"] .seg-pill').textContent,'0','Comparison displays the current 0 rather than reference 1');
 assert.equal(d.getElementById('kpiOrderCost').textContent,budget,'Comparison must not alter the all-supplier budget');
 // Column filters work over the comparison union; «Номенклатура» offers only comparison properties.
 d.querySelector('[data-filter-col="name"]').click();
 const nameOptions=[...d.querySelectorAll('#efOptionsList input[data-excel-value]')].map(input=>input.dataset.excelValue);
 assert.deepEqual(nameOptions,['Новый товар','Остаток вырос','Рейтинг снизился'],'Name filter lists only comparison properties');
 const optionRow=label=>[...d.querySelectorAll('#efOptionsList .ef-opt-row')].find(row=>row.textContent.includes(label));
 assert.match(optionRow('Остаток вырос').textContent,/2/,'Count of stock-growth rows');
 assert.match(optionRow('Рейтинг снизился').textContent,/3/,'Count of rating-drop rows');
 const setOption=(label,checked)=>{const input=optionRow(label).querySelector('input');input.checked=checked;input.dispatchEvent(new w.Event('change',{bubbles:true}));};
 // Each change re-renders the options, so rows are looked up freshly every time.
 setOption('Новый товар',false);setOption('Рейтинг снизился',false);
 d.getElementById('efBtnOk').click();await tick();
 assert.deepEqual(rows(),[8,11],'Stock-growth property filters the comparison');
 d.querySelector('[data-filter-col="salesSegment"]').click();
 const ratingOptions=[...d.querySelectorAll('#efOptionsList input[data-excel-value]')].map(input=>input.dataset.excelValue).sort();
 assert.deepEqual(ratingOptions,['0','4'],'Other column filters count comparison rows with the displayed rating');
 setOption('4',false);
 d.getElementById('efBtnOk').click();await tick();
 assert.deepEqual(rows(),[11],'Rating filter combines with the property filter');
 d.querySelector('.tab-btn[data-tab="table"]').click();assert.deepEqual(rows(),[],'Leaving comparison restores ordinary search and drops property filters');
 d.getElementById('btnClearAllExcelFilters').click();await tick(); // ordinary filters persist after exit; clear them for the next section
 for(const tab of ['table','suppliers','charts','analytics']){
  compare.click();await tick();assert.deepEqual(rows(),[8,9,11,12,14]);
  d.querySelector(`.tab-btn[data-tab="${tab}"]`).click();
  assert.equal(compare.getAttribute('aria-pressed'),'false');assert.ok(d.getElementById('comparisonHint').classList.contains('hidden'));assert.deepEqual(rows(),[10]);
 }
 // A stock-only match must survive live checkbox edits: reference is frozen.
 for(const id of ['btnSales12','btnRelevant'])for(let i=0;i<4;i++)d.getElementById(id).click();
 assert.equal(d.querySelector('#tableBody tr[data-row="9"] .seg-pill').textContent,'0','Ordinary table displays the same current rating as comparison');
 compare.click();await tick();
 const mark=d.querySelector('[data-plus-row="8"]');mark.checked=false;mark.dispatchEvent(new w.Event('change',{bubbles:true}));await tick();
 assert.deepEqual(rows(),[8,9,11,12,14]);
 compare.click();await tick();assert.deepEqual(rows(),[8,9,11,12,14],'Repeated comparison ignores edited live marks');
 d.querySelector('.tab-btn[data-tab="table"]').click();
 const restore=d.querySelector('[data-plus-row="8"]');restore.checked=true;restore.dispatchEvent(new w.Event('change',{bubbles:true}));await tick();
 for(const id of ['btnSales12','btnRelevant'])d.getElementById(id).click();
 let resolve;deferred=new Promise(r=>resolve=r);compare.click();await tick();
 d.querySelector('.tab-btn[data-tab="suppliers"]').click();resolve();await tick();deferred=null;
 assert.equal(compare.getAttribute('aria-pressed'),'false','Tab navigation cancels a pending comparison too');
 fail=true;compare.click();await tick();assert.match(d.getElementById('toast').textContent,/Нет эталона/);assert.equal(compare.disabled,false);assert.deepEqual(rows(),[10]);
 console.log('Reference comparison, tab exit/cancellation, layout, and compact save statuses passed');w.close();
})().catch(e=>{console.error(e);w.close();process.exitCode=1;});
