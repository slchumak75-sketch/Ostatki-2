package xlsxio

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"ostatki/internal/model"
)

// Стили (индексы в cellXfs сгенерированного styles.xml):
const (
	styleDefault = 0
	styleHeader  = 1 // жирный белый на синем
	styleFloat2  = 2 // 0.00
	styleInt     = 3 // 0
	styleHeaderG = 4 // жирный белый на зелёном
	styleBold    = 5
)

type cell struct {
	text  string
	num   float64
	isNum bool
	style int
}

func sCell(text string, style int) cell { return cell{text: text, style: style} }
func nCell(v float64, style int) cell   { return cell{num: v, isNum: true, style: style} }

type sheet struct {
	name   string
	widths []float64
	rows   [][]cell
	freeze int // число закреплённых сверху строк
	filter bool
}

func colLetters(n int) string {
	s := ""
	for n > 0 {
		n--
		s = string(rune('A'+n%26)) + s
		n /= 26
	}
	return s
}

func escAttr(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func numStr(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func (sh sheet) xml() string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	b.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	if sh.freeze > 0 {
		fmt.Fprintf(&b, `<sheetViews><sheetView workbookViewId="0"><pane ySplit="%d" topLeftCell="A%d" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A%d" sqref="A%d"/></sheetView></sheetViews>`,
			sh.freeze, sh.freeze+1, sh.freeze+1, sh.freeze+1)
	}
	if len(sh.widths) > 0 {
		b.WriteString(`<cols>`)
		for i, w := range sh.widths {
			fmt.Fprintf(&b, `<col min="%d" max="%d" width="%s" customWidth="1"/>`, i+1, i+1, numStr(w))
		}
		b.WriteString(`</cols>`)
	}
	b.WriteString(`<sheetData>`)
	for ri, row := range sh.rows {
		fmt.Fprintf(&b, `<row r="%d">`, ri+1)
		for ci, c := range row {
			ref := colLetters(ci+1) + strconv.Itoa(ri+1)
			if c.isNum {
				fmt.Fprintf(&b, `<c r="%s" s="%d"><v>%s</v></c>`, ref, c.style, numStr(c.num))
			} else if c.text != "" {
				fmt.Fprintf(&b, `<c r="%s" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, c.style, escAttr(c.text))
			}
		}
		b.WriteString(`</row>`)
	}
	b.WriteString(`</sheetData>`)
	if sh.filter && len(sh.rows) > 0 {
		lastCol := 1
		for _, row := range sh.rows {
			if len(row) > lastCol {
				lastCol = len(row)
			}
		}
		fmt.Fprintf(&b, `<autoFilter ref="A1:%s%d"/>`, colLetters(lastCol), len(sh.rows))
	}
	b.WriteString(`</worksheet>`)
	return b.String()
}

const stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F5496"/><bgColor rgb="FF2F5496"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF548235"/><bgColor rgb="FF548235"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="1" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

func writeWorkbook(sheets []sheet) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name, content string) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write([]byte(content))
		return err
	}
	var ct strings.Builder
	ct.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	ct.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`)
	for i := range sheets {
		fmt.Fprintf(&ct, `<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, i+1)
	}
	ct.WriteString(`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`)

	var wb, wbRels strings.Builder
	wb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	wb.WriteString(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	wbRels.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	wbRels.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for i, sh := range sheets {
		fmt.Fprintf(&wb, `<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, escAttr(sh.name), i+1, i+1)
		fmt.Fprintf(&wbRels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, i+1, i+1)
	}
	wb.WriteString(`</sheets></workbook>`)
	fmt.Fprintf(&wbRels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`, len(sheets)+1)

	rels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n" +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

	if err := write("[Content_Types].xml", ct.String()); err != nil {
		return nil, err
	}
	if err := write("_rels/.rels", rels); err != nil {
		return nil, err
	}
	if err := write("xl/workbook.xml", wb.String()); err != nil {
		return nil, err
	}
	if err := write("xl/_rels/workbook.xml.rels", wbRels.String()); err != nil {
		return nil, err
	}
	if err := write("xl/styles.xml", stylesXML); err != nil {
		return nil, err
	}
	for i, sh := range sheets {
		if err := write(fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1), sh.xml()); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func numOrEmpty(v *float64, style int) cell {
	if v == nil {
		return sCell("", styleDefault)
	}
	return nCell(*v, style)
}

func qtyCell(v float64) cell {
	if v == float64(int64(v)) {
		return nCell(v, styleInt)
	}
	return nCell(v, styleFloat2)
}

// Write формирует итоговую книгу: ведомость с заполненным столбцом H «К закупке»
// (8-й столбец, как в исходном файле) + листы закупки, сезонности и методики.
// Оформление исходного файла в v1 не сохраняется (данные — полностью), см. docs.
func Write(st *model.State) ([]byte, error) {
	// --- Лист 1: ведомость ---
	hdr := []cell{
		sCell("Склад", styleHeader), sCell("Группа номенклатуры", styleHeader),
		sCell("Артикул", styleHeader), sCell("Номенклатура", styleHeader),
		sCell("Ед.", styleHeader), sCell("Расход", styleHeader),
		sCell("Конечный остаток", styleHeader), sCell("К закупке (рекомендация)", styleHeader),
		sCell("Цена последнего поставщика", styleHeader), sCell("Розничная цена", styleHeader),
		sCell("Последний поставщик", styleHeader),
	}
	for _, m := range st.Months {
		hdr = append(hdr, sCell(m.Label+" г.", styleHeader))
	}
	rows1 := [][]cell{hdr}
	for _, r := range st.Rows {
		row := []cell{
			sCell(r.Warehouse, styleDefault), sCell(r.Group, styleDefault),
			sCell(r.Article, styleDefault), sCell(r.Name, styleDefault),
			sCell(r.Unit, styleDefault), numOrEmpty(r.Rashod, styleFloat2),
			qtyCell(r.Stock),
		}
		rec := qtyCell(r.Recommend)
		if r.Recommend > 0 {
			rec.style = styleBold
		}
		row = append(row, rec,
			numOrEmpty(r.PurchasePrice, styleFloat2),
			numOrEmpty(r.RetailPrice, styleFloat2),
			sCell(r.Supplier, styleDefault))
		for _, v := range r.Sales {
			row = append(row, qtyCell(v))
		}
		rows1 = append(rows1, row)
	}
	widths1 := []float64{16, 22, 12, 52, 7, 10, 11, 13, 13, 12, 28}
	for range st.Months {
		widths1 = append(widths1, 9)
	}
	sh1 := sheet{name: "Ведомость", widths: widths1, rows: rows1, freeze: 1, filter: true}

	// --- Лист 2: закупка по поставщикам ---
	hdr2 := []cell{
		sCell("Поставщик", styleHeaderG), sCell("Артикул", styleHeaderG),
		sCell("Номенклатура", styleHeaderG), sCell("Ед.", styleHeaderG),
		sCell("Остаток", styleHeaderG), sCell("Прогноз на период", styleHeaderG),
		sCell("К закупке", styleHeaderG), sCell("Цена поставщика", styleHeaderG),
		sCell("Сумма заказа", styleHeaderG), sCell("Склад", styleHeaderG),
	}
	rows2 := [][]cell{hdr2}
	var order []*model.Row
	for i := range st.Rows {
		if st.Rows[i].Recommend > 0 {
			order = append(order, &st.Rows[i])
		}
	}
	sort.Slice(order, func(i, j int) bool {
		if order[i].Supplier != order[j].Supplier {
			return order[i].Supplier < order[j].Supplier
		}
		return order[i].OrderCost > order[j].OrderCost
	})
	for _, r := range order {
		rows2 = append(rows2, []cell{
			sCell(r.Supplier, styleDefault), sCell(r.Article, styleDefault),
			sCell(r.Name, styleDefault), sCell(r.Unit, styleDefault),
			qtyCell(r.Stock), nCell(r.ForecastTotal, styleFloat2),
			qtyCell(r.Recommend), numOrEmpty(r.PurchasePrice, styleFloat2),
			nCell(r.OrderCost, styleFloat2), sCell(r.Warehouse, styleDefault),
		})
	}
	rows2 = append(rows2, []cell{})
	rows2 = append(rows2, []cell{
		sCell("ИТОГО", styleBold), sCell("", styleDefault),
		sCell(fmt.Sprintf("%d SKU", st.Summary.OrderSKU), styleBold),
		sCell("", styleDefault), sCell("", styleDefault), sCell("", styleDefault),
		nCell(st.Summary.OrderUnits, styleBold), sCell("", styleDefault),
		nCell(st.Summary.OrderBudget, styleFloat2),
	})
	sh2 := sheet{name: "Закупка по поставщикам",
		widths: []float64{28, 12, 52, 6, 9, 13, 11, 13, 13, 16},
		rows:   rows2, freeze: 1, filter: true}

	// --- Лист 3: сезонность ---
	groupNames := make([]string, 0, len(st.SeasonalByGroup))
	for g := range st.SeasonalByGroup {
		groupNames = append(groupNames, g)
	}
	sort.Strings(groupNames)
	hdr3 := []cell{sCell("Месяц", styleHeader), sCell("Все товары", styleHeader)}
	for _, g := range groupNames {
		hdr3 = append(hdr3, sCell(g, styleHeader))
	}
	rows3 := [][]cell{hdr3}
	monthNames := [12]string{"Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
		"Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"}
	for c := 0; c < 12; c++ {
		row := []cell{sCell(monthNames[c], styleDefault)}
		g := 1.0
		if c < len(st.SeasonalGlobal) {
			g = st.SeasonalGlobal[c]
		}
		row = append(row, nCell(g, styleFloat2))
		for _, name := range groupNames {
			v := 1.0
			if s := st.SeasonalByGroup[name]; c < len(s) {
				v = s[c]
			}
			row = append(row, nCell(v, styleFloat2))
		}
		rows3 = append(rows3, row)
	}
	sh3 := sheet{name: "Сезонность", widths: []float64{14, 14, 22, 22}, rows: rows3}

	// --- Лист 4: методика ---
	var fcLabels []string
	for _, fm := range st.ForecastMonths {
		fcLabels = append(fcLabels, fm.Label)
	}
	kv := func(k string, v cell) []cell { return []cell{sCell(k, styleDefault), v} }
	rows4 := [][]cell{
		{sCell("Параметры и методика расчёта столбца «К закупке»", styleBold)},
		{},
		kv("Исходный файл", sCell(st.FileName, styleDefault)),
		kv("Версия приложения", sCell(st.Version, styleDefault)),
		kv("Период прогноза", sCell(strings.Join(fcLabels, ", "), styleDefault)),
		kv("Горизонт (полных месяцев)", nCell(float64(st.Params.Horizon), styleInt)),
		kv("Страховой запас, %", nCell(st.Params.SafetyPercent, styleFloat2)),
		kv("Срок поставки, дней", nCell(st.Params.LeadDays, styleFloat2)),
		kv("Нет продаж N мес. -> не закупать", nCell(float64(st.Params.DeadMonths), styleInt)),
		kv("Последний месяц неполный", sCell(fmt.Sprintf("%v", st.Params.PartialLast), styleDefault)),
		{},
		{sCell("К закупке = max(0, ПрогнозСпроса + СпросЗаСрокПоставки + СтраховойЗапас − Остаток), округление вверх.", styleDefault)},
		{sCell("Прогноз месяца = БазовыйУровень × ИндексСезонности(месяц). БазовыйУровень — среднее десезонализированное потребление за последние 12 полных месяцев (+ затухающий тренд).", styleDefault)},
		{sCell("Индекс сезонности товара сглаживается к индексу его группы: чем короче история товара, тем больше вес группы. Полная методика: docs/ALGORITHM.md.", styleDefault)},
		{},
		kv("ИТОГО к закупке: SKU", nCell(float64(st.Summary.OrderSKU), styleInt)),
		kv("ИТОГО к закупке: единиц", nCell(st.Summary.OrderUnits, styleFloat2)),
		kv("ИТОГО бюджет закупки", nCell(st.Summary.OrderBudget, styleFloat2)),
		{},
		{sCell("Предупреждения о данных:", styleBold)},
	}
	for _, w := range st.Warnings {
		rows4 = append(rows4, []cell{sCell("– "+w, styleDefault)})
	}
	sh4 := sheet{name: "Методика", widths: []float64{42, 90}, rows: rows4}

	return writeWorkbook([]sheet{sh1, sh2, sh3, sh4})
}
