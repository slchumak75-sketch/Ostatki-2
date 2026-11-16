package xlsx

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// Батч-39: новый формат выгрузки «Ведомость 16.11.2026 (ОК).xlsx» — столбцы
// переставлены и дополнены (Код, Начальный остаток, Приход, Минимальный резерв,
// Оптовая надбавка, «+»), столбца «К закупкам» в шапке больше нет. Привязка
// идёт по названиям шапки; позиция 8 («Приход») не должна притворяться столбцом
// заказа, заказы пишутся в новый столбец после последнего в шапке.

func loadNewFormat(t *testing.T) ([]byte, *model.WorkbookData) {
	t.Helper()
	raw, err := readFileAtRepoRoot(t, "Ведомость 16.11.2026 (ОК).xlsx")
	if err != nil {
		t.Fatal(err)
	}
	wb, err := ParseBytes(raw, "vedomost-new.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	return raw, wb
}

func readFileAtRepoRoot(t *testing.T, name string) ([]byte, error) {
	t.Helper()
	return os.ReadFile(filepath.Join("..", "..", name))
}

func TestParseNewFormatVedomost2026(t *testing.T) {
	_, wb := loadNewFormat(t)

	if wb.HeaderRow != 7 {
		t.Fatalf("HeaderRow = %d, ожидалось 7", wb.HeaderRow)
	}
	if wb.OrderCol != 54 { // BB — после последнего столбца шапки BA
		t.Fatalf("OrderCol = %d, ожидалось 54 (новый столбец после месяцев)", wb.OrderCol)
	}
	if len(wb.Periods) != 37 {
		t.Fatalf("периодов = %d, ожидалось 37 (Ноябрь 2023 .. Ноябрь 2026)", len(wb.Periods))
	}
	// 33224 товарных строк
	if len(wb.Items) < 33000 || len(wb.Items) > 34000 {
		t.Fatalf("нереалистичное число позиций: %d", len(wb.Items))
	}
	var row8 *model.RawItem
	for i := range wb.Items {
		if wb.Items[i].ExcelRow == 8 {
			row8 = &wb.Items[i]
			break
		}
	}
	if row8 == nil {
		t.Fatal("строка 8 не найдена среди позиций")
	}
	if row8.Warehouse != "Склад Мир" {
		t.Fatalf("склад = %q", row8.Warehouse)
	}
	if row8.Name != "1 Кабель АВВГ-4*16" {
		t.Fatalf("номенклатура = %q", row8.Name)
	}
	if row8.SKU != "" {
		t.Fatalf("артикул = %q (в новом файле пуст)", row8.SKU)
	}
	if row8.ClosingStock != 0 {
		t.Fatalf("конечный остаток = %v, ожидался 0 (не «Начальный остаток»)", row8.ClosingStock)
	}
	if row8.PurchasePrice < 4 || row8.PurchasePrice > 4.02 {
		t.Fatalf("цена поставщика = %v, ожидалась 4.01", row8.PurchasePrice)
	}
	if !strings.Contains(row8.Supplier, "Элсви") {
		t.Fatalf("поставщик = %q", row8.Supplier)
	}
	sum := 0.0
	for _, v := range row8.MonthlySales {
		sum += v
	}
	if sum != 60 {
		t.Fatalf("сумма помесячных продаж = %v, ожидалось 60 (Октябрь 2026)", sum)
	}
	// «Приход» (столбец 8, в строке 8 значение 60) не должен попасть в заказы
	for _, it := range wb.Items {
		if it.ExcelRow == 8 && it.ExistingOrder != nil {
			t.Fatalf("«Приход» прочитан как заказ: existingOrder=%v", *it.ExistingOrder)
		}
	}
}

// Старые форматы не должны измениться: «К закупкам» по шапке или пустая позиция 8.
func TestParseOrderColOldFormats(t *testing.T) {
	// Файл с шапкой «К закупкам» на позиции 8.
	raw1, err := readFileAtRepoRoot(t, "Ведомость с периодом ОК (1).xlsx")
	if err != nil {
		t.Fatal(err)
	}
	wb1, err := ParseBytes(raw1, "old-1.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if wb1.OrderCol != 8 {
		t.Fatalf("старый формат с «К закупкам»: OrderCol = %d, ожидалось 8", wb1.OrderCol)
	}
	// Файл с пустой ячейкой шапки на позиции 8.
	raw2, err := readFileAtRepoRoot(t, "Ведомость ок.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	wb2, err := ParseBytes(raw2, "old-2.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if wb2.OrderCol != 8 {
		t.Fatalf("старый формат с пустой шапкой на 8: OrderCol = %d, ожидалось 8", wb2.OrderCol)
	}
}

func TestWriteOrderColumnNewFormat(t *testing.T) {
	raw, wb := loadNewFormat(t)

	out, err := WriteOrderColumnLossless(raw, wb.HeaderRow, wb.OrderCol, "К закупкам", map[int]int{8: 7}, false)
	if err != nil {
		t.Fatal(err)
	}

	// Повторное чтение: заказ в новом столбце BB, данные целы.
	wb2, err := ParseBytes(out, "vedomost-new-filled.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if wb2.OrderCol != 54 {
		t.Fatalf("повторное чтение: OrderCol = %d, ожидалось 54", wb2.OrderCol)
	}
	found := false
	for _, it := range wb2.Items {
		if it.ExcelRow == 8 {
			if it.ExistingOrder == nil || *it.ExistingOrder != 7 {
				t.Fatalf("после записи заказ строки 8 = %v, ожидалось 7", it.ExistingOrder)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("строка 8 не найдена после записи")
	}

	// Сырой XML: dimension расширен до BB, метки «+» (столбец P) не тронуты.
	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatal(err)
	}
	var sheetRaw []byte
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && !strings.Contains(f.Name, "_rels") {
			rc, err := f.Open()
			if err != nil {
				t.Fatal(err)
			}
			sheetRaw, err = io.ReadAll(rc)
			_ = rc.Close()
			if err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if sheetRaw == nil {
		t.Fatal("sheet XML не найден")
	}
	sheet := string(sheetRaw)
	if !regexp.MustCompile(`<dimension ref="A1:BB33231"`).MatchString(sheet) {
		m := regexp.MustCompile(`<dimension ref="([^"]+)"`).FindStringSubmatch(sheet)
		t.Fatalf("dimension = %v, ожидалось A1:BB33231", m)
	}
	if !strings.Contains(sheet, `<c r="BB8"`) || !strings.Contains(sheet, "<v>7</v>") {
		t.Fatal("ячейка BB8 со значением 7 не найдена")
	}
	if !strings.Contains(sheet, `<c r="P7"`) {
		t.Fatal("шапка столбца «+» (P7) пропала")
	}
	if n := len(regexp.MustCompile(`<c r="P\d+"`).FindAllString(sheet, -1)); n < 30000 {
		t.Fatalf("метки «+» в столбце P потеряны: осталось %d ячеек", n)
	}
}
