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
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// Батч-41: «Анализ остатков» — сопоставление товаров двух складов
// (артикул → название с процентом), излишки (запас > N месяцев — настройка)
// и необходимые заказы (логика «Подсветить заказ»).

func stockAnalysisApp() *AppServer {
	app := New(false)

	app.report = &model.CalculationReport{FileName: "ved.xlsx", Items: []model.CalculatedItem{
		// Совпадение по артикулу: излишек на А (запас 20 мес при норме 12),
		// на Б нужен заказ (рейтинг 3 при нулевом остатке).
		{RawItem: model.RawItem{ExcelRow: 8, SKU: "A1", Name: "Дрель ударная", Group: "Инструмент", Warehouse: "Склад Мир", ClosingStock: 20, PurchasePrice: 10}, SumSalesLast12M: 12},
		{RawItem: model.RawItem{ExcelRow: 9, SKU: "A1", Name: "Дрель ударная", Group: "Инструмент", Warehouse: "Склад Кореличи", ClosingStock: 0}, SalesSegment: 3, FinalOrderQty: 5},
		// Совпадение по названию (нормализация, 100%): излишек при нулевых продажах,
		// на Б заказа нет.
		{RawItem: model.RawItem{ExcelRow: 10, SKU: "", Name: "Молоток стальной, 500 г", Group: "Хозтовары", Warehouse: "Склад Мир", ClosingStock: 50, PurchasePrice: 8}},
		{RawItem: model.RawItem{ExcelRow: 11, SKU: "", Name: "Молоток стальной 500г", Group: "Хозтовары", Warehouse: "Склад Кореличи", ClosingStock: 3}, SalesSegment: 1},
		// Нечёткое совпадение 60% (Jaccard 3/5): на Б нужен заказ.
		{RawItem: model.RawItem{ExcelRow: 12, SKU: "", Name: "Шуруповерт аккумуляторный 18В 2Ач", Group: "Инструмент", Warehouse: "Склад Мир", ClosingStock: 30, PurchasePrice: 15}},
		{RawItem: model.RawItem{ExcelRow: 13, SKU: "", Name: "Шуруповерт акк. 18В 2Ач", Group: "Инструмент", Warehouse: "Склад Кореличи", ClosingStock: 0}, SalesSegment: 2, FinalOrderQty: 4},
		// Обычный заказ (без излишка на А).
		{RawItem: model.RawItem{ExcelRow: 14, SKU: "C1", Name: "Линейка металлическая", Group: "Канцелярия", Warehouse: "Склад Мир", ClosingStock: 1, PurchasePrice: 2}, SumSalesLast12M: 24},
		{RawItem: model.RawItem{ExcelRow: 15, SKU: "C1", Name: "Линейка металлическая", Group: "Канцелярия", Warehouse: "Склад Кореличи", ClosingStock: 0}, SalesSegment: 2, FinalOrderQty: 2},
		// Похожие названия, но ниже порога 60% — не должны попасть в таблицу.
		{RawItem: model.RawItem{ExcelRow: 16, SKU: "", Name: "Клей момент супер", Group: "Хозтовары", Warehouse: "Склад Мир", ClosingStock: 40, PurchasePrice: 5}},
		{RawItem: model.RawItem{ExcelRow: 17, SKU: "", Name: "Перчатки рабочие хб", Group: "Хозтовары", Warehouse: "Склад Кореличи", ClosingStock: 1}, SalesSegment: 2},
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

func TestStockAnalysisMatchingAndVerdicts(t *testing.T) {
	app := stockAnalysisApp()
	data := fetchStockAnalysis(t, app, "/api/stock-analysis?whA=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9C%D0%B8%D1%80&whB=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9A%D0%BE%D1%80%D0%B5%D0%BB%D0%B8%D1%87%D0%B8&months=12")
	if got := int(data["matched"].(float64)); got != 4 {
		t.Fatalf("matched = %d, ожидалось 4", got)
	}
	if got := int(data["bySku"].(float64)); got != 2 {
		t.Fatalf("bySku = %d, ожидалось 2", got)
	}
	if got := int(data["byName"].(float64)); got != 2 {
		t.Fatalf("byName = %d, ожидалось 2 (пара ниже 60 процентов отброшена)", got)
	}
	rowsRaw, _ := data["rows"].([]any)
	if len(rowsRaw) != 4 {
		t.Fatalf("rows = %d, ожидалось 4", len(rowsRaw))
	}
	get := func(r any, field string) any { return r.(map[string]any)[field] }
	byName2 := map[string]map[string]any{}
	for _, raw := range rowsRaw {
		r := raw.(map[string]any)
		byName2[get(r, "name").(string)] = r
	}
	// Переток: излишек 20-12=8 шт, 80 руб, заказ на Б 5.
	r0 := byName2["Дрель ударная"]
	if r0 == nil {
		t.Fatal("пара по артикулу (дрель) отсутствует")
	}
	if get(r0, "sku") != "A1" || int(get(r0, "matchScore").(float64)) != 100 || get(r0, "matchBy") != "артикул" {
		t.Fatalf("дрель match: %+v", r0)
	}
	if v := get(r0, "whAExcessUnits").(float64); v != 8 {
		t.Fatalf("дрель excess units = %v, ожидалось 8", v)
	}
	if v := get(r0, "whAExcessValue").(float64); v != 80 {
		t.Fatalf("дрель excess value = %v, ожидалось 80", v)
	}
	if !get(r0, "whBNeedOrder").(bool) || int(get(r0, "whBOrderQty").(float64)) != 5 {
		t.Fatalf("дрель need/order: %+v", r0)
	}
	if !strings.HasPrefix(get(r0, "verdict").(string), "Заказ не требуется") {
		t.Fatalf("дрель verdict = %v", get(r0, "verdict"))
	}
	// Молоток: излишек 50 шт (продаж 0), Б без заказа.
	r1 := byName2["Молоток стальной 500г"]
	if r1 == nil {
		t.Fatal("пара по названию (молоток) отсутствует")
	}
	if int(get(r1, "matchScore").(float64)) != 100 {
		t.Fatalf("молоток score: %+v", r1)
	}
	if v := get(r1, "whAExcessValue").(float64); v != 400 {
		t.Fatalf("молоток excess value = %v, ожидалось 400", v)
	}
	if get(r1, "whBNeedOrder").(bool) {
		t.Fatalf("молоток не должен требовать заказ: %+v", r1)
	}
	if !strings.HasPrefix(get(r1, "verdict").(string), "Излишек") {
		t.Fatalf("молоток verdict = %v", get(r1, "verdict"))
	}
	// Шуруповёрт: нечёткое совпадение 67%.
	r2 := byName2["Шуруповерт акк. 18В 2Ач"]
	if r2 == nil {
		t.Fatal("нечёткая пара (шуруповёрт) отсутствует")
	}
	if int(get(r2, "matchScore").(float64)) != 67 {
		t.Fatalf("шуруповёрт fuzzy score: %+v", r2)
	}
	if !strings.HasPrefix(get(r2, "verdict").(string), "Заказ не требуется") {
		t.Fatalf("шуруповёрт verdict = %v", get(r2, "verdict"))
	}
	// Линейка: обычный заказ.
	r3 := byName2["Линейка металлическая"]
	if r3 == nil {
		t.Fatal("пара (линейка) отсутствует")
	}
	if get(r3, "verdict") != "Обычный заказ на складе Б" {
		t.Fatalf("линейка verdict = %v", get(r3, "verdict"))
	}
	if v := get(r3, "whAExcessUnits").(float64); v != 0 {
		t.Fatalf("линейка не должна иметь излишка: %v", v)
	}
	// Пара ниже порога 60% (клей/перчатки) не попала.
	if byName2["Клей момент супер"] != nil || byName2["Перчатки рабочие хб"] != nil {
		t.Fatal("пара ниже порога попала в таблицу")
	}
}

func TestStockAnalysisCustomMonths(t *testing.T) {
	app := stockAnalysisApp()
	// При норме 25 месяцев дрель (запас 20 мес) уже не излишек → обычный заказ.
	data := fetchStockAnalysis(t, app, "/api/stock-analysis?whA=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9C%D0%B8%D1%80&whB=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9A%D0%BE%D1%80%D0%B5%D0%BB%D0%B8%D1%87%D0%B8&months=25")
	rowsRaw, _ := data["rows"].([]any)
	get := func(r any, field string) any { return r.(map[string]any)[field] }
	for _, raw := range rowsRaw {
		r := raw.(map[string]any)
		if get(r, "sku") == "A1" {
			if get(r, "verdict") != "Обычный заказ на складе Б" {
				t.Fatalf("при норме 25 мес дрель не излишек: %+v", r)
			}
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
	var sheet []byte
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && !strings.Contains(f.Name, "_rels") {
			rc, _ := f.Open()
			sheet, _ = io.ReadAll(rc)
			_ = rc.Close()
		}
	}
	if sheet == nil || !bytes.Contains(sheet, []byte("Заказ не требуется")) || !bytes.Contains(sheet, []byte("Совпадение")) {
		t.Fatalf("sheet не содержит ожидаемых данных")
	}
	var wb []byte
	for _, f := range zr.File {
		if f.Name == "xl/workbook.xml" {
			rc, _ := f.Open()
			wb, _ = io.ReadAll(rc)
			_ = rc.Close()
		}
	}
	if !bytes.Contains(wb, []byte("Анализ остатков")) {
		t.Fatal("лист не переименован в «Анализ остатков»")
	}
	_ = xlsx.StockAnalysisRow{}
}
