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
    {sku:'A1',name:'Дрель ударная',group:'Группа',matchScore:100,matchBy:'артикул',whAStock:20,whAMonths:20,whAExcessUnits:8,whAExcessValue:80,whBStock:0,whBOrderQty:5,whBNeedOrder:true,verdict:'Заказ не требуется: закрыть перетоком со склада А (излишек 8 шт ≈ 80.00 руб.)'},
    {sku:'',name:'Перчатки рабочие',group:'Группа',matchScore:64,matchBy:'название',whAStock:50,whAMonths:999,whAExcessUnits:50,whAExcessValue:400,whBStock:1,whBOrderQty:2,whBNeedOrder:true,verdict:'Заказ не требуется: закрыть перетоком со склада А (излишек 50 шт ≈ 400.00 руб.)'}
   ],matched:2,bySku:1,byName:1,months:9,whA:'Склад Мир',whB:'Склад Кореличи'})};
 if(path.startsWith('api/stock-analysis/export'))return {ok:true,blob:async()=>new w.Blob(['xlsx'])};
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 return {ok:true,json:async()=>env};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 // Б41: пять старых кнопок удалены, новая — на их месте в «Конфигурации».
 for(const id of ['btnBackupEtalon','btnReferenceHistory','btnCompareExport','btnFullBackup','btnFullRestore','fullRestoreInput'])assert.equal(d.getElementById(id),null,'Б41: '+id+' удалён');
 assert.ok(d.getElementById('btnStockAnalysis').closest('#paramsPanel'),'Анализ остатков сидит в панели конфигурации');
 // Открытие окна: селекторы заполняются складами ведомости, месяцы — настройка.
 d.getElementById('btnStockAnalysis').click();await tick();
 assert.ok(!d.getElementById('stockAnalysisModal').classList.contains('hidden'),'Окно анализа открылось');
 const whA=d.getElementById('stockAnalysisWhA'),whB=d.getElementById('stockAnalysisWhB');
 assert.equal(whA.options.length,2);assert.equal(whB.options.length,2);
 assert.equal(whA.value,'Склад Кореличи','склады в селекторах по алфавиту');assert.equal(whB.value,'Склад Мир');
 assert.equal(d.getElementById('stockAnalysisMonths').value,'12','Месяцы по умолчанию 12');
 // Запуск анализа: параметры уходят в запрос (норма месяцев = 9), таблица рендерится.
 d.getElementById('stockAnalysisMonths').value='9';
 d.getElementById('btnStockAnalysisRun').click();await tick();
 const req=calls.find(c=>c.path.startsWith('api/stock-analysis?'));
 assert.ok(req,'запрос анализа выполнен');
 assert.ok(req.path.includes('months=9'),'порог месяцев из настройки: '+req.path);
 assert.ok(req.path.includes(encodeURIComponent('Склад Мир'))&&req.path.includes(encodeURIComponent('Склад Кореличи')));
 const table=d.getElementById('stockAnalysisResults').querySelector('table');
 assert.ok(table,'таблица результатов построена');
 assert.match(table.textContent,/Дрель ударная/);
 assert.match(table.textContent,/100% \(артикул\)/);
 assert.match(table.textContent,/64% \(название\)/);
 assert.match(table.textContent,/Заказ не требуется: закрыть перетоком со склада А/);
 assert.match(d.getElementById('stockAnalysisSummary').textContent,/Совпадений: 2/);
 assert.equal(d.getElementById('btnStockAnalysisExport').disabled,false);
 // Настройка месяцев запоминается.
 assert.equal(w.localStorage.getItem('ostatki_stock_analysis_months'),'9');
 // Выгрузка в Excel.
 d.getElementById('btnStockAnalysisExport').click();await tick();
 assert.ok(downloads.includes('Анализ остатков.xlsx'),'Excel-выгрузка скачивается');
 // Esc закрывает окно (строго no-op по данным).
 d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await tick();
 assert.ok(d.getElementById('stockAnalysisModal').classList.contains('hidden'),'Esc закрывает окно анализа');
 console.log('STOCK-ANALYSIS UI + б41 button removal: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
