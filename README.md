# Остатки 2 — Приложение Windows (Go + HTML GUI) для автозаполнения столбца 8 «К закупкам»

В проекте параллельно сохранены, поддерживаются и автоматически собираются на GitHub Actions **три независимые сборки** для Windows 10/11 (`x64`, `CGO_ENABLED=0`, единый автономный `.exe` без внешних зависимостей):

- 🏆 **Сборка «Вариант 3» (актуальная, `Latest`, PRO SCM):** расположена в корне проекта (`cmd/ostatki/`, `internal/`) и зафиксирована отдельным снапшотом в `variants/variant3/` (`Ведомость с периодом ОК (1).xlsx`, `Ведомость с периодом ОК (Вариант 3).xlsx`, `Заявки поставщикам (авторасчёт).xlsx`).
- 📦 **Сборка «Вариант 2» (сохранённая предыдущая сборка PRO SCM):** изолирована в `variants/variant2/` (`Ведомость с периодом ОК (Вариант 2).xlsx`).
- 📦 **Сборка «Вариант 1» (сохранённый базовый эталон):** изолирована в `variants/variant1/` (`Ведомость с периодом ОК (Вариант 1).xlsx`).

---

## Скачивание готовых Windows `.exe` сборок (GitHub Releases)

| Сборка | Страница релиза | Прямое скачивание `.exe` | Полный `.zip`-архив |
| :--- | :--- | :--- | :--- |
| **Вариант 3 (`Latest`)** | [`Вариант 3`](https://github.com/slchumak75-sketch/Ostatki-2/releases/tag/variant-3) | [`OstatkiZakupki_Variant_3.exe`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-3/OstatkiZakupki_Variant_3.exe) | [`Variant_3_Windows_x64.zip`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-3/Variant_3_Windows_x64.zip) |
| **Вариант 2** | [`Вариант 2`](https://github.com/slchumak75-sketch/Ostatki-2/releases/tag/variant-2) | [`OstatkiZakupki_Variant_2.exe`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-2/OstatkiZakupki_Variant_2.exe) | [`Variant_2_Windows_x64.zip`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-2/Variant_2_Windows_x64.zip) |
| **Вариант 1** | [`Вариант 1`](https://github.com/slchumak75-sketch/Ostatki-2/releases/tag/variant-1) | [`OstatkiZakupki_Variant_1.exe`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-1/OstatkiZakupki_Variant_1.exe) | [`Variant_1_Windows_x64.zip`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-1/Variant_1_Windows_x64.zip) |

При каждом `push` / `pull_request` workflow [`.github/workflows/build.yml`](.github/workflows/build.yml) также параллельно тестирует и публикует все три артефакта (**`Вариант 1`**, **`Вариант 2`**, **`Вариант 3`**).

---

## Возможности актуальной сборки «Вариант 3»

1. **Рабочая таблица 1-в-1 со структурой ведомости 1С:**
   - **Раздельные сортируемые колонки:** `Стр.`, `Склад` (столбец `A`), `Группа` (столбец `B`), `Артикул` (столбец `C`, 197 артикулов в базе), `Номенклатура` (чистое наименование товара без лишних бейджей и подстрок, как в исходном Excel), `Сегм.`, `Прод. 12м`, `Остаток`, `Столбец 8: К закупкам` (чистое числовое поле ввода без стрелок вверх/вниз), `Цена`, `Сумма`, `Поставщик`.
   - Отсутствуют технические столбцы `Сезон` и `Цель`, исключено сравнение с «Вариантом 1».
2. **Полное игнорирование цветовой раскраски (красных полей) в загружаемых файлах 1С Excel:**
   При чтении ведомости парсер анализирует исключительно фактические числовые значения остатков и продаж, полностью игнорируя старую красную заливку ячеек из 1С.
3. **Подавление разовых оптовых выбросов (`Winsorization`, 108 SKU в базе):**
   Разовые оптовые/тендерные отгрузки автоматически сглаживаются, подсвечиваются на графике и не завышают розничный заказ.
4. **Матрица `ABC × XYZ` (`AX..CZ`), метод `Croston / SBA` и оптимизатор лимита бюджета (`Budget Cap`):**
   Стабильные лидеры продаж (`AX`, `AY`) получают повышенный уровень сервиса (`SLA ×1.25 / ×1.15`), штучные товары класса `Z` рассчитываются по методу Синтетоса–Бойлана (`SBA`), а 4-листовый отчёт `Заявки поставщикам (авторасчёт).xlsx` формирует листы *К закупкам (Вариант 3)*, *По поставщикам*, *Сезонность и ABC-XYZ* и *Неликвиды и избыток* (`400 SKU`, `1 458 ед.`, `7 102,89 руб.`).

---

## Сборка из исходников

```bash
# Прогнать все тесты (корень + Вариант 1 + Вариант 2 + Вариант 3)
go vet ./... && go test -v -race ./...

# Собрать Windows GUI приложение «Вариант 3»
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -H=windowsgui" \
  -o OstatkiZakupki_Вариант_3.exe ./cmd/ostatki

# Собрать Windows GUI приложение «Вариант 2»
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -H=windowsgui" \
  -o OstatkiZakupki_Вариант_2.exe ./variants/variant2/cmd/ostatki

# Собрать Windows GUI приложение «Вариант 1»
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -H=windowsgui" \
  -o OstatkiZakupki_Вариант_1.exe ./variants/variant1/cmd/ostatki
```

Подробная архитектурная документация приведена в **[`AGENTS.md`](AGENTS.md)** и **[`CHANGELOG.md`](CHANGELOG.md)**.
