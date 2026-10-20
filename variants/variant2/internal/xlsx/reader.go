package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/variants/variant2/internal/model"
)

var (
	numberTokenRe = regexp.MustCompile(`-?\d+(?:[.,]\d+)?`)
	yearTokenRe   = regexp.MustCompile(`\b(20\d{2})\b`)
	mmYYYYRe      = regexp.MustCompile(`^(0?[1-9]|1[0-2])[./-](20\d{2})$`)
	yyyyMMRe      = regexp.MustCompile(`^(20\d{2})[./-](0?[1-9]|1[0-2])$`)
)

var russianMonths = []struct {
	prefix string
	month  int
}{
	{"январ", 1},
	{"феврал", 2},
	{"март", 3},
	{"апрел", 4},
	{"ма", 5}, // май / мая
	{"июн", 6},
	{"июл", 7},
	{"август", 8},
	{"сентябр", 9},
	{"октябр", 10},
	{"ноябр", 11},
	{"декабр", 12},
}

// ReadFile читает ведомость 1С из файла на диске и возвращает как структуру WorkbookData, так и сырые байты.
func ReadFile(filePath string) (*model.WorkbookData, []byte, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, nil, fmt.Errorf("чтение файла %s: %w", filePath, err)
	}
	wb, err := ParseBytes(raw, path.Base(strings.ReplaceAll(filePath, "\\", "/")))
	if err != nil {
		return nil, nil, err
	}
	wb.FilePath = filePath
	return wb, raw, nil
}

// ParseBytes разбирает .xlsx архив из памяти.
func ParseBytes(raw []byte, fileName string) (*model.WorkbookData, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("некорректный ZIP/XLSX архив: %w", err)
	}

	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		files[f.Name] = f
	}

	sheetName, sheetPath, err := resolveFirstSheet(files)
	if err != nil {
		return nil, err
	}

	sharedStrings, err := readSharedStrings(files["xl/sharedStrings.xml"])
	if err != nil {
		return nil, err
	}

	redStyleIDs := detectCriticalStyleIDs(files["xl/styles.xml"])
	createdDate, modifiedDate := readCoreDates(files["docProps/core.xml"])

	sheetFile, ok := files[sheetPath]
	if !ok {
		return nil, fmt.Errorf("лист %s не найден в архиве", sheetPath)
	}

	rows, err := parseWorksheetRows(sheetFile, sharedStrings)
	if err != nil {
		return nil, err
	}

	wb := &model.WorkbookData{
		FileName:     fileName,
		SheetName:    sheetName,
		CreatedDate:  createdDate,
		ModifiedDate: modifiedDate,
		HeaderRow:    7,
		OrderCol:     8,
	}

	// Поиск заголовка отчёта (напр. "Ведомость по остаткам ТМЦ на складах") и строки шапки таблицы
	headerRowNum := 0
	for _, r := range rows {
		if r.num <= 25 {
			for _, cell := range r.cells {
				val := strings.TrimSpace(cell.val)
				if wb.Title == "" && strings.Contains(strings.ToLower(val), "ведомость") {
					wb.Title = val
				}
				if strings.EqualFold(val, "Номенклатура") {
					headerRowNum = r.num
				}
			}
			if headerRowNum > 0 {
				break
			}
		}
	}
	if headerRowNum == 0 {
		return nil, fmt.Errorf("не найдена строка шапки с колонкой «Номенклатура»")
	}
	wb.HeaderRow = headerRowNum

	// Разбор столбцов шапки
	var headerCells map[int]parsedCell
	for _, r := range rows {
		if r.num == headerRowNum {
			headerCells = r.cells
			break
		}
	}

	colWarehouse := 1
	colGroup := 2
	colSKU := 3
	colName := 4
	colUnit := 5
	colExpense := 6
	colStock := 7
	colOrder := 8
	colPrice := 9
	colRetail := 10
	colSupplier := 11

	maxCol := 0
	for c := range headerCells {
		if c > maxCol {
			maxCol = c
		}
	}

	// Точная привязка колонок по тексту шапки + сохранение стандартной схемы 1..11 при совпадении
	for c := 1; c <= maxCol; c++ {
		h := strings.ToLower(strings.TrimSpace(headerCells[c].val))
		if year, month, ok := ParsePeriodHeader(headerCells[c].val); ok {
			wb.Periods = append(wb.Periods, model.PeriodColumn{
				ColIndex:     c,
				ColLetter:    ColIndexToLetters(c),
				Label:        strings.TrimSpace(headerCells[c].val),
				Year:         year,
				Month:        month,
				Completeness: 1.0,
			})
			continue
		}
		switch {
		case h == "склад":
			colWarehouse = c
		case strings.Contains(h, "группа"):
			colGroup = c
		case strings.Contains(h, "артикул"):
			colSKU = c
		case h == "номенклатура":
			colName = c
		case strings.HasPrefix(h, "ед"):
			colUnit = c
		case strings.Contains(h, "расход"):
			colExpense = c
		case strings.Contains(h, "остаток"):
			colStock = c
		case strings.Contains(h, "закуп"):
			colOrder = c
			wb.OrderHeader = strings.TrimSpace(headerCells[c].val)
		case strings.Contains(h, "цена") && strings.Contains(h, "поставщ"):
			colPrice = c
		case strings.Contains(h, "рознич") && strings.Contains(h, "цена"):
			colRetail = c
		case strings.Contains(h, "поставщик") && !strings.Contains(h, "цена"):
			colSupplier = c
		}
	}
	wb.OrderCol = colOrder
	if wb.OrderHeader == "" {
		wb.OrderHeader = strings.TrimSpace(headerCells[colOrder].val)
	}

	if len(wb.Periods) == 0 {
		return nil, fmt.Errorf("в строке %d не найдены столбцы помесячной статистики продаж", headerRowNum)
	}

	// Чтение товарных строк ниже шапки
	for _, r := range rows {
		if r.num <= headerRowNum {
			continue
		}
		name := strings.TrimSpace(r.cells[colName].val)
		warehouse := strings.TrimSpace(r.cells[colWarehouse].val)
		if name == "" && warehouse == "" {
			continue
		}
		// Пропуск возможных итоговых строк внизу отчёта
		lowerName := strings.ToLower(name)
		if lowerName == "итого" || lowerName == "всего" || strings.EqualFold(warehouse, "итого") {
			continue
		}

		sales := make([]float64, len(wb.Periods))
		for i, p := range wb.Periods {
			sales[i] = ParseFlexibleFloat(r.cells[p.ColIndex].val)
		}

		var existingOrder *float64
		if ordCell, ok := r.cells[colOrder]; ok && strings.TrimSpace(ordCell.val) != "" {
			v := ParseFlexibleFloat(ordCell.val)
			existingOrder = &v
		}

		stockCell := r.cells[colStock]
		retailRaw := strings.TrimSpace(r.cells[colRetail].val)

		wb.Items = append(wb.Items, model.RawItem{
			ExcelRow:      r.num,
			Warehouse:     warehouse,
			Group:         strings.TrimSpace(r.cells[colGroup].val),
			SKU:           strings.TrimSpace(r.cells[colSKU].val),
			Name:          name,
			Unit:          strings.TrimSpace(r.cells[colUnit].val),
			TotalExpense:  ParseFlexibleFloat(r.cells[colExpense].val),
			ClosingStock:  ParseFlexibleFloat(stockCell.val),
			ExistingOrder: existingOrder,
			PurchasePrice: ParseFlexibleFloat(r.cells[colPrice].val),
			RetailPrice:   ParseFlexibleFloat(retailRaw),
			RetailRaw:     retailRaw,
			Supplier:      strings.TrimSpace(r.cells[colSupplier].val),
			IsCritical1C:  redStyleIDs[stockCell.style],
			MonthlySales:  sales,
		})
	}

	return wb, nil
}

// ParseFlexibleFloat безопасно парсит числа из ячеек 1С, включая многострочные значения партий ("7.00\n9.72").
func ParseFlexibleFloat(raw string) float64 {
	s := strings.TrimSpace(strings.ReplaceAll(raw, "\u00a0", ""))
	if s == "" || s == "-" {
		return 0
	}
	// Быстрый путь для стандартных чисел без переносов строк
	if !strings.ContainsAny(s, " \n\r\t") {
		if v, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", "."), 64); err == nil {
			return v
		}
	}
	cleaned := strings.ReplaceAll(s, " ", "")
	matches := numberTokenRe.FindAllString(cleaned, -1)
	if len(matches) == 0 {
		return 0
	}
	// В 1С при нескольких партиях последняя строка содержит наиболее свежую цену партии
	last := strings.ReplaceAll(matches[len(matches)-1], ",", ".")
	v, err := strconv.ParseFloat(last, 64)
	if err != nil {
		return 0
	}
	return v
}

// ParsePeriodHeader распознаёт месяц (1..12) и год из заголовков вида "Октябрь 2023 г.", "01.2025", "2025-01".
func ParsePeriodHeader(raw string) (year int, month int, ok bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return 0, 0, false
	}
	if m := mmYYYYRe.FindStringSubmatch(s); len(m) == 3 {
		mo, _ := strconv.Atoi(m[1])
		yr, _ := strconv.Atoi(m[2])
		return yr, mo, true
	}
	if m := yyyyMMRe.FindStringSubmatch(s); len(m) == 3 {
		yr, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		return yr, mo, true
	}
	ym := yearTokenRe.FindStringSubmatch(s)
	if len(ym) < 2 {
		return 0, 0, false
	}
	yr, err := strconv.Atoi(ym[1])
	if err != nil {
		return 0, 0, false
	}
	for _, rm := range russianMonths {
		if strings.Contains(s, rm.prefix) {
			return yr, rm.month, true
		}
	}
	return 0, 0, false
}

// ColIndexToLetters преобразует 1-based номер колонки в буквенный адрес Excel (1->A, 8->H, 27->AA, 48->AV).
func ColIndexToLetters(col int) string {
	var out []byte
	for col > 0 {
		col--
		out = append([]byte{byte('A' + col%26)}, out...)
		col /= 26
	}
	return string(out)
}

// LettersToColIndex преобразует адрес ячейки или столбца ("H8" или "AV") в 1-based индекс столбца.
func LettersToColIndex(cellRef string) int {
	col := 0
	for i := 0; i < len(cellRef); i++ {
		ch := cellRef[i]
		if ch >= 'A' && ch <= 'Z' {
			col = col*26 + int(ch-'A'+1)
		} else if ch >= 'a' && ch <= 'z' {
			col = col*26 + int(ch-'a'+1)
		} else {
			break
		}
	}
	return col
}

type parsedCell struct {
	val   string
	style int
}

type parsedRow struct {
	num   int
	cells map[int]parsedCell
}

func parseWorksheetRows(zf *zip.File, shared []string) ([]parsedRow, error) {
	rc, err := zf.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	dec := xml.NewDecoder(rc)
	var rows []parsedRow
	var curRow *parsedRow
	var curCol int
	var curType string
	var curStyle int
	inValue := false
	inInlineT := false
	var valBuf strings.Builder

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("разбор XML листа: %w", err)
		}
		switch se := tok.(type) {
		case xml.StartElement:
			switch se.Name.Local {
			case "row":
				rNum := 0
				for _, a := range se.Attr {
					if a.Name.Local == "r" {
						rNum, _ = strconv.Atoi(a.Value)
					}
				}
				curRow = &parsedRow{num: rNum, cells: make(map[int]parsedCell, 48)}
			case "c":
				curCol = 0
				curType = ""
				curStyle = 0
				valBuf.Reset()
				for _, a := range se.Attr {
					switch a.Name.Local {
					case "r":
						curCol = LettersToColIndex(a.Value)
					case "t":
						curType = a.Value
					case "s":
						curStyle, _ = strconv.Atoi(a.Value)
					}
				}
			case "v":
				inValue = true
			case "t":
				if curCol > 0 {
					inInlineT = true
				}
			}
		case xml.CharData:
			if inValue || inInlineT {
				valBuf.Write(se)
			}
		case xml.EndElement:
			switch se.Name.Local {
			case "v":
				inValue = false
			case "t":
				inInlineT = false
			case "c":
				if curRow != nil && curCol > 0 {
					rawVal := valBuf.String()
					if curType == "s" {
						if idx, err := strconv.Atoi(strings.TrimSpace(rawVal)); err == nil && idx >= 0 && idx < len(shared) {
							rawVal = shared[idx]
						}
					}
					curRow.cells[curCol] = parsedCell{val: rawVal, style: curStyle}
					curCol = 0
				}
			case "row":
				if curRow != nil {
					rows = append(rows, *curRow)
					curRow = nil
				}
			}
		}
	}
	return rows, nil
}

func readSharedStrings(zf *zip.File) ([]string, error) {
	if zf == nil {
		return nil, nil
	}
	rc, err := zf.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	dec := xml.NewDecoder(rc)
	var result []string
	inSI := false
	inT := false
	var buf strings.Builder

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("разбор sharedStrings.xml: %w", err)
		}
		switch se := tok.(type) {
		case xml.StartElement:
			if se.Name.Local == "si" {
				inSI = true
				buf.Reset()
			} else if inSI && se.Name.Local == "t" {
				inT = true
			}
		case xml.CharData:
			if inSI && inT {
				buf.Write(se)
			}
		case xml.EndElement:
			if se.Name.Local == "t" {
				inT = false
			} else if se.Name.Local == "si" {
				inSI = false
				result = append(result, buf.String())
			}
		}
	}
	return result, nil
}

func resolveFirstSheet(files map[string]*zip.File) (sheetName string, sheetPath string, err error) {
	sheetName = "Лист_1"
	sheetPath = "xl/worksheets/sheet1.xml"

	wbFile, ok := files["xl/workbook.xml"]
	if !ok {
		return sheetName, sheetPath, nil
	}
	rc, err := wbFile.Open()
	if err != nil {
		return sheetName, sheetPath, nil
	}
	defer rc.Close()

	type sheetNode struct {
		Name string `xml:"name,attr"`
		RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
	}
	type wbXML struct {
		Sheets []sheetNode `xml:"sheets>sheet"`
	}
	var parsed wbXML
	if err := xml.NewDecoder(rc).Decode(&parsed); err != nil || len(parsed.Sheets) == 0 {
		return sheetName, sheetPath, nil
	}
	sheetName = parsed.Sheets[0].Name
	rid := parsed.Sheets[0].RID

	if relsFile, ok := files["xl/_rels/workbook.xml.rels"]; ok && rid != "" {
		rrc, err := relsFile.Open()
		if err == nil {
			defer rrc.Close()
			type relNode struct {
				ID     string `xml:"Id,attr"`
				Target string `xml:"Target,attr"`
			}
			type relsXML struct {
				Rels []relNode `xml:"Relationship"`
			}
			var rParsed relsXML
			if xml.NewDecoder(rrc).Decode(&rParsed) == nil {
				for _, rel := range rParsed.Rels {
					if rel.ID == rid {
						target := strings.TrimPrefix(rel.Target, "/")
						if !strings.HasPrefix(target, "xl/") {
							target = "xl/" + target
						}
						sheetPath = path.Clean(target)
						break
					}
				}
			}
		}
	}
	return sheetName, sheetPath, nil
}

func readCoreDates(zf *zip.File) (created string, modified string) {
	if zf == nil {
		return "", ""
	}
	rc, err := zf.Open()
	if err != nil {
		return "", ""
	}
	defer rc.Close()

	dec := xml.NewDecoder(rc)
	cur := ""
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch se := tok.(type) {
		case xml.StartElement:
			cur = se.Name.Local
		case xml.CharData:
			val := strings.TrimSpace(string(se))
			if len(val) >= 10 {
				if cur == "created" && created == "" {
					created = val[:10]
				} else if cur == "modified" && modified == "" {
					modified = val[:10]
				}
			}
		case xml.EndElement:
			cur = ""
		}
	}
	return created, modified
}

// detectCriticalStyleIDs находит индексы cellXfs с красной заливкой (напр. 1С подсветка минимального остатка).
func detectCriticalStyleIDs(zf *zip.File) map[int]bool {
	res := make(map[int]bool)
	if zf == nil {
		return res
	}
	rc, err := zf.Open()
	if err != nil {
		return res
	}
	defer rc.Close()

	type colorNode struct {
		Indexed *int   `xml:"indexed,attr"`
		RGB     string `xml:"rgb,attr"`
	}
	type patternFill struct {
		PatternType string    `xml:"patternType,attr"`
		FgColor     colorNode `xml:"fgColor"`
	}
	type fillNode struct {
		Pattern patternFill `xml:"patternFill"`
	}
	type xfNode struct {
		FillID int `xml:"fillId,attr"`
	}
	type stylesDoc struct {
		Fills []fillNode `xml:"fills>fill"`
		Xfs   []xfNode   `xml:"cellXfs>xf"`
	}
	var doc stylesDoc
	if xml.NewDecoder(rc).Decode(&doc) != nil {
		return res
	}
	redFills := make(map[int]bool)
	for i, f := range doc.Fills {
		rgb := strings.ToUpper(f.Pattern.FgColor.RGB)
		if rgb == "FFFF0000" || rgb == "00FF0000" || (f.Pattern.FgColor.Indexed != nil && (*f.Pattern.FgColor.Indexed == 2 || *f.Pattern.FgColor.Indexed == 10)) {
			redFills[i] = true
		}
	}
	for i, xf := range doc.Xfs {
		if redFills[xf.FillID] {
			res[i] = true
		}
	}
	return res
}
