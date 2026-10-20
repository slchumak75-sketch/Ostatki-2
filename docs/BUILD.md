# Сборка и разработка

## Требования

- Go ≥ 1.23 (внешних зависимостей нет — сборка работает офлайн, go.sum не нужен).
- Для Python-инструментов в `tools/`: Python 3.10+ и `pip install openpyxl`.

## Локально

```bash
# тесты и проверки
go test ./...
go vet ./...

# запуск GUI на любой ОС (браузер откроется сам)
go run ./cmd/ostatki -file "Ведомость с периодом ОК (1).xlsx"

# сборка Windows exe с любой ОС (кросс-компиляция, CGO не нужен)
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X main.version=v1.0.0" -o Ostatki.exe ./cmd/ostatki

# консольный режим
./Ostatki.exe -cli -in "Ведомость.xlsx" -out result.xlsx -horizon 3
```

## GitHub Actions (основной способ)

Workflow `.github/workflows/build-windows.yml` запускается автоматически при:

- push в `main` или `arena/**`;
- pull request;
- ручном запуске (Actions → Build Windows → Run workflow);
- теге `v*` — дополнительно создаётся GitHub Release с zip.

Этапы: gofmt (информационно) → `go vet` → `go test` → кросс-компиляция linux/darwin/freebsd
(проверка платформенных файлов) → сборка `Ostatki.exe` (windows/amd64, версия из тега или `dev-<sha>`) →
**smoke-тест**: `-cli` по реальной ведомости из корня репозитория → zip (exe + README + руководство).

Артефакты запуска: `Ostatki-windows-amd64` (приложение) и `smoke-result-xlsx`
(ведомость с «К закупке», которую сгенерировала именно Go-сборка на CI).
Скачать: вкладка Actions → нужный запуск → Artifacts (нужна авторизация GitHub),
либо `gh run download <id>`.

Выпуск версии: `git tag v1.0.0 && git push origin v1.0.0` → Release соберётся сам.

## Разработка фронтенда без Go

```bash
pip install openpyxl
python3 tools/dev_server.py 8765   # тот же GUI и API; xlsx из корня подхватится сам
```

Правки в `internal/app/web/` видны после обновления страницы. Когда GUI готов,
тот же код без изменений работает внутри Go exe (embed).

## Сверка Go и Python реализаций алгоритма

```bash
python3 tools/fill_purchase.py                  # output/Ведомость_К_закупке.xlsx (Python)
./Ostatki.exe -cli -in "Ведомость с периодом ОК (1).xlsx" -out /tmp/go.xlsx   # (Go)
```

Итоги в консоли (SKU/единиц/бюджет) обязаны совпадать: при параметрах по умолчанию и исходном файле —
**765 SKU · 4138 ед. · 21 036,70**. Расхождение = алгоритмы разошлись, чинить до слияния.
