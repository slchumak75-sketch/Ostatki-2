package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
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
