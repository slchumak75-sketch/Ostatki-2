const fs=require('node:fs'),assert=require('node:assert/strict');
// Б85: по жалобе «обновил 7.27, а в настройке почты ничего не изменилось»:
// окно почты — с прокруткой (поля копий не уезжают за низ экрана), помощник
// обновления запускается как проверенные диалоги и не молчит при неудаче.
const css=fs.readFileSync('internal/server/web/styles.css','utf8');
assert.ok(css.includes('#mailSettingsModal .v4-modal-card { overflow-y: auto; }'),'Б85: окно «Настройка почты» прокручивается');
const upd=fs.readFileSync('internal/server/update_windows.go','utf8');
assert.ok(!upd.includes('SysProcAttr')&&!upd.includes('CreationFlags'),'Б85: помощник без спецфлагов процесса, как диалоги выбора файлов');
assert.ok(upd.includes('ostatki_update.log'),'Б85: помощник ведёт журнал обновления');
assert.ok(upd.includes('Обновление программы не удалось'),'Б85: при неудачной замене — заметка на рабочем столе');
console.log('BATCH-85: mail modal scroll + updater robustness contracts: OK');
