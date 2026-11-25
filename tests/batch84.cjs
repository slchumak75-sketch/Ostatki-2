const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
// Б84: кнопка «Сохранить настройки» вместо «Сохранить поля» (поля + почта +
// параметры на сервере одним нажатием); в «Настройке почты» — два адреса
// копий заказов; копии учитываются в результате отправки.
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар один',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4,manualOverride:null}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:1,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:1,orderItems:1,totalOrderQty:4,totalOrderCost:8}],groups:[]};
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body,method:options.method||'GET'});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/settings/mail'&&!options.method)return {ok:true,json:async()=>({host:'smtp.example.ru',port:465,username:'u@example.ru',from:'',useTLS:true,hasPassword:true,configured:true,copy1:'boss@firma.ru',copy2:''})};
 if(path==='api/settings/mail')return {ok:true,json:async()=>({saved:true})};
 if(path.startsWith('api/supplier-emails'))return {ok:true,json:async()=>({emails:['a@sup.ru'],last:'a@sup.ru'})};
 if(path==='api/orders/send-mail')return {ok:true,json:async()=>({sent:true,to:body.to,fileName:'Заказ.xlsx',copiesSent:['boss@firma.ru'],copiesFailed:[]})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=(ms=70)=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 await tick();
 // Кнопка переименована и сохраняет всё одним нажатием.
 const btn=d.getElementById('btnSaveFields');
 assert.equal(btn.textContent.trim(),'Сохранить настройки','Б84: вместо «Сохранить поля» — «Сохранить настройки»');
 assert.equal(d.getElementById('btnSaveFieldsPreview').textContent.trim(),'Сохранить настройки','Б84: и в предпросмотре');
 btn.click();await tick();
 assert.ok(calls.some(c=>c.path==='api/column-widths'&&c.method==='POST'),'Б84: ширины полей сохранены');
 assert.ok(calls.some(c=>c.path==='api/settings/save-all'),'Б84: почта и параметры сохранены на сервере');
 assert.match(d.getElementById('toast').textContent,/Настройки сохранены/);
 // Настройка почты: два адреса копий подставляются и сохраняются.
 d.getElementById('btnMailSettings').click();await tick();
 assert.equal(d.getElementById('mailCopy1').value,'boss@firma.ru','Б84: копия №1 подставлена из настроек');
 d.getElementById('mailCopy2').value='buh@firma.ru';
 d.getElementById('btnMailSettingsOk').click();await tick();
 const mailPost=calls.find(c=>c.path==='api/settings/mail'&&c.method==='POST');
 assert.equal(mailPost.body.copy1,'boss@firma.ru','Б84: копия №1 уходит в настройки');
 assert.equal(mailPost.body.copy2,'buh@firma.ru','Б84: копия №2 уходит в настройки');
 // Отправка заказа: результат показывает ушедшие копии.
 d.querySelector('[data-sup-row-check]').click();await tick();
 d.querySelector('[data-mail-sup]').click();await tick();
 d.getElementById('btnMailSendOk').click();await tick();
 assert.match(d.getElementById('toast').textContent,/копии: boss@firma\.ru/,'Б84: пользователю видно, куда ушли копии');
 console.log('BATCH-84: «Сохранить настройки» + mail copies UI: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
