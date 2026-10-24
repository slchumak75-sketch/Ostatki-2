package server_test

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
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

	// 3. POST /api/override + проверка точного равенства Сумма = Заказ * Цена во всех строках
	req = httptest.NewRequest(http.MethodPost, "/api/override", bytes.NewReader([]byte(`{"excelRow":8,"value":25}`)))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/override code=%d", rec.Code)
	}
	var overrideEnv struct {
		Report *struct {
			TotalOrderCost float64                  `json:"totalOrderCost"`
			Items          []model.CalculatedItem   `json:"items"`
			Warehouses     []model.WarehouseSummary `json:"warehouses"`
			Suppliers      []model.SupplierSummary  `json:"suppliers"`
		} `json:"report"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &overrideEnv); err != nil || overrideEnv.Report == nil {
		t.Fatalf("unmarshal override envelope failed: %v", err)
	}
	foundRow8 := false
	itemsSum := 0.0
	for _, it := range overrideEnv.Report.Items {
		unitPrice := math.Round(it.PurchasePrice*100) / 100
		expectedSum := math.Round(float64(it.FinalOrderQty)*unitPrice*100) / 100
		if math.Abs(it.OrderCost-expectedSum) > 1e-6 {
			t.Fatalf("row %d: expected OrderCost = FinalOrderQty(%d) * Price(%.2f) = %.2f, got %.2f",
				it.ExcelRow, it.FinalOrderQty, unitPrice, expectedSum, it.OrderCost)
		}
		itemsSum += it.OrderCost
		if it.ExcelRow == 8 {
			foundRow8 = true
			if it.FinalOrderQty != 25 || math.Abs(it.OrderCost-59.25) > 1e-6 {
				t.Fatalf("row 8 override mismatch: qty=%d orderCost=%.2f", it.FinalOrderQty, it.OrderCost)
			}
		}
	}
	if !foundRow8 {
		t.Fatalf("expected ExcelRow 8 in report items")
	}
	whSum := 0.0
	for _, w := range overrideEnv.Report.Warehouses {
		whSum += w.TotalOrderCost
	}
	supSum := 0.0
	for _, s := range overrideEnv.Report.Suppliers {
		supSum += s.TotalOrderCost
	}
	itemsSum = math.Round(itemsSum*100) / 100
	whSum = math.Round(whSum*100) / 100
	supSum = math.Round(supSum*100) / 100
	if math.Abs(itemsSum-overrideEnv.Report.TotalOrderCost) > 1e-6 ||
		math.Abs(whSum-overrideEnv.Report.TotalOrderCost) > 1e-6 ||
		math.Abs(supSum-overrideEnv.Report.TotalOrderCost) > 1e-6 {
		t.Fatalf("order cost mismatch across tabs: total=%.2f items=%.2f warehouses=%.2f suppliers=%.2f",
			overrideEnv.Report.TotalOrderCost, itemsSum, whSum, supSum)
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

	// 5c. POST /api/clear — очистка загруженной ведомости перед новой загрузкой
	req = httptest.NewRequest(http.MethodPost, "/api/clear", bytes.NewReader([]byte(`{}`)))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/clear code=%d body=%s", rec.Code, rec.Body.String())
	}
	var clearEnv struct {
		HasWorkbook bool            `json:"hasWorkbook"`
		Report      json.RawMessage `json:"report"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &clearEnv); err != nil {
		t.Fatalf("unmarshal clear response failed: %v", err)
	}
	if clearEnv.HasWorkbook || len(clearEnv.Report) > 0 {
		t.Fatalf("expected empty database after /api/clear, got hasWorkbook=%v report=%s", clearEnv.HasWorkbook, string(clearEnv.Report))
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

	// 6b. POST /api/selected-suppliers — выбор поставщиков галочками для бюджета, статуса «Готов к отправке» и выгрузки Excel
	req = httptest.NewRequest(http.MethodPost, "/api/selected-suppliers",
		bytes.NewReader([]byte(`{"suppliers":["ООО \"СИСТЕМА ООО\""]}`)))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/selected-suppliers code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Выгрузка заказа для отмеченного поставщика разрешена (200 OK)
	req = httptest.NewRequest(http.MethodGet, "/api/export/supplier-order?supplier="+url.QueryEscape(`ООО "СИСТЕМА ООО"`), nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() < 800 {
		t.Fatalf("expected 200 OK for checked supplier xlsx, got code=%d len=%d", rec.Code, rec.Body.Len())
	}

	// Выгрузка заказа для НЕотмеченного поставщика отклоняется (400 Bad Request)
	req = httptest.NewRequest(http.MethodGet, "/api/export/supplier-order?supplier="+url.QueryEscape(`ООО "ТД Комплект"`), nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for unchecked supplier xlsx, got code=%d", rec.Code)
	}

	// При этом в самой ведомости автозаполнение «Заказ» НЕ обнуляется (а позиции с рейтингом «0» изначально имеют AutoOrderQty=0)
	req = httptest.NewRequest(http.MethodGet, "/api/state", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var afterCheckState struct {
		Report *struct {
			TotalOrderCost float64                `json:"totalOrderCost"`
			Items          []model.CalculatedItem `json:"items"`
		} `json:"report"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &afterCheckState); err != nil || afterCheckState.Report == nil {
		t.Fatalf("unmarshal state after selected-suppliers failed: %v", err)
	}
	if afterCheckState.Report.TotalOrderCost < 4000.0 {
		t.Fatalf("expected positive table report order cost untouched by supplier check, got %.2f", afterCheckState.Report.TotalOrderCost)
	}
	zeroSegRow := 0
	for _, it := range afterCheckState.Report.Items {
		if it.SalesSegment == 0 {
			if zeroSegRow == 0 {
				zeroSegRow = it.ExcelRow
			}
			if it.AutoOrderQty != 0 || it.FinalOrderQty != 0 {
				t.Fatalf("expected rating 0 row %d to have autoOrderQty=0 and finalOrderQty=0, got auto=%d final=%d",
					it.ExcelRow, it.AutoOrderQty, it.FinalOrderQty)
			}
		}
	}
	if zeroSegRow == 0 {
		t.Fatalf("expected at least one row with SalesSegment == 0")
	}
	// Ручной ввод заказа для позиции с рейтингом «0» при этом работает штатно
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/override",
		bytes.NewReader([]byte(fmt.Sprintf(`{"excelRow":%d,"value":7}`, zeroSegRow)))))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/override on zero-rating row failed: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/override",
		bytes.NewReader([]byte(fmt.Sprintf(`{"excelRow":%d,"clear":true}`, zeroSegRow)))))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/override clear on zero-rating row failed: %d", rec.Code)
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
		"Подготовка к весне",
		`data-preset="spring"`,
		"Сбросить ручные правки",
		`id="btnClearOverrides"`,
		"zeroSuppliers",
		"btnZeroCheckedSuppliers",
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
		"На 2 месяца",
		"twomonths",
		"btn-primary",
		"btn-success",
		"kpiBudgetInfo",
		"Отчёт и заявки",
		"Алгоритм",
		"helpModal",
		"Загрузить .xlsx",
		"Поиск артикул",
		"сегмент",
		"Сегмент",
		"сегм.",
		"Сегм.",
	} {
		if strings.Contains(htmlBody, removed) {
			t.Fatalf("HTML still contains removed element/label: %q", removed)
		}
	}
	for _, mustHaveHTML := range []string{
		`<input type="number" id="inpHorizon"`,
		`<div class="params-body hidden" id="paramsBody">`,
		`id="btnToggleAdvanced" aria-expanded="false" aria-controls="paramsPanel">Параметры`,
		`<button class="btn btn-beige" id="btnUpload"`,
		`Загрузить новую ведомость`,
		`id="btnLoadSavedDb"`,
		`Загрузить сохраненную ведомость`,
		`id="btnSaveDb"`,
		`Сохранить ведомость`,
		`id="savedDbModal"`,
		`id="closeConfirmModal"`,
		`Сохранить текущую ведомость?`,
		`id="btnCloseSaveYes">ДА</button>`,
		`id="btnCloseSaveNo">НЕТ</button>`,
		`id="ddWarehouse"`,
		`id="ddGroup"`,
		`id="ddSku"`,
		`id="ddNomenclature"`,
		`id="ddPlus"`,
		`id="ddRating"`,
		`id="ddStatus"`,
		`id="ddSearchNameMenu"`,
		`<button class="btn btn-beige" id="btnClearDatabase"`,
		`Очистить ведомость`,
		`<button class="tab-btn tab-beige active" data-tab="table"`,
		`<button class="tab-btn tab-beige" data-tab="suppliers"`,
		`id="ovFltWarehouse"`,
		`id="ovFltName"`,
		`id="ovFltSupplier"`,
		`id="ovInpSearch"`,
		`<tfoot id="tableFoot"></tfoot>`,
		`<tfoot id="suppliersFoot"></tfoot>`,
		`<input type="number" id="inpLeadTime" min="0" max="180" step="1" value="4"`,
		`<input type="number" id="inpSafety" min="0" max="200" step="1" value="10"`,
		`Ведомость <span class="tab-counter" id="cntTabTable">`,
		`class="param-field param-paired"`,
		`<option value="">Рейтинг: Все</option>`,
		`<option value="5">5-Высокий</option>`,
		`<option value="4">4-Выше среднего</option>`,
		`<option value="3">3-Средний</option>`,
		`<option value="2">2-Ниже среднего</option>`,
		`<option value="1">1-Низкий</option>`,
		`<option value="0">0-Нет продаж</option>`,
		`class="budget-inline-card"`,
		`<span class="kpi-label">Бюджет закупки</span>`,
		`data-sort="warehouse" data-col="warehouse"`,
		`data-sort="group" data-col="group"`,
		`data-sort="name" data-col="name"`,
		`data-sort="unit" data-col="unit"`,
		`>Рейтинг</span>`,
		`data-sort="salesSegment" data-col="salesSegment" class="seg-col"`,
		`data-sort="sumSalesLast12M" data-col="sumSalesLast12M"`,
		`data-sort="closingStock" data-col="closingStock"`,
		`data-sort="finalOrderQty" data-col="finalOrderQty"`,
		`data-sort="purchasePrice" data-col="purchasePrice"`,
		`data-sort="retailPrice" data-col="retailPrice"`,
		`id="ratingChartPopover"`,
	} {
		if !strings.Contains(htmlBody, mustHaveHTML) {
			t.Fatalf("HTML missing expected element: %q", mustHaveHTML)
		}
	}
	// Проверка строгого порядка кнопок управления ведомостью:
	// Загрузить новую ведомость -> Загрузить сохраненную ведомость -> Сохранить ведомость -> Очистить ведомость
	uploadIdx := strings.Index(htmlBody, `id="btnUpload"`)
	loadSavedIdx := strings.Index(htmlBody, `id="btnLoadSavedDb"`)
	saveDbIdx := strings.Index(htmlBody, `id="btnSaveDb"`)
	clearIdx := strings.Index(htmlBody, `id="btnClearDatabase"`)
	if !(uploadIdx > 0 && loadSavedIdx > uploadIdx && saveDbIdx > loadSavedIdx && clearIdx > saveDbIdx) {
		t.Fatal("unexpected database button order")
	}
	for _, removed := range []string{`id="btnDownloadXlsx"`, `id="btnTheme"`, `id="btnPrintOrder"`, `id="btnActiveFilter"`, `id="btnHelp"`, `id="btnDownloadOrders"`, `id="btnCheckZeroRating"`} {
		if strings.Contains(htmlBody, removed) {
			t.Fatalf("removed button still present: %s", removed)
		}
	}
	panelIdx := strings.Index(htmlBody, `id="paramsPanel"`)
	for _, id := range []string{"btnSaveProperties"} {
		if strings.Index(htmlBody, `id="`+id+`"`) < panelIdx {
			t.Fatalf("button %s must be inside parameters", id)
		}
	}

	// Проверка порядка столбцов в таблице «Ведомость»:
	// Группа -> Артикул -> Номенклатура -> Ед. -> Запас -> + -> Рейтинг, а также Цена -> Розница -> Сумма
	groupColIdx := strings.Index(htmlBody, `data-sort="group" data-col="group"`)
	skuColIdx := strings.Index(htmlBody, `data-sort="sku" data-col="sku"`)
	nameIdx := strings.Index(htmlBody, `data-sort="name" data-col="name"`)
	unitIdx := strings.Index(htmlBody, `data-sort="unit" data-col="unit"`)
	surplusIdx := strings.Index(htmlBody, `data-sort="surplusStock" data-col="surplusStock" class="num-col col-5digits"`)
	plusColIdx := strings.Index(htmlBody, `data-sort="_staryoChecked" data-col="plus" class="plus-col"`)
	ratingIdx := strings.Index(htmlBody, `data-sort="salesSegment" data-col="salesSegment" class="seg-col"`)
	if !(groupColIdx > 0 && skuColIdx > groupColIdx && nameIdx > skuColIdx && unitIdx > nameIdx && surplusIdx > unitIdx && plusColIdx > surplusIdx && ratingIdx > plusColIdx) {
		t.Fatalf("expected column order Группа -> Артикул -> Номенклатура -> Ед. -> Запас -> + -> Рейтинг, got indices %d, %d, %d, %d, %d, %d, %d",
			groupColIdx, skuColIdx, nameIdx, unitIdx, surplusIdx, plusColIdx, ratingIdx)
	}
	// Проверка, что столбец «Розница» следует сразу после столбца «Цена»
	priceIdx := strings.Index(htmlBody, `data-sort="purchasePrice" data-col="purchasePrice"`)
	retailIdx := strings.Index(htmlBody, `data-sort="retailPrice" data-col="retailPrice"`)
	sumIdx := strings.Index(htmlBody, `data-sort="orderCost" data-col="orderCost"`)
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
	for _, removedCSS := range []string{"stock-crit", "inspector-drawer", "table-split-layout", "cell-2lines", "font-size: 8px", "td.seg-cell.seg-"} {
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
		"border-radius: 50%",
		"color: #000000 !important",
		"#22c55e",
		"#a3e635",
		"#ffeb3b",
		"#fef9c3",
		"#f9a8d4",
		"#ef4444",
		".unit-col",
		"#fltSupplier",
		"width: 330px",
		"--sticky-toolbar-top",
		"#view-overstock .data-table thead th { top: 0; }",
		".budget-inline-card",
		"#itemsTable:not(.show-plus-col) th.plus-col",
		".plus-input",
		"width: 20px",
		"height: 20px",
		".rating-chart-popover",
		".btn-beige",
		".btn-neutral",
		".tab-btn.tab-beige",
		"#f5ead6",
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
		"twomonths",
		"btnClearOverrides",
		"kpiBudgetInfo",
		"helpModal",
		"btnCloseHelp",
		"zeroSuppliers",
		"restoreSuppliers",
		"btnZeroCheckedSuppliers",
		"preset === 'spring'",
		"сегмент",
		"Сегмент",
		"сегм.",
		"Сегм.",
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
		"it.surplusStock",
		`<td class="unit-cell">шт.</td>`,
		`<td class="plus-cell"><input type="checkbox" class="plus-input`,
		`data-rating-row="${it.excelRow}"`,
		`data-sum-row="${it.excelRow}"`,
		"calcLineSum",
		"recomputeReportSummaries",
		"renderTableFooter",
		"updateRowSumLive",
		"initColumnResizers",
		"api/selected-suppliers",
		"isSupplierChecked",
		"btnCheckAllSuppliers",
		"btnUncheckAllSuppliers",
		"runInteractiveNameSearch",
		"renderMultiSelectMenu",
		"api/clear",
		"ovFltWarehouse",
		"ovFltName",
		"ovFltSupplier",
		"renderThreeYearSalesChart",
		"showRatingChartPopover",
		"api/export/supplier-order",
		"formatOrderFileName",
		"freshEdit",
		"syncStickyHeaderOffset",
		"Отображены все строки",
		"AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000",
		"saveDatabase('autosave')",
		"api/db/save",
		"api/db/list",
		"api/db/load",
		"api/db/upload",
		"openCloseConfirmModal",
	} {
		if !strings.Contains(jsBody, mustHaveJS) {
			t.Fatalf("app.js missing required UI helper/function: %q", mustHaveJS)
		}
	}
	// Автофильтры перенесены в заголовки всех 15 столбцов.
	for _, col := range []string{"warehouse", "group", "sku", "name", "unit", "surplusStock", "plus", "salesSegment", "sumSalesLast12M", "closingStock", "finalOrderQty", "purchasePrice", "retailPrice", "orderCost", "supplier"} {
		if !strings.Contains(htmlBody, `data-filter-col="`+col+`"`) {
			t.Fatalf("missing column filter: %s", col)
		}
	}
	if !strings.Contains(htmlBody, `id="excelFilterPopover"`) || !strings.Contains(jsBody, "matchesExcelFilters") {
		t.Fatal("missing Excel filter UI")
	}

	// Проверка столбцов в «Радаре замороженного капитала и неликвидов»:
	// Номенклатура -> Рейтинг -> Поставщик -> Продажи -> Остаток, а также ресайз столбцов (initColumnResizers(ovContainer))
	if !strings.Contains(htmlBody, `id="ovFltRating"`) {
		t.Fatalf("missing id=\"ovFltRating\" in index.html")
	}
	ovStart := strings.Index(jsBody, "function renderOverstockView")
	ovEnd := strings.Index(jsBody[ovStart:], "function collectParamsFromUI")
	ovChunk := jsBody[ovStart : ovStart+ovEnd]
	ovNameIdx := strings.Index(ovChunk, `<th data-ov-sort="name" class="col-name">Номенклатура</th>`)
	ovRatingIdx := strings.Index(ovChunk, `<th data-ov-sort="salesSegment" class="seg-col"`)
	ovSupIdx := strings.Index(ovChunk, `<th data-ov-sort="supplier">Поставщик</th>`)
	ovSalesIdx := strings.Index(ovChunk, `<th data-ov-sort="sumSalesLast12M" class="num-col col-5digits">Продажи</th>`)
	ovStockIdx := strings.Index(ovChunk, `<th data-ov-sort="closingStock" class="num-col col-5digits">Остаток</th>`)
	if !(ovNameIdx > 0 && ovRatingIdx > ovNameIdx && ovSupIdx > ovRatingIdx && ovSalesIdx > ovSupIdx && ovStockIdx > ovSalesIdx) {
		t.Fatalf("expected Overstock table columns Номенклатура -> Рейтинг -> Поставщик -> Продажи -> Остаток, got %d, %d, %d, %d, %d", ovNameIdx, ovRatingIdx, ovSupIdx, ovSalesIdx, ovStockIdx)
	}
	if !strings.Contains(ovChunk, `initColumnResizers(ovContainer)`) || !strings.Contains(ovChunk, `data-rating-row="${it.excelRow}"`) {
		t.Fatalf("Overstock table missing initColumnResizers(ovContainer) or data-rating-row badge")
	}

	// 8. Проверка полноэкранного запуска на Windows, отсутствия rundll32 и наличия встроенного PE-манифеста (.syso)
	winSrcBytes, err := os.ReadFile(filepath.Join("..", "desktop", "open_windows.go"))
	if err != nil {
		t.Fatalf("read open_windows.go failed: %v", err)
	}
	winSrc := string(winSrcBytes)
	if strings.Contains(winSrc, "rundll32") || strings.Contains(winSrc, "1460,920") {
		t.Fatalf("open_windows.go must not contain rundll32 or small fixed 1460x920 window size")
	}
	for _, mustWin := range []string{"--start-maximized", "ShellExecuteW"} {
		if !strings.Contains(winSrc, mustWin) {
			t.Fatalf("open_windows.go missing %q", mustWin)
		}
	}
	sysoInfo, err := os.Stat(filepath.Join("..", "..", "cmd", "ostatki", "rsrc_windows_amd64.syso"))
	if err != nil || sysoInfo.Size() < 1024 {
		t.Fatalf("expected embedded Windows PE resource rsrc_windows_amd64.syso (>1KB), err=%v", err)
	}
	if strings.Contains(winSrc, "--start-fullscreen") {
		t.Fatal("fullscreen launch restores unwanted browser controls")
	}
	if !strings.Contains(htmlBody, `id="btnCloseApp"`) {
		t.Fatalf("HTML missing fullscreen/close window controls")
	}
}

func TestLargeDatabaseSpeedAndConcurrentClear(t *testing.T) {
	app := server.New(false)
	repoFile := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
	if err := app.LoadWorkbookFromPath(repoFile); err != nil {
		t.Fatalf("LoadWorkbookFromPath: %v", err)
	}
	h := app.Handler()

	// 1. Проверка строгих анти-кэш заголовков на статических файлах UI
	for _, assetPath := range []string{"/", "/app.js", "/styles.css"} {
		req := httptest.NewRequest(http.MethodGet, assetPath, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s failed: %d", assetPath, rec.Code)
		}
		cc := rec.Header().Get("Cache-Control")
		if !strings.Contains(cc, "no-store") {
			t.Fatalf("GET %s missing Cache-Control no-store, got %q", assetPath, cc)
		}
	}

	// 2. Проверка прозрачного gzip-сжатия для ускорения передачи больших ведомостей
	gzReq := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	gzReq.Header.Set("Accept-Encoding", "gzip")
	gzRec := httptest.NewRecorder()
	h.ServeHTTP(gzRec, gzReq)
	if gzRec.Code != http.StatusOK {
		t.Fatalf("gzip GET /api/state failed: %d", gzRec.Code)
	}
	if gzRec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected Content-Encoding: gzip, got %q", gzRec.Header().Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(gzRec.Body)
	if err != nil {
		t.Fatalf("gzip reader failed: %v", err)
	}
	decompressed, err := io.ReadAll(zr)
	_ = zr.Close()
	if err != nil || !strings.Contains(string(decompressed), `"hasWorkbook":true`) {
		t.Fatalf("invalid gzip payload, err=%v", err)
	}

	// 2.5 Проверка выгрузки «Старьё выгрузка» (/api/export/staryo):
	// только отмеченные галочкой строки и строго 5 столбцов (Склад, Артикул, Номенклатура, Цена, Розница)
	var envCheck struct {
		Report *model.CalculationReport `json:"report"`
	}
	if err := json.Unmarshal(decompressed, &envCheck); err != nil || envCheck.Report == nil || len(envCheck.Report.Items) < 3 {
		t.Fatalf("failed to decode state report items: %v", err)
	}
	rA := envCheck.Report.Items[0]
	rB := envCheck.Report.Items[2]
	staryoReqBody := fmt.Sprintf("rows=%d,%d", rA.ExcelRow, rB.ExcelRow)
	staryoReq := httptest.NewRequest(http.MethodPost, "/api/export/staryo", strings.NewReader(staryoReqBody))
	staryoReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	staryoRec := httptest.NewRecorder()
	h.ServeHTTP(staryoRec, staryoReq)
	if staryoRec.Code != http.StatusOK {
		t.Fatalf("POST /api/export/staryo failed: %d body=%s", staryoRec.Code, staryoRec.Body.String())
	}
	zrStaryo, err := zip.NewReader(bytes.NewReader(staryoRec.Body.Bytes()), int64(staryoRec.Body.Len()))
	if err != nil {
		t.Fatalf("open exported staryo xlsx zip failed: %v", err)
	}
	var sheetXML string
	for _, f := range zrStaryo.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			rc, err := f.Open()
			if err != nil {
				t.Fatalf("open sheet1.xml: %v", err)
			}
			b, _ := io.ReadAll(rc)
			_ = rc.Close()
			sheetXML = string(b)
		}
	}
	for _, wantHeader := range []string{
		`<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Склад</t></is></c>`,
		`<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">Артикул</t></is></c>`,
		`<c r="C1" s="1" t="inlineStr"><is><t xml:space="preserve">Номенклатура</t></is></c>`,
		`<c r="D1" s="1" t="inlineStr"><is><t xml:space="preserve">Цена</t></is></c>`,
		`<c r="E1" s="1" t="inlineStr"><is><t xml:space="preserve">Розница</t></is></c>`,
	} {
		if !strings.Contains(sheetXML, wantHeader) {
			t.Fatalf("staryo sheet1.xml missing header %s\ngot: %s", wantHeader, sheetXML)
		}
	}
	if strings.Contains(sheetXML, `r="F1"`) {
		t.Fatalf("expected strictly 5 columns (A..E) in staryo sheet1.xml, found F1: %s", sheetXML)
	}
	if rowTags := strings.Count(sheetXML, `<row r="`); rowTags != 3 {
		t.Fatalf("expected 1 header row + 2 checked rows = 3 rows, got %d", rowTags)
	}
	if !strings.Contains(sheetXML, `<c r="A2" s="2" t="inlineStr"><is><t xml:space="preserve">`+rA.Warehouse+`</t></is></c>`) ||
		!strings.Contains(sheetXML, `<c r="C2" s="2" t="inlineStr"><is><t xml:space="preserve">`+rA.Name+`</t></is></c>`) {
		t.Fatalf("expected first checked item warehouse %q in A2 and name %q in C2, got: %s", rA.Warehouse, rA.Name, sheetXML)
	}

	// 3. Проверка скорости параллельного расчёта на большой ведомости: 30 000 SKU × 37 мес. (1 110 000 ячеек)
	const nItems = 30000
	const nMonths = 37
	periods := make([]model.PeriodColumn, nMonths)
	for m := 0; m < nMonths; m++ {
		yr := 2023 + m/12
		mo := (m % 12) + 1
		periods[m] = model.PeriodColumn{
			ColIndex: 12 + m,
			Label:    fmt.Sprintf("%02d.%d", mo, yr),
			Year:     yr,
			Month:    mo,
		}
	}
	salesPool := make([]float64, nItems*nMonths)
	items := make([]model.RawItem, nItems)
	for i := 0; i < nItems; i++ {
		ms := salesPool[i*nMonths : (i+1)*nMonths : (i+1)*nMonths]
		for m := 0; m < nMonths; m++ {
			v := float64((i*7+m*13)%9) * 1.5
			if m == 14 && i%40 == 0 {
				v = 450 // оптовый выброс для проверки параллельной Winsorization
			}
			ms[m] = v
		}
		items[i] = model.RawItem{
			ExcelRow:      10 + i,
			Warehouse:     fmt.Sprintf("Склад %d", (i%4)+1),
			Group:         fmt.Sprintf("Группа %d", (i%25)+1),
			SKU:           fmt.Sprintf("SKU-%06d", i+1),
			Name:          fmt.Sprintf("Номенклатура позиция №%d", i+1),
			Unit:          "шт.",
			ClosingStock:  float64(i % 15),
			PurchasePrice: 120.50 + float64(i%70),
			RetailPrice:   195.00 + float64(i%70)*1.5,
			Supplier:      fmt.Sprintf("Поставщик %d", (i%35)+1),
			MonthlySales:  ms,
		}
	}
	largeWB := &model.WorkbookData{
		FileName:  "Большая_база_30000.xlsx",
		HeaderRow: 8,
		OrderCol:  8,
		Periods:   periods,
		Items:     items,
	}

	t0 := time.Now()
	largeRep := forecast.Calculate(largeWB, model.DefaultParams(), nil)
	calcDur := time.Since(t0)
	t.Logf("30,000 SKU x 37 months (1,110,000 sales cells) parallel calculation took %v (orderUnits=%d, orderCost=%.2f)", calcDur, largeRep.TotalOrderUnits, largeRep.TotalOrderCost)
	if largeRep.TotalItems != nItems || largeRep.TotalOrderUnits <= 0 {
		t.Fatalf("unexpected large report totals: items=%d units=%d", largeRep.TotalItems, largeRep.TotalOrderUnits)
	}

	// 4. Гонка: параллельные запросы /api/params и /api/override во время нажатия «Очистить ведомость» (/api/clear)
	var wg sync.WaitGroup
	for w := 0; w < 6; w++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			pBody, _ := json.Marshal(model.DefaultParams())
			r1 := httptest.NewRequest(http.MethodPost, "/api/params", bytes.NewReader(pBody))
			w1 := httptest.NewRecorder()
			h.ServeHTTP(w1, r1)

			oBody := []byte(fmt.Sprintf(`{"excelRow":%d,"value":15}`, 15+worker))
			r2 := httptest.NewRequest(http.MethodPost, "/api/override", bytes.NewReader(oBody))
			w2 := httptest.NewRecorder()
			h.ServeHTTP(w2, r2)
		}(w)
	}
	time.Sleep(2 * time.Millisecond)
	clearReq := httptest.NewRequest(http.MethodPost, "/api/clear", strings.NewReader("{}"))
	clearRec := httptest.NewRecorder()
	h.ServeHTTP(clearRec, clearReq)
	if clearRec.Code != http.StatusOK {
		t.Fatalf("POST /api/clear failed: %d", clearRec.Code)
	}
	wg.Wait()

	// Финальный контрольный вызов GET /api/clear и проверка, что ведомость гарантированно пуста
	clearGetReq := httptest.NewRequest(http.MethodGet, "/api/clear", nil)
	clearGetRec := httptest.NewRecorder()
	h.ServeHTTP(clearGetRec, clearGetReq)
	if clearGetRec.Code != http.StatusOK {
		t.Fatalf("GET /api/clear failed: %d", clearGetRec.Code)
	}

	stReq := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	stRec := httptest.NewRecorder()
	h.ServeHTTP(stRec, stReq)
	if !strings.Contains(stRec.Body.String(), `"hasWorkbook":false`) {
		t.Fatalf("expected database to be cleared, got: %s", stRec.Body.String())
	}
}

func TestSaveOverwriteAutosaveAndRestoreFullDatabaseState(t *testing.T) {
	saveDir := t.TempDir()
	app := server.New(true)
	app.SetSaveDir(saveDir)

	repoFile := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
	if err := app.LoadWorkbookFromPath(repoFile); err != nil {
		t.Fatalf("LoadWorkbookFromPath: %v", err)
	}
	h := app.Handler()

	// Создаём устаревший файл сохранённой ведомости для того же склада, чтобы проверить автоматическую перезапись
	staleFile := filepath.Join(saveDir, "Склад Кореличи, Ведомость сохраненная, 01.01.2026.xlsx")
	if err := os.WriteFile(staleFile, []byte("stale"), 0o644); err != nil {
		t.Fatalf("write stale file: %v", err)
	}

	// Меняем параметры расчёта, ручные заказы, выбор поставщиков и состояние интерфейса
	customParams := model.DefaultParams()
	customParams.HorizonDays = 42
	customParams.LeadTimeDays = 6
	customParams.SafetyStockPct = 15
	customParams.SeasonMode = model.SeasonGroupOnly
	customParams.PackMultiple = 5
	customParams.MinDisplayStock = 1
	pBytes, _ := json.Marshal(customParams)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/params", bytes.NewReader(pBytes)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/params failed: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/override", bytes.NewReader([]byte(`{"excelRow":8,"value":35}`))))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/override failed: %d", rec.Code)
	}

	selRow := 12
	savePayload := map[string]any{
		"reason":                  "manual",
		"pendingOverrides":        map[string]int{"9": 15},
		"supplierSelectionActive": true,
		"selectedSuppliers":       []string{`ООО "СИСТЕМА ООО"`, `ООО "ГолдДекор"`},
		"ui": model.SavedUIState{
			ColFilters:         map[string][]string{"name": {"Автомат"}, "closingStock": {}},
			ShowAllItems:       true,
			StaryoMode:         true,
			StaryoRows:         []int{8, 12, 20},
			HidePlusSku:        true,
			ActiveTab:          "overstock",
			ActivePreset:       "short",
			ParamsExpanded:     true,
			SelectedExcelRow:   &selRow,
			SortKey:            "closingStock",
			SortDir:            "asc",
			FltWarehouse:       "Склад Кореличи",
			FltWarehouses:      []string{"Склад Кореличи"},
			FltGroups:          []string{"Электрика"},
			FltSkus:            []string{"10045", "10046"},
			FltNomenclatures:   []string{"Автомат ВА 47-29"},
			FltPlus:            []string{"checked"},
			FltRatings:         []string{"5", "4"},
			FltStatuses:        []string{"order"},
			FltGroup:           "",
			FltSupplier:        `ООО "ГолдДекор"`,
			FltSupplierSearch:  "Голд",
			FltRating:          "5",
			FltStatus:          "order",
			SearchSku:          "100",
			SearchName:         "автомат",
			OvFltWarehouse:     "Склад Кореличи",
			OvFltRating:        "0",
			OvSearch:           "кабель",
			OvSortKey:          "closingStock",
			OvSortDir:          "asc",
			OverstockLimit:     1000,
			TableColWidths:     []int{110, 140, 90, 260, 48, 70, 36, 70, 75, 75, 80, 75, 75, 85, 180},
			SuppliersColWidths: []int{120, 240, 80, 90, 100, 110, 110, 120, 140},
			OvColWidths:        []int{110, 130, 90, 250, 70, 180, 75, 75, 75, 75, 120},
			ScrollY:            480,
		},
	}

	// 1. Ручное сохранение («Сохранить ведомость»)
	saveBody1, _ := json.Marshal(savePayload)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/db/save", bytes.NewReader(saveBody1)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/db/save manual failed: %d %s", rec.Code, rec.Body.String())
	}
	var saveResp struct {
		OK       bool   `json:"ok"`
		FileName string `json:"fileName"`
		FilePath string `json:"filePath"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &saveResp); err != nil || !saveResp.OK {
		t.Fatalf("unexpected save response: err=%v body=%s", err, rec.Body.String())
	}
	wantPrefix := "Ведомость сохранена, "
	if !strings.HasPrefix(saveResp.FileName, wantPrefix) || !strings.HasSuffix(saveResp.FileName, ".xlsx") {
		t.Fatalf("unexpected saved database filename: %q (want prefix %q)", saveResp.FileName, wantPrefix)
	}
	if _, err := os.Stat(staleFile); !os.IsNotExist(err) {
		t.Fatalf("expected stale saved file %q to be overwritten/removed", staleFile)
	}

	// 2. Автосохранение поверх уже сохранённого файла («autosave»)
	savePayload["reason"] = "autosave"
	saveBody2, _ := json.Marshal(savePayload)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/db/save", bytes.NewReader(saveBody2)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/db/save autosave failed: %d %s", rec.Code, rec.Body.String())
	}

	// Имя включает время последнего сохранения и может измениться между запросами.
	previousPath := saveResp.FilePath
	if err := json.Unmarshal(rec.Body.Bytes(), &saveResp); err != nil || !saveResp.OK {
		t.Fatalf("unexpected autosave response: err=%v body=%s", err, rec.Body.String())
	}
	if previousPath != saveResp.FilePath {
		if _, err := os.Stat(previousPath); !os.IsNotExist(err) {
			t.Fatalf("previous save must be replaced: %s", previousPath)
		}
	}

	// Список сохранённых ведомостей должен содержать ровно 1 актуальный файл (без дублей)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/db/list", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/db/list failed: %d", rec.Code)
	}
	var listResp struct {
		Files []model.SavedDatabaseFileInfo `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("unmarshal /api/db/list failed: %v", err)
	}
	if len(listResp.Files) != 1 || listResp.Files[0].FileName != saveResp.FileName {
		t.Fatalf("expected exactly 1 saved database file %q, got %+v", saveResp.FileName, listResp.Files)
	}

	// 3. Очищаем ведомость, затем восстанавливаем через POST /api/db/load
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/clear", strings.NewReader("{}")))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/clear failed: %d", rec.Code)
	}

	loadBody, _ := json.Marshal(map[string]string{"fileName": saveResp.FileName})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/db/load", bytes.NewReader(loadBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/db/load failed: %d %s", rec.Code, rec.Body.String())
	}

	verifyRestored := func(bodyBytes []byte, label string) {
		var restored struct {
			HasWorkbook             bool                     `json:"hasWorkbook"`
			SavedFileName           string                   `json:"savedFileName"`
			Overrides               map[int]int              `json:"overrides"`
			SupplierSelectionActive bool                     `json:"supplierSelectionActive"`
			SelectedSuppliers       []string                 `json:"selectedSuppliers"`
			UIState                 model.SavedUIState       `json:"uiState"`
			Report                  *model.CalculationReport `json:"report"`
		}
		if err := json.Unmarshal(bodyBytes, &restored); err != nil {
			t.Fatalf("[%s] unmarshal restored state failed: %v", label, err)
		}
		if !restored.HasWorkbook || restored.Report == nil {
			t.Fatalf("[%s] expected active restored report", label)
		}
		if restored.Report.Params.HorizonDays != 42 || restored.Report.Params.LeadTimeDays != 6 || restored.Report.Params.PackMultiple != 5 {
			t.Fatalf("[%s] params not restored: %+v", label, restored.Report.Params)
		}
		if restored.Overrides[8] != 35 || restored.Overrides[9] != 15 {
			t.Fatalf("[%s] manual & pending overrides not restored: %+v", label, restored.Overrides)
		}
		if !restored.SupplierSelectionActive || len(restored.SelectedSuppliers) != 2 {
			t.Fatalf("[%s] selected suppliers not restored: active=%v list=%v", label, restored.SupplierSelectionActive, restored.SelectedSuppliers)
		}
		if !restored.UIState.ShowAllItems || !restored.UIState.StaryoMode || len(restored.UIState.StaryoRows) != 3 || !restored.UIState.HidePlusSku ||
			restored.UIState.ActiveTab != "overstock" || restored.UIState.FltWarehouse != "Склад Кореличи" ||
			len(restored.UIState.ColFilters) != 2 || len(restored.UIState.ColFilters["name"]) != 1 || len(restored.UIState.FltSkus) != 2 || len(restored.UIState.FltNomenclatures) != 1 ||
			len(restored.UIState.FltPlus) != 1 || restored.UIState.OvSearch != "кабель" || restored.UIState.ScrollY != 480 {
			t.Fatalf("[%s] UI state not fully restored: %+v", label, restored.UIState)
		}
	}
	verifyRestored(rec.Body.Bytes(), "api/db/load")

	// 4. Также проверяем загрузку сохранённого .xlsx с компьютера через POST /api/db/upload
	savedDiskBytes, err := os.ReadFile(saveResp.FilePath)
	if err != nil {
		t.Fatalf("read saved file from disk: %v", err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/clear", strings.NewReader("{}")))

	var mpBuf bytes.Buffer
	mw := multipart.NewWriter(&mpBuf)
	fw, _ := mw.CreateFormFile("file", saveResp.FileName)
	_, _ = fw.Write(savedDiskBytes)
	_ = mw.Close()

	upReq := httptest.NewRequest(http.MethodPost, "/api/db/upload", &mpBuf)
	upReq.Header.Set("Content-Type", mw.FormDataContentType())
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, upReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/db/upload failed: %d %s", rec.Code, rec.Body.String())
	}
	verifyRestored(rec.Body.Bytes(), "api/db/upload")

	// 5. И проверяем прямое открытие сохранённой ведомости через LoadWorkbookFromPath в новом экземпляре сервера
	app2 := server.New(true)
	if err := app2.LoadWorkbookFromPath(saveResp.FilePath); err != nil {
		t.Fatalf("app2 LoadWorkbookFromPath on saved db failed: %v", err)
	}
	rec = httptest.NewRecorder()
	app2.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	verifyRestored(rec.Body.Bytes(), "LoadWorkbookFromPath")
}
