const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:1,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:1,orderItems:1,totalOrderQty:4,totalOrderCost:8}],groups:[]};
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body});
 if(path==='api/properties'&&options.method==='POST')return {ok:true,json:async()=>({ok:true})};
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/column-widths'&&options.method==='POST')return {ok:true,json:async()=>({ok:true})};
 if(path==='api/db/save')return {ok:true,json:async()=>({fileName:'Ведомость сохраненная.xlsx',savedAt:'22.11.2026'})};
 if(path==='api/shutdown')return {ok:true,json:async()=>({})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,80));
function manualWidths(table,widths){
 table.classList.add('table-manual-cols');
 const cg=d.createElement('colgroup');
 widths.forEach(x=>{const c=d.createElement('col');c.style.width=x+'px';cg.appendChild(c);});
 table.insertBefore(cg,table.firstChild);
}
(async()=>{try{
 await tick();
 // Б77: подсказка об автосохранении конфигурации на месте.
 assert.ok(d.getElementById('configAutosaveHint'),'Б77: подсказка автосохранения конфигурации');
 assert.match(d.getElementById('configAutosaveHint').textContent,/автоматически/);
 // Б77: «Сохранить поля» — все таблицы одним нажатием (+ своя кнопка в предпросмотре).
 manualWidths(d.getElementById('itemsTable'),[40,180,90]);
 manualWidths(d.getElementById('suppliersTable'),[120,200,80]);
 manualWidths(d.getElementById('orderPreviewTable'),[90,300,60]);
 assert.ok(d.getElementById('btnSaveFieldsPreview'),'Б77: своя кнопка «Сохранить поля» в предпросмотре');
 d.getElementById('btnSaveFieldsPreview').click();await tick();
 const cw=calls.filter(c=>c.path==='api/column-widths').at(-1);
 assert.ok(cw,'Б77: сохранение полей вызвано из предпросмотра');
 assert.deepEqual(cw.body.widths.itemsTable,[40,180,90],'Б77: главная таблица в сохранении');
 assert.deepEqual(cw.body.widths.suppliersTable,[120,200,80],'Б77: вкладка «Заказ» в сохранении');
 assert.deepEqual(cw.body.widths.orderPreviewTable,[90,300,60],'Б77: предпросмотр в сохранении');
 assert.ok(calls.some(c=>c.path==='api/settings/save-all'),'Б84: «Сохранить настройки» фиксирует и почту/параметры на сервере');
 assert.match(d.getElementById('toast').textContent,/Настройки сохранены/,'Б84: кнопка теперь «Сохранить настройки» — всё одним нажатием');
 // Б77: кнопка «Выход» открывает вопрос «Сохранить эталон?».
 assert.ok(d.getElementById('btnAppExit'),'Б77: кнопка «Выход» на месте');
 d.getElementById('btnAppExit').click();await tick();
 assert.ok(!d.getElementById('closeConfirmModal').classList.contains('hidden'),'Б77: диалог выхода открыт');
 assert.equal(d.getElementById('closeConfirmTitle').textContent,'Сохранить эталон?');
 // «Не сохранять» = только эталон: ведомость всё равно сохраняется, затем shutdown.
 calls.length=0;
 d.getElementById('btnCloseSaveNo').click();await tick();await tick();
 const save=calls.find(c=>c.path==='api/db/save');
 assert.ok(save,'Б77: ведомость сохранена при выходе без эталона');
 assert.equal(save.body.reason,'close');
 assert.ok(calls.some(c=>c.path==='api/shutdown'),'Б77: программа завершена после сохранения');
 // Серверный контракт автосохранения конфигурации.
 const goSet=fs.readFileSync('internal/server/user_settings.go','utf8');
 assert.ok(goSet.includes('persistConfigParams')&&goSet.includes('Params *model.ForecastParams'),'Б77: конфигурация пишется в настройки');
 const goSrv=fs.readFileSync('internal/server/server.go','utf8');
 assert.ok(goSrv.includes('s.persistConfigParams(normParams)'),'Б77: сохранение при каждом изменении параметров');
 console.log('BATCH-77: exit asks etalon + vedomost autosaved + config autosave + fields everywhere: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
