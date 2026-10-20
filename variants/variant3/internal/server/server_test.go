package server_test

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/variants/variant3/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/variants/variant3/internal/server"
)

func TestServerAPIEndpoints(t *testing.T) {
	app := server.New(false)
	repoFile := filepath.Join("..", "..", "..", "..", "Ведомость с периодом ОК (1).xlsx")
	if err := app.LoadWorkbookFromPath(repoFile); err != nil {
		t.Fatalf("LoadWorkbookFromPath: %v", err)
	}
	h := app.Handler()

	// 1. GET /api/state
	req := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/state code=%d", rec.Code)
	}

	// 2. POST /api/params
	p := model.DefaultParams()
	p.HorizonDays = 45
	body, _ := json.Marshal(p)
	req = httptest.NewRequest(http.MethodPost, "/api/params", bytes.NewReader(body))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/params code=%d", rec.Code)
	}

	// 3. POST /api/override
	req = httptest.NewRequest(http.MethodPost, "/api/override", bytes.NewReader([]byte(`{"excelRow":8,"value":25}`)))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/override code=%d", rec.Code)
	}

	// 4. GET /api/export/xlsx
	req = httptest.NewRequest(http.MethodGet, "/api/export/xlsx", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() < 100000 {
		t.Fatalf("GET /api/export/xlsx code=%d len=%d", rec.Code, rec.Body.Len())
	}

	// 5. GET /api/export/orders
	req = httptest.NewRequest(http.MethodGet, "/api/export/orders", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() < 1000 {
		t.Fatalf("GET /api/export/orders code=%d len=%d", rec.Code, rec.Body.Len())
	}

	// 6. POST /api/upload
	rawBytes, err := os.ReadFile(repoFile)
	if err != nil {
		t.Fatalf("read raw: %v", err)
	}
	var mpBuf bytes.Buffer
	mw := multipart.NewWriter(&mpBuf)
	fw, _ := mw.CreateFormFile("file", "upload_test.xlsx")
	_, _ = fw.Write(rawBytes)
	_ = mw.Close()

	req = httptest.NewRequest(http.MethodPost, "/api/upload", &mpBuf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/upload code=%d body=%s", rec.Code, rec.Body.String())
	}
}
