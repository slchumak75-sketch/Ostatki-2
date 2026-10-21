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

	// 5. На весенне-летний пик спрос должен кратно расти
	summerParams := model.DefaultParams()
	summerParams.PlanStartDate = "2027-05-01"
	summerRep := forecast.Calculate(wb, summerParams, nil)
	if summerRep.TotalOrderUnits <= rep.TotalOrderUnits {
		t.Fatalf("expected summer forecast units (%d) > November forecast units (%d)", summerRep.TotalOrderUnits, rep.TotalOrderUnits)
	}

	// 5б. Скорректированный в меньшую сторону режим «Подготовка к весне (Март–Апр)»
	springParams := model.DefaultParams()
	springParams.PlanStartDate = "2027-03-01"
	springParams.HorizonDays = 21
	springParams.LeadTimeDays = 4
	springParams.SafetyStockPct = 5
	springParams.SeasonMode = "conservative"
	springRep := forecast.Calculate(wb, springParams, nil)
	if springRep.TotalOrderCost <= 0 || springRep.TotalOrderCost >= summerRep.TotalOrderCost {
		t.Fatalf("expected moderated spring prep cost in (0, %.2f), got %.2f",
			summerRep.TotalOrderCost, springRep.TotalOrderCost)
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
		segCounts[it.SalesSegment]++
	}
	for seg, cnt := range segCounts {
		if cnt == 0 {
			t.Fatalf("expected non-empty sales segment %d (%s), got 0 items", seg, model.SalesSegmentLabelByCode(seg))
		}
	}
}
