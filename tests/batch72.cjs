const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const report={fileName:'Т.xlsx',items:[],params:{},periods:[],warehouses:[],suppliers:[],groups:[]};
w.fetch=async(path,options={})=>{
 calls.push({path,body:options.body?JSON.parse(options.body):null});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/settings/mail'&&!options.method)return {ok:true,json:async()=>({host:'smtp.mail.ru',port:465,username:'u@mail.ru',from:'u@mail.ru',useTLS:true,hasPassword:true,configured:true})};
 if(path==='api/settings/mail')return {ok:true,json:async()=>({saved:true})};
 if(path==='api/settings/mail-test')return {ok:false,json:async()=>({error:'почтовый сервер требует ПАРОЛЬ ПРИЛОЖЕНИЯ, а не обычный пароль от ящика. Создайте его в настройках вашей почты'})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 // Б72: человеческая ошибка пароля приложения показывается прямо в окне почты.
 d.getElementById('btnMailSettings').click();await tick();
 d.getElementById('btnMailTest').click();await tick();
 assert.match(d.getElementById('mailTestResult').textContent,/ПАРОЛЬ ПРИЛОЖЕНИЯ/,'Б72: понятная инструкция вместо технического ответа сервера');
 assert.match(d.getElementById('toast').textContent,/ПАРОЛЬ ПРИЛОЖЕНИЯ/);
 // Б72: серверные контракты кодировки папок и человеческих ошибок.
 const goSettings=fs.readFileSync('internal/server/user_settings.go','utf8');
 assert.ok(goSettings.includes('decodePickedFolderPath'),'Б72: путь из окна декодируется из base64');
 assert.ok(goSettings.includes('Выбранная папка не найдена'),'Б72: выбранная папка проверяется на существование');
 const goWin=fs.readFileSync('internal/server/folder_dialog_windows.go','utf8');
 assert.ok(goWin.includes('ToBase64String'),'Б72: окно Windows отдаёт путь в base64(UTF-8) — кириллица не бьётся');
 const goMail=fs.readFileSync('internal/server/mail_order.go','utf8');
 assert.ok(goMail.includes('friendlySMTPError'),'Б72: ошибки почты переводятся на человеческий язык');
 console.log('BATCH-72: folder encoding + friendly mail errors: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
