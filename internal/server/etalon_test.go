package server_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func etalonRequest(t *testing.T, app *server.AppServer, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(raw)))
	if rec.Code != 200 {
		t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
	}
	return rec
}
func etalonUpload(t *testing.T, app *server.AppServer, path, name string, raw []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	f, _ := mw.CreateFormFile("file", name)
	_, _ = f.Write(raw)
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}
func etalonReport(t *testing.T, app *server.AppServer) *model.CalculationReport {
	t.Helper()
	rec := etalonRequest(t, app, http.MethodGet, "/api/state", nil)
	var env struct {
		Report *model.CalculationReport `json:"report"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	return env.Report
}

func TestEtalonManualOnlyFrozenRatingsAndFresh1CStock(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	fixture := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
	if err := app.LoadWorkbookFromPath(fixture); err != nil {
		t.Fatal(err)
	}
	initial := etalonReport(t, app)
	target := initial.Items[0]
	key := xlsx.NomenclaturePropertyKey(target.SKU, target.Group, target.Name, target.Warehouse)
	storage := filepath.Join(dir, "Свойства Номенклатуры")
	etalonRequest(t, app, http.MethodPost, "/api/properties", map[string]bool{"save": true})
	if _, err := os.Stat(filepath.Join(storage, "etalon.json")); !os.IsNotExist(err) {
		t.Fatal("ordinary save created reference")
	}
	// A reference file may contain historical stock; it must not replace 1C stock.
	frozen := (target.SalesSegment + 1) % 6
	record := model.NomenclatureRecord{Warehouse: target.Warehouse, SKU: target.SKU, Name: target.Name, Group: target.Group, Checked: true, Rating: frozen, Stock: 999999}
	raw, err := xlsx.GenerateNomenclatureXLSX(map[string]model.NomenclatureRecord{key: record})
	if err != nil {
		t.Fatal(err)
	}
	rec := etalonUpload(t, app, "/api/etalon/import", "Эталон.xlsx", raw)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	got := etalonReport(t, app).Items[0]
	if got.SalesSegment != frozen || got.ClosingStock != target.ClosingStock {
		t.Fatal("reference rating/1C stock mismatch", got.SalesSegment, got.ClosingStock)
	}
	before, err := os.ReadFile(filepath.Join(storage, "etalon.json"))
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a fresh 1C report with a changed closing balance.
	source, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(source), int64(len(source)))
	if err != nil {
		t.Fatal(err)
	}
	var changed bytes.Buffer
	zw := zip.NewWriter(&changed)
	patched := false
	newStock := target.ClosingStock + 123
	re := regexp.MustCompile(fmt.Sprintf(`(?s)<c\b[^>]*\br="G%d"[^>]*>.*?</c>`, target.ExcelRow))
	for _, f := range zr.File {
		r, _ := f.Open()
		data, _ := io.ReadAll(r)
		_ = r.Close()
		if strings.HasPrefix(f.Name, "xl/worksheets/") && re.Match(data) {
			data = re.ReplaceAll(data, []byte(fmt.Sprintf(`<c r="G%d"><v>%g</v></c>`, target.ExcelRow, newStock)))
			patched = true
		}
		w, _ := zw.Create(f.Name)
		_, _ = w.Write(data)
	}
	_ = zw.Close()
	if !patched {
		t.Fatal("fixture stock cell not found")
	}
	if err = app.LoadWorkbookFromBytes(changed.Bytes(), "Новая ведомость 1С.xlsx"); err != nil {
		t.Fatal(err)
	}
	got = etalonReport(t, app).Items[0]
	if got.SalesSegment != frozen || got.ClosingStock != newStock {
		t.Fatalf("new 1C report: rating=%d stock=%v", got.SalesSegment, got.ClosingStock)
	}
	etalonRequest(t, app, http.MethodPost, "/api/params", initial.Params)
	etalonRequest(t, app, http.MethodPost, "/api/properties", map[string]bool{"save": true})
	after, _ := os.ReadFile(filepath.Join(storage, "etalon.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("ordinary save/recalculation rewrote reference")
	}
	// Reloading the process must retain the fixed rating but still use fresh 1C stock.
	restarted := server.New(false)
	restarted.SetSaveDir(dir)
	if err = restarted.LoadWorkbookFromBytes(changed.Bytes(), "Новая 1С.xlsx"); err != nil {
		t.Fatal(err)
	}
	got = etalonReport(t, restarted).Items[0]
	if got.SalesSegment != frozen || got.ClosingStock != newStock {
		t.Fatal("restart lost reference or replaced stock")
	}
	// Stored stock is a constant too: reading/exporting the reference must
	// retain the imported balance, not the new live 1C balance.
	exported := etalonRequest(t, restarted, http.MethodGet, "/api/etalon/export", nil)
	stored, err := xlsx.ParseNomenclatureXLSX(exported.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if r := stored[key]; r.Rating != frozen || r.Stock != 999999 {
		t.Fatal("stored reference stock/rating changed without manual save", r)
	}
	unchanged, _ := os.ReadFile(filepath.Join(storage, "etalon.json"))
	if !bytes.Equal(before, unchanged) {
		t.Fatal("restart/export rewrote the reference")
	}
	save := etalonRequest(t, restarted, http.MethodPost, "/api/etalon/save", nil)
	var ack struct {
		FileName       string `json:"fileName"`
		SavedInProgram bool   `json:"savedInProgram"`
	}
	_ = json.Unmarshal(save.Body.Bytes(), &ack)
	want := "Эталон, " + time.Now().Format("02.01.2006") + ".xlsx"
	if !ack.SavedInProgram {
		t.Fatal("server did not confirm saving in the program")
	}
	if ack.FileName != want {
		t.Fatal("reference must use date-only name", ack.FileName)
	}
	snapshot, err := os.ReadFile(filepath.Join(storage, want))
	if err != nil {
		t.Fatal(err)
	}
	records, err := xlsx.ParseNomenclatureXLSX(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if r := records[key]; r.Rating != frozen || r.Stock != newStock || !r.Checked || r.Name != target.Name {
		t.Fatal("manual snapshot lost fields", r)
	}
	activeBefore, _ := os.ReadFile(filepath.Join(storage, "etalon.json"))
	shutdown := httptest.NewRecorder()
	restarted.Handler().ServeHTTP(shutdown, httptest.NewRequest(http.MethodPost, "/api/shutdown", nil))
	activeAfter, _ := os.ReadFile(filepath.Join(storage, "etalon.json"))
	if !bytes.Equal(activeBefore, activeAfter) {
		t.Fatal("exit rewrote the manual reference")
	}
}

func TestNomenclatureMetadataSurvivesClearRestartAndJSONImport(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	key := xlsx.NomenclaturePropertyKey("00001", "", "Товар", "Склад А")
	record := model.NomenclatureRecord{Warehouse: "Склад А", SKU: "00001", Name: "Товар", Checked: false, Rating: 4, Stock: -1.25}
	catalog := model.NomenclatureCatalog{Version: 2, Properties: map[string]bool{key: false}, Nomenclature: map[string]model.NomenclatureRecord{key: record}}
	raw, _ := json.Marshal(catalog)
	rec := etalonUpload(t, app, "/api/properties/import", "backup.json", raw)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	etalonRequest(t, app, http.MethodPost, "/api/properties", map[string]bool{"save": true})
	app.ClearDatabase()
	restarted := server.New(false)
	restarted.SetSaveDir(dir)
	rec = etalonRequest(t, restarted, http.MethodGet, "/api/properties/export", nil)
	rows, err := xlsx.ParseNomenclatureXLSX(rec.Body.Bytes())
	if err != nil || rows[key] != record {
		t.Fatal("six fields lost after clear/restart", rows, err)
	}
	// A corrupt import is rejected before mutating the catalog.
	bad := etalonUpload(t, restarted, "/api/etalon/import", "bad.xlsx", []byte("broken"))
	if bad.Code != 400 {
		t.Fatal("broken reference accepted")
	}
	rec = etalonRequest(t, restarted, http.MethodGet, "/api/properties/export", nil)
	rows, err = xlsx.ParseNomenclatureXLSX(rec.Body.Bytes())
	if err != nil || rows[key] != record {
		t.Fatal("bad import changed catalog")
	}
}

func TestVariant5MigratesVariant4PropertiesReadOnly(t *testing.T) {
	// On Unix os.UserConfigDir follows XDG_CONFIG_HOME; Windows defaults are separately packaged.
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", root)
	t.Setenv("APPDATA", root)
	t.Setenv("HOME", root)
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	root = config
	dir := filepath.Join(root, "Ostatki2", "properties")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	key := xlsx.NomenclaturePropertyKey("001", "", "", "Склад")
	old, _ := json.Marshal(map[string]bool{key: true})
	path := filepath.Join(dir, "properties.json")
	if err := os.WriteFile(path, old, 0600); err != nil {
		t.Fatal(err)
	}
	app := server.New(false)
	rec := etalonRequest(t, app, http.MethodGet, "/api/properties", nil)
	var ack struct {
		Properties map[string]bool `json:"properties"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ack)
	if !ack.Properties[key] {
		t.Fatal("old marks not migrated")
	}
	etalonRequest(t, app, http.MethodPost, "/api/properties", map[string]bool{"save": true})
	after, _ := os.ReadFile(path)
	if !bytes.Equal(old, after) {
		t.Fatal("Variant 4 catalog was changed")
	}
	if _, err := os.Stat(filepath.Join(root, "Ostatki2", "properties-v5", "properties.json")); err != nil {
		t.Fatal(err)
	}
}

func TestEtalonStoredDatePreservedOnExport(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	r := model.NomenclatureRecord{Warehouse: "Склад А", SKU: "001", Name: "Товар", Rating: 4, Stock: 12.5}
	key := xlsx.NomenclaturePropertyKey(r.SKU, r.Group, r.Name, r.Warehouse)
	c := model.NomenclatureCatalog{Version: 2, SavedAt: "2026-10-20T14:15:00+03:00", Properties: map[string]bool{key: false}, Nomenclature: map[string]model.NomenclatureRecord{key: r}}
	raw, _ := json.Marshal(c)
	rec := etalonUpload(t, app, "/api/etalon/import", "Эталон.json", raw)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	restarted := server.New(false)
	restarted.SetSaveDir(dir)
	info := etalonRequest(t, restarted, http.MethodGet, "/api/properties", nil)
	var result struct {
		FileName string `json:"etalonFileName"`
	}
	_ = json.Unmarshal(info.Body.Bytes(), &result)
	if result.FileName != "Эталон, 20.10.2026.xlsx" {
		t.Fatal("snapshot date lost", result.FileName)
	}
	exported := etalonRequest(t, restarted, http.MethodGet, "/api/etalon/export", nil)
	disposition, params, err := mime.ParseMediaType(exported.Header().Get("Content-Disposition"))
	if err != nil || disposition != "attachment" || params["filename"] != result.FileName {
		t.Fatal("export filename mismatch", params, err)
	}
	records, err := xlsx.ParseNomenclatureXLSX(exported.Body.Bytes())
	if err != nil || records[key] != r {
		t.Fatal("export changed saved stock/rating", records, err)
	}
}

func TestSaveStatusesSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	rec := etalonRequest(t, app, http.MethodPost, "/api/properties", map[string]bool{"save": true})
	var saved struct {
		FileName string `json:"fileName"`
		SavedAt  string `json:"savedAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.RFC3339, saved.SavedAt); err != nil {
		t.Fatal("no durable save timestamp", err)
	}
	r := model.NomenclatureRecord{SKU: "001", Name: "Товар", Warehouse: "Склад", Stock: 10, Rating: 1}
	key := xlsx.NomenclaturePropertyKey(r.SKU, r.Group, r.Name, r.Warehouse)
	catalog := model.NomenclatureCatalog{Version: 2, SavedAt: "2026-10-20T12:13:14+03:00", Properties: map[string]bool{key: false}, Nomenclature: map[string]model.NomenclatureRecord{key: r}}
	raw, _ := json.Marshal(catalog)
	uploaded := etalonUpload(t, app, "/api/etalon/import", "Эталон.json", raw)
	if uploaded.Code != 200 {
		t.Fatal(uploaded.Body.String())
	}
	var imported struct {
		SavedAt string `json:"savedAt"`
	}
	_ = json.Unmarshal(uploaded.Body.Bytes(), &imported)
	if _, err := time.Parse(time.RFC3339, imported.SavedAt); err != nil {
		t.Fatal("missing import save timestamp")
	}
	restarted := server.New(false)
	restarted.SetSaveDir(dir)
	rec = etalonRequest(t, restarted, http.MethodGet, "/api/properties", nil)
	var status struct {
		LastFileName   string `json:"lastFileName"`
		SavedAt        string `json:"savedAt"`
		EtalonFileName string `json:"etalonFileName"`
		EtalonSavedAt  string `json:"etalonSavedAt"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status.EtalonFileName != "Эталон, 20.10.2026.xlsx" || status.EtalonSavedAt != imported.SavedAt {
		t.Fatal("reference source date and in-program save time were not retained", status)
	}
	if status.LastFileName != "properties.json" || status.SavedAt == "" {
		t.Fatal("catalog save metadata was not retained", status)
	}
	// A new manual snapshot's own filename/time must be restored exactly as well.
	rec = etalonRequest(t, restarted, http.MethodPost, "/api/properties", map[string]bool{"save": true})
	_ = json.Unmarshal(rec.Body.Bytes(), &saved)
	again := server.New(false)
	again.SetSaveDir(dir)
	rec = etalonRequest(t, again, http.MethodGet, "/api/properties", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status.LastFileName != saved.FileName || status.SavedAt != saved.SavedAt {
		t.Fatal("manual snapshot status changed after restart", status, saved)
	}
}
