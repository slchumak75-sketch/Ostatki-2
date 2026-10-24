package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/userpaths"
)

func TestOutputFolders(t *testing.T) {
	app := New(false)
	root := t.TempDir()
	app.SetSaveDir(root)
	app.desktopMode = true
	for _, tc := range []struct{ path, folder, body string }{
		{"/api/properties/export", "Номенклатура", "{}"},
		{"/api/properties/backup", "Номенклатура", `{"version":2,"properties":{"sku:A":false},"nomenclature":{}}`},
	} {
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, tc.path, bytes.NewBufferString(tc.body)))
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", tc.path, rec.Code, rec.Body.String())
		}
		var result struct{ FileName string }
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(root, tc.folder, result.FileName))
		if err != nil || len(data) == 0 {
			t.Fatalf("export missing: %v", err)
		}
	}
	// Browser POST must not write to the server machine's Downloads.
	app.desktopMode = false
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/properties/export", bytes.NewBufferString("{}")))
	if rec.Code != 400 {
		t.Fatalf("browser export: %d", rec.Code)
	}
	// A directory error is never reported as a successful export.
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	app.SetSaveDir(blocker)
	app.desktopMode = true
	rec = httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/properties/export", bytes.NewBufferString("{}")))
	if rec.Code != 500 {
		t.Fatalf("failed export: %d", rec.Code)
	}
}

func TestDefaultStatementFolder(t *testing.T) {
	downloads, err := userpaths.DownloadsDir()
	if err != nil {
		t.Fatal(err)
	}
	app := New(false)
	app.savedDBPath = filepath.Join(t.TempDir(), "old.xlsx")
	if got := app.SaveDir(); got != filepath.Join(downloads, "Ведомость") {
		t.Fatalf("unexpected save folder: %s", got)
	}
}
