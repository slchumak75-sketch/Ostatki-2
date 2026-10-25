package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

var NomenclatureHeaders = []string{"Склад", "Артикул", "Номенклатура", "+", "Рейтинг", "Остаток"}

func RecordFromKey(key string) (model.NomenclatureRecord, error) {
	var p []string
	var r model.NomenclatureRecord
	if json.Unmarshal([]byte(key), &p) != nil {
		return r, fmt.Errorf("неверный ключ номенклатуры")
	}
	switch {
	case len(p) >= 2 && p[0] == "sku" && len(p) <= 3:
		r.SKU = p[1]
		if len(p) == 3 {
			r.Warehouse = p[2]
		}
	case len(p) >= 3 && p[0] == "name" && len(p) <= 4:
		r.Group = p[1]
		r.Name = p[2]
		if len(p) == 4 {
			r.Warehouse = p[3]
		}
	default:
		return r, fmt.Errorf("неверный ключ номенклатуры")
	}
	return r, nil
}

func ValidateNomenclature(r model.NomenclatureRecord) error {
	if strings.TrimSpace(r.SKU) == "" && strings.TrimSpace(r.Name) == "" {
		return fmt.Errorf("нет артикула или наименования")
	}
	if r.Rating < 0 || r.Rating > 5 {
		return fmt.Errorf("рейтинг должен быть целым числом от 0 до 5")
	}
	if math.IsNaN(r.Stock) || math.IsInf(r.Stock, 0) {
		return fmt.Errorf("неверный остаток")
	}
	if r.ReferenceRows != "" {
		var rows []model.NomenclatureRecord
		if err := json.Unmarshal([]byte(r.ReferenceRows), &rows); err != nil || len(rows) < 2 {
			return fmt.Errorf("неверные строки эталона")
		}
		key := NomenclaturePropertyKey(r.SKU, r.Group, r.Name, r.Warehouse)
		for _, row := range rows {
			if row.ReferenceRows != "" {
				return fmt.Errorf("вложенные строки эталона недопустимы")
			}
			if err := ValidateNomenclature(row); err != nil {
				return err
			}
			if NomenclaturePropertyKey(row.SKU, row.Group, row.Name, row.Warehouse) != key {
				return fmt.Errorf("строка эталона относится к другому товару")
			}
		}
	}
	return nil
}

// DecodeNomenclatureCatalog accepts both the new six-field format and old JSON marks.
func DecodeNomenclatureCatalog(raw []byte) (model.NomenclatureCatalog, error) {
	var c model.NomenclatureCatalog
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return c, fmt.Errorf("неверный JSON номенклатуры")
	}
	if _, ok := probe["version"]; ok {
		if err := json.Unmarshal(raw, &c); err != nil {
			return c, fmt.Errorf("неверный каталог: %w", err)
		}
		if c.Version != 2 || c.Properties == nil || c.Nomenclature == nil {
			return c, fmt.Errorf("неподдерживаемый формат каталога")
		}
	} else {
		if err := json.Unmarshal(raw, &c.Properties); err != nil {
			return c, fmt.Errorf("неверные свойства: %w", err)
		}
		c.Version = 2
		c.Nomenclature = map[string]model.NomenclatureRecord{}
	}
	for k, r := range c.Nomenclature {
		if err := ValidateNomenclature(r); err != nil {
			return c, err
		}
		if !recordKeyMatches(k, r) {
			return c, fmt.Errorf("ключ не соответствует номенклатуре")
		}
		if checked, ok := c.Properties[k]; ok {
			r.Checked = checked
		} else {
			c.Properties[k] = r.Checked
		}
		c.Nomenclature[k] = r
	}
	return c, nil
}

func GeneratePropertiesXLSX(properties map[string]bool, items []model.CalculatedItem) ([]byte, error) {
	records := map[string]model.NomenclatureRecord{}
	for key, checked := range properties {
		r, err := RecordFromKey(key)
		if err != nil {
			return nil, err
		}
		r.Checked = checked
		records[key] = r
	}
	for _, it := range items {
		key := NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		records[key] = model.NomenclatureRecord{Warehouse: it.Warehouse, SKU: it.SKU, Group: it.Group, Name: it.Name, Checked: properties[key], Rating: it.SalesSegment, Stock: it.ClosingStock}
	}
	return GenerateNomenclatureXLSX(records)
}

func GenerateNomenclatureXLSX(records map[string]model.NomenclatureRecord) ([]byte, error) {
	keys := make([]string, 0, len(records))
	for k := range records {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	const start = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
	var sheet, meta strings.Builder
	sheet.WriteString(start + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="2" width="24" customWidth="1"/><col min="3" max="3" width="55" customWidth="1"/><col min="4" max="6" width="12" customWidth="1"/></cols><sheetData><row r="1">`)
	for i, h := range NomenclatureHeaders {
		sheet.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	sheet.WriteString(`</row>`)
	meta.WriteString(start + `<sheetData>`)
	for i, key := range keys {
		r := records[key]
		if err := ValidateNomenclature(r); err != nil {
			return nil, err
		}
		row := strconv.Itoa(i + 2)
		sheet.WriteString(`<row r="` + row + `">`)
		mark := "0"
		if r.Checked {
			mark = "1"
		}
		for j, v := range []string{r.Warehouse, r.SKU, r.Name, mark} {
			sheet.WriteString(inlineStrCell(ColIndexToLetters(j+1)+row, 2, v))
		}
		sheet.WriteString(`<c r="E` + row + `" s="2"><v>` + strconv.Itoa(r.Rating) + `</v></c><c r="F` + row + `" s="2"><v>` + strconv.FormatFloat(r.Stock, 'f', -1, 64) + `</v></c></row>`)
		// A hidden standard worksheet preserves legacy no-article group identities.
		raw, _ := json.Marshal(r)
		meta.WriteString(`<row r="` + row + `">` + inlineStrCell("A"+row, 2, key) + inlineStrCell("B"+row, 2, string(raw)) + `</row>`)
	}
	sheet.WriteString(`</sheetData><autoFilter ref="A1:F` + strconv.Itoa(len(keys)+1) + `"/></worksheet>`)
	meta.WriteString(`</sheetData></worksheet>`)
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
		data := string(raw)
		switch f.Name {
		case "xl/worksheets/sheet1.xml":
			data = sheet.String()
		case "xl/workbook.xml":
			data = strings.ReplaceAll(data, `name="Старьё"`, `name="Номенклатура"`)
			data = strings.Replace(data, `</sheets>`, `<sheet name="Служебные ключи" sheetId="2" state="hidden" r:id="rIdNomenclature"/></sheets>`, 1)
		case "xl/_rels/workbook.xml.rels":
			data = strings.Replace(data, `</Relationships>`, `<Relationship Id="rIdNomenclature" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/nomenclature-keys.xml"/></Relationships>`, 1)
		case "[Content_Types].xml":
			data = strings.Replace(data, `</Types>`, `<Override PartName="/xl/worksheets/nomenclature-keys.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`, 1)
		}
		w, err := zw.Create(f.Name)
		if err != nil {
			return nil, err
		}
		if _, err = w.Write([]byte(data)); err != nil {
			return nil, err
		}
	}
	w, err := zw.Create("xl/worksheets/nomenclature-keys.xml")
	if err != nil {
		return nil, err
	}
	if _, err = w.Write([]byte(meta.String())); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func ParsePropertiesXLSX(raw []byte) (map[string]bool, error) {
	records, err := ParseNomenclatureXLSX(raw)
	if err != nil {
		return nil, err
	}
	props := map[string]bool{}
	for k, r := range records {
		props[k] = r.Checked
	}
	return props, nil
}

// XLSX compresses worksheet XML heavily: large valid references exceed 32 MiB.
// Bound both individual entries and aggregate expansion to retain ZIP-bomb protection.
const maxNomenclatureEntryBytes uint64 = 128 << 20
const maxNomenclatureExpandedBytes uint64 = 256 << 20

func checkNomenclatureEntrySize(size, total uint64) error {
	if size > maxNomenclatureEntryBytes || total > maxNomenclatureExpandedBytes || size > maxNomenclatureExpandedBytes-total {
		return fmt.Errorf("слишком большой Excel: максимум 128 МБ на распакованный компонент и 256 МБ на всё распакованное содержимое")
	}
	return nil
}

func ParseNomenclatureXLSX(raw []byte) (map[string]model.NomenclatureRecord, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("неверный Excel: %w", err)
	}
	files := map[string]*zip.File{}
	var total uint64
	for _, f := range zr.File {
		if err := checkNomenclatureEntrySize(f.UncompressedSize64, total); err != nil {
			return nil, err
		}
		total += f.UncompressedSize64
		files[f.Name] = f
	}
	shared, err := readSharedStrings(files["xl/sharedStrings.xml"])
	if err != nil {
		return nil, err
	}
	_, path, err := resolveFirstSheet(files)
	if err != nil {
		return nil, err
	}
	if files[path] == nil {
		return nil, fmt.Errorf("нет листа номенклатуры")
	}
	rows, err := parseWorksheetRows(files[path], shared)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("пустой лист")
	}
	legacy := strings.TrimSpace(rows[0].cellAt(3)) == "Группа"
	headers := NomenclatureHeaders
	if legacy {
		headers = []string{"Склад", "Артикул", "Группа", "Номенклатура", "+"}
	}
	for i, h := range headers {
		if strings.TrimSpace(rows[0].cellAt(i+1)) != h {
			return nil, fmt.Errorf("ожидаются столбцы: %s", strings.Join(NomenclatureHeaders, ", "))
		}
	}
	identities := map[string][]model.NomenclatureRecord{}
	identity := func(r model.NomenclatureRecord) string {
		b, _ := json.Marshal([]string{strings.TrimSpace(r.Warehouse), strings.TrimSpace(r.SKU), strings.TrimSpace(r.Name)})
		return string(b)
	}
	metadataPath, err := nomenclatureSheetPath(files, "Служебные ключи")
	if err != nil {
		return nil, err
	}
	if f := files[metadataPath]; f != nil {
		mr, err := parseWorksheetRows(f, shared)
		if err != nil {
			return nil, err
		}
		for _, row := range mr {
			var r model.NomenclatureRecord
			if json.Unmarshal([]byte(row.cellAt(2)), &r) != nil || ValidateNomenclature(r) != nil || !recordKeyMatches(row.cellAt(1), r) {
				return nil, fmt.Errorf("повреждены служебные ключи")
			}
			id := identity(r)
			identities[id] = append(identities[id], r)
		}
	}
	records := map[string]model.NomenclatureRecord{}
	for _, row := range rows[1:] {
		r := model.NomenclatureRecord{Warehouse: strings.TrimSpace(row.cellAt(1)), SKU: strings.TrimSpace(row.cellAt(2)), Name: strings.TrimSpace(row.cellAt(3))}
		markCol := 4
		if legacy {
			r.Group = r.Name
			r.Name = strings.TrimSpace(row.cellAt(4))
			markCol = 5
		}
		if r.SKU == "" && r.Name == "" {
			empty := true
			for i := 1; i <= len(headers); i++ {
				if strings.TrimSpace(row.cellAt(i)) != "" {
					empty = false
				}
			}
			if empty {
				continue
			}
			return nil, fmt.Errorf("строка %d: нет артикула или наименования", row.num)
		}
		switch strings.ToLower(strings.TrimSpace(row.cellAt(markCol))) {
		case "1", "true", "да", "+", "✓":
			r.Checked = true
		case "0", "false", "нет", "":
		default:
			return nil, fmt.Errorf("строка %d: галочка должна быть 1 или 0", row.num)
		}
		if !legacy {
			rating, err := strconv.Atoi(strings.TrimSpace(row.cellAt(5)))
			if err != nil {
				return nil, fmt.Errorf("строка %d: неверный рейтинг", row.num)
			}
			r.Rating = rating
			stock, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(row.cellAt(6)), ",", "."), 64)
			if err != nil {
				return nil, fmt.Errorf("строка %d: неверный остаток", row.num)
			}
			r.Stock = stock
			candidates := identities[identity(r)]
			if len(candidates) == 1 {
				r.Group = candidates[0].Group
				// Keep per-line reference metadata only for an unedited row.
				c := candidates[0]
				if c.Stock == r.Stock && c.Rating == r.Rating {
					r.ReferenceRows = c.ReferenceRows
				}
			} else if r.SKU == "" && len(candidates) > 1 {
				found := false
				for _, c := range candidates {
					key := NomenclaturePropertyKey(c.SKU, c.Group, c.Name, c.Warehouse)
					if c.Checked == r.Checked && c.Rating == r.Rating && c.Stock == r.Stock {
						if _, used := records[key]; !used {
							r.Group = c.Group
							r.ReferenceRows = c.ReferenceRows
							found = true
							break
						}
					}
				}
				if !found {
					return nil, fmt.Errorf("строка %d: неоднозначная номенклатура без артикула", row.num)
				}
			}
		}
		if err := ValidateNomenclature(r); err != nil {
			return nil, fmt.Errorf("строка %d: %w", row.num, err)
		}
		key := NomenclaturePropertyKey(r.SKU, r.Group, r.Name, r.Warehouse)
		if prev, ok := records[key]; ok && prev != r {
			return nil, fmt.Errorf("строка %d: противоречащие данные одного товара", row.num)
		}
		records[key] = r
	}
	return records, nil
}

func IsLegacyPropertiesXLSX(raw []byte) (bool, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return false, err
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	shared, err := readSharedStrings(files["xl/sharedStrings.xml"])
	if err != nil {
		return false, err
	}
	_, path, err := resolveFirstSheet(files)
	if err != nil {
		return false, err
	}
	if files[path] == nil {
		return false, fmt.Errorf("нет листа")
	}
	rows, err := parseWorksheetRows(files[path], shared)
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, fmt.Errorf("пустой лист")
	}
	return strings.TrimSpace(rows[0].cellAt(3)) == "Группа", nil
}

func recordKeyMatches(key string, r model.NomenclatureRecord) bool {
	return key == NomenclaturePropertyKey(r.SKU, r.Group, r.Name, r.Warehouse) || (r.Warehouse == "" && key == NomenclaturePropertyKey(r.SKU, r.Group, r.Name))
}

// Excel/LibreOffice may rename worksheet parts when saving. Resolve the hidden
// sheet through workbook relationships, never by its original ZIP filename.
func nomenclatureSheetPath(files map[string]*zip.File, name string) (string, error) {
	wbFile := files["xl/workbook.xml"]
	if wbFile == nil {
		return "", nil
	}
	data, err := readZipEntry(wbFile)
	if err != nil {
		return "", err
	}
	var wb struct {
		Sheets []struct {
			Name string `xml:"name,attr"`
			RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err = xml.Unmarshal(data, &wb); err != nil {
		return "", err
	}
	var rid string
	for _, s := range wb.Sheets {
		if s.Name == name {
			rid = s.RID
			break
		}
	}
	if rid == "" {
		return "", nil
	}
	rf := files["xl/_rels/workbook.xml.rels"]
	if rf == nil {
		return "", fmt.Errorf("нет связей служебного листа")
	}
	data, err = readZipEntry(rf)
	if err != nil {
		return "", err
	}
	var rels struct {
		Items []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	if err = xml.Unmarshal(data, &rels); err != nil {
		return "", err
	}
	for _, r := range rels.Items {
		if r.ID == rid {
			var target string
			if strings.HasPrefix(r.Target, "/") {
				target = path.Clean(strings.TrimPrefix(r.Target, "/"))
			} else {
				target = path.Join("xl", r.Target)
			}
			if files[target] == nil {
				return "", fmt.Errorf("нет служебного листа")
			}
			return target, nil
		}
	}
	return "", fmt.Errorf("не найдена связь служебного листа")
}
