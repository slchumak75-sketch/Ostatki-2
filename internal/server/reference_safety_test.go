package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func safetyRequest(app *AppServer, method, path string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(raw)))
	return rec
}
func safetyToken(t *testing.T, app *AppServer) string {
	t.Helper()
	rec := safetyRequest(app, "GET", "/api/etalon/preview", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var p struct {
		Token string `json:"token"`
	}
	json.Unmarshal(rec.Body.Bytes(), &p)
	return p.Token
}
func safetyApp(t *testing.T) *AppServer {
	t.Helper()
	app := New(false)
	app.SetSaveDir(t.TempDir())
	app.report = &model.CalculationReport{FileName: "Тест.xlsx", Items: []model.CalculatedItem{{RawItem: model.RawItem{ExcelRow: 8, SKU: "001", Name: "Товар <1>", Warehouse: "Мир", ClosingStock: 5}, SalesSegment: 3}}}
	dir, _ := app.propertiesDirLocked()
	if err := app.loadPropertiesLocked(filepath.Join(dir, "properties.json")); err != nil {
		t.Fatal(err)
	}
	key := xlsx.NomenclaturePropertyKey("001", "", "Товар <1>", "Мир")
	app.properties[key] = true
	return app
}
func TestConfirmedReferenceAndHistory(t *testing.T) {
	app := safetyApp(t)
	if rec := safetyRequest(app, "POST", "/api/etalon/save-confirmed", map[string]any{}); rec.Code != 409 {
		t.Fatal("unconfirmed save accepted", rec.Code)
	}
	token := safetyToken(t, app)
	if rec := safetyRequest(app, "POST", "/api/etalon/save-confirmed", map[string]string{"token": token}); rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	dir, _ := app.propertiesDirLocked()
	before, _ := os.ReadFile(filepath.Join(dir, "etalon.json"))
	token = safetyToken(t, app)
	app.report.Items[0].ClosingStock = 6
	if rec := safetyRequest(app, "POST", "/api/etalon/save-confirmed", map[string]string{"token": token}); rec.Code != 409 {
		t.Fatal("stale confirmation accepted")
	}
	unchanged, _ := os.ReadFile(filepath.Join(dir, "etalon.json"))
	if !bytes.Equal(before, unchanged) {
		t.Fatal("rejected save changed reference")
	}
	for i := 0; i < 12; i++ {
		app.report.Items[0].ClosingStock = float64(i + 6)
		rec := safetyRequest(app, "POST", "/api/etalon/save-confirmed", map[string]string{"token": safetyToken(t, app)})
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
	}
	history := safetyRequest(app, "GET", "/api/etalon/history", nil)
	var data struct {
		Entries []struct {
			ID     string `json:"id"`
			Source string `json:"source"`
		} `json:"entries"`
	}
	json.Unmarshal(history.Body.Bytes(), &data)
	if len(data.Entries) != 10 || data.Entries[0].Source != "Тест.xlsx" {
		t.Fatal(history.Body.String())
	}
	if rec := safetyRequest(app, "POST", "/api/etalon/history", map[string]string{"id": "../etalon.json", "token": safetyToken(t, app)}); rec.Code != 400 {
		t.Fatal("path traversal accepted")
	}
	stock := app.report.Items[0].ClosingStock
	if rec := safetyRequest(app, "POST", "/api/etalon/history", map[string]string{"id": data.Entries[0].ID, "token": safetyToken(t, app)}); rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if app.report.Items[0].ClosingStock != stock {
		t.Fatal("history restore changed current stock")
	}
}

func backupMultipart(t *testing.T, app *AppServer, raw []byte, selected []string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	f, _ := writer.CreateFormFile("file", "backup.zip")
	f.Write(raw)
	names, _ := json.Marshal(selected)
	writer.WriteField("selected", string(names))
	writer.WriteField("token", safetyToken(t, app))
	writer.Close()
	req := httptest.NewRequest("POST", "/api/backup/restore", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}
func TestSelectiveBackupRestore(t *testing.T) {
	app := safetyApp(t)
	rec := safetyRequest(app, "POST", "/api/etalon/save-confirmed", map[string]string{"token": safetyToken(t, app)})
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	dir, _ := app.propertiesDirLocked()
	widths := []byte(`{"widths":{"itemsTable":[100,200]}}`)
	os.WriteFile(filepath.Join(dir, "column-widths.json"), widths, 0600)
	app.params.HorizonDays = 77
	backup := safetyRequest(app, "GET", "/api/backup/full", nil)
	if backup.Code != 200 {
		t.Fatal(backup.Code, backup.Body.String())
	}
	for k := range app.properties {
		app.properties[k] = false
	}
	app.params.HorizonDays = 12
	if rec := backupMultipart(t, app, backup.Body.Bytes(), []string{"settings.json", "column-widths.json"}); rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if app.params.HorizonDays != 77 {
		t.Fatal("settings not restored")
	}
	for _, v := range app.properties {
		if v {
			t.Fatal("unselected marks restored")
		}
	}
	restarted := New(false)
	restarted.SetSaveDir(app.customSaveDir)
	if restarted.preferredParamsLocked().HorizonDays != 77 {
		t.Fatal("restored settings lost on restart")
	}
	if rec := backupMultipart(t, app, backup.Body.Bytes(), []string{"properties.json", "etalon.json"}); rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	for _, v := range app.properties {
		if !v {
			t.Fatal("selected marks not restored")
		}
	}
	before, _ := os.ReadFile(filepath.Join(dir, "etalon.json"))
	if rec := backupMultipart(t, app, backup.Body.Bytes(), []string{"etalon.json", "missing.json"}); rec.Code != 400 {
		t.Fatal("invalid part accepted")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "etalon.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("failed validation changed reference")
	}
	// ZIP paths are never extracted to disk.
	var bad bytes.Buffer
	zw := zip.NewWriter(&bad)
	f, _ := zw.Create("../etalon.json")
	f.Write([]byte(`{}`))
	zw.Close()
	if rec := backupMultipart(t, app, bad.Bytes(), []string{"etalon.json"}); rec.Code != 400 {
		t.Fatal("unsafe ZIP accepted")
	}
}

func TestComparisonReasonsExportAndNewItemsShown(t *testing.T) {
	app := safetyApp(t)
	safetyRequest(app, "POST", "/api/etalon/save-confirmed", map[string]string{"token": safetyToken(t, app)})
	app.report.Items[0].ClosingStock = 10
	app.report.Items[0].SalesSegment = 0
	app.report.Items = append(app.report.Items, model.CalculatedItem{RawItem: model.RawItem{ExcelRow: 9, SKU: "NEW", Name: "Новый", ClosingStock: 999}})
	rec := safetyRequest(app, "GET", "/api/etalon/compare", nil)
	if !strings.Contains(rec.Body.String(), `"excelRow":9`) || !strings.Contains(rec.Body.String(), "Остаток вырос") || !strings.Contains(rec.Body.String(), "Рейтинг снизился") {
		t.Fatal(rec.Body.String())
	}
	rec = safetyRequest(app, "GET", "/api/etalon/compare/export", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			r, _ := f.Open()
			raw, _ := io.ReadAll(r)
			r.Close()
			text := string(raw)
			if !strings.Contains(text, "Новый") || !strings.Contains(text, "Товар &lt;1&gt;") || !strings.Contains(text, `A1:H3`) {
				t.Fatal(text)
			}
			if !strings.Contains(text, "новый товар") || strings.Contains(text, `<c r="D3" s="3"><v>0</v>`) || strings.Contains(text, `<c r="F3" s="3"><v>0</v>`) {
				t.Fatal("new rows must not fabricate historical values", text)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("no comparison sheet")
	}
}

func TestWorkbookPreflightReadOnly(t *testing.T) {
	app := safetyApp(t)
	original := app.report
	raw, err := os.ReadFile(filepath.Join("..", "..", "Ведомость ок.xlsx"))
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	f, _ := writer.CreateFormFile("file", "Ведомость.xlsx")
	f.Write(raw)
	writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/workbook/check", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"noPrices"`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if app.report != original {
		t.Fatal("preflight changed current report")
	}
}
