package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestActionHistoryRestoresWorkingDataNotReference(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("APPDATA", t.TempDir())
	app := New(false)
	file := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
	if err := app.LoadWorkbookFromPath(file); err != nil {
		t.Fatal(err)
	}
	app.etalon = map[string]model.NomenclatureRecord{"frozen": {Checked: true, Rating: 3, Stock: 7}}
	frozen, _ := json.Marshal(app.etalon)
	call := func(method string, body []byte) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		app.handleActionHistory(rec, httptest.NewRequest(method, "/api/action-history", bytes.NewReader(body)))
		return rec
	}
	rec := call(http.MethodGet, nil)
	if rec.Code != 200 {
		t.Fatalf("snapshot: %d %s", rec.Code, rec.Body.String())
	}
	initial := append([]byte(nil), rec.Body.Bytes()...)
	var snap actionHistorySnapshot
	if err := json.Unmarshal(initial, &snap); err != nil {
		t.Fatal(err)
	}
	item := app.wb.Items[0]
	key := xlsx.NomenclaturePropertyKey(item.SKU, item.Group, item.Name, item.Warehouse)
	snap.Overrides[item.ExcelRow] = 9
	snap.Properties[key] = true
	snap.Suppliers = []string{item.Supplier}
	snap.SelectionActive = true
	snap.Params.HorizonDays = 45
	modified, _ := json.Marshal(snap)
	rec = call(http.MethodPost, modified)
	if rec.Code != 200 || app.overrides[item.ExcelRow] != 9 || !app.properties[key] || app.params.HorizonDays != 45 {
		t.Fatalf("restore modified: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, initial)
	if rec.Code != 200 || len(app.overrides) != 0 || app.properties[key] {
		t.Fatalf("undo: %d %s", rec.Code, rec.Body.String())
	}
	currentFrozen, _ := json.Marshal(app.etalon)
	if !bytes.Equal(frozen, currentFrozen) {
		t.Fatal("undo changed frozen reference")
	}
	rec = call(http.MethodPost, modified)
	if rec.Code != 200 || app.overrides[item.ExcelRow] != 9 {
		t.Fatal("redo failed")
	}
	// Loading the very same filename is still a new workbook generation.
	if err := app.LoadWorkbookFromPath(file); err != nil {
		t.Fatal(err)
	}
	rec = call(http.MethodPost, modified)
	if rec.Code != 409 || len(app.overrides) != 0 {
		t.Fatal("old history was applied to a new workbook")
	}
}
