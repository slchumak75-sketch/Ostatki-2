const fs=require('node:fs'),assert=require('node:assert/strict');
// Б87: скрытый помощник обновления заменён видимым окном «Программа
// обновляется…» с шагами; при сбое окно остаётся с причиной, а не исчезает.
const upd=fs.readFileSync('internal/server/update_windows.go','utf8');
assert.ok(!upd.includes('"-WindowStyle", "Hidden"'),'Б87: помощник обновления запускается видимым окном');
assert.ok(upd.includes('Программа обновляется…'),'Б87: на экране видно, что программа обновляется');
assert.ok(upd.includes('Шаг 1 из 3')&&upd.includes('Шаг 2 из 3')&&upd.includes('Шаг 3 из 3'),'Б87: шаги обновления на экране');
assert.ok(upd.includes('Read-Host'),'Б87: при сбое окно ждёт пользователя с причиной');
assert.ok(upd.includes('0xEF, 0xBB, 0xBF'),'Б87: скрипт с UTF-8 BOM — русские строки не «кракозябры»');
assert.ok(upd.includes('Get-Item -LiteralPath $dst').valueOf(),'Б87: проверка, что новый файл записался полностью');
console.log('BATCH-87: visible updater window contracts: OK');
