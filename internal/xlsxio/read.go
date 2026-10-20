// Package xlsxio читает ведомость 1С (.xlsx) и пишет результат с заполненным
// столбцом «К закупке». Только стандартная библиотека: archive/zip + encoding/xml.
//
// Особенности входного файла (подтверждены анализом, см. docs/ANALYSIS.md):
//   - заголовки НЕ в первой строке (в исходном файле — строка 7);
//   - числа часто хранятся строками ("8.00"), пустая цена — " ";
//   - в розничной цене бывает два числа через перевод строки — берём последнее;
//   - столбец H (8-й) без заголовка — это и есть «К закупке».
package xlsxio

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"ostatki/internal/forecast"
	"ostatki/internal/model"
)

// Parsed — результат чтения файла.
type Parsed struct {
	Items       []model.Item
	Months      []model.Month
	SheetName   string
	PurchaseCol int // 1-based номер столбца «К закупке» в исходном файле (0 — не найден)
}

type rel struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
}

type relsDoc struct {
	Rels []rel `xml:"Relationship"`
}

type workbookDoc struct {
	Sheets []struct {
		Name string `xml:"name,attr"`
		RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
	} `xml:"sheets>sheet"`
}

type sharedStringsDoc struct {
	Items []struct {
		Text string `xml:"t"`
		Runs []struct {
			Text string `xml:"t"`
		} `xml:"r"`
	} `xml:"si"`
}

type cellDoc struct {
	Ref   string `xml:"r,attr"`
	Type  string `xml:"t,attr"`
	Value string `xml:"v"`
	Is    *struct {
		Text string `xml:"t"`
		Runs []struct {
			Text string `xml:"t"`
		} `xml:"r"`
	} `xml:"is"`
}

type sheetDoc struct {
	Rows []struct {
		Cells []cellDoc `xml:"c"`
	} `xml:"sheetData>row"`
}

func readZipFile(zr *zip.Reader, name string) ([]byte, error) {
	for _, f := range zr.File {
		if strings.TrimPrefix(f.Name, "/") == name {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(io.LimitReader(rc, 64<<20))
		}
	}
	return nil, fmt.Errorf("в xlsx нет части %s", name)
}

// Parse читает xlsx из памяти.
func Parse(data []byte) (*Parsed, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("файл не является xlsx (zip): %w", err)
	}
	// Первый лист через workbook.xml + rels, с откатом на стандартный путь.
	sheetPath := "xl/worksheets/sheet1.xml"
	sheetName := ""
	if wbData, err := readZipFile(zr, "xl/workbook.xml"); err == nil {
		var wb workbookDoc
		if xml.Unmarshal(wbData, &wb) == nil && len(wb.Sheets) > 0 {
			sheetName = wb.Sheets[0].Name
			if relsData, err := readZipFile(zr, "xl/_rels/workbook.xml.rels"); err == nil {
				var rd relsDoc
				if xml.Unmarshal(relsData, &rd) == nil {
					for _, r := range rd.Rels {
						if r.ID == wb.Sheets[0].RID {
							t := strings.TrimPrefix(r.Target, "/")
							if !strings.HasPrefix(t, "xl/") {
								t = "xl/" + t
							}
							sheetPath = t
						}
					}
				}
			}
		}
	}
	var shared []string
	if ssData, err := readZipFile(zr, "xl/sharedStrings.xml"); err == nil {
		var ss sharedStringsDoc
		if xml.Unmarshal(ssData, &ss) == nil {
			for _, si := range ss.Items {
				if si.Text != "" || len(si.Runs) == 0 {
					shared = append(shared, si.Text)
				} else {
					var b strings.Builder
					for _, run := range si.Runs {
						b.WriteString(run.Text)
					}
					shared = append(shared, b.String())
				}
			}
		}
	}
	sheetData, err := readZipFile(zr, sheetPath)
	if err != nil {
		return nil, err
	}
	var sd sheetDoc
	if err := xml.Unmarshal(sheetData, &sd); err != nil {
		return nil, fmt.Errorf("не удалось разобрать лист: %w", err)
	}
	// Сетка строк: номер строки (1-based) -> столбец (1-based) -> текст.
	grid := map[int]map[int]string{}
	maxCol := 0
	for ri, row := range sd.Rows {
		rowNum := ri + 1
		for _, c := range row.Cells {
			col, r := parseCellRef(c.Ref)
			if r > 0 {
				rowNum = r
			}
			if col == 0 {
				continue
			}
			if col > maxCol {
				maxCol = col
			}
			text := cellText(c, shared)
			if grid[rowNum] == nil {
				grid[rowNum] = map[int]string{}
			}
			grid[rowNum][col] = text
		}
	}
	return buildItems(grid, maxCol, sheetName)
}

func cellText(c cellDoc, shared []string) string {
	switch c.Type {
	case "s":
		n, err := strconv.Atoi(strings.TrimSpace(c.Value))
		if err == nil && n >= 0 && n < len(shared) {
			return shared[n]
		}
		return ""
	case "inlineStr":
		if c.Is == nil {
			return ""
		}
		if c.Is.Text != "" || len(c.Is.Runs) == 0 {
			return c.Is.Text
		}
		var b strings.Builder
		for _, run := range c.Is.Runs {
			b.WriteString(run.Text)
		}
		return b.String()
	default: // числа, "str", "b" — кэшированное значение
		return c.Value
	}
}

func parseCellRef(ref string) (col int, row int) {
	i := 0
	for i < len(ref) && ref[i] >= 'A' && ref[i] <= 'Z' {
		col = col*26 + int(ref[i]-'A'+1)
		i++
	}
	if i < len(ref) {
		row, _ = strconv.Atoi(ref[i:])
	}
	return col, row
}

var monthStem = []struct {
	stem string
	num  int
}{
	{"январ", 1}, {"феврал", 2}, {"март", 3}, {"апрел", 4}, {"май", 5}, {"мая", 5},
	{"июн", 6}, {"июл", 7}, {"август", 8}, {"сентябр", 9}, {"октябр", 10},
	{"ноябр", 11}, {"декабр", 12},
}

var yearRe = regexp.MustCompile(`20\d\d`)
var numRe = regexp.MustCompile(`-?\d+(?:[.,]\d+)?`)

// ParseMonthHeader разбирает "Октябрь 2023 г." -> (2023, 10, true).
func ParseMonthHeader(text string) (year int, month int, ok bool) {
	s := strings.ToLower(text)
	y := yearRe.FindString(s)
	if y == "" {
		return 0, 0, false
	}
	for _, m := range monthStem {
		if strings.Contains(s, m.stem) {
			year, _ = strconv.Atoi(y)
			return year, m.num, true
		}
	}
	return 0, 0, false
}

// ParseNum достаёт число из ячейки 1С. Если чисел несколько — берёт ПОСЛЕДНЕЕ
// (в файле встречаются старая и новая розничная цена в одной ячейке).
func ParseNum(text string) *float64 {
	found := numRe.FindAllString(strings.ReplaceAll(text, "\u00a0", " "), -1)
	if len(found) == 0 {
		return nil
	}
	v, err := strconv.ParseFloat(strings.ReplaceAll(found[len(found)-1], ",", "."), 64)
	if err != nil {
		return nil
	}
	return &v
}

func buildItems(grid map[int]map[int]string, maxCol int, sheetName string) (*Parsed, error) {
	get := func(row, col int) string {
		if grid[row] == nil {
			return ""
		}
		return grid[row][col]
	}
	headerRow := 0
	colIdx := map[string]int{}
	var months []model.Month
	var monthCols []int
	for r := 1; r <= 20; r++ {
		hasName, hasWarehouse := false, false
		for c := 1; c <= maxCol; c++ {
			t := strings.ToLower(strings.TrimSpace(get(r, c)))
			if t == "номенклатура" {
				hasName = true
			}
			if t == "склад" {
				hasWarehouse = true
			}
		}
		if !(hasName && hasWarehouse) {
			continue
		}
		headerRow = r
		for c := 1; c <= maxCol; c++ {
			raw := get(r, c)
			t := strings.ToLower(strings.TrimSpace(raw))
			if y, m, ok := ParseMonthHeader(raw); ok {
				months = append(months, model.Month{Year: y, Month: m, Label: forecast.MonthLabel(y, m)})
				monthCols = append(monthCols, c)
				continue
			}
			switch {
			case t == "склад":
				colIdx["warehouse"] = c
			case strings.Contains(t, "группа"):
				colIdx["group"] = c
			case t == "артикул":
				colIdx["article"] = c
			case t == "номенклатура":
				colIdx["name"] = c
			case strings.HasPrefix(t, "ед"):
				colIdx["unit"] = c
			case t == "расход":
				colIdx["rashod"] = c
			case strings.Contains(t, "остаток"):
				colIdx["stock"] = c
			case strings.Contains(t, "цена") && strings.Contains(t, "постав"):
				colIdx["purchasePrice"] = c
			case strings.Contains(t, "рознич"):
				colIdx["retailPrice"] = c
			case strings.Contains(t, "поставщик"):
				colIdx["supplier"] = c
			}
		}
		break
	}
	if headerRow == 0 {
		return nil, errors.New("не найдена строка заголовков (нужны «Склад» и «Номенклатура»)")
	}
	if len(months) == 0 {
		return nil, errors.New("не найдены помесячные столбцы продаж (например, «Октябрь 2023 г.») ")
	}
	purchaseCol := 0
	if s, ok1 := colIdx["stock"]; ok1 {
		if pp, ok2 := colIdx["purchasePrice"]; ok2 && pp == s+2 {
			purchaseCol = s + 1
		}
	}
	nameCol := colIdx["name"]
	var items []model.Item
	maxRow := 0
	for r := range grid {
		if r > maxRow {
			maxRow = r
		}
	}
	for r := headerRow + 1; r <= maxRow; r++ {
		name := strings.TrimSpace(get(r, nameCol))
		if name == "" {
			continue
		}
		it := model.Item{Name: name}
		if c, ok := colIdx["warehouse"]; ok {
			it.Warehouse = strings.TrimSpace(get(r, c))
		}
		if c, ok := colIdx["group"]; ok {
			it.Group = strings.TrimSpace(get(r, c))
		}
		if c, ok := colIdx["article"]; ok {
			it.Article = strings.TrimSpace(get(r, c))
		}
		if c, ok := colIdx["unit"]; ok {
			it.Unit = strings.TrimSpace(get(r, c))
		}
		if c, ok := colIdx["supplier"]; ok {
			it.Supplier = strings.TrimSpace(get(r, c))
		}
		if c, ok := colIdx["rashod"]; ok {
			it.Rashod = ParseNum(get(r, c))
		}
		if c, ok := colIdx["stock"]; ok {
			if v := ParseNum(get(r, c)); v != nil {
				it.Stock = *v
			}
		}
		if c, ok := colIdx["purchasePrice"]; ok {
			it.PurchasePrice = ParseNum(get(r, c))
		}
		if c, ok := colIdx["retailPrice"]; ok {
			it.RetailPrice = ParseNum(get(r, c))
		}
		it.Sales = make([]float64, len(monthCols))
		for i, c := range monthCols {
			if v := ParseNum(get(r, c)); v != nil {
				it.Sales[i] = *v
			}
		}
		items = append(items, it)
	}
	if len(items) == 0 {
		return nil, errors.New("под заголовками нет строк с номенклатурой")
	}
	return &Parsed{Items: items, Months: months, SheetName: sheetName, PurchaseCol: purchaseCol}, nil
}
