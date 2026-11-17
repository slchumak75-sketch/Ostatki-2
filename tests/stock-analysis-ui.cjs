const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[],downloads=[],timers=[];
w.scrollTo=()=>{};w.setInterval=(cb,ms)=>{timers.push({cb,ms});return timers.length;};
w.URL.createObjectURL=()=> 'blob:sa';w.URL.revokeObjectURL=()=>{};
w.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};
const mk=(row,sku,name,wh,stock,sum12,segment=1,final=0,price=10)=>({excelRow:row,sku,name,warehouse:wh,group:'Группа',supplier:'Поставщик',closingStock:stock,sumSalesLast12M:sum12,salesSegment:segment,purchasePrice:price,monthlySales:[],finalOrderQty:final});
const items=[
 mk(8,'A1','Дрель ударная','Склад Мир',20,12,1,0,10),
 mk(9,'A1','Дрель ударная','Склад Кореличи',0,0,3,5,10),
 mk(10,'','Молоток стальной','Склад Мир',50,0,1,0,8),
 mk(11,'','Молоток стальной','Склад Кореличи',3,4,1,0,8),
 mk(12,'','Перчатки рабочие','Склад Кореличи',1,0,2,2,3),
];
const env={report:{items,fileName:'Ведомость.xlsx',periods:[],warehouses:['Склад Мир','Склад Кореличи'],suppliers:[],groups:[],params:{},totalItems:items.length},savedFileName:'',lastSavedAt:''};
w.fetch=async(path,options={})=>{
 calls.push({path,options});
 if(path.startsWith('api/stock-analysis?'))return {ok:true,json:async()=>({
   rows:[
    {group:'Группа',sku:'A1',name:'Дрель ударная',matchScore:100,whAStock:20,whAMonths:20,whBStock:0,whBMonths:0,arrow:'AtoB',excessUnits:8,excessValue:80},
    {group:'Группа',sku:'',name:'Перчатки рабочие',matchScore:64,whAStock:50,whAMonths:999,whBStock:1,whBMonths:2,arrow:'BtoA',excessUnits:50,excessValue:400}
   ],matched:2,bySku:1,byName:1,months:9,whA:'Склад Мир',whB:'Склад Кореличи'})};
 if(path.startsWith('api/stock-analysis/export'))return {ok:true,blob:async()=>new w.Blob(['xlsx'])};
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 return {ok:true,json:async()=>env};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 for(const id of ['btnBackupEtalon','btnReferenceHistory','btnCompareExport','btnFullBackup','btnFullRestore','fullRestoreInput'])assert.equal(d.getElementById(id),null,'Б41: '+id+' удалён');
 assert.ok(d.getElementById('btnStockAnalysis').closest('#paramsPanel'),'Анализ остатков сидит в панели конфигурации');
 d.getElementById('btnStockAnalysis').click();await tick();
 assert.ok(!d.getElementById('stockAnalysisModal').classList.contains('hidden'),'Окно анализа открылось');
 const whA=d.getElementById('stockAnalysisWhA'),whB=d.getElementById('stockAnalysisWhB');
 assert.equal(whA.options.length,2);assert.equal(whB.options.length,2);
 assert.equal(whA.value,'Склад Кореличи','склады в селекторах по алфавиту');assert.equal(whB.value,'Склад Мир');
 assert.equal(d.getElementById('stockAnalysisMonths').value,'12','Месяцы по умолчанию 12');
 d.getElementById('stockAnalysisMonths').value='9';
 d.getElementById('btnStockAnalysisRun').click();
 assert.match(d.getElementById('stockAnalysisSummary').textContent,/Анализирую/,'индикатор сразу после нажатия (синхронно, до ответа)');
 await tick();
 const req=calls.find(c=>c.path.startsWith('api/stock-analysis?'));
 assert.ok(req,'запрос анализа выполнен');
 assert.ok(req.path.includes('months=9'),'порог месяцев из настройки: '+req.path);
 // Б43: таблица Группа/Артикул/Наименование/Совпадение/Склады + жирная стрелка.
 const table=d.getElementById('stockAnalysisResults').querySelector('table');
 assert.ok(table,'таблица результатов построена');
 const head=table.querySelector('tr').textContent;
 assert.match(head,/Группа/);assert.match(head,/Артикул/);assert.match(head,/Номенклатура/);
 assert.match(head,/Совпадение/);assert.match(head,/Склад Мир/);assert.match(head,/Склад Кореличи/);assert.match(head,/Перемещение/);
 assert.match(table.textContent,/Дрель ударная/);
 assert.match(table.textContent,/100%/);
 const arrow=table.querySelector('span[style*="font-weight:700"]');
 assert.ok(arrow && arrow.textContent==='→','жирная стрелка направления А→Б');
 assert.match(table.textContent,/←/,'обратная стрелка Б→А присутствует');
 assert.match(d.getElementById('stockAnalysisSummary').textContent,/Совпадений: 2/);
 assert.equal(d.getElementById('btnStockAnalysisExport').disabled,false);
 assert.equal(w.localStorage.getItem('ostatki_stock_analysis_months'),'9');
 d.getElementById('btnStockAnalysisExport').click();await tick();
 assert.ok(downloads.includes('Анализ остатков.xlsx'),'Excel-выгрузка скачивается');
 d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await tick();
 assert.ok(d.getElementById('stockAnalysisModal').classList.contains('hidden'),'Esc закрывает окно анализа');
 // Б43: таблица на всю высоту экрана (CSS).
 const css=fs.readFileSync('internal/server/web/styles.css','utf8');
 assert.match(css,/#stockAnalysisResults\s*\{\s*max-height: calc\(100vh - 250px\);/,'таблица на всю высоту экрана');
 assert.match(css,/position: sticky/,'шапка таблицы прилипает при прокрутке');
 console.log('STOCK-ANALYSIS UI (б43 arrows + fullscreen table): OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
