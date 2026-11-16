package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// Батч-36: «Загрузить заказ» — файл заказа (с переименованными складами
// «Мирсититорг»/«Мирстроймаркет» и пустыми артикулами) сопоставляется с
// ведомостью и перезаписывает значения столбца «Заказ».
func TestImportOrderEndpoint(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx"))
	if err != nil {
		t.Fatal(err)
	}
	app := server.New(false)
	app.SetSaveDir(t.TempDir())
	if err := app.LoadWorkbookFromBytes(raw, "veedomost-test.xlsx"); err != nil {
		t.Fatal(err)
	}

	// Собираем заказ из первого элемента ведомости: склад — внутреннее имя
	// (генератор сам выведет «Мирсититорг»), артикул пуст, количество 25.
	base, err := firstWorkbookItem(app)
	if err != nil {
		t.Fatal(err)
	}
	rep := &model.CalculationReport{Items: []model.CalculatedItem{
		{RawItem: model.RawItem{Warehouse: base.Warehouse, SKU: " ", Name: base.Name, Supplier: `ООО "БелАдмиралСтрой"`, ClosingStock: 1}, SumSalesLast12M: 3, FinalOrderQty: 25},
	}}
	orderBytes, err := xlsx.GenerateSingleSupplierOrderXLSX(rep, "", `ООО "БелАдмиралСтрой"`)
	if err != nil {
		t.Fatal(err)
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", "заказ.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fw.Write(orderBytes); err != nil {
		t.Fatal(err)
	}
	if err = mw.Close(); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/import/order", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	app.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("import order: %d %s", rec.Code, rec.Body.String())
	}
	var env struct {
		ImportSummary *struct {
			Applied   int      `json:"applied"`
			Cleared   int      `json:"cleared"`
			Unmatched []string `json:"unmatched"`
			Total     int      `json:"total"`
		} `json:"importSummary"`
		Report *struct {
			Items []struct {
				ExcelRow      int    `json:"excelRow"`
				SKU           string `json:"sku"`
				Name          string `json:"name"`
				FinalOrderQty int    `json:"finalOrderQty"`
			} `json:"items"`
		} `json:"report"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.ImportSummary == nil || env.ImportSummary.Applied != 1 {
		t.Fatalf("expected applied=1, got %+v", env.ImportSummary)
	}
	if len(env.ImportSummary.Unmatched) != 0 {
		t.Fatalf("unexpected unmatched: %v", env.ImportSummary.Unmatched)
	}
	found := false
	for _, it := range env.Report.Items {
		if it.Name == base.Name && it.FinalOrderQty == 25 {
			found = true
		}
	}
	if !found {
		t.Fatalf("order quantity 25 not applied to the matched item")
	}
}

func firstWorkbookItem(app *server.AppServer) (model.RawItem, error) {
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	data, err := io.ReadAll(rec.Body)
	if err != nil {
		return model.RawItem{}, err
	}
	var env struct {
		Report *struct {
			Items []struct {
				ExcelRow  int    `json:"excelRow"`
				Warehouse string `json:"warehouse"`
				SKU       string `json:"sku"`
				Name      string `json:"name"`
			} `json:"items"`
		} `json:"report"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return model.RawItem{}, err
	}
	if env.Report == nil || len(env.Report.Items) == 0 {
		return model.RawItem{}, os.ErrNotExist
	}
	it := env.Report.Items[0]
	_ = time.Now()
	return model.RawItem{Warehouse: it.Warehouse, SKU: it.SKU, Name: it.Name, ExcelRow: it.ExcelRow}, nil
}
