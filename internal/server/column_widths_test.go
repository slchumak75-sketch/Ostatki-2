package server_test

import (
	"bytes"
	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSavedColumnWidthsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/column-widths", bytes.NewBufferString(`{"widths":{"itemsTable":[10,20,30]}}`)))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	app2 := server.New(false)
	app2.SetSaveDir(dir)
	rec = httptest.NewRecorder()
	app2.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/column-widths", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `[10,20,30]`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	app2.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/column-widths", bytes.NewBufferString(`{"widths":{"itemsTable":[-1]}}`)))
	if rec.Code != 400 {
		t.Fatal("invalid widths accepted")
	}
}
