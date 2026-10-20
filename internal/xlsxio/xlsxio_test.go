package xlsxio

import (
	"testing"

	"ostatki/internal/forecast"
	"ostatki/internal/model"
)

func fp(v float64) *float64 { return &v }

func TestWriteThenParseRoundTrip(t *testing.T) {
	months := make([]model.Month, 13)
	y, m := 2025, 1
	for i := range months {
		months[i] = model.Month{Year: y, Month: m, Label: forecast.MonthLabel(y, m)}
		m++
		if m > 12 {
			m = 1
			y++
		}
	}
	sales := make([]float64, 13)
	for i := range sales {
		sales[i] = float64(i + 1)
	}
	items := []model.Item{{
		Warehouse: "Склад Мир", Group: "Группа & <1>", Article: "A-1",
		Name: "Замок «Тест» & Co", Unit: "шт", Rashod: fp(91), Stock: 7,
		PurchasePrice: fp(10.5), RetailPrice: fp(15.75), Supplier: "ООО «Тест»",
		Sales: sales,
	}}
	st := forecast.Compute(items, months, model.DefaultParams())
	st.FileName = "test.xlsx"
	data, err := Write(st)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	parsed, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse сгенерированного файла: %v", err)
	}
	if len(parsed.Items) != 1 {
		t.Fatalf("ожидался 1 товар, получено %d", len(parsed.Items))
	}
	got := parsed.Items[0]
	if got.Name != "Замок «Тест» & Co" {
		t.Fatalf("имя искажено: %q", got.Name)
	}
	if got.Stock != 7 {
		t.Fatalf("остаток искажён: %v", got.Stock)
	}
	if len(got.Sales) != 13 || got.Sales[12] != 13 {
		t.Fatalf("продажи искажены: %v", got.Sales)
	}
	if parsed.PurchaseCol != 8 {
		t.Fatalf("столбец «К закупке» должен быть 8-м, получено %d", parsed.PurchaseCol)
	}
}

func TestParseNumQuirks(t *testing.T) {
	cases := []struct {
		in   string
		want *float64
	}{
		{"8.00", fp(8)},
		{" ", nil},
		{"", nil},
		{"7.00\n9.72", fp(9.72)}, // две цены в ячейке — берём последнюю
		{"1 234,5", fp(234.5)},   // известное ограничение: тысячи с пробелом не склеиваются
		{"12,5", fp(12.5)},
	}
	for _, c := range cases {
		got := ParseNum(c.in)
		if (got == nil) != (c.want == nil) {
			t.Fatalf("ParseNum(%q): nil=%v, ожидался nil=%v", c.in, got == nil, c.want == nil)
		}
		if got != nil && *got != *c.want {
			t.Fatalf("ParseNum(%q) = %v, ожидалось %v", c.in, *got, *c.want)
		}
	}
}

func TestParseMonthHeader(t *testing.T) {
	y, m, ok := ParseMonthHeader("Октябрь 2023 г.")
	if !ok || y != 2023 || m != 10 {
		t.Fatalf("получено %d %d %v", y, m, ok)
	}
	if _, _, ok := ParseMonthHeader("Номенклатура"); ok {
		t.Fatalf("«Номенклатура» не должна распознаваться как месяц")
	}
}
