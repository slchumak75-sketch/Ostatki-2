package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// Б78: пометка «Отправлено» живёт, пока заказ совпадает с отпечатком
// отправленного, и снимается при любом изменении заказа.
func TestOrderMailSentMarkFollowsOrderFingerprint(t *testing.T) {
	app := New(false)
	app.SetSaveDir(t.TempDir())
	app.report = &model.CalculationReport{Items: []model.CalculatedItem{
		{RawItem: model.RawItem{ExcelRow: 8, Supplier: "Поставщик", Warehouse: "Мир", PurchasePrice: 10}, FinalOrderQty: 5},
		{RawItem: model.RawItem{ExcelRow: 9, Supplier: "Поставщик", Warehouse: "Мир", PurchasePrice: 3}, FinalOrderQty: 0},
	}}
	app.rememberOrderMailSent("Поставщик", "Мир", false, "zakaz@example.com", app.report)

	get := func() string {
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/orders/sent-marks", nil))
		if rec.Code != 200 {
			t.Fatalf("sent-marks: %d %s", rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}
	if body := get(); !strings.Contains(body, "Поставщик|Мир") || !strings.Contains(body, "zakaz@example.com") {
		t.Fatalf("пометки нет после отправки: %s", body)
	}
	app.report.Items[0].FinalOrderQty = 6
	if body := get(); strings.Contains(body, "Поставщик|Мир") {
		t.Fatalf("пометка не снялась после изменения заказа: %s", body)
	}
}
