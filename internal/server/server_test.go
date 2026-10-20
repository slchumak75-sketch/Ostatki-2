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

	// 0. Проверка параметров по умолчанию: Срок поставки = 4 дня, Базовый страх. запас = 10%
	defParams := model.DefaultParams()
	if defParams.LeadTimeDays != 4 || defParams.SafetyStockPct != 10.0 {
		t.Fatalf("expected DefaultParams LeadTimeDays=4 & SafetyStockPct=10, got lead=%d safety=%v", defParams.LeadTimeDays, defParams.SafetyStockPct)
	}
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

	// 5b. GET /api/export/supplier-order — заказ поставщику из столбца «Действия» (4 столбца + шаблон имени файла)
	req = httptest.NewRequest(http.MethodGet, `/api/export/supplier-order?warehouse=%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4+%D0%9A%D0%BE%D1%80%D0%B5%D0%BB%D0%B8%D1%87%D0%B8&supplier=%D0%9E%D0%9E%D0%9E+%22%D0%93%D0%BE%D0%BB%D0%B4%D0%94%D0%B5%D0%BA%D0%BE%D1%80%22`, nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() < 800 {
		t.Fatalf("GET /api/export/supplier-order code=%d len=%d", rec.Code, rec.Body.Len())
	}
	disp := rec.Header().Get("Content-Disposition")
	if !strings.Contains(disp, "%D0%A1%D0%BA%D0%BB%D0%B0%D0%B4%20%D0%9A%D0%BE%D1%80%D0%B5%D0%BB%D0%B8%D1%87%D0%B8%2C%20%D0%9E%D0%9E%D0%9E%20%C2%AB%D0%93%D0%BE%D0%BB%D0%B4%D0%94%D0%B5%D0%BA%D0%BE%D1%80%C2%BB%2C%20") {
		t.Fatalf("unexpected Content-Disposition filename header: %s", disp)
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

	// 7. GET /, GET /styles.css и GET /app.js (проверка UI-структуры, колонок и удалённых панелей)
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
		"Ведомость и Столбец 8",
		"Матрица ABC×XYZ и Сезонность",
		"view-seasonality",
		"seasonalityContainer",
		"inspectorDrawer",
		"inspectorPlaceholder",
		"inspectorContent",
		"table-split-layout",
		"inpStartDate",
		"hintCompleteness",
		"inpDecay",
		"kpiRetailValue",
		"kpiHorizonRange",
		"kpiOverstockVal",
		`type="range"`,
		"lblHorizon",
		"lblLeadTime",
		"lblSafety",
		"ABC-XYZ: Все",
		"AX — Золотой хит",
		"Столбец 8 «К закупкам»",
		"kpiOrderUnits",
		"kpiOrderItems",
		"kpiGrid",
		"Округление и заголовок H7",
		"selRounding",
		"inpHeaderName",
		"selPageSize",
		"btnPrevPage",
		"btnNextPage",
		"lblPageNum",
	} {
		if strings.Contains(htmlBody, removed) {
			t.Fatalf("HTML still contains removed element/label: %q", removed)
		}
	}
	for _, mustHaveHTML := range []string{
		`<input type="number" id="inpHorizon"`,
		`<input type="number" id="inpLeadTime" min="0" max="180" step="1" value="4"`,
		`<input type="number" id="inpSafety" min="0" max="200" step="1" value="10"`,
		`Ведомость <span class="tab-counter" id="cntTabTable">`,
		`class="param-field param-paired"`,
		`<option value="5">5-Высокий</option>`,
		`<option value="4">4-Выше среднего</option>`,
		`<option value="3">3-Средний</option>`,
		`<option value="2">2-Ниже среднего</option>`,
		`<option value="1">1-Низкий</option>`,
		`<option value="0">0-Нет продаж</option>`,
		`class="budget-inline-card"`,
		`<span class="kpi-label">Бюджет закупки</span>`,
		`<th data-sort="warehouse" class="wh-col">Склад</th>`,
		`<th data-sort="group" class="grp-col">Группа</th>`,
		`<th data-sort="salesSegment" class="seg-col"`,
		`<th data-sort="sumSalesLast12M" class="num-col col-5digits">Продажи</th>`,
		`<th data-sort="closingStock" class="num-col col-5digits">Остаток</th>`,
		`<th data-sort="finalOrderQty" class="num-col col-5digits order-col-head">Заказ</th>`,
		`<th data-sort="purchasePrice" class="num-col">Цена</th>`,
		`<th data-sort="retailPrice" class="num-col">Розница</th>`,
	} {
		if !strings.Contains(htmlBody, mustHaveHTML) {
			t.Fatalf("HTML missing expected element: %q", mustHaveHTML)
		}
	}
	// Проверка, что столбец «Розница» следует сразу после столбца «Цена»
	priceIdx := strings.Index(htmlBody, `<th data-sort="purchasePrice" class="num-col">Цена</th>`)
	retailIdx := strings.Index(htmlBody, `<th data-sort="retailPrice" class="num-col">Розница</th>`)
	sumIdx := strings.Index(htmlBody, `<th data-sort="orderCost" class="num-col">Сумма</th>`)
	if !(priceIdx > 0 && retailIdx > priceIdx && sumIdx > retailIdx) {
		t.Fatalf("expected column order Цена -> Розница -> Сумма, got indices %d, %d, %d", priceIdx, retailIdx, sumIdx)
	}

	req = httptest.NewRequest(http.MethodGet, "/styles.css", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /styles.css code=%d", rec.Code)
	}
	cssBody := rec.Body.String()
	for _, removedCSS := range []string{"stock-crit", "inspector-drawer", "table-split-layout", "cell-2lines", "font-size: 8px"} {
		if strings.Contains(cssBody, removedCSS) {
			t.Fatalf("styles.css still contains removed selector: %q", removedCSS)
		}
	}
	for _, mustHaveCSS := range []string{
		".col-5digits",
		"calc(6ch",
		".wh-col",
		".grp-col",
		"font-size: 11.5px",
		"width: 1%",
		"padding: 1px 6px",
		"height: 18px",
		".checks-inline-bar",
		".param-field.param-paired",
		"minmax(0, 1fr) minmax(0, 1fr)",
		".auto-order-row",
		"--auto-order-bg",
		".seg-pill",
		".budget-inline-card",
		"overflow: visible",
		"top: var(--sticky-head-top",
	} {
		if !strings.Contains(cssBody, mustHaveCSS) {
			t.Fatalf("styles.css missing required styling rule: %q", mustHaveCSS)
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
		"stock-crit",
		"lblHorizon",
		"lblLeadTime",
		"lblSafety",
		"renderInspector",
		"buildHistoryBarSVG",
		"buildTwelveMonthSVG",
		"renderSeasonalityView",
		"formatTwoLines",
		"cell-2lines",
		"selRounding",
		"inpHeaderName",
		"kpiOrderUnits",
		"selPageSize",
	} {
		if strings.Contains(jsBody, removedJS) {
			t.Fatalf("app.js still contains removed fragment: %q", removedJS)
		}
	}
	for _, mustHaveJS := range []string{
		"fmtRetail",
		"auto-order-row",
		"salesSegment",
		"salesSegmentLabel",
		"api/export/supplier-order",
		"formatOrderFileName",
		"freshEdit",
		"syncStickyHeaderOffset",
		"Отображены все строки",
	} {
		if !strings.Contains(jsBody, mustHaveJS) {
			t.Fatalf("app.js missing required UI helper/function: %q", mustHaveJS)
		}
	}
	// Проверка, что во вкладке «Радар неликвидов» столбец «Продажи» стоит перед «Остаток»
	ovStart := strings.Index(jsBody, "function renderOverstockView")
	ovChunk := jsBody[ovStart:]
	ovSalesIdx := strings.Index(ovChunk, `<th class="num-col col-5digits">Продажи</th>`)
	ovStockIdx := strings.Index(ovChunk, `<th class="num-col col-5digits">Остаток</th>`)
	if !(ovSalesIdx > 0 && ovStockIdx > ovSalesIdx) {
		t.Fatalf("expected Overstock table columns Продажи -> Остаток, got indices %d, %d", ovSalesIdx, ovStockIdx)
	}
}
