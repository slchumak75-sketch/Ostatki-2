package xlsx

import (
	"archive/zip"
	"bytes"
	"strconv"
	"strings"
)

type ComparisonExportRow struct {
	IsNew                        bool
	Warehouse, SKU, Name, Reason string
	OldStock, Stock              float64
	OldRating, Rating            int
}

func GenerateComparisonXLSX(items []ComparisonExportRow) ([]byte, error) {
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="2" width="22" customWidth="1"/><col min="3" max="3" width="50" customWidth="1"/><col min="4" max="7" width="20" customWidth="1"/><col min="8" max="8" width="65" customWidth="1"/></cols><sheetData><row r="1">`)
	for i, h := range []string{"Склад", "Артикул", "Номенклатура", "Остаток эталона", "Остаток текущий", "Рейтинг эталона", "Рейтинг текущий", "Причина"} {
		sheet.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	sheet.WriteString(`</row>`)
	for i, it := range items {
		r := strconv.Itoa(i + 2)
		sheet.WriteString(`<row r="` + r + `">`)
		for j, v := range []string{it.Warehouse, it.SKU, it.Name} {
			sheet.WriteString(inlineStrCell(ColIndexToLetters(j+1)+r, 2, v))
		}
		for j, v := range []float64{it.OldStock, it.Stock, float64(it.OldRating), float64(it.Rating)} {
			if it.IsNew && (j == 0 || j == 2) {
				sheet.WriteString(emptyStyledCell(ColIndexToLetters(j+4)+r, 3))
			} else {
				sheet.WriteString(numCell(ColIndexToLetters(j+4)+r, 3, v))
			}
		}
		sheet.WriteString(inlineStrCell("H"+r, 2, it.Reason) + `</row>`)
	}
	sheet.WriteString(`</sheetData><autoFilter ref="A1:H` + strconv.Itoa(len(items)+1) + `"/></worksheet>`)
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
			raw = bytes.ReplaceAll(raw, []byte(`name="Старьё"`), []byte(`name="Сравнение с эталоном"`))
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
