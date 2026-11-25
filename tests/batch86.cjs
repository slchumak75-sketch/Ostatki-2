const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
// Б86: при обновлении браузер показывал лишний системный вопрос «Уйти со
// страницы?», а старое окно не закрывалось и висело заглушкой
// «Программа обновляется…». После подтверждения обновления закрытие —
// штатное (isClosingConfirmed), beforeunload молчит.
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:1,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:0,finalOrderQty:0,manualOverride:null}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[],groups:[],suppliers:[]};
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/settings/pick-file')return {ok:true,json:async()=>({path:'C:\\Загрузки\\OstatkiZakupki_Variant_7.30.exe',cancelled:false})};
 if(path==='api/update/apply')return {ok:true,json:async()=>({updating:true,mode:'replace'})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
w.close=()=>{}; // окно «не закрылось» — проверяем поведение заглушки
const tick=(ms=70)=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 await tick();
 // До обновления уход со страницы честно предупреждается (ведомось открыта).
 const before=new w.Event('beforeunload',{cancelable:true});
 w.dispatchEvent(before);
 assert.equal(before.defaultPrevented,true,'до обновления вопрос «Уйти?» на месте');
 // Обновление: выбор файла → подтверждение.
 d.getElementById('btnUpdateApp').click();await tick();
 d.getElementById('safetyDialogYes').click();await tick(150);
 assert.ok(calls.some(c=>c.path==='api/update/apply'),'Б86: обновление применено');
 // После подтверждения закрытие штатное: системный вопрос не всплывает.
 const after=new w.Event('beforeunload',{cancelable:true});
 w.dispatchEvent(after);
 assert.equal(after.defaultPrevented,false,'Б86: при обновлении браузер не спрашивает «Уйти?»');
 // Текст заглушки подсказывает запасной путь, если окно новой версии не видно.
 await tick(1600);
 assert.match(d.body.textContent,/ярлыком «Остатки 2»/,'Б86: заглушка подсказывает запуск ярлыком');
 console.log('BATCH-86: no leave-prompt during update, helpful stub text: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
