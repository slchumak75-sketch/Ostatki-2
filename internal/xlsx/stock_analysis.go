package xlsx

import (
	"archive/zip"
	"bytes"
	"math"
	"strconv"
	"strings"
)

// Батч-41: «Анализ остатков» — сопоставление товаров двух складов и выводы
// об излишках и необходимых заказах. Одна структура используется и для JSON
// ответа, и для Excel-выгрузки.
type StockAnalysisRow struct {
	SKU            string  `json:"sku"`
	Name           string  `json:"name"`
	Group          string  `json:"group"`
	MatchScore     int     `json:"matchScore"`
	MatchBy        string  `json:"matchBy"`
	WhAStock       float64 `json:"whAStock"`
	WhAMonths      float64 `json:"whAMonths"`
	WhAExcessUnits float64 `json:"whAExcessUnits"`
	WhAExcessValue float64 `json:"whAExcessValue"`
	WhBStock       float64 `json:"whBStock"`
	WhBOrderQty    int     `json:"whBOrderQty"`
	WhBNeedOrder   bool    `json:"whBNeedOrder"`
	Verdict        string  `json:"verdict"`
}

func GenerateStockAnalysisXLSX(rows []StockAnalysisRow, whA, whB string, months float64) ([]byte, error) {
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="46" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="5" width="14" customWidth="1"/><col min="6" max="11" width="14" customWidth="1"/><col min="12" max="12" width="56" customWidth="1"/></cols><sheetData><row r="1">`)
	headers := []string{
		"Артикул", "Номенклатура", "Группа", "Совпадение", "Способ",
		"Остаток «" + whA + "»", "Запас «" + whA + "», мес",
		"Излишек «" + whA + "», шт", "Излишек «" + whA + "», руб",
		"Остаток «" + whB + "»", "Заказ «" + whB + "», шт", "Вывод",
	}
	for i, h := range headers {
		sheet.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	sheet.WriteString(`</row>`)
	for i, r := range rows {
		rowNum := strconv.Itoa(i + 2)
		sheet.WriteString(`<row r="` + rowNum + `">`)
		sheet.WriteString(inlineStrCell("A"+rowNum, 2, r.SKU))
		sheet.WriteString(inlineStrCell("B"+rowNum, 2, r.Name))
		sheet.WriteString(inlineStrCell("C"+rowNum, 2, r.Group))
		sheet.WriteString(numCell("D"+rowNum, 3, float64(r.MatchScore)))
		sheet.WriteString(inlineStrCell("E"+rowNum, 2, r.MatchBy))
		sheet.WriteString(numCell("F"+rowNum, 3, r.WhAStock))
		if r.WhAMonths >= 999 {
			sheet.WriteString(inlineStrCell("G"+rowNum, 2, "∞"))
		} else {
			sheet.WriteString(numCell("G"+rowNum, 3, math.Round(r.WhAMonths*10)/10))
		}
		sheet.WriteString(numCell("H"+rowNum, 3, r.WhAExcessUnits))
		sheet.WriteString(numCell("I"+rowNum, 3, r.WhAExcessValue))
		sheet.WriteString(numCell("J"+rowNum, 3, r.WhBStock))
		sheet.WriteString(numCell("K"+rowNum, 3, float64(r.WhBOrderQty)))
		sheet.WriteString(inlineStrCell("L"+rowNum, 2, r.Verdict))
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData><autoFilter ref="A1:L` + strconv.Itoa(len(rows)+1) + `"/></worksheet>`)
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
