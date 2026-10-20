package server_test

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
)

func TestServerAPIEndpoints(t *testing.T) {
	app := server.New(false)
	repoFile := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
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

	// 7. GET / и GET /app.js (проверка удаления лишних полей и наличия только графиков в правой панели)
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / code=%d", rec.Code)
	}
	htmlBody := rec.Body.String()
	for _, removed := range []string{
		"Ожидаемая розница и маржа",
		"Горизонт планирования",
		"Анти-выбросы и Радар неликвидов",
		"Вес свежих лет:",
		"Дата начала планирования",
		">Стр.<",
		"Прод. 12м",
		"Столбец 8: К закупкам",
		"inpStartDate",
		"hintCompleteness",
		"inpDecay",
		"kpiRetailValue",
		"kpiHorizonRange",
		"kpiOverstockVal",
	} {
		if strings.Contains(htmlBody, removed) {
			t.Fatalf("HTML still contains removed element/label: %q", removed)
		}
	}
	for _, mustHaveHTML := range []string{
		`<th data-sort="warehouse" class="wh-col">Склад</th>`,
		`<th data-sort="group" class="grp-col">Группа</th>`,
		`<th data-sort="sumSalesLast12M" class="num-col col-5digits">Продажи</th>`,
		`<th data-sort="closingStock" class="num-col col-5digits">Остаток</th>`,
		`<th data-sort="finalOrderQty" class="num-col col-5digits order-col-head">Заказ</th>`,
	} {
		if !strings.Contains(htmlBody, mustHaveHTML) {
			t.Fatalf("HTML missing expected column header: %q", mustHaveHTML)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/styles.css", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /styles.css code=%d", rec.Code)
	}
	cssBody := rec.Body.String()
	for _, mustHaveCSS := range []string{".col-5digits", "calc(6ch", ".wh-col", ".grp-col", ".cell-2lines", "font-size: 8px", "width: 1%"} {
		if !strings.Contains(cssBody, mustHaveCSS) {
			t.Fatalf("styles.css missing required column styling rule: %q", mustHaveCSS)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/app.js", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /app.js code=%d", rec.Code)
	}
	jsBody := rec.Body.String()
	for _, removedJS := range []string{
		"inpStartDate",
		"hintCompleteness",
		"ins-head",
		"ins-metrics",
		"explain-box",
		"Обоснование расчёта",
		">Стр.<",
		"Продажи 12м",
	} {
		if strings.Contains(jsBody, removedJS) {
			t.Fatalf("app.js still contains removed fragment: %q", removedJS)
		}
	}
	for _, keptChart := range []string{
		"buildHistoryBarSVG",
		"buildTwelveMonthSVG",
		"formatTwoLines",
		"cell-2lines",
	} {
		if !strings.Contains(jsBody, keptChart) {
			t.Fatalf("app.js missing required UI helper/function: %q", keptChart)
		}
	}
}
