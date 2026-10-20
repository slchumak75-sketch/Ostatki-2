# Архитектура

## Идея

Один файл `Ostatki.exe` (Go, только стандартная библиотека, CGO выключен — бинарь портативный):

- запускает локальный HTTP-сервер **только на 127.0.0.1** (порт 8765, при занятости — следующие);
- отдаёт встроенный (`go:embed`) HTML/CSS/JS интерфейс и сам открывает браузер;
- файл ведомости загружается через браузер (кнопка или drag&drop), обрабатывается **в памяти**, никуда не отправляется;
- есть консольный режим `-cli` для пакетной обработки и CI smoke-теста.

Почему не Wails/WebView: ноль внешних зависимостей → нет go.sum, сборка офлайн, кросс-компиляция тривиальна,
не нужен WebView2 на машине пользователя. Цена решения: интерфейс — вкладка браузера, рядом живёт консольное окно
(его нельзя закрывать; остановка — кнопка «Выход» в GUI или Ctrl+C). Roadmap: `-H windowsgui` + трей — см. AGENT_HANDOFF.

Почему XLSX пишется/читается вручную (zip + XML), а не excelize: та же причина — ноль зависимостей.
Чтение: workbook.xml/rels → первый лист, sharedStrings, inlineStr; заголовки ищутся по словам
(«Склад»+«Номенклатура» в первых 20 строках), месяцы — по русским названиям+году, колонки — по ключевым словам.
Запись: генерируется новая книга (4 листа) с полным набором данных исходника и заполненным столбцом H (8-м);
**оформление исходного файла в v1 не сохраняется** (данные — полностью). Если нужно сохранить оформление 1С —
используйте `tools/fill_purchase.py` (openpyxl правит копию оригинала) либо мигрируйте писатель на excelize.

## Карта кода

| Путь | Что |
|---|---|
| `cmd/ostatki/main.go` | флаги, режимы GUI/CLI, старт сервера, версия (`-ldflags -X main.version`) |
| `cmd/ostatki/browser_*.go` | открытие браузера по платформам |
| `internal/model/model.go` | типы и JSON-контракт (camelCase — не переименовывать без правки app.js и Python) |
| `internal/forecast/forecast.go` | алгоритм (зеркало `tools/forecast.py`), агрегаты, предупреждения |
| `internal/xlsxio/read.go` | парсер ведомости 1С со всеми её причудами |
| `internal/xlsxio/write.go` | генератор итогового xlsx (Ведомость / Закупка по поставщикам / Сезонность / Методика) |
| `internal/app/server.go` | HTTP API + раздача GUI, состояние в памяти (1 пользователь) |
| `internal/app/web/` | `index.html`, `style.css`, `app.js` — весь фронтенд, без CDN, графики на canvas вручную |
| `tools/forecast.py` | эталонный алгоритм на Python (зеркало Go) |
| `tools/read_xlsx.py` | чтение ведомости для Python-инструментов (openpyxl) |
| `tools/analyze.py` | повторный анализ файла → цифры для ANALYSIS.md |
| `tools/fill_purchase.py` | заполнение столбца H в копии оригинала (сохраняет оформление) → `output/` |
| `tools/dev_server.py` | dev-сервер с тем же API: превью/разработка GUI без Go; автозагрузка xlsx из корня |
| `output/Ведомость_К_закупке.xlsx` | готовый результат по исходному файлу (сгенерирован fill_purchase.py) |
| `.github/workflows/build-windows.yml` | CI: vet+тесты+кросс-проверки, сборка exe, smoke на реальном файле, артефакты, Release по тегу `v*` |

## API (контракт Go ⇄ фронтенд ⇄ Python dev-сервер)

| Метод и путь | Тело / параметры | Ответ |
|---|---|---|
| `GET /` (+ статика) | — | GUI |
| `GET /api/health` | — | `{ok, version}` |
| `GET /api/state` | — | полное состояние или `{empty:true, version}` |
| `POST /api/upload` | multipart: `file` (xlsx ≤32 МБ), `params` (JSON-строка, необяз.) | полное состояние; 422 при плохом файле |
| `POST /api/recalc` | JSON `{params:{...полный набор...}}` | полное состояние |
| `GET /api/export.xlsx` | — | книга с заполненным H (Go: сгенерированная; Python-dev: копия оригинала с H) |
| `GET /api/purchase.csv` | — | CSV заказа: UTF-8+BOM, разделитель `;`, десятичная запятая |
| `POST /api/shutdown` | — | `{ok:true}` и остановка процесса |

Состояние (`model.State`): `fileName, version, loadedAt, params, months[], forecastMonths[],
seasonalGlobal[12], seasonalByGroup{}, rows[], summary{}, groupsAgg[], suppliersAgg[],
warehousesAgg[], warnings[]`. Каждая строка `rows[]` содержит исходные поля товара
(warehouse…sales[]) и расчётные (forecast[], recommend, marginPct, status, abc, …) — см. `internal/model/model.go`.
Полное состояние исходного файла — ~2,3 МБ JSON; для локального приложения приемлемо, пагинация — на клиенте.

Параметры `params`: `{horizon, safetyPercent, leadDays, deadMonths, partialLast, useTrend, shrinkageK}`.
Go-сервер нормализует диапазоны (`normalizeParams`), Python принимает как есть — фронтенд шлёт валидные значения.

## CLI

```
Ostatki.exe -cli -in "Ведомость.xlsx" -out result.xlsx [-horizon 3 -safety 20 -lead 14 -dead 12 -partial-last=true -trend=true]
Ostatki.exe -file "Ведомость.xlsx" [-port 8765] [-no-browser]   :: GUI с предзагрузкой
Ostatki.exe -version
```

## Безопасность и данные

Сервер слушает только 127.0.0.1; загруженный файл не пишется на диск Go-приложением (только память);
Python dev-сервер пишет временный файл в `/tmp` (dev-only, в Windows-доставку не входит).
Внешних сетевых вызовов приложение не делает.
