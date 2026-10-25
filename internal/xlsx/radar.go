package xlsx

import (
	"archive/zip"
	"bytes"
	"strconv"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// GenerateRadarXLSX exports the complete ordered radar selection, not its DOM page.
func GenerateRadarXLSX(items []model.CalculatedItem) ([]byte, error) {
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="3" width="24" customWidth="1"/><col min="4" max="4" width="55" customWidth="1"/><col min="5" max="5" width="10" customWidth="1"/><col min="6" max="6" width="35" customWidth="1"/><col min="7" max="11" width="20" customWidth="1"/></cols><sheetData><row r="1">`)
	headers := []string{"Склад", "Группа", "Артикул", "Номенклатура", "Рейтинг", "Поставщик", "Продажи", "Остаток", "Цена", "Розница", "Заморожено сверх года"}
	for i, h := range headers {
		sheet.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	sheet.WriteString(`</row>`)
	numeric := func(ref string, v float64, style int) string {
		return `<c r="` + ref + `" s="` + strconv.Itoa(style) + `"><v>` + strconv.FormatFloat(v, 'f', -1, 64) + `</v></c>`
	}
	total := 0.0
	for i, it := range items {
		row := strconv.Itoa(i + 2)
		sheet.WriteString(`<row r="` + row + `">`)
		for j, v := range []string{it.Warehouse, it.Group, it.SKU, it.Name} {
			sheet.WriteString(inlineStrCell(ColIndexToLetters(j+1)+row, 2, v))
		}
		sheet.WriteString(numeric("E"+row, float64(it.SalesSegment), 4) + inlineStrCell("F"+row, 2, it.Supplier) + numeric("G"+row, it.SumSalesLast12M, 3) + numeric("H"+row, it.ClosingStock, 3) + numeric("I"+row, it.PurchasePrice, 3))
		if it.RetailPrice <= 0 && strings.TrimSpace(it.RetailRaw) != "" {
			sheet.WriteString(inlineStrCell("J"+row, 2, it.RetailRaw))
		} else {
			sheet.WriteString(numeric("J"+row, it.RetailPrice, 3))
		}
		sheet.WriteString(numeric("K"+row, it.OverstockValue, 3) + `</row>`)
		total += it.OverstockValue
	}
	row := strconv.Itoa(len(items) + 2)
	sheet.WriteString(`<row r="` + row + `">` + inlineStrCell("D"+row, 1, "Итого") + numeric("K"+row, total, 3) + `</row></sheetData><autoFilter ref="A1:K` + strconv.Itoa(len(items)+1) + `"/></worksheet>`)
	template, err := GenerateStaryoExportXLSX(nil)
	if err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(template), int64(len(template)))
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		raw, err := readZipEntry(f)
		if err != nil {
			return nil, err
		}
		if f.Name == "xl/worksheets/sheet1.xml" {
			raw = []byte(sheet.String())
		}
		if f.Name == "xl/workbook.xml" {
			raw = bytes.ReplaceAll(raw, []byte(`name="Старьё"`), []byte(`name="Радар неликвидов"`))
		}
		w, err := zw.Create(f.Name)
		if err != nil {
			return nil, err
		}
		if _, err = w.Write(raw); err != nil {
			return nil, err
		}
	}
	if err = zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
