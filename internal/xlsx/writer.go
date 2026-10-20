package xlsx

import (
	"archive/zip"
	"bytes"
	"fmt"
	"html"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

var (
	sstCountRe  = regexp.MustCompile(`\bcount="(\d+)"`)
	sstUniqueRe = regexp.MustCompile(`\buniqueCount="(\d+)"`)
)

// WriteOrderColumnLossless записывает заголовок и расчётные значения столбца 8 ("К закупкам")
// в копию исходного .xlsx с 100% сохранением форматирования, палитры 1С и графических объектов.
func WriteOrderColumnLossless(
	rawXLSX []byte,
	headerRow int,
	orderCol int,
	headerText string,
	ordersByRow map[int]int,
	writeZeroValues bool,
) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(rawXLSX), int64(len(rawXLSX)))
	if err != nil {
		return nil, fmt.Errorf("чтение исходного XLSX: %w", err)
	}

	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		files[f.Name] = f
	}
	_, sheetPath, err := resolveFirstSheet(files)
	if err != nil {
		return nil, err
	}

	if strings.TrimSpace(headerText) == "" {
		headerText = "К закупкам"
	}

	// 1. Обновление sharedStrings.xml (добавление заголовка "К закупкам", если его ещё нет)
	existingStrings, err := readSharedStrings(files["xl/sharedStrings.xml"])
	if err != nil {
		return nil, err
	}
	headerSSID := -1
	for i, s := range existingStrings {
		if s == headerText {
			headerSSID = i
			break
		}
	}

	var updatedSST []byte
	if ssFile := files["xl/sharedStrings.xml"]; ssFile != nil && headerSSID < 0 {
		rawSST, err := readZipEntry(ssFile)
		if err != nil {
			return nil, err
		}
		headerSSID = len(existingStrings)
		updatedSST = appendSharedStringXML(rawSST, headerText)
	}

	// 2. Хирургическое обновление целевого столбца (H / orderCol) в sheet1.xml
	sheetFile := files[sheetPath]
	if sheetFile == nil {
		return nil, fmt.Errorf("не найден лист %s", sheetPath)
	}
	rawSheet, err := readZipEntry(sheetFile)
	if err != nil {
		return nil, err
	}
	updatedSheet := patchWorksheetColumn(rawSheet, headerRow, orderCol, headerSSID, headerText, ordersByRow, writeZeroValues)

	// 3. Пересборка ZIP-архива с побайтовым сохранением всех остальных файлов
	var outBuf bytes.Buffer
	outBuf.Grow(len(rawXLSX) + 65536)
	zw := zip.NewWriter(&outBuf)

	for _, f := range zr.File {
		hdr := f.FileHeader
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(&hdr)
		if err != nil {
			return nil, err
		}
		switch f.Name {
		case "xl/sharedStrings.xml":
			if updatedSST != nil {
				if _, err := w.Write(updatedSST); err != nil {
					return nil, err
				}
				continue
			}
		case sheetPath:
			if _, err := w.Write(updatedSheet); err != nil {
				return nil, err
			}
			continue
		}
		data, err := readZipEntry(f)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return outBuf.Bytes(), nil
}

// SaveOrderColumnToFile атомарно сохраняет заполненный .xlsx на диск.
func SaveOrderColumnToFile(
	outPath string,
	rawXLSX []byte,
	headerRow int,
	orderCol int,
	headerText string,
	ordersByRow map[int]int,
	writeZeroValues bool,
) error {
	outBytes, err := WriteOrderColumnLossless(rawXLSX, headerRow, orderCol, headerText, ordersByRow, writeZeroValues)
	if err != nil {
		return err
	}
	tmpPath := outPath + ".tmp"
	if err := os.WriteFile(tmpPath, outBytes, 0o644); err != nil {
		return fmt.Errorf("запись временного файла: %w", err)
	}
	if err := os.Rename(tmpPath, outPath); err != nil {
		_ = os.Remove(tmpPath)
		return os.WriteFile(outPath, outBytes, 0o644)
	}
	return nil
}

func readZipEntry(zf *zip.File) ([]byte, error) {
	rc, err := zf.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

func appendSharedStringXML(rawSST []byte, text string) []byte {
	s := string(rawSST)
	s = sstCountRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := sstCountRe.FindStringSubmatch(m)
		n, _ := strconv.Atoi(sub[1])
		return fmt.Sprintf(`count="%d"`, n+1)
	})
	s = sstUniqueRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := sstUniqueRe.FindStringSubmatch(m)
		n, _ := strconv.Atoi(sub[1])
		return fmt.Sprintf(`uniqueCount="%d"`, n+1)
	})
	preserve := ""
	if strings.TrimSpace(text) != text || strings.Contains(text, "\n") {
		preserve = ` xml:space="preserve"`
	}
	newSI := fmt.Sprintf(`<si><t%s>%s</t></si>`, preserve, html.EscapeString(text))
	idx := strings.LastIndex(s, "</sst>")
	if idx < 0 {
		return rawSST
	}
	return []byte(s[:idx] + newSI + s[idx:])
}

// patchWorksheetColumn за O(N) без тяжёлых регулярок проходит по <row r="...">...</row> и обновляет только ячейку целевого столбца.
func patchWorksheetColumn(
	rawSheet []byte,
	headerRow int,
	targetCol int,
	headerSSID int,
	headerText string,
	ordersByRow map[int]int,
	writeZeroValues bool,
) []byte {
	src := string(rawSheet)
	colPrefix := ColIndexToLetters(targetCol)

	var out strings.Builder
	out.Grow(len(src) + len(ordersByRow)*16)

	cursor := 0
	for {
		idxRow := strings.Index(src[cursor:], "<row ")
		if idxRow < 0 {
			out.WriteString(src[cursor:])
			break
		}
		rowStart := cursor + idxRow
		gtRel := strings.IndexByte(src[rowStart:], '>')
		if gtRel < 0 {
			out.WriteString(src[cursor:])
			break
		}
		rowOpenEnd := rowStart + gtRel + 1
		rowOpen := src[rowStart:rowOpenEnd]
		rNumStr := extractAttrFast(rowOpen, "r")
		rowNum, _ := strconv.Atoi(rNumStr)

		out.WriteString(src[cursor:rowStart])

		// Проверка самозакрывающейся строки <row .../>
		if strings.HasSuffix(rowOpen, "/>") {
			out.WriteString(rowOpen)
			cursor = rowOpenEnd
			continue
		}

		closeRel := strings.Index(src[rowOpenEnd:], "</row>")
		if closeRel < 0 {
			out.WriteString(src[rowStart:])
			break
		}
		rowBodyEnd := rowOpenEnd + closeRel
		rowCloseEnd := rowBodyEnd + len("</row>")

		isHeader := rowNum == headerRow
		qty, hasOrder := ordersByRow[rowNum]

		if !isHeader && !hasOrder {
			out.WriteString(src[rowStart:rowCloseEnd])
			cursor = rowCloseEnd
			continue
		}

		targetRef := colPrefix + rNumStr
		rowBody := src[rowOpenEnd:rowBodyEnd]

		out.WriteString(rowOpen)
		out.WriteString(rewriteCellInRowBodyFast(rowBody, targetCol, targetRef, isHeader, headerSSID, headerText, qty, writeZeroValues))
		out.WriteString("</row>")

		cursor = rowCloseEnd
	}

	return []byte(out.String())
}

func extractAttrFast(tagOpen, attrName string) string {
	needle := attrName + `="`
	pos := 0
	for {
		i := strings.Index(tagOpen[pos:], needle)
		if i < 0 {
			return ""
		}
		absIdx := pos + i
		if absIdx > 0 {
			prev := tagOpen[absIdx-1]
			if prev != ' ' && prev != '\t' && prev != '\n' && prev != '\r' {
				pos = absIdx + len(needle)
				continue
			}
		}
		valStart := absIdx + len(needle)
		qEnd := strings.IndexByte(tagOpen[valStart:], '"')
		if qEnd < 0 {
			return ""
		}
		return tagOpen[valStart : valStart+qEnd]
	}
}

func rewriteCellInRowBodyFast(
	rowBody string,
	targetCol int,
	targetRef string,
	isHeader bool,
	headerSSID int,
	headerText string,
	qty int,
	writeZeroValues bool,
) string {
	foundStart, foundEnd := -1, -1
	foundStyle := ""
	fallbackStyle := ""
	insertBeforeOffset := len(rowBody)

	pos := 0
	for {
		cRel := strings.Index(rowBody[pos:], "<c ")
		if cRel < 0 {
			break
		}
		cStart := pos + cRel
		gtRel := strings.IndexByte(rowBody[cStart:], '>')
		if gtRel < 0 {
			break
		}
		openEnd := cStart + gtRel + 1
		cOpen := rowBody[cStart:openEnd]
		var cEnd int
		if strings.HasSuffix(cOpen, "/>") {
			cEnd = openEnd
		} else {
			closeRel := strings.Index(rowBody[openEnd:], "</c>")
			if closeRel < 0 {
				break
			}
			cEnd = openEnd + closeRel + len("</c>")
		}

		ref := extractAttrFast(cOpen, "r")
		if sVal := extractAttrFast(cOpen, "s"); sVal != "" && fallbackStyle == "" {
			fallbackStyle = sVal
		}
		if ref != "" {
			cIdx := LettersToColIndex(ref)
			if cIdx == targetCol {
				foundStart = cStart
				foundEnd = cEnd
				foundStyle = extractAttrFast(cOpen, "s")
				break
			}
			if cIdx > targetCol && insertBeforeOffset == len(rowBody) {
				insertBeforeOffset = cStart
			}
		}
		pos = cEnd
	}

	styleAttr := ""
	if foundStart >= 0 && foundStyle != "" {
		styleAttr = ` s="` + foundStyle + `"`
	} else if fallbackStyle != "" {
		styleAttr = ` s="` + fallbackStyle + `"`
	}

	var replacement string
	if isHeader {
		if headerSSID >= 0 {
			replacement = fmt.Sprintf(`<c r="%s"%s t="s"><v>%d</v></c>`, targetRef, styleAttr, headerSSID)
		} else {
			replacement = fmt.Sprintf(`<c r="%s"%s t="inlineStr"><is><t>%s</t></is></c>`, targetRef, styleAttr, html.EscapeString(headerText))
		}
	} else {
		if qty == 0 && !writeZeroValues {
			replacement = fmt.Sprintf(`<c r="%s"%s/>`, targetRef, styleAttr)
		} else {
			replacement = fmt.Sprintf(`<c r="%s"%s><v>%d</v></c>`, targetRef, styleAttr, qty)
		}
	}

	if foundStart >= 0 {
		return rowBody[:foundStart] + replacement + rowBody[foundEnd:]
	}
	return rowBody[:insertBeforeOffset] + replacement + rowBody[insertBeforeOffset:]
}

// GenerateSupplierOrdersXLSX создаёт отдельный многолистовый Excel-отчёт для закупок и отправки поставщикам.
func GenerateSupplierOrdersXLSX(report *model.CalculationReport, filterWarehouse string, filterSupplier string) ([]byte, error) {
	// Собираем строки к заказу (> 0)
	var orderItems []model.CalculatedItem
	for _, it := range report.Items {
		if it.FinalOrderQty <= 0 {
			continue
		}
		if filterWarehouse != "" && it.Warehouse != filterWarehouse {
			continue
		}
		if filterSupplier != "" && it.Supplier != filterSupplier {
			continue
		}
		orderItems = append(orderItems, it)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	addFile := func(name, content string) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write([]byte(content))
		return err
	}

	if err := addFile("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet5.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`); err != nil {
		return nil, err
	}

	if err := addFile("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`); err != nil {
		return nil, err
	}

	if err := addFile("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`); err != nil {
		return nil, err
	}

	if err := addFile("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="К закупкам (Вариант 2)" sheetId="1" r:id="rId1"/>
    <sheet name="По поставщикам" sheetId="2" r:id="rId2"/>
    <sheet name="Сезонность и ABC-XYZ" sheetId="3" r:id="rId3"/>
    <sheet name="Неликвиды и избыток" sheetId="4" r:id="rId4"/>
    <sheet name="Сравнение Вариант 2 vs 1" sheetId="5" r:id="rId5"/>
  </sheets>
</workbook>`); err != nil {
		return nil, err
	}

	if err := addFile("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="#,##0.00"/>
    <numFmt numFmtId="165" formatCode="#,##0"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="10"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="12"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`); err != nil {
		return nil, err
	}

	// Лист 1: Детальный список к закупке
	var s1 strings.Builder
	s1.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>
  <col min="1" max="1" width="8" customWidth="1"/>
  <col min="2" max="2" width="18" customWidth="1"/>
  <col min="3" max="3" width="28" customWidth="1"/>
  <col min="4" max="4" width="22" customWidth="1"/>
  <col min="5" max="5" width="13" customWidth="1"/>
  <col min="6" max="6" width="44" customWidth="1"/>
  <col min="7" max="7" width="8" customWidth="1"/>
  <col min="8" max="8" width="12" customWidth="1"/>
  <col min="9" max="9" width="14" customWidth="1"/>
  <col min="10" max="10" width="14" customWidth="1"/>
  <col min="11" max="11" width="15" customWidth="1"/>
  <col min="12" max="12" width="12" customWidth="1"/>
  <col min="13" max="13" width="8" customWidth="1"/>
  <col min="14" max="14" width="48" customWidth="1"/>
</cols><sheetData>`)

	titleText := fmt.Sprintf("Заявка на закупку (горизонт: %s — %s, %d+%d дн., страх. запас %.0f%%)",
		report.EffectiveStartDate, report.EffectiveEndDate, report.Params.HorizonDays, report.Params.LeadTimeDays, report.Params.SafetyStockPct)
	s1.WriteString(fmt.Sprintf(`<row r="1" ht="22" customHeight="1">%s</row>`, inlineStrCell("A1", 5, titleText)))

	headers1 := []string{
		"Стр. Excel", "Склад", "Поставщик", "Группа номенклатуры", "Артикул",
		"Номенклатура", "Ед.", "Остаток", "К закупкам", "Цена закуп.",
		"Сумма заказа", "Сезон. коэф.", "ABC", "Обоснование расчёта",
	}
	s1.WriteString(`<row r="3" ht="28" customHeight="1">`)
	for i, h := range headers1 {
		s1.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"3", 1, h))
	}
	s1.WriteString(`</row>`)

	sumUnits := 0
	sumCost := 0.0
	for idx, it := range orderItems {
		r := idx + 4
		rs := strconv.Itoa(r)
		sumUnits += it.FinalOrderQty
		sumCost += it.OrderCost
		s1.WriteString(`<row r="` + rs + `" ht="20" customHeight="1">`)
		s1.WriteString(numCell("A"+rs, 6, float64(it.ExcelRow)))
		s1.WriteString(inlineStrCell("B"+rs, 2, it.Warehouse))
		s1.WriteString(inlineStrCell("C"+rs, 2, it.Supplier))
		s1.WriteString(inlineStrCell("D"+rs, 2, it.Group))
		s1.WriteString(inlineStrCell("E"+rs, 2, it.SKU))
		s1.WriteString(inlineStrCell("F"+rs, 2, it.Name))
		s1.WriteString(inlineStrCell("G"+rs, 2, it.Unit))
		s1.WriteString(numCell("H"+rs, 6, it.ClosingStock))
		s1.WriteString(numCell("I"+rs, 3, float64(it.FinalOrderQty)))
		s1.WriteString(numCell("J"+rs, 4, it.PurchasePrice))
		s1.WriteString(numCell("K"+rs, 4, it.OrderCost))
		s1.WriteString(numCell("L"+rs, 4, it.HorizonSeasonIdx))
		s1.WriteString(inlineStrCell("M"+rs, 2, it.ABCXYZ))
		s1.WriteString(inlineStrCell("N"+rs, 2, it.Explanation))
		s1.WriteString(`</row>`)
	}
	totRow := len(orderItems) + 4
	trs := strconv.Itoa(totRow)
	s1.WriteString(`<row r="` + trs + `" ht="22" customHeight="1">`)
	s1.WriteString(inlineStrCell("F"+trs, 3, "ИТОГО ПО ЗАЯВКЕ:"))
	s1.WriteString(numCell("I"+trs, 3, float64(sumUnits)))
	s1.WriteString(numCell("K"+trs, 4, sumCost))
	s1.WriteString(`</row></sheetData>`)
	if len(orderItems) > 0 {
		s1.WriteString(fmt.Sprintf(`<autoFilter ref="A3:N%d"/>`, len(orderItems)+3))
	}
	s1.WriteString(`</worksheet>`)
	if err := addFile("xl/worksheets/sheet1.xml", s1.String()); err != nil {
		return nil, err
	}

	// Лист 2: Сводка по поставщикам
	var s2 strings.Builder
	s2.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>
  <col min="1" max="1" width="34" customWidth="1"/>
  <col min="2" max="5" width="18" customWidth="1"/>
  <col min="6" max="6" width="16" customWidth="1"/>
</cols><sheetData>`)
	s2.WriteString(`<row r="1" ht="26" customHeight="1">`)
	for i, h := range []string{"Поставщик", "Всего SKU", "SKU к закупке", "Единиц к закупке", "Сумма закупки (руб.)", "Доля бюджета (%)"} {
		s2.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	s2.WriteString(`</row>`)
	for i, sup := range report.Suppliers {
		r := strconv.Itoa(i + 2)
		s2.WriteString(`<row r="` + r + `" ht="20" customHeight="1">`)
		s2.WriteString(inlineStrCell("A"+r, 2, sup.Supplier))
		s2.WriteString(numCell("B"+r, 6, float64(sup.TotalItems)))
		s2.WriteString(numCell("C"+r, 6, float64(sup.OrderItems)))
		s2.WriteString(numCell("D"+r, 3, float64(sup.TotalOrderQty)))
		s2.WriteString(numCell("E"+r, 4, sup.TotalOrderCost))
		s2.WriteString(numCell("F"+r, 4, sup.ShareOfBudget))
		s2.WriteString(`</row>`)
	}
	s2.WriteString(`</sheetData></worksheet>`)
	if err := addFile("xl/worksheets/sheet2.xml", s2.String()); err != nil {
		return nil, err
	}

	// Лист 3: Сезонные индексы групп
	var s3 strings.Builder
	s3.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>
  <col min="1" max="1" width="28" customWidth="1"/>
  <col min="2" max="13" width="11" customWidth="1"/>
</cols><sheetData>`)
	mNames := []string{"Группа номенклатуры", "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"}
	s3.WriteString(`<row r="1" ht="26" customHeight="1">`)
	for i, h := range mNames {
		s3.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	s3.WriteString(`</row>`)
	for i, g := range report.Groups {
		r := strconv.Itoa(i + 2)
		s3.WriteString(`<row r="` + r + `" ht="20" customHeight="1">`)
		s3.WriteString(inlineStrCell("A"+r, 2, g.Group))
		for m := 0; m < 12; m++ {
			s3.WriteString(numCell(ColIndexToLetters(m+2)+r, 4, g.MonthlyIndices[m]))
		}
		s3.WriteString(`</row>`)
	}
	s3.WriteString(`</sheetData></worksheet>`)
	if err := addFile("xl/worksheets/sheet3.xml", s3.String()); err != nil {
		return nil, err
	}

	// Лист 4: Неликвиды и сверхнормативный остаток (> 365 дней)
	var s4 strings.Builder
	s4.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>
  <col min="1" max="1" width="9" customWidth="1"/>
  <col min="2" max="3" width="24" customWidth="1"/>
  <col min="4" max="4" width="44" customWidth="1"/>
  <col min="5" max="8" width="16" customWidth="1"/>
</cols><sheetData>`)
	s4.WriteString(`<row r="1" ht="26" customHeight="1">`)
	for i, h := range []string{"Стр. Excel", "Склад", "Поставщик", "Номенклатура", "Остаток", "Продажи 12м", "Запас (дней)", "Заморожено (руб.)"} {
		s4.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	s4.WriteString(`</row>`)
	ovRow := 2
	for _, it := range report.Items {
		if !it.IsOverstock {
			continue
		}
		if filterWarehouse != "" && it.Warehouse != filterWarehouse {
			continue
		}
		rs := strconv.Itoa(ovRow)
		ovRow++
		s4.WriteString(`<row r="` + rs + `" ht="20" customHeight="1">`)
		s4.WriteString(numCell("A"+rs, 6, float64(it.ExcelRow)))
		s4.WriteString(inlineStrCell("B"+rs, 2, it.Warehouse))
		s4.WriteString(inlineStrCell("C"+rs, 2, it.Supplier))
		s4.WriteString(inlineStrCell("D"+rs, 2, it.Name))
		s4.WriteString(numCell("E"+rs, 6, it.ClosingStock))
		s4.WriteString(numCell("F"+rs, 6, it.SumSalesLast12M))
		s4.WriteString(numCell("G"+rs, 4, it.DaysOfSupply))
		s4.WriteString(numCell("H"+rs, 4, it.OverstockValue))
		s4.WriteString(`</row>`)
	}
	s4.WriteString(`</sheetData></worksheet>`)
	if err := addFile("xl/worksheets/sheet4.xml", s4.String()); err != nil {
		return nil, err
	}

	// Лист 5: Сравнение сборки «Вариант 2» vs «Вариант 1»
	var s5 strings.Builder
	s5.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>
  <col min="1" max="1" width="9" customWidth="1"/>
  <col min="2" max="2" width="18" customWidth="1"/>
  <col min="3" max="3" width="44" customWidth="1"/>
  <col min="4" max="9" width="15" customWidth="1"/>
</cols><sheetData>`)
	s5.WriteString(`<row r="1" ht="26" customHeight="1">`)
	for i, h := range []string{"Стр. Excel", "Склад", "Номенклатура", "ABC-XYZ", "Опт-выбросы", "Вариант 1 (ед.)", "Вариант 2 (ед.)", "Разница (ед.)", "Эффект (руб.)"} {
		s5.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	s5.WriteString(`</row>`)
	diffRow := 2
	for _, it := range report.Items {
		if it.DeltaFromV1 == 0 {
			continue
		}
		rs := strconv.Itoa(diffRow)
		diffRow++
		s5.WriteString(`<row r="` + rs + `" ht="20" customHeight="1">`)
		s5.WriteString(numCell("A"+rs, 6, float64(it.ExcelRow)))
		s5.WriteString(inlineStrCell("B"+rs, 2, it.Warehouse))
		s5.WriteString(inlineStrCell("C"+rs, 2, it.Name))
		s5.WriteString(inlineStrCell("D"+rs, 2, it.ABCXYZ))
		s5.WriteString(numCell("E"+rs, 6, float64(it.OutlierMonths)))
		s5.WriteString(numCell("F"+rs, 6, float64(it.Variant1OrderQty)))
		s5.WriteString(numCell("G"+rs, 3, float64(it.FinalOrderQty)))
		s5.WriteString(numCell("H"+rs, 6, float64(it.DeltaFromV1)))
		s5.WriteString(numCell("I"+rs, 4, float64(it.DeltaFromV1)*it.PurchasePrice))
		s5.WriteString(`</row>`)
	}
	s5.WriteString(`</sheetData></worksheet>`)
	if err := addFile("xl/worksheets/sheet5.xml", s5.String()); err != nil {
		return nil, err
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func inlineStrCell(ref string, style int, text string) string {
	return fmt.Sprintf(`<c r="%s" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`,
		ref, style, html.EscapeString(text))
}

func numCell(ref string, style int, val float64) string {
	formatted := strconv.FormatFloat(val, 'f', -1, 64)
	return fmt.Sprintf(`<c r="%s" s="%d"><v>%s</v></c>`, ref, style, formatted)
}
