package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// Батч-41/43: «Анализ остатков» — сопоставление товаров двух складов
// (артикул → название с процентом), таблица вида Группа | Артикул |
// Наименование | Совпадение, % | Склад А | стрелка | Склад Б.
// Стрелка: излишек (запас > нормы месяцев) перемещается туда, где меньше.

func stockAnalysisApp() *AppServer {
	app := New(false)
	app.report = &model.CalculationReport{FileName: "ved.xlsx", Items: []model.CalculatedItem{
		// Артикул A1: Мир запас 20 мес (излишек 8 шт × 10 руб), Кореличи пуст.
		{RawItem: model.RawItem{ExcelRow: 8, SKU: "A1", Name: "Дрель ударная", Group: "Инструмент", Warehouse: "Склад Мир", ClosingStock: 20, PurchasePrice: 10}, SumSalesLast12M: 12},
		{RawItem: model.RawItem{ExcelRow: 9, SKU: "A1", Name: "Дрель ударная", Group: "Инструмент", Warehouse: "Склад Кореличи", ClosingStock: 0}, SalesSegment: 3, FinalOrderQty: 5},
		// Название 100%: Мир без продаж (излишек 50 шт × 8 руб), Кореличи мало.
		{RawItem: model.RawItem{ExcelRow: 10, SKU: "", Name: "Молоток стальной, 500 г", Group: "Хозтовары", Warehouse: "Склад Мир", ClosingStock: 50, PurchasePrice: 8}},
		{RawItem: model.RawItem{ExcelRow: 11, SKU: "", Name: "Молоток стальной 500г", Group: "Хозтовары", Warehouse: "Склад Кореличи", ClosingStock: 3}, SalesSegment: 1},
		// Нечёткое совпадение 67%: Мир излишек 30 шт × 15 руб, Кореличи пуст.
		{RawItem: model.RawItem{ExcelRow: 12, SKU: "", Name: "Шуруповерт аккумуляторный 18В 2Ач", Group: "Инструмент", Warehouse: "Склад Мир", ClosingStock: 30, PurchasePrice: 15}},
		{RawItem: model.RawItem{ExcelRow: 13, SKU: "", Name: "Шуруповерт акк. 18В 2Ач", Group: "Инструмент", Warehouse: "Склад Кореличи", ClosingStock: 0}, SalesSegment: 2, FinalOrderQty: 4},
		// Обратное направление: на Мире пусто, на Кореличи излишек 88 шт × 1 руб.
		{RawItem: model.RawItem{ExcelRow: 14, SKU: "D1", Name: "Саморез 3.5*35", Group: "Крепёж", Warehouse: "Склад Мир", ClosingStock: 0}, SalesSegment: 2, FinalOrderQty: 3},
		{RawItem: model.RawItem{ExcelRow: 15, SKU: "D1", Name: "Саморез 3.5*35", Group: "Крепёж", Warehouse: "Склад Кореличи", ClosingStock: 100, PurchasePrice: 1}, SumSalesLast12M: 12},
		// Без излишков ни на одном складе — в таблицу не попадает (нет стрелки).
		{RawItem: model.RawItem{ExcelRow: 16, SKU: "C1", Name: "Линейка металлическая", Group: "Канцелярия", Warehouse: "Склад Мир", ClosingStock: 1, PurchasePrice: 2}, SumSalesLast12M: 24},
		{RawItem: model.RawItem{ExcelRow: 17, SKU: "C1", Name: "Линейка металлическая", Group: "Канцелярия", Warehouse: "Склад Кореличи", ClosingStock: 0}, SalesSegment: 2, FinalOrderQty: 2},
		// Похожие названия ниже порога 60% — не совпадают.
		{RawItem: model.RawItem{ExcelRow: 18, SKU: "", Name: "Клей момент супер", Group: "Хозтовары", Warehouse: "Склад Мир", ClosingStock: 40, PurchasePrice: 5}},
		{RawItem: model.RawItem{ExcelRow: 19, SKU: "", Name: "Перчатки рабочие хб", Group: "Хозтовары", Warehouse: "Склад Кореличи", ClosingStock: 1}, SalesSegment: 2},
	}}
	return app
}

func fetchStockAnalysis(t *testing.T, app *AppServer, path string) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestStockAnalysisMatchingAndArrows(t *testing.T) {
	app := stockAnalysisApp()
	data := fetchStockAnalysis(t, app, "/api/stock-analysis?whA=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9C%D0%B8%D1%80&whB=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9A%D0%BE%D1%80%D0%B5%D0%BB%D0%B8%D1%87%D0%B8&months=12")
	if got := int(data["matched"].(float64)); got != 5 {
		t.Fatalf("matched = %d, ожидалось 5", got)
	}
	if got := int(data["bySku"].(float64)); got != 3 {
		t.Fatalf("bySku = %d, ожидалось 3", got)
	}
	if got := int(data["byName"].(float64)); got != 2 {
		t.Fatalf("byName = %d, ожидалось 2 (пара ниже 60 процентов отброшена)", got)
	}
	rowsRaw, _ := data["rows"].([]any)
	if len(rowsRaw) != 4 {
		t.Fatalf("rows = %d, ожидалось 4 (пары со стрелками)", len(rowsRaw))
	}
	get := func(r any, field string) any { return r.(map[string]any)[field] }
	byName2 := map[string]map[string]any{}
	for _, raw := range rowsRaw {
		r := raw.(map[string]any)
		byName2[get(r, "name").(string)] = r
	}
	// Дрель: стрелка Мир → Кореличи, излишек 8 шт / 80 руб, совпадение 100%.
	r0 := byName2["Дрель ударная"]
	if r0 == nil {
		t.Fatal("пара по артикулу (дрель) отсутствует")
	}
	if get(r0, "sku") != "A1" || int(get(r0, "matchScore").(float64)) != 100 {
		t.Fatalf("дрель match: %+v", r0)
	}
	if get(r0, "arrow") != "AtoB" {
		t.Fatalf("дрель arrow = %v, ожидалось AtoB", get(r0, "arrow"))
	}
	if v := get(r0, "excessUnits").(float64); v != 8 {
		t.Fatalf("дрель excess units = %v, ожидалось 8", v)
	}
	if v := get(r0, "excessValue").(float64); v != 80 {
		t.Fatalf("дрель excess value = %v, ожидалось 80", v)
	}
	if v := get(r0, "whAStock").(float64); v != 20 {
		t.Fatalf("дрель whAStock = %v, ожидалось 20", v)
	}
	if v := get(r0, "whBStock").(float64); v != 0 {
		t.Fatalf("дрель whBStock = %v, ожидалось 0", v)
	}
	if v := get(r0, "whAMonths").(float64); v != 20 {
		t.Fatalf("дрель whAMonths = %v, ожидалось 20", v)
	}
	if get(r0, "group") != "Инструмент" {
		t.Fatalf("дрель group = %v", get(r0, "group"))
	}
	// Молоток: стрелка Мир → Кореличи, излишек 50 шт / 400 руб (продаж нет).
	r1 := byName2["Молоток стальной 500г"]
	if r1 == nil {
		t.Fatal("пара по названию (молоток) отсутствует")
	}
	if int(get(r1, "matchScore").(float64)) != 100 {
		t.Fatalf("молоток score: %+v", r1)
	}
	if get(r1, "arrow") != "AtoB" {
		t.Fatalf("молоток arrow = %v", get(r1, "arrow"))
	}
	if v := get(r1, "excessValue").(float64); v != 400 {
		t.Fatalf("молоток excess value = %v, ожидалось 400", v)
	}
	// Шуруповёрт: нечёткое совпадение 67%, стрелка Мир → Кореличи.
	r2 := byName2["Шуруповерт акк. 18В 2Ач"]
	if r2 == nil {
		t.Fatal("нечёткая пара (шуруповёрт) отсутствует")
	}
	if int(get(r2, "matchScore").(float64)) != 67 {
		t.Fatalf("шуруповёрт fuzzy score: %+v", r2)
	}
	if get(r2, "arrow") != "AtoB" {
		t.Fatalf("шуруповёрт arrow = %v", get(r2, "arrow"))
	}
	// Саморез: обратное направление Кореличи → Мир, излишек 88 шт / 88 руб.
	r3 := byName2["Саморез 3.5*35"]
	if r3 == nil {
		t.Fatal("пара обратного направления (саморез) отсутствует")
	}
	if get(r3, "arrow") != "BtoA" {
		t.Fatalf("саморез arrow = %v, ожидалось BtoA", get(r3, "arrow"))
	}
	if v := get(r3, "excessUnits").(float64); v != 88 {
		t.Fatalf("саморез excess units = %v, ожидалось 88", v)
	}
	if v := get(r3, "whBStock").(float64); v != 100 {
		t.Fatalf("саморез whBStock = %v, ожидалось 100", v)
	}
	// Линейка (без излишков) не попала; пара ниже порога тоже.
	if byName2["Линейка металлическая"] != nil {
		t.Fatal("пара без стрелки попала в таблицу")
	}
	if byName2["Клей момент супер"] != nil || byName2["Перчатки рабочие хб"] != nil {
		t.Fatal("пара ниже порога попала в таблицу")
	}
	// Сортировка по величине излишка: шуруповёрт (450) первым, молоток (400) вторым.
	if get(rowsRaw[0], "name") != "Шуруповерт акк. 18В 2Ач" {
		t.Fatalf("первая строка = %v, ожидался шуруповёрт", get(rowsRaw[0], "name"))
	}
	if get(rowsRaw[1], "name") != "Молоток стальной 500г" {
		t.Fatalf("вторая строка = %v, ожидался молоток", get(rowsRaw[1], "name"))
	}
}

func TestStockAnalysisCustomMonths(t *testing.T) {
	app := stockAnalysisApp()
	// При норме 25 месяцев дрель (запас 20 мес) уже не излишек — пары нет.
	data := fetchStockAnalysis(t, app, "/api/stock-analysis?whA=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9C%D0%B8%D1%80&whB=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9A%D0%BE%D1%80%D0%B5%D0%BB%D0%B8%D1%87%D0%B8&months=25")
	rowsRaw, _ := data["rows"].([]any)
	get := func(r any, field string) any { return r.(map[string]any)[field] }
	for _, raw := range rowsRaw {
		r := raw.(map[string]any)
		if get(r, "sku") == "A1" {
			t.Fatalf("при норме 25 мес дрель не излишек и не должна попасть: %+v", r)
		}
	}
}

func TestStockAnalysisValidation(t *testing.T) {
	app := stockAnalysisApp()
	cases := []struct{ q, wantErr string }{
		{"", "выберите два склада"},
		{"whA=%D0%9C%D0%B8%D1%80&whB=%D0%9C%D0%B8%D1%80", "должны различаться"},
		{"whA=%D0%9D%D0%B5%D1%82&whB=%D0%9C%D0%B8%D1%80", "нет позиций"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/stock-analysis?"+c.q, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("q=%s: код %d, ожидался 400", c.q, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), c.wantErr) {
			t.Fatalf("q=%s: %s", c.q, rec.Body.String())
		}
	}
}

func TestStockAnalysisExportXLSX(t *testing.T) {
	app := stockAnalysisApp()
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/stock-analysis/export?whA=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9C%D0%B8%D1%80&whB=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9A%D0%BE%D1%80%D0%B5%D0%BB%D0%B8%D1%87%D0%B8&months=12", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	body, err := io.ReadAll(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) < 1000 {
		t.Fatalf("файл слишком мал: %d байт", len(body))
	}
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	var sheet, wb []byte
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && !strings.Contains(f.Name, "_rels") {
			rc, _ := f.Open()
			sheet, _ = io.ReadAll(rc)
			_ = rc.Close()
		}
		if f.Name == "xl/workbook.xml" {
			rc, _ := f.Open()
			wb, _ = io.ReadAll(rc)
			_ = rc.Close()
		}
	}
	if sheet == nil || !bytes.Contains(sheet, []byte("Перемещение")) || !bytes.Contains(sheet, []byte("Группа")) {
		t.Fatal("sheet не содержит новую шапку")
	}
	// Жирная стрелка (стиль 1 = bold): ячейка F2 «→».
	if !bytes.Contains(sheet, []byte(`<c r="F2" s="1" t="inlineStr"><is><t xml:space="preserve">→</t></is></c>`)) {
		i := bytes.Index(sheet, []byte(`r="F2"`))
		t.Fatalf("жирная стрелка не найдена; контекст: %s", sheet[max(0, i-40):min(len(sheet), i+160)])
	}
	// Обратная стрелка во второй строке-источнике (саморез: BtoA → «←»).
	if !bytes.Contains(sheet, []byte(`s="1" t="inlineStr"><is><t xml:space="preserve">←`)) {
		t.Fatal("обратная стрелка «←» не найдена")
	}
	if !bytes.Contains(wb, []byte("Анализ остатков")) {
		t.Fatal("лист не переименован в «Анализ остатков»")
	}
}
