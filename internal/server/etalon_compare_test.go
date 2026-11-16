package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestComparisonUsesRawRatingAndWarehouseScopedUnion(t *testing.T) {
	app := New(false)
	dir := t.TempDir()
	app.SetSaveDir(dir)
	app.propertiesLoaded = true
	app.properties = map[string]bool{}
	app.etalon = map[string]model.NomenclatureRecord{}
	app.report = &model.CalculationReport{}
	// checked, current stock, reference stock, current rating, reference rating, matches
	cases := []struct {
		checked           bool
		stock, refStock   float64
		rating, refRating int
		matches           bool
	}{
		{true, 11, 10, 3, 3, true},   // marked stock increase
		{false, 9, 10, 0, 1, true},   // 1 -> 0, even without mark and without stock increase
		{false, 11, 10, 3, 3, false}, // growth without a mark
		{true, 10, 10, 2, 2, false},  // equality is not growth
		{true, 9, 10, 2, 2, false},   // decrease is not growth
		{false, 9, 10, 0, 2, true},   // any positive reference rating may fall to zero
		{true, -1, -2, 0, 1, true},   // negative balances and overlap, one output row
		{false, 9, 10, 0, 3, true},
		{false, 9, 10, 0, 4, true},
		{false, 9, 10, 0, 5, true},
		{false, 9, 10, 0, 0, false}, // unchanged zero is not a drop
		{false, 9, 10, 1, 5, false}, // current rating must be exactly zero
	}
	for i, c := range cases {
		it := model.CalculatedItem{RawItem: model.RawItem{ExcelRow: i + 8, SKU: "001", Warehouse: string(rune('А' + i)), Name: "Товар", ClosingStock: c.stock}, SalesSegment: c.rating}
		if i == 6 {
			it.SKU = ""
			it.Group = "Группа"
		}
		key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		app.report.Items = append(app.report.Items, it)
		app.properties[key] = c.checked
		app.etalon[key] = model.NomenclatureRecord{SKU: it.SKU, Warehouse: it.Warehouse, Name: it.Name, Group: it.Group, Stock: c.refStock, Rating: c.refRating, Checked: c.checked}
	}
	// An identity absent in this warehouse is shown explicitly as new.
	app.report.Items = append(app.report.Items, model.CalculatedItem{RawItem: model.RawItem{ExcelRow: 99, SKU: "001", Warehouse: "Новый склад", Name: "Товар", ClosingStock: 999}, SalesSegment: 0})
	original := append([]model.CalculatedItem(nil), app.report.Items...)
	app.mu.RLock()
	overlay := app.buildStateEnvelopeLocked()
	app.mu.RUnlock()
	if overlay.Report.Items[1].SalesSegment != 0 {
		t.Fatal("normal report must display its current rating, not the reference rating")
	}
	// The catalog and ordinary export must not inherit the reference rating.
	app.wb = &model.WorkbookData{}
	if app.reportForExportLocked().Items[1].SalesSegment != 0 {
		t.Fatal("export inherited the reference rating")
	}
	catalog := app.catalogLocked()
	it := app.report.Items[1]
	key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
	if catalog.Nomenclature[key].Rating != 0 || app.etalon[key].Rating != 1 {
		t.Fatal("live catalog and fixed reference were mixed")
	}
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/etalon/compare", nil))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var got struct {
		Rows  []etalonComparisonRow `json:"rows"`
		Count int                   `json:"matchedCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Rows) != len(cases)+1 || got.Count != 8 {
		t.Fatal(got)
	}
	newRow := got.Rows[len(cases)]
	if !newRow.IsNew || !newRow.Matches || newRow.StockIncreased || newRow.RatingDropped || newRow.Reason != "новый товар" {
		t.Fatal(newRow)
	}
	for i, c := range cases {
		r := got.Rows[i]
		if r.Matches != c.matches || r.CurrentRating != c.rating {
			t.Fatalf("case %d: %+v", i, r)
		}
	}
	if !reflect.DeepEqual(original, app.report.Items) {
		t.Fatal("comparison mutated the original report")
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 0 {
		t.Fatal("comparison must not write files", files, err)
	}
}

func TestComparisonRequiresWorkbookAndReference(t *testing.T) {
	app := New(false)
	app.SetSaveDir(t.TempDir())
	for _, report := range []*model.CalculationReport{nil, {Items: []model.CalculatedItem{{RawItem: model.RawItem{ExcelRow: 8}}}}} {
		app.report = report
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/etalon/compare", nil))
		if rec.Code != 400 {
			t.Fatal(rec.Code)
		}
	}
}

func TestFailedPropertiesWriteDoesNotAdvanceSaveStatus(t *testing.T) {
	app := New(false)
	app.propertiesLoaded = true
	app.propertiesFileName = "previous.json"
	app.propertiesSavedAt = "2026-10-20T10:00:00+03:00"
	dir := t.TempDir()
	// An occupied directory at the catalog filename forces replacement to fail.
	if err := os.Mkdir(dir+"/properties.json", 0700); err != nil {
		t.Fatal(err)
	}
	if err := app.persistPropertiesLocked(dir); err == nil {
		t.Fatal("expected storage failure")
	}
	if app.propertiesFileName != "previous.json" || app.propertiesSavedAt != "2026-10-20T10:00:00+03:00" {
		t.Fatal("failed write changed the last successful save metadata")
	}
}

// Reproduce correction -> ordinary save -> clear/reload -> compare -> restart.
// Both the reference bytes and the result must survive live checkbox changes.
func TestComparisonReferenceMarksSurviveCorrectionAndReload(t *testing.T) {
	dir := t.TempDir()
	app := New(false)
	app.SetSaveDir(dir)
	storage, err := app.propertiesDirLocked()
	if err != nil {
		t.Fatal(err)
	}
	if err := app.loadPropertiesLocked(storage + "/properties.json"); err != nil {
		t.Fatal(err)
	}
	items := []model.CalculatedItem{
		{RawItem: model.RawItem{ExcelRow: 8, SKU: "001", Warehouse: "Склад", Name: "Снять отметку", ClosingStock: 11}, SalesSegment: 3},
		{RawItem: model.RawItem{ExcelRow: 9, SKU: "002", Warehouse: "Склад", Name: "Добавить отметку", ClosingStock: 11}, SalesSegment: 3},
	}
	key := func(i int) string {
		it := items[i]
		return xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
	}
	refs := referenceRecords(items, map[string]bool{key(0): true})
	for k, v := range refs {
		v.Stock = 10
		refs[k] = v
	}
	if err := app.commitEtalonLocked(storage, model.NomenclatureCatalog{Version: 2, Properties: map[string]bool{key(0): true, key(1): false}, Nomenclature: refs}); err != nil {
		t.Fatal(err)
	}
	path := storage + "/etalon.json"
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	compare := func(app *AppServer) []etalonComparisonRow {
		t.Helper()
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/etalon/compare", nil))
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var data struct {
			Rows []etalonComparisonRow `json:"rows"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		if len(data.Rows) != 2 || !data.Rows[0].Matches || data.Rows[1].Matches {
			t.Fatalf("comparison borrowed live marks: %+v", data.Rows)
		}
		return data.Rows
	}
	app.properties[key(0)] = true
	app.report = &model.CalculationReport{Items: items}
	initial := compare(app)
	// The correction reverses both live marks, but does not explicitly save reference.
	app.properties[key(0)] = false
	app.properties[key(1)] = true
	if err := app.persistPropertiesLocked(storage); err != nil {
		t.Fatal(err)
	}
	if got := compare(app); !reflect.DeepEqual(initial, got) {
		t.Fatal("correction changed comparison")
	}
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/clear", nil))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	app.report = &model.CalculationReport{Items: append([]model.CalculatedItem(nil), items...)}
	if got := compare(app); !reflect.DeepEqual(initial, got) {
		t.Fatal("reload changed comparison")
	}
	restarted := New(false)
	restarted.SetSaveDir(dir)
	restarted.report = &model.CalculationReport{Items: items}
	if got := compare(restarted); !reflect.DeepEqual(initial, got) {
		t.Fatal("restart changed comparison")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("reference file changed without explicit save")
	}
}

// Батч-40: выгрузка 1С от 16.11.2026 оставила «Артикул» пустым у части позиций.
// Эталон, сохранённый по старым файлам (ключи «sku»+склад), должен узнавать
// те же позиции в новой выгрузке по «группа+наименование+склад» — без ложных
// «новинок» (у пользователя их было 6364).
func TestComparisonBridgesReferenceWithMissingSKU(t *testing.T) {
	app := New(false)
	dir := t.TempDir()
	app.SetSaveDir(dir)
	app.propertiesLoaded = true
	app.properties = map[string]bool{}
	app.etalon = map[string]model.NomenclatureRecord{}
	app.report = &model.CalculationReport{}

	const sku, group, name, wh = "АРТ-1", "ХОЗГРУППА", "Блюдо овал. жарост. 2,1л", "Склад Мир"
	oldKey := xlsx.NomenclaturePropertyKey(sku, group, name, wh)
	app.etalon[oldKey] = model.NomenclatureRecord{SKU: sku, Group: group, Name: name, Warehouse: wh, Stock: 10, Rating: 3, Checked: true}

	// Та же позиция в новой выгрузке: артикул пуст, ключ «имя»-формы.
	it := model.CalculatedItem{RawItem: model.RawItem{ExcelRow: 8, SKU: "", Group: group, Name: name, Warehouse: wh, ClosingStock: 11}, SalesSegment: 3}
	app.report.Items = append(app.report.Items, it)
	app.properties[xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)] = true

	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/etalon/compare", nil))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var got struct {
		Rows  []etalonComparisonRow `json:"rows"`
		Count int                   `json:"matchedCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Rows) != 1 {
		t.Fatalf("rows = %d, ожидалась 1 (без ложных новинок)", len(got.Rows))
	}
	r := got.Rows[0]
	if r.IsNew {
		t.Fatal("позиция с пропавшим артикулом помечена как новая")
	}
	if !r.Matches || !r.StockIncreased || !r.EtalonChecked {
		t.Fatalf("semantics: %+v", r)
	}
	if r.EtalonStock != 10 || r.EtalonRating != 3 || r.CurrentRating != 3 {
		t.Fatalf("reference fields: %+v", r)
	}
}

// Обратное направление: эталон сохранён по новой выгрузке (ключ «имя»-формы),
// текущий файл — старого формата (позиция с артикулом).
func TestReferenceLookupBridgesNameKeys(t *testing.T) {
	const group, name, wh = "ХОЗГРУППА", "Блюдо овал. жарост. 2,1л", "Склад Мир"
	nameKey := xlsx.NomenclaturePropertyKey("", group, name, wh)
	records := map[string]model.NomenclatureRecord{
		nameKey: {SKU: "", Group: group, Name: name, Warehouse: wh, Stock: 5, Rating: 2, Checked: false},
	}
	lookup := referenceLookup(records)
	it := model.CalculatedItem{RawItem: model.RawItem{ExcelRow: 9, SKU: "АРТ-9", Group: group, Name: name, Warehouse: wh, ClosingStock: 5}, SalesSegment: 2}
	ref, ok := lookup(it)
	if !ok || ref.Stock != 5 || ref.Rating != 2 {
		t.Fatalf("fallback name-key: ok=%v rec=%+v", ok, ref)
	}
}

// Мостик пометок/исключений: свойство записано по старому sku-ключу
// (метаданные в каталоге), позиция в новой выгрузке без артикула.
func TestOrderExclusionsBridgeMissingSKU(t *testing.T) {
	app := New(false)
	const sku, group, name, wh = "АРТ-1", "ХОЗГРУППА", "Блюдо овал. жарост. 2,1л", "Склад Мир"
	skuKey := xlsx.NomenclaturePropertyKey(sku, group, name, wh)
	app.properties = map[string]bool{skuKey: true}
	app.nomenclature = map[string]model.NomenclatureRecord{
		skuKey: {SKU: sku, Group: group, Name: name, Warehouse: wh},
	}
	wb := &model.WorkbookData{Items: []model.RawItem{
		{ExcelRow: 5, SKU: "", Group: group, Name: name, Warehouse: wh},
		{ExcelRow: 6, SKU: "", Group: group, Name: "Другой товар", Warehouse: wh},
	}}
	rows := app.orderExclusionsLocked(wb)
	if !rows[5] {
		t.Fatal("исключение по старому sku-ключу не найдено для позиции без артикула")
	}
	if rows[6] {
		t.Fatal("чужая позиция ошибочно исключена")
	}
	// Кэш индекса валиден при повторном вызове (набор ключей не менялся).
	rows2 := app.orderExclusionsLocked(wb)
	if !rows2[5] || rows2[6] {
		t.Fatal("повторный вызов дал другой результат")
	}
}
