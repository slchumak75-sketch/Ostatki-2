package xlsx

import (
	"archive/zip"
	"bytes"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// OrderImportRow — строка загруженного файла заказа (батч-36).
type OrderImportRow struct {
	Warehouse string
	SKU       string
	Name      string
	Qty       int
	Row       int // номер строки в файле заказа (для сообщений)
}

// InternalWarehouseName — обратный маппинг отображаемых названий складов
// выгрузки «Заказ поставщику» («Мирсититорг» → «Склад Кореличи») во
// внутренние названия ведомости. Неизвестные названия возвращаются как есть.
func InternalWarehouseName(display string) string {
	d := strings.TrimSpace(display)
	for internal, shown := range supplierOrderWarehouseNames {
		if shown == d {
			return internal
		}
	}
	return d
}

// ParseOrderImportBytes разбирает файл заказа (выгрузка «Заказ поставщику» и
// совместимые однолистовые форматы): ищет строку шапки со столбцами
// «Склад/Наименование склада» и «Заказ» (+ «Артикул», «Номенклатура»),
// возвращает строки данных с количествами.
func ParseOrderImportBytes(raw []byte) ([]OrderImportRow, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("некорректный ZIP/XLSX архив: %w", err)
	}
	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		files[f.Name] = f
	}
	_, sheetPath, err := resolveFirstSheet(files)
	if err != nil {
		return nil, err
	}
	shared, err := readSharedStrings(files["xl/sharedStrings.xml"])
	if err != nil {
		return nil, err
	}
	rows, err := parseWorksheetRows(files[sheetPath], shared)
	if err != nil {
		return nil, err
	}
	normalize := func(v string) string {
		return strings.ToLower(strings.Join(strings.Fields(v), " "))
	}
	whCol, skuCol, nameCol, qtyCol := 0, 0, 0, 0
	headerRow := -1
	for i := range rows {
		if rows[i].num > 50 {
			break
		}
		wh, sku, name, qty := 0, 0, 0, 0
		for col := 1; col < len(rows[i].cells); col++ {
			switch normalize(rows[i].cellAt(col)) {
			case "наименование склада", "склад":
				wh = col
			case "артикул":
				sku = col
			case "номенклатура", "наименование":
				name = col
			case "заказ", "к закупке", "к закупкам":
				qty = col
			}
		}
		if wh > 0 && qty > 0 {
			whCol, skuCol, nameCol, qtyCol = wh, sku, name, qty
			headerRow = rows[i].num
			break
		}
	}
	if headerRow < 0 {
		return nil, fmt.Errorf("в файле не найдены столбцы «Склад» и «Заказ» — это файл заказа поставщику?")
	}
	out := make([]OrderImportRow, 0, 64)
	for i := range rows {
		r := &rows[i]
		if r.num <= headerRow {
			continue
		}
		wh := strings.TrimSpace(r.cellAt(whCol))
		sku := ""
		if skuCol > 0 {
			sku = strings.TrimSpace(r.cellAt(skuCol))
		}
		name := ""
		if nameCol > 0 {
			name = strings.TrimSpace(r.cellAt(nameCol))
		}
		if wh == "" && sku == "" && name == "" {
			continue
		}
		qty := 0
		qtyTxt := strings.TrimSpace(strings.Replace(r.cellAt(qtyCol), ",", ".", 1))
		if qtyTxt != "" {
			f, err := strconv.ParseFloat(qtyTxt, 64)
			if err != nil {
				return nil, fmt.Errorf("строка %d: неверное количество %q", r.num, r.cellAt(qtyCol))
			}
			qty = int(math.Round(f))
		}
		if qty < 0 {
			qty = 0
		}
		out = append(out, OrderImportRow{Warehouse: wh, SKU: sku, Name: name, Qty: qty, Row: r.num})
	}
	return out, nil
}
