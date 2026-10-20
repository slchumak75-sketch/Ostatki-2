# Остатки 2 — Приложение Windows (Go + HTML GUI) для автозаполнения столбца 8 «К закупкам»

В проекте параллельно сохранены, поддерживаются и автоматически собираются на GitHub Actions **четыре независимые сборки** для Windows 10/11 (`x64`, `CGO_ENABLED=0`, единый автономный `.exe` без внешних зависимостей):

- 🏆 **Сборка «Вариант 4» (актуальная основная программа, `Latest`, PRO SCM):** расположена в корне проекта (`cmd/ostatki/`, `internal/`), лаконичный интерфейс без лишних блоков (`Ведомость с периодом ОК (1).xlsx`, `Заявки поставщикам (авторасчёт).xlsx`).
- 📦 **Сборка «Вариант 3» (сохранённая сборка):** полностью изолирована и зафиксирована в `variants/variant3/` (`Ведомость с периодом ОК (Вариант 3).xlsx`).
- 📦 **Сборка «Вариант 2» (сохранённая сборка):** изолирована в `variants/variant2/` (`Ведомость с периодом ОК (Вариант 2).xlsx`).
- 📦 **Сборка «Вариант 1» (сохранённый базовый эталон):** изолирована в `variants/variant1/` (`Ведомость с периодом ОК (Вариант 1).xlsx`).

---

## Скачивание готовых Windows `.exe` сборок (GitHub Releases)

| Сборка | Страница релиза | Прямое скачивание `.exe` | Полный `.zip`-архив |
| :--- | :--- | :--- | :--- |
| **Вариант 4 (`Latest`)** | [`Вариант 4`](https://github.com/slchumak75-sketch/Ostatki-2/releases/tag/variant-4) | [`OstatkiZakupki_Variant_4.exe`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-4/OstatkiZakupki_Variant_4.exe) | [`Variant_4_Windows_x64.zip`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-4/Variant_4_Windows_x64.zip) |
| **Вариант 3** | [`Вариант 3`](https://github.com/slchumak75-sketch/Ostatki-2/releases/tag/variant-3) | [`OstatkiZakupki_Variant_3.exe`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-3/OstatkiZakupki_Variant_3.exe) | [`Variant_3_Windows_x64.zip`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-3/Variant_3_Windows_x64.zip) |
| **Вариант 2** | [`Вариант 2`](https://github.com/slchumak75-sketch/Ostatki-2/releases/tag/variant-2) | [`OstatkiZakupki_Variant_2.exe`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-2/OstatkiZakupki_Variant_2.exe) | [`Variant_2_Windows_x64.zip`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-2/Variant_2_Windows_x64.zip) |
| **Вариант 1** | [`Вариант 1`](https://github.com/slchumak75-sketch/Ostatki-2/releases/tag/variant-1) | [`OstatkiZakupki_Variant_1.exe`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-1/OstatkiZakupki_Variant_1.exe) | [`Variant_1_Windows_x64.zip`](https://github.com/slchumak75-sketch/Ostatki-2/releases/download/variant-1/Variant_1_Windows_x64.zip) |

---

## Возможности актуальной сборки «Вариант 4»

1. **Чистый лаконичный интерфейс закупщика:**
   - В верхнем сводном блоке оставлены только 2 ключевые карточки: **«Столбец 8 «К закупкам»»** и **«Бюджет закупки»** (убраны блоки *«Ожидаемая розница и маржа»*, *«Горизонт планирования»*, *«Анти-выбросы и Радар неликвидов»*).
   - В панели справа от таблицы номенклатуры оставлены **только графики** (*«История продаж»* и *«Прогноз спроса по 12 месяцам года»*) — вся текстовая шапка, плитки метрик и блок обоснования убраны.
   - В панели параметров расчёта убраны поля *«Дата начала планирования»* и *«Вес свежих лет:»* (дата среза из метаданных 1С и коэффициент `0.65` применяются автоматически).
2. **Рабочая таблица 1-в-1 со структурой ведомости 1С:**
   - 11 сортируемых колонок: `Склад`, `Группа`, `Артикул`, чистое наименование `Номенклатуры`, `Сегм.`, `Продажи`, `Остаток`, `Заказ`, `Цена`, `Сумма`, `Поставщик` (столбец `Стр.` убран).
   - Столбцы **`Склад`** и **`Группа`** сделаны двухстрочными (`formatTwoLines`), со шрифтом, уменьшенным в 1,5 раза (`8px`, `line-height: 1.15`), и сжаты до минимально возможной ширины (`width: 1%`, `padding: 3px 2px`).
   - Столбцы **`Продажи`**, **`Остаток`** и **`Заказ`** отформатированы с разделением групп разрядов (`99 999`) и зафиксированы строго на ширину пяти цифровых символов с учётом разделителя групп разрядов (`tabular-nums`, без стрелок прокрутки в поле ввода).
3. **Точный расчёт PRO SCM без искажений:**
   - Полное игнорирование старых красных ячеек из выгрузки 1С, подавление разовых оптовых выбросов (`Winsorization`), матрица `ABC × XYZ`, метод `Croston / SBA` для редких `Z`-товаров, лимит бюджета и 4-листовый отчёт Excel (`400 SKU`, `1 458 ед.`, `7 102,89 руб.`).

Подробная архитектурная документация приведена в **[`AGENTS.md`](AGENTS.md)** и **[`CHANGELOG.md`](CHANGELOG.md)**.
