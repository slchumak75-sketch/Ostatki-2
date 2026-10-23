package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

func NomenclaturePropertyKey(sku, group, name string, warehouse ...string) string {
	parts := []string{"sku", strings.TrimSpace(sku)}
	if parts[1] == "" {
		parts = []string{"name", strings.TrimSpace(group), strings.TrimSpace(name)}
	}
	if len(warehouse) > 0 {
		parts = append(parts, strings.TrimSpace(warehouse[0]))
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(parts)
	return strings.TrimSuffix(b.String(), "\n")
}

// GeneratePropertiesXLSX includes explicit false values and properties absent from the current report.
func GeneratePropertiesXLSX(properties map[string]bool, items []model.CalculatedItem) ([]byte, error) {
	names := map[string][2]string{}
	for _, it := range items {
		names[NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)] = [2]string{it.Group, it.Name}
	}
	keys := make([]string, 0, len(properties))
	for k := range properties {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="2" width="24" customWidth="1"/><col min="3" max="3" width="55" customWidth="1"/><col min="4" max="4" width="10" customWidth="1"/></cols><sheetData><row r="1">`)
	for i, h := range []string{"Склад", "Артикул", "Группа", "Номенклатура", "+"} {
		sheet.WriteString(inlineStrCell(ColIndexToLetters(i+1)+"1", 1, h))
	}
	sheet.WriteString(`</row>`)
	for i, k := range keys {
		var parts []string
		if err := json.Unmarshal([]byte(k), &parts); err != nil || len(parts) < 2 {
			return nil, fmt.Errorf("неверный ключ свойства")
		}
		sku, group, name := "", names[k][0], names[k][1]
		warehouse := ""
		switch {
		case parts[0] == "sku" && (len(parts) == 2 || len(parts) == 3):
			sku = parts[1]
			if len(parts) == 3 {
				warehouse = parts[2]
			}
		case parts[0] == "name" && (len(parts) == 3 || len(parts) == 4):
			group, name = parts[1], parts[2]
			if len(parts) == 4 {
				warehouse = parts[3]
			}
		default:
			return nil, fmt.Errorf("неверный ключ свойства")
		}
		row := strconv.Itoa(i + 2)
		sheet.WriteString(`<row r="` + row + `">`)
		mark := "0"
		if properties[k] {
			mark = "1"
		}
		for j, val := range []string{warehouse, sku, group, name, mark} {
			sheet.WriteString(inlineStrCell(ColIndexToLetters(j+1)+row, 2, val))
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	// Reuse the application's workbook/style template.
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
		data, err := readZipEntry(f)
		if err != nil {
			return nil, err
		}
		if f.Name == "xl/worksheets/sheet1.xml" {
			data = []byte(sheet.String())
		}
		w, err := zw.Create(f.Name)
		if err != nil {
			return nil, err
		}
		if _, err = w.Write(data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func ParsePropertiesXLSX(raw []byte) (map[string]bool, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("неверный файл Excel: %w", err)
	}
	files := map[string]*zip.File{}
	var total uint64
	for _, f := range zr.File {
		total += f.UncompressedSize64
		if total > 32<<20 {
			return nil, fmt.Errorf("слишком большой файл свойств")
		}
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
		return nil, fmt.Errorf("нет листа свойств")
	}
	rows, err := parseWorksheetRows(files[path], shared)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("пустой лист")
	}
	for i, h := range []string{"Склад", "Артикул", "Группа", "Номенклатура", "+"} {
		if strings.TrimSpace(rows[0].cellAt(i+1)) != h {
			return nil, fmt.Errorf("ожидаются столбцы: Склад, Артикул, Группа, Номенклатура, +")
		}
	}
	props := map[string]bool{}
	for _, row := range rows[1:] {
		warehouse := strings.TrimSpace(row.cellAt(1))
		sku, group, name := strings.TrimSpace(row.cellAt(2)), strings.TrimSpace(row.cellAt(3)), strings.TrimSpace(row.cellAt(4))
		if sku == "" && name == "" {
			if strings.TrimSpace(row.cellAt(5)) != "" {
				return nil, fmt.Errorf("строка %d: нет артикула или наименования", row.num)
			}
			continue
		}
		value := strings.ToLower(strings.TrimSpace(row.cellAt(5)))
		var checked bool
		switch value {
		case "1", "true", "да", "+", "✓":
			checked = true
		case "0", "false", "нет", "":
			checked = false
		default:
			return nil, fmt.Errorf("строка %d: галочка должна быть 1 или 0", row.num)
		}
		key := NomenclaturePropertyKey(sku, group, name, warehouse)
		if prev, ok := props[key]; ok && prev != checked {
			return nil, fmt.Errorf("строка %d: противоречащие свойства одного товара", row.num)
		}
		props[key] = checked
	}
	return props, nil
}
