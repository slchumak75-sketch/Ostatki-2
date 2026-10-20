package forecast

import (
	"testing"

	"ostatki/internal/model"
)

func makeMonths(startYear, startMonth, n int) []model.Month {
	out := make([]model.Month, n)
	y, m := startYear, startMonth
	for i := 0; i < n; i++ {
		out[i] = model.Month{Year: y, Month: m, Label: MonthLabel(y, m)}
		m++
		if m > 12 {
			m = 1
			y++
		}
	}
	return out
}

func fp(v float64) *float64 { return &v }

func baseItem(name string, sales []float64, stock float64) model.Item {
	return model.Item{
		Warehouse: "Склад", Group: "Группа", Name: name, Unit: "шт",
		Stock: stock, PurchasePrice: fp(10), RetailPrice: fp(15),
		Supplier: "Поставщик", Sales: sales,
	}
}

func TestSeasonalForecastHigherInPeak(t *testing.T) {
	months := makeMonths(2023, 10, 37) // Окт 2023 .. Окт 2026 (последний — неполный)
	// Товар продаётся только летом (июнь-август), по 30 шт.
	sales := make([]float64, 37)
	for t, mn := range months {
		if mn.Month >= 6 && mn.Month <= 8 {
			sales[t] = 30
		}
	}
	items := []model.Item{baseItem("Летний товар", sales, 0)}
	p := model.DefaultParams()
	p.Horizon = 12 // прогноз на год: должен захватить лето
	st := Compute(items, months, p)
	r := st.Rows[0]
	// Июль (индекс 6) должен быть заметно «сезоннее» января.
	if !(r.Seasonal[6] > r.Seasonal[0]*1.5) {
		t.Fatalf("ожидалась выраженная сезонность: июль=%.3f январь=%.3f", r.Seasonal[6], r.Seasonal[0])
	}
	if r.Recommend <= 0 {
		t.Fatalf("при нулевом остатке и продажах рекомендация должна быть > 0, получено %v", r.Recommend)
	}
	if r.Status != "urgent" {
		t.Fatalf("ожидался статус urgent, получено %s", r.Status)
	}
}

func TestDeadItemNotOrdered(t *testing.T) {
	months := makeMonths(2023, 10, 37)
	sales := make([]float64, 37)
	sales[0] = 10 // продажа только в самом начале истории
	items := []model.Item{baseItem("Мёртвый товар", sales, 5)}
	st := Compute(items, months, model.DefaultParams())
	if st.Rows[0].Recommend != 0 {
		t.Fatalf("мёртвый товар закупать нельзя, получено %v", st.Rows[0].Recommend)
	}
	if st.Rows[0].Status != "dead" {
		t.Fatalf("ожидался статус dead, получено %s", st.Rows[0].Status)
	}
}

func TestEnoughStockNotOrdered(t *testing.T) {
	months := makeMonths(2023, 10, 37)
	sales := make([]float64, 37)
	for i := range sales {
		sales[i] = 1
	}
	items := []model.Item{baseItem("Запас большой", sales, 1000)}
	st := Compute(items, months, model.DefaultParams())
	if st.Rows[0].Recommend != 0 {
		t.Fatalf("при огромном запасе рекомендация должна быть 0, получено %v", st.Rows[0].Recommend)
	}
}

func TestNeverSoldNotOrdered(t *testing.T) {
	months := makeMonths(2023, 10, 37)
	items := []model.Item{baseItem("Никогда не продавался", make([]float64, 37), 0)}
	st := Compute(items, months, model.DefaultParams())
	if st.Rows[0].Recommend != 0 {
		t.Fatalf("товар без истории закупать нельзя, получено %v", st.Rows[0].Recommend)
	}
}

func TestForecastPeriodStartsAfterLastFullMonth(t *testing.T) {
	months := makeMonths(2023, 10, 37)
	sales := make([]float64, 37)
	for i := range sales {
		sales[i] = 2
	}
	items := []model.Item{baseItem("Ровный товар", sales, 0)}
	st := Compute(items, months, model.DefaultParams())
	// partialLast=true: [Окт 2026 (остаток), Ноя 2026, Дек 2026, Янв 2027]
	if len(st.ForecastMonths) != 4 {
		t.Fatalf("ожидалось 4 месяца прогноза, получено %d", len(st.ForecastMonths))
	}
	if !st.ForecastMonths[0].Remainder || st.ForecastMonths[0].Month != 10 || st.ForecastMonths[0].Year != 2026 {
		t.Fatalf("первый месяц прогноза должен быть остатком Окт 2026: %+v", st.ForecastMonths[0])
	}
	last := st.ForecastMonths[3]
	if last.Month != 1 || last.Year != 2027 {
		t.Fatalf("последний месяц прогноза должен быть Янв 2027: %+v", last)
	}
}
