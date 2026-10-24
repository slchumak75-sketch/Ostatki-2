package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

func TestNomenclatureSixFieldsRoundTripAndIdentity(t *testing.T) {
	records := map[string]model.NomenclatureRecord{}
	for _, r := range []model.NomenclatureRecord{
		{Warehouse: "Склад А", SKU: "0001", Name: "Товар & < >", Checked: true, Rating: 5, Stock: 12.25},
		{Warehouse: "Склад Б", SKU: "0001", Name: "Товар & < >", Checked: false, Rating: 0, Stock: -2.5},
		{Warehouse: "Склад А", SKU: "=not-formula", Name: "Текст", Rating: 1, Stock: 0},
		{Warehouse: "Склад А", Group: "Группа 1", Name: "Без артикула", Checked: false, Rating: 2, Stock: 1},
		{Warehouse: "Склад А", Group: "Группа 2", Name: "Без артикула", Checked: true, Rating: 3, Stock: 2},
	} {
		records[NomenclaturePropertyKey(r.SKU, r.Group, r.Name, r.Warehouse)] = r
	}
	raw, err := GenerateNomenclatureXLSX(records)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseNomenclatureXLSX(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(records) {
		t.Fatal("lost records")
	}
	for key, want := range records {
		if got[key] != want {
			t.Fatalf("%s: got %+v want %+v", key, got[key], want)
		}
	}
	zr, _ := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	rows, err := parseWorksheetRows(files["xl/worksheets/sheet1.xml"], nil)
	if err != nil {
		t.Fatal(err)
	}
	for i, h := range NomenclatureHeaders {
		if rows[0].cellAt(i+1) != h {
			t.Fatal("wrong header order")
		}
	}
	if rows[0].cellAt(7) != "" {
		t.Fatal("unexpected visible column")
	}
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			data, _ := readZipEntry(f)
			if !bytes.Contains(data, []byte(`<autoFilter ref="A1:F6"`)) {
				t.Fatal("Excel filters missing")
			}
			if bytes.Contains(data, []byte(`<f>`)) {
				t.Fatal("text SKU became a formula")
			}
		}
	}
}

func TestNomenclatureMetadataSurvivesWorksheetPartRename(t *testing.T) {
	r := model.NomenclatureRecord{Warehouse: "Склад", Name: "Без артикула", Group: "Группа", Rating: 3, Stock: 2}
	key := NomenclaturePropertyKey(r.SKU, r.Group, r.Name, r.Warehouse)
	raw, err := GenerateNomenclatureXLSX(map[string]model.NomenclatureRecord{key: r})
	if err != nil {
		t.Fatal(err)
	}
	zr, _ := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "nomenclature-keys.xml", "sheet2.xml")
		data, _ := readZipEntry(f)
		if name == "xl/_rels/workbook.xml.rels" || name == "[Content_Types].xml" {
			data = []byte(strings.ReplaceAll(string(data), "nomenclature-keys.xml", "sheet2.xml"))
		}
		w, _ := zw.Create(name)
		_, _ = w.Write(data)
	}
	_ = zw.Close()
	records, err := ParseNomenclatureXLSX(out.Bytes())
	if err != nil || records[key] != r {
		t.Fatal("Excel-resaved identity lost", records, err)
	}
}

func TestNomenclatureLegacyExcelAndJSON(t *testing.T) {
	template, err := GenerateStaryoExportXLSX(nil)
	if err != nil {
		t.Fatal(err)
	}
	zr, _ := zip.NewReader(bytes.NewReader(template), int64(len(template)))
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		raw, _ := readZipEntry(f)
		if f.Name == "xl/worksheets/sheet1.xml" {
			sheet := `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
			for i, values := range [][]string{{"Склад", "Артикул", "Группа", "Номенклатура", "+"}, {"Склад", "0001", "Группа", "Товар", "0"}} {
				row := string(rune('1' + i))
				sheet += `<row r="` + row + `">`
				for j, v := range values {
					sheet += inlineStrCell(ColIndexToLetters(j+1)+row, 2, v)
				}
				sheet += `</row>`
			}
			sheet += `</sheetData></worksheet>`
			raw = []byte(sheet)
		}
		w, _ := zw.Create(f.Name)
		_, _ = w.Write(raw)
	}
	_ = zw.Close()
	records, err := ParseNomenclatureXLSX(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	key := NomenclaturePropertyKey("0001", "Группа", "Товар", "Склад")
	if len(records) != 1 || records[key].Checked || records[key].Name != "Товар" {
		t.Fatal(records)
	}
	if legacy, err := IsLegacyPropertiesXLSX(out.Bytes()); err != nil || !legacy {
		t.Fatal("legacy preflight", legacy, err)
	}
	old, _ := json.Marshal(map[string]bool{key: false})
	catalog, err := DecodeNomenclatureCatalog(old)
	if err != nil || len(catalog.Properties) != 1 || catalog.Properties[key] {
		t.Fatal("old JSON", err)
	}
}

func TestNomenclatureValidation(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"version":3,"properties":{},"nomenclature":{}}`, `{"version":2}`} {
		if _, err := DecodeNomenclatureCatalog([]byte(raw)); err == nil {
			t.Fatal("accepted invalid catalog", raw)
		}
	}
	key := NomenclaturePropertyKey("001", "", "Товар", "Склад")
	r := model.NomenclatureRecord{SKU: "001", Name: "Товар", Warehouse: "Склад", Rating: 6}
	if _, err := GenerateNomenclatureXLSX(map[string]model.NomenclatureRecord{key: r}); err == nil {
		t.Fatal("out of range rating accepted")
	}
	r.Rating = 2
	raw, _ := GenerateNomenclatureXLSX(map[string]model.NomenclatureRecord{key: r})
	zr, _ := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		data, _ := readZipEntry(f)
		if f.Name == "xl/worksheets/sheet1.xml" {
			data = []byte(strings.Replace(string(data), `<v>2</v>`, `<v>2.5</v>`, 1))
		}
		w, _ := zw.Create(f.Name)
		_, _ = w.Write(data)
	}
	_ = zw.Close()
	if _, err := ParseNomenclatureXLSX(out.Bytes()); err == nil {
		t.Fatal("fractional rating accepted")
	}
}
