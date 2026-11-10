package forecast_test

import (
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestSeasonalForecastRealDatasetVariant4(t *testing.T) {
	wb, _, err := xlsx.ReadFile(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx"))
	if err != nil {
		t.Fatalf("failed to load workbook: %v", err)
	}

	params := model.DefaultParams()
	rep := forecast.Calculate(wb, params, nil)

	if rep.BuildVariant != "Вариант 4" {
		t.Fatalf("expected BuildVariant='Вариант 4', got %q", rep.BuildVariant)
	}
	if len(rep.Groups) != 2 {
		t.Fatalf("expected 2 groups, got %d", len(rep.Groups))
	}

	// 1. Проверка фильтра разовых оптовых выбросов на реальном кейсе R1351 («Петля гаражная с шар 20*110 б/п»: 1100 шт. в ноябре 2023)
	var row1351 *model.CalculatedItem
	for i := range rep.Items {
		if rep.Items[i].ExcelRow == 1351 {
			row1351 = &rep.Items[i]
			break
		}
	}
	if row1351 == nil {
		t.Fatalf("row 1351 not found")
	}
	if row1351.OutlierMonths == 0 || row1351.FinalOrderQty >= 20 {
		t.Fatalf("expected Variant 2 outlier filter to cap row 1351 retail order below 20, got qty=%d outliers=%d", row1351.FinalOrderQty, row1351.OutlierMonths)
	}

	// 2. Сезонный расчёт должен быть экономичнее плоского среднего на осенне-зимнем спаде
	if rep.TotalOrderCost >= rep.FlatOrderCost {
		t.Fatalf("expected seasonal budget (%.2f) < naive flat budget (%.2f)", rep.TotalOrderCost, rep.FlatOrderCost)
	}

	// 3. Проверка радара неликвидов / замороженного капитала
	if rep.OverstockItemsCount < 10 || rep.OverstockFrozenCost < 1000 {
		t.Fatalf("expected overstock detection >10 items & >1000 BYN, got %d items / %.2f BYN", rep.OverstockItemsCount, rep.OverstockFrozenCost)
	}

	// 4. Проверка оптимизатора лимита бюджета (BudgetCap = 3000 руб.)
	cappedParams := model.DefaultParams()
	cappedParams.BudgetCap = 3000.0
	cappedRep := forecast.Calculate(wb, cappedParams, nil)
	if cappedRep.TotalOrderCost > 3000.01 || cappedRep.TotalOrderCost < 2900.0 {
		t.Fatalf("expected BudgetCap=3000 to pack budget tightly into [2900..3000], got %.2f", cappedRep.TotalOrderCost)
	}

	// 5. На весенне-летний пик спрос должен кратно расти, а суммарный излишний запас — снижаться
	summerParams := model.DefaultParams()
	summerParams.PlanStartDate = "2027-05-01"
	summerRep := forecast.Calculate(wb, summerParams, nil)
	if summerRep.TotalOrderUnits <= rep.TotalOrderUnits {
		t.Fatalf("expected summer forecast units (%d) > November forecast units (%d)", summerRep.TotalOrderUnits, rep.TotalOrderUnits)
	}
	novSurplusUnits := 0
	summerSurplusUnits := 0
	for i := range rep.Items {
		if rep.Items[i].SurplusStock < 0 || summerRep.Items[i].SurplusStock < 0 {
			t.Fatalf("row %d negative SurplusStock", rep.Items[i].ExcelRow)
		}
		if rep.Items[i].AutoOrderQty > 0 && rep.Items[i].SurplusStock != 0 {
			t.Fatalf("row %d cannot simultaneously require order (%d) and have surplus (%d)",
				rep.Items[i].ExcelRow, rep.Items[i].AutoOrderQty, rep.Items[i].SurplusStock)
		}
		novSurplusUnits += rep.Items[i].SurplusStock
		summerSurplusUnits += summerRep.Items[i].SurplusStock
	}
	if novSurplusUnits <= summerSurplusUnits {
		t.Fatalf("expected off-season November surplus units (%d) > peak-season May surplus units (%d)", novSurplusUnits, summerSurplusUnits)
	}

	// 6. Проверка 6-уровневой шкалы рейтинга продаж (0-Нет продаж .. 5-Высокий)
	var segCounts [6]int
	for i := range rep.Items {
		it := &rep.Items[i]
		if it.SalesSegment < 0 || it.SalesSegment > 5 {
			t.Fatalf("row %d invalid SalesSegment=%d", it.ExcelRow, it.SalesSegment)
		}
		wantLabel := model.SalesSegmentLabelByCode(it.SalesSegment)
		if it.SalesSegmentLabel != wantLabel {
			t.Fatalf("row %d label mismatch: got %q want %q", it.ExcelRow, it.SalesSegmentLabel, wantLabel)
		}
		if it.SumSalesLast6M <= 0 && it.SalesSegment != 0 {
			t.Fatalf("row %d has 0 sales in 6m (%v), want segment 0, got %d", it.ExcelRow, it.SumSalesLast6M, it.SalesSegment)
		}
		if it.SumSalesLast6M > 0 && it.SalesSegment == 0 {
			t.Fatalf("row %d has positive 6m sales (%v), must be in 1..5, got 0", it.ExcelRow, it.SumSalesLast6M)
		}
		if it.SalesSegment == 0 && (it.AutoOrderQty != 0 || it.FinalOrderQty != 0) {
			t.Fatalf("row %d has rating 0, expected autoOrderQty=0 & finalOrderQty=0, got auto=%d final=%d",
				it.ExcelRow, it.AutoOrderQty, it.FinalOrderQty)
		}
		segCounts[it.SalesSegment]++
	}
	for seg, cnt := range segCounts {
		if cnt == 0 {
			t.Fatalf("expected non-empty sales segment %d (%s), got 0 items", seg, model.SalesSegmentLabelByCode(seg))
		}
	}
}

// Поставщики без продаж за последние 12 месяцев не попадают в реестр заказов.
func TestSuppliersRegistryExcludesNoSalesSuppliers(t *testing.T) {
	wb, _, err := xlsx.ReadFile(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx"))
	if err != nil {
		t.Fatalf("failed to load workbook: %v", err)
	}
	base := wb.Items[0]
	zero := make([]float64, len(wb.Periods))
	live := make([]float64, len(wb.Periods))
	for m := len(live) - 12; m < len(live); m++ {
		live[m] = 5
	}
	wb.Items = append(wb.Items,
		model.RawItem{ExcelRow: 900001, Warehouse: base.Warehouse, Group: base.Group, SKU: "TEST-NOSALES", Name: "Тест без продаж", ClosingStock: 5, PurchasePrice: 10, Supplier: "Поставщик Без Продаж", MonthlySales: zero},
		model.RawItem{ExcelRow: 900002, Warehouse: base.Warehouse, Group: base.Group, SKU: "TEST-WITHSALES", Name: "Тест с продажами", ClosingStock: 5, PurchasePrice: 10, Supplier: "Поставщик С Продажами", MonthlySales: live},
	)
	rep := forecast.Calculate(wb, model.DefaultParams(), nil)
	for _, s := range rep.Suppliers {
		if s.Supplier == "Поставщик Без Продаж" {
			t.Fatalf("поставщик без продаж за 12 месяцев попал в реестр: %s/%s", s.Warehouse, s.Supplier)
		}
	}
	found := false
	for _, s := range rep.Suppliers {
		if s.Supplier == "Поставщик С Продажами" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("поставщик с продажами должен остаться в реестре")
	}
	live12 := map[string]bool{}
	for i := range rep.Items {
		it := &rep.Items[i]
		if it.SumSalesLast12M > 0 {
			live12[it.Warehouse+"\x00"+it.Supplier] = true
		}
	}
	for _, s := range rep.Suppliers {
		if !live12[s.Warehouse+"\x00"+s.Supplier] {
			t.Fatalf("в реестре поставщик без продаж за 12 месяцев: %s/%s", s.Warehouse, s.Supplier)
		}
	}
}

// Батч-32: окно рейтинга продаж 6/9/12 месяцев (RatingWindowMonths).
// Сезонный SKU с продажами 11–12 мес. назад: при окне 6 — «0-Нет продаж» и пустой
// авторасчёт, при окне 9 — всё ещё 0, при окне 12 — рейтинг 1..5 и авторасчёт
// заполняется. Граница окна: продажа ровно 9 мес. назад попадает в окно 9.
func TestRatingWindowMonths(t *testing.T) {
	wb, _, err := xlsx.ReadFile(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx"))
	if err != nil {
		t.Fatalf("failed to load workbook: %v", err)
	}
	base := wb.Items[0]
	T := len(wb.Periods)
	if T < 13 {
		t.Fatalf("ожидается >= 13 периодов, получено %d", T)
	}
	seasonal := make([]float64, T)
	seasonal[T-12] = 10
	seasonal[T-11] = 10
	recent := make([]float64, T)
	recent[T-9] = 8
	wb.Items = append(wb.Items,
		model.RawItem{ExcelRow: 910001, Warehouse: base.Warehouse, Group: base.Group, SKU: "TEST-SEASON", Name: "Сезонный тест", ClosingStock: 0, PurchasePrice: 10, Supplier: base.Supplier, MonthlySales: seasonal},
		model.RawItem{ExcelRow: 910002, Warehouse: base.Warehouse, Group: base.Group, SKU: "TEST-BOUND9", Name: "Граница 9 мес", ClosingStock: 0, PurchasePrice: 10, Supplier: base.Supplier, MonthlySales: recent},
	)

	find := func(rep *model.CalculationReport, sku string) *model.CalculatedItem {
		for i := range rep.Items {
			if rep.Items[i].SKU == sku {
				return &rep.Items[i]
			}
		}
		t.Fatalf("%s: элемент не найден в отчёте", sku)
		return nil
	}

	rep6 := forecast.Calculate(wb, model.DefaultParams(), nil)
	for _, sku := range []string{"TEST-SEASON", "TEST-BOUND9"} {
		it := find(rep6, sku)
		if it.SalesSegment != 0 {
			t.Fatalf("%s: окно 6, ожидается рейтинг 0, получено %d", sku, it.SalesSegment)
		}
		if it.FinalOrderQty != 0 {
			t.Fatalf("%s: окно 6, авторасчёт должен быть пуст, получено %d", sku, it.FinalOrderQty)
		}
	}

	p9 := model.DefaultParams()
	p9.RatingWindowMonths = 9
	rep9 := forecast.Calculate(wb, p9, nil)
	if it := find(rep9, "TEST-BOUND9"); it.SalesSegment == 0 {
		t.Fatalf("TEST-BOUND9: продажа ровно 9 мес. назад должна попасть в окно 9")
	}
	if it := find(rep9, "TEST-SEASON"); it.SalesSegment != 0 {
		t.Fatalf("TEST-SEASON: окно 9, ожидается рейтинг 0, получено %d", it.SalesSegment)
	}

	p12 := model.DefaultParams()
	p12.RatingWindowMonths = 12
	rep12 := forecast.Calculate(wb, p12, nil)
	it := find(rep12, "TEST-SEASON")
	if it.SalesSegment < 1 || it.SalesSegment > 5 {
		t.Fatalf("TEST-SEASON: окно 12, ожидается рейтинг 1..5, получено %d", it.SalesSegment)
	}
	if it.FinalOrderQty <= 0 {
		t.Fatalf("TEST-SEASON: окно 12, авторасчёт должен заполниться, получено %d", it.FinalOrderQty)
	}
	if it2 := find(rep12, "TEST-BOUND9"); it2.SalesSegment == 0 {
		t.Fatalf("TEST-BOUND9: окно 12, рейтинг должен быть > 0")
	}
}
