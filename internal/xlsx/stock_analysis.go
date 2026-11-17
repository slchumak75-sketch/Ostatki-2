package xlsx

import (
	"archive/zip"
	"bytes"
	"strconv"
	"strings"
)

// Батч-41/43: «Анализ остатков» — сопоставление товаров двух складов.
// Батч-43: таблица в виде Группа | Артикул | Наименование | Совпадение, % |
// [Склад А] | стрелка перемещения | [Склад Б] — и в окне, и в Excel.
type StockAnalysisRow struct {
	Group       string  `json:"group"`
	SKU         string  `json:"sku"`
	Name        string  `json:"name"`
	MatchScore  int     `json:"matchScore"`
	WhAStock    float64 `json:"whAStock"`
	WhAMonths   float64 `json:"whAMonths"`
	WhBStock    float64 `json:"whBStock"`
	WhBMonths   float64 `json:"whBMonths"`
	Arrow       string  `json:"arrow"`       // "AtoB" | "BtoA" | "" (нет перемещения)
	ExcessUnits float64 `json:"excessUnits"` // излишек на складе-источнике, шт
	ExcessValue float64 `json:"excessValue"` // излишек на складе-источнике, руб
}

func GenerateStockAnalysisXLSX(rows []StockAnalysisRow, whA, whB string, months float64) ([]byte, error) {
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="46" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/><col min="5" max="5" width="15" customWidth="1"/><col min="6" max="6" width="15" customWidth="1"/><col min="7" max="7" width="15" customWidth="1"/></cols><sheetData><row r="1">`)
	headers := []string{
		"Группа", "Артикул", "Номенклатура", "Совпадение, %",
		whA, "Перемещение", whB,
	}
	for i, h := range headers {
		sheet.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	sheet.WriteString(`</row>`)
	arrowGlyph := map[string]string{"AtoB": "→", "BtoA": "←"}
	for i, r := range rows {
		rowNum := strconv.Itoa(i + 2)
		sheet.WriteString(`<row r="` + rowNum + `">`)
		sheet.WriteString(inlineStrCell("A"+rowNum, 2, r.Group))
		sheet.WriteString(inlineStrCell("B"+rowNum, 2, r.SKU))
		sheet.WriteString(inlineStrCell("C"+rowNum, 2, r.Name))
		sheet.WriteString(numCell("D"+rowNum, 3, float64(r.MatchScore)))
		sheet.WriteString(numCell("E"+rowNum, 3, r.WhAStock))
		if g, ok := arrowGlyph[r.Arrow]; ok {
			// Стиль 1: жирный шрифт, рамка, по центру — «хорошая жирная стрелка».
			sheet.WriteString(inlineStrCell("F"+rowNum, 1, g))
		} else {
			sheet.WriteString(emptyStyledCell("F"+rowNum, 4))
		}
		sheet.WriteString(numCell("G"+rowNum, 3, r.WhBStock))
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData><autoFilter ref="A1:G` + strconv.Itoa(len(rows)+1) + `"/></worksheet>`)
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
			raw = bytes.ReplaceAll(raw, []byte(`name="Старьё"`), []byte(`name="Анализ остатков"`))
		}
		if err := addZipPart(zw, f.Name, raw); err != nil {
			return nil, err
		}
	}
	if err = zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
