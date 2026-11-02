package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// Подмена поставщика в отдельной строке: значение пишется в книгу,
// исходный поставщик отслеживается и возвращается отменой по истории.
func TestSupplierOverrideRowSubstitutionAndHistory(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := New(false)
	repoFile := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
	if err := app.LoadWorkbookFromPath(repoFile); err != nil {
		t.Fatal(err)
	}
	h := app.Handler()

	row, original := 0, ""
	for _, it := range app.report.Items {
		if it.Supplier != "" {
			row, original = it.ExcelRow, it.Supplier
			break
		}
	}
	if row == 0 {
		t.Fatal("fixture needs a row with a supplier")
	}

	// Снимок истории ДО подмены.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/action-history", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("history GET: %d %s", rec.Code, rec.Body.String())
	}
	var before actionHistorySnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}

	// Подмена поставщика в одной строке.
	body, _ := json.Marshal(map[string]any{"excelRow": row, "supplier": "Подменный поставщик"})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/supplier-override", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("supplier-override: %d %s", rec.Code, rec.Body.String())
	}
	var env stateEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Report == nil {
		t.Fatal("envelope must include the report")
	}
	for _, it := range env.Report.Items {
		if it.ExcelRow == row && it.Supplier != "Подменный поставщик" {
			t.Fatalf("report row %d supplier = %q, want substituted", row, it.Supplier)
		}
		if it.ExcelRow != row && it.Supplier == "Подменный поставщик" {
			t.Fatalf("row %d must keep its own supplier", it.ExcelRow)
		}
	}
	for i := range app.wb.Items {
		if app.wb.Items[i].ExcelRow == row && app.wb.Items[i].Supplier != "Подменный поставщик" {
			t.Fatalf("workbook row %d supplier = %q, want substituted", row, app.wb.Items[i].Supplier)
		}
	}
	if app.supplierOriginals[row] != original {
		t.Fatalf("original supplier not tracked: got %q, want %q", app.supplierOriginals[row], original)
	}
	if env.SupplierOriginals[row] != original {
		t.Fatalf("envelope must expose originals: got %q", env.SupplierOriginals[row])
	}

	// Снимок ПОСЛЕ подмены содержит подмену с исходным поставщиком.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/action-history", nil))
	var after actionHistorySnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	sub, ok := after.SupplierSubs[row]
	if !ok || sub.Original != original || sub.Current != "Подменный поставщик" {
		t.Fatalf("snapshot must contain the substitution, got %+v (ok=%v)", sub, ok)
	}

	// Отмена по снимку «до»: поставщик строки возвращается, подмена забыта.
	restored, _ := json.Marshal(before)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/action-history", bytes.NewReader(restored)))
	if rec.Code != http.StatusOK {
		t.Fatalf("history restore: %d %s", rec.Code, rec.Body.String())
	}
	for i := range app.wb.Items {
		if app.wb.Items[i].ExcelRow == row && app.wb.Items[i].Supplier != original {
			t.Fatalf("history restore: row %d supplier = %q, want %q", row, app.wb.Items[i].Supplier, original)
		}
	}
	if _, tracked := app.supplierOriginals[row]; tracked {
		t.Fatal("history restore must forget the substitution")
	}

	// Повторная подмена и возврат пустым значением supplier.
	body, _ = json.Marshal(map[string]any{"excelRow": row, "supplier": "Подменный поставщик"})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/supplier-override", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("second substitution: %d %s", rec.Code, rec.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"excelRow": row, "supplier": ""})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/supplier-override", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("revert with empty supplier: %d %s", rec.Code, rec.Body.String())
	}
	for i := range app.wb.Items {
		if app.wb.Items[i].ExcelRow == row && app.wb.Items[i].Supplier != original {
			t.Fatalf("empty supplier must restore original: row %d = %q, want %q", row, app.wb.Items[i].Supplier, original)
		}
	}
	if _, tracked := app.supplierOriginals[row]; tracked {
		t.Fatal("revert must forget the substitution")
	}

	// Неверная строка отклоняется.
	body, _ = json.Marshal(map[string]any{"excelRow": 999999, "supplier": "X"})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/supplier-override", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid row must be 400, got %d", rec.Code)
	}
}
