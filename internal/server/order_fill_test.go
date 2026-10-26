package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestFillOrderOnlySelectedPair(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := New(false)
	if err := app.LoadWorkbookFromPath(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")); err != nil {
		t.Fatal(err)
	}
	for _, it := range app.report.Items {
		if it.FinalOrderQty != 0 || it.ManualOverride != nil {
			t.Fatal("new statement must have empty orders without fake manual overrides")
		}
	}
	if app.report.TotalOrderCost != 0 || app.report.TotalOrderUnits != 0 {
		t.Fatal("new statement must have zero budget and quantities")
	}
	target := -1
	for i, it := range app.report.Items {
		if it.AutoOrderQty > 0 && it.Supplier != "" {
			target = i
			break
		}
	}
	if target < 0 {
		t.Fatal("fixture needs an automatic recommendation")
	}
	item := app.report.Items[target]
	scope := map[int]bool{}
	for _, it := range app.report.Items {
		if it.Supplier == item.Supplier && it.Warehouse == item.Warehouse {
			scope[it.ExcelRow] = true
			app.overrides[it.ExcelRow] = 0
		}
	}
	outside := 0
	for _, it := range app.report.Items {
		if !scope[it.ExcelRow] {
			outside = it.ExcelRow
			app.overrides[outside] = 17
			break
		}
	}
	if outside == 0 {
		t.Fatal("fixture needs another supplier/warehouse")
	}
	app.report = forecast.CalculateExplicit(app.wb, app.params, app.overrides, app.orderExclusionsLocked(app.wb))
	previous := map[int]int{}
	for _, it := range app.report.Items {
		previous[it.ExcelRow] = it.FinalOrderQty
	}
	body, _ := json.Marshal(map[string]string{"supplier": item.Supplier, "warehouse": item.Warehouse})
	rec := httptest.NewRecorder()
	app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("fill: %d %s", rec.Code, rec.Body.String())
	}
	for _, it := range app.report.Items {
		if !scope[it.ExcelRow] && previous[it.ExcelRow] != it.FinalOrderQty {
			t.Fatalf("outside row %d changed", it.ExcelRow)
		}
		if it.ExcelRow == item.ExcelRow && it.FinalOrderQty <= 0 {
			t.Fatal("recommendation was not filled")
		}
	}
	if app.overrides[outside] != 17 {
		t.Fatal("outside override changed")
	}
	for row := range scope {
		if _, ok := app.overrides[row]; !ok {
			t.Fatalf("scope quantity %d not saved", row)
		}
	}
	// A second action cancels only the chosen pair and remains empty on recalculation.
	cancelBody, _ := json.Marshal(map[string]any{"supplier": item.Supplier, "warehouse": item.Warehouse, "cancel": true})
	rec = httptest.NewRecorder()
	app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(cancelBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel: %d %s", rec.Code, rec.Body.String())
	}
	for _, it := range app.report.Items {
		if scope[it.ExcelRow] && it.FinalOrderQty != 0 {
			t.Fatalf("cancellation left row %d filled", it.ExcelRow)
		}
		if !scope[it.ExcelRow] && it.FinalOrderQty != previous[it.ExcelRow] {
			t.Fatal("cancellation modified another scope")
		}
	}
	if app.overrides[outside] != 17 {
		t.Fatal("cancellation modified outside override")
	}
	// A checked item must retain its explicit quantity, not be auto-filled.
	app.properties = map[string]bool{xlsx.NomenclaturePropertyKey(item.SKU, item.Group, item.Name, item.Warehouse): true}
	app.overrides[item.ExcelRow] = 6
	app.report = forecast.CalculateExplicit(app.wb, app.params, app.overrides, app.orderExclusionsLocked(app.wb))
	rec = httptest.NewRecorder()
	app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
	if rec.Code != http.StatusOK || app.overrides[item.ExcelRow] != 6 {
		t.Fatalf("marked manual order changed: %d %s", rec.Code, rec.Body.String())
	}
	// Invalid requests must never mutate either report or overrides.
	previousReport := app.report
	for _, tc := range []struct {
		method, body string
		status       int
	}{{http.MethodGet, "", 405}, {http.MethodPost, `{}`, 400}, {http.MethodPost, `{"supplier":"missing","warehouse":"missing"}`, 400}} {
		rec = httptest.NewRecorder()
		app.handleFillOrder(rec, httptest.NewRequest(tc.method, "/api/orders/fill", bytes.NewBufferString(tc.body)))
		if rec.Code != tc.status || app.report != previousReport {
			t.Fatalf("invalid request changed state: %d", rec.Code)
		}
	}
}

func TestFillMultipleSuppliers(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := New(false)
	if err := app.LoadWorkbookFromPath(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")); err != nil {
		t.Fatal(err)
	}
	var sample model.RawItem
	for _, calculated := range app.report.Items {
		if calculated.AutoOrderQty > 0 {
			for _, raw := range app.wb.Items {
				if raw.ExcelRow == calculated.ExcelRow {
					sample = raw
					break
				}
			}
			break
		}
	}
	if sample.ExcelRow == 0 {
		t.Fatal("fixture lacks recommendations")
	}
	app.wb.Items = nil
	for i, supplier := range []string{"A", "B", "C", "A"} {
		raw := sample
		raw.ExcelRow = 8 + i
		raw.Supplier = supplier
		raw.Warehouse = "Первый"
		if i == 3 {
			raw.Warehouse = "Другой"
		}
		app.wb.Items = append(app.wb.Items, raw)
	}
	app.overrides = map[int]int{10: 4, 11: 5}
	app.report = forecast.CalculateExplicit(app.wb, app.params, app.overrides)
	for _, cancel := range []bool{false, true} {
		body, _ := json.Marshal(map[string]any{"suppliers": []string{"A", "B"}, "warehouse": "Первый", "cancel": cancel})
		rec := httptest.NewRecorder()
		app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
		if rec.Code != 200 {
			t.Fatalf("multi: %d %s", rec.Code, rec.Body.String())
		}
		for _, it := range app.report.Items {
			switch it.ExcelRow {
			case 8, 9:
				if cancel && it.FinalOrderQty != 0 {
					t.Fatal("multi cancel left order")
				}
				if !cancel && it.FinalOrderQty <= 0 {
					t.Fatal("selected supplier not filled")
				}
			case 10:
				if it.FinalOrderQty != 4 {
					t.Fatal("unselected supplier changed")
				}
			case 11:
				if it.FinalOrderQty != 5 {
					t.Fatal("other warehouse changed")
				}
			}
		}
	}
}

func TestFillOrderUsesSubmittedSeasonalParameters(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := New(false)
	if err := app.LoadWorkbookFromPath(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")); err != nil {
		t.Fatal(err)
	}
	var target model.CalculatedItem
	for _, it := range app.report.Items {
		if it.AutoOrderQty > 0 && it.Supplier != "" {
			target = it
			break
		}
	}
	if target.ExcelRow == 0 {
		t.Fatal("missing seasonal recommendation")
	}
	base := model.DefaultParams()
	base.PlanStartDate = "2026-05-01"
	variants := []model.ForecastParams{base, base, base, base, base}
	variants[1].HorizonDays = 90
	variants[2].LeadTimeDays = 30
	variants[3].SafetyStockPct = 80
	variants[4].SeasonMode = model.SeasonFlatSimple
	totals := make([]int, len(variants))
	for i, params := range variants {
		// Stale server settings must not win over the current form submitted with Fill.
		app.params = base
		app.overrides = map[int]int{}
		app.report = forecast.CalculateExplicit(app.wb, base, app.overrides)
		expected := forecast.Calculate(app.wb, params, nil)
		body, _ := json.Marshal(map[string]any{"supplier": target.Supplier, "warehouse": target.Warehouse, "params": params})
		rec := httptest.NewRecorder()
		app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
		if rec.Code != 200 {
			t.Fatalf("variant %d: %d %s", i, rec.Code, rec.Body.String())
		}
		for j, it := range app.report.Items {
			if it.Supplier == target.Supplier && it.Warehouse == target.Warehouse {
				if it.FinalOrderQty != expected.Items[j].FinalOrderQty {
					t.Fatalf("variant %d row %d does not follow current forecast", i, it.ExcelRow)
				}
				totals[i] += it.FinalOrderQty
			} else if it.FinalOrderQty != 0 {
				t.Fatal("filled an unrelated supplier/warehouse")
			}
		}
		if app.params.HorizonDays != params.HorizonDays || app.params.LeadTimeDays != params.LeadTimeDays || app.params.SafetyStockPct != params.SafetyStockPct || app.params.SeasonMode != params.SeasonMode {
			t.Fatal("submitted settings not retained")
		}
	}
	if totals[0] == totals[1] || totals[0] == totals[2] || totals[0] == totals[3] {
		t.Fatalf("coverage, lead time and safety must affect the order: %v", totals)
	}
}

func TestClearSupplierOrderSelectedWarehouse(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := New(false)
	if err := app.LoadWorkbookFromPath(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")); err != nil {
		t.Fatal(err)
	}
	supplier := ""
	for _, it := range app.wb.Items {
		if it.Supplier != "" {
			supplier = it.Supplier
			break
		}
	}
	if supplier == "" {
		t.Fatal("missing supplier")
	}
	for _, it := range app.wb.Items {
		app.overrides[it.ExcelRow] = 17
	}
	app.report = forecast.CalculateExplicit(app.wb, app.params, app.overrides)
	warehouse := ""
	for _, it := range app.wb.Items {
		if it.Supplier == supplier {
			warehouse = it.Warehouse
			break
		}
	}
	missing, _ := json.Marshal(map[string]any{"supplier": supplier, "clear": true})
	invalid := httptest.NewRecorder()
	app.handleFillOrder(invalid, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(missing)))
	if invalid.Code != http.StatusBadRequest {
		t.Fatal("clear without warehouse must be rejected")
	}
	body, _ := json.Marshal(map[string]any{"supplier": supplier, "warehouse": warehouse, "clear": true})
	rec := httptest.NewRecorder()
	app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("clear: %d %s", rec.Code, rec.Body.String())
	}
	cleared, retained := 0, 0
	for _, it := range app.report.Items {
		if it.Supplier == supplier && it.Warehouse == warehouse {
			cleared++
			if it.FinalOrderQty != 0 {
				t.Fatal("supplier order was not cleared")
			}
			if _, ok := app.overrides[it.ExcelRow]; ok {
				t.Fatal("manual override retained")
			}
		} else {
			retained++
			if it.FinalOrderQty != 17 {
				t.Fatal("other supplier order changed")
			}
		}
	}
	if cleared == 0 || retained == 0 {
		t.Fatal("fixture must cover selected and other suppliers")
	}
}

func TestFillOrderRefreshRowsInteractive(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := New(false)
	if err := app.LoadWorkbookFromPath(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")); err != nil {
		t.Fatal(err)
	}
	app.report = forecast.Calculate(app.wb, app.params, nil)
	excludedScan := app.orderExclusionsLocked(app.wb)
	scope := map[int]*model.CalculatedItem{}
	supplier, warehouse := "", ""
	for i := range app.report.Items {
		it := &app.report.Items[i]
		if strings.TrimSpace(it.Supplier) == "" || it.AutoOrderQty <= 0 || excludedScan[it.ExcelRow] {
			continue
		}
		if supplier == "" {
			supplier, warehouse = strings.TrimSpace(it.Supplier), it.Warehouse
		}
		if strings.TrimSpace(it.Supplier) == supplier && it.Warehouse == warehouse {
			scope[it.ExcelRow] = it
		}
	}
	if supplier == "" || len(scope) < 3 {
		t.Fatal("fixture must contain a scope with at least three rows")
	}
	fresh := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"supplier": supplier, "warehouse": warehouse})
	app.handleFillOrder(fresh, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
	if fresh.Code != 200 {
		t.Fatalf("initial fill: %d %s", fresh.Code, fresh.Body.String())
	}
	keys := make([]int, 0, len(scope))
	for row := range scope {
		keys = append(keys, row)
	}
	sort.Ints(keys)
	autoRow, manualRow, pinnedRow := keys[0], keys[1], keys[2]
	item := func(row int) *model.CalculatedItem {
		for i := range app.report.Items {
			if app.report.Items[i].ExcelRow == row {
				return &app.report.Items[i]
			}
		}
		t.Fatalf("row %d missing from the report", row)
		return nil
	}
	autoStored := item(autoRow).FinalOrderQty
	if autoStored <= 0 {
		t.Fatal("auto row must hold an algorithm quantity")
	}
	// The user edited the second row after the fill; the browser still reports the stale auto value.
	manualStored := item(manualRow).FinalOrderQty
	app.overrides[manualRow] = manualStored + 1000
	app.report = forecast.CalculateExplicit(app.wb, app.params, app.overrides)
	outsider := 0
	for _, it := range app.report.Items {
		if strings.TrimSpace(it.Supplier) != supplier || it.Warehouse != warehouse {
			outsider = it.ExcelRow
			break
		}
	}
	if outsider == 0 {
		t.Fatal("fixture must contain rows outside the scope")
	}
	outsiderQty := item(outsider).FinalOrderQty
	params := model.DefaultParams()
	params.HorizonDays = 90
	refresh := map[int]int{autoRow: autoStored, manualRow: manualStored, 999999: 5}
	body, _ = json.Marshal(map[string]any{"supplier": supplier, "warehouse": warehouse, "params": params, "refreshRows": refresh})
	rec := httptest.NewRecorder()
	app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	excluded := app.orderExclusionsLocked(app.wb)
	calcOverrides := make(map[int]int, len(app.overrides)+len(app.report.Items))
	for row, qty := range app.overrides {
		calcOverrides[row] = qty
	}
	for _, it := range app.report.Items {
		if it.ExcelRow != autoRow {
			calcOverrides[it.ExcelRow] = it.FinalOrderQty
		}
	}
	expected := forecast.Calculate(app.wb, params, calcOverrides, excluded)
	expectedRow := func(row int) int {
		for i := range expected.Items {
			if expected.Items[i].ExcelRow == row {
				return expected.Items[i].FinalOrderQty
			}
		}
		return 0
	}
	if got := item(autoRow).FinalOrderQty; got != expectedRow(autoRow) {
		t.Fatalf("refreshed row %d: got %d, expected %d", autoRow, got, expectedRow(autoRow))
	}
	if got := item(manualRow).FinalOrderQty; got != manualStored+1000 {
		t.Fatalf("stale row %d must keep the manual quantity, got %d", manualRow, got)
	}
	if got := item(pinnedRow).FinalOrderQty; got != scope[pinnedRow].AutoOrderQty {
		t.Fatalf("scope row outside refreshRows must stay pinned, got %d", got)
	}
	if got := item(outsider).FinalOrderQty; got != outsiderQty {
		t.Fatalf("outsider row changed: %d -> %d", outsiderQty, got)
	}
	if app.params.HorizonDays != 90 {
		t.Fatal("refresh must retain the submitted parameters")
	}
	// An empty refresh payload must not zero the scope.
	before := item(autoRow).FinalOrderQty
	body, _ = json.Marshal(map[string]any{"supplier": supplier, "warehouse": warehouse, "params": params, "refreshRows": map[int]int{}})
	rec = httptest.NewRecorder()
	app.handleFillOrder(rec, httptest.NewRequest(http.MethodPost, "/api/orders/fill", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("empty refresh: %d %s", rec.Code, rec.Body.String())
	}
	if got := item(autoRow).FinalOrderQty; got != before {
		t.Fatalf("empty refresh must not change quantities, got %d", got)
	}
}
