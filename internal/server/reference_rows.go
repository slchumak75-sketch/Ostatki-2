package server

import (
	"encoding/json"
	"sort"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// Reference rows are separate from checkbox identity: duplicate 1C lines may
// share the same SKU/name+warehouse but have different stocks and ratings.
func referenceRecords(items []model.CalculatedItem, properties map[string]bool) map[string]model.NomenclatureRecord {
	records := map[string]model.NomenclatureRecord{}
	groups := map[string][]model.NomenclatureRecord{}
	for _, it := range items {
		key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		r := model.NomenclatureRecord{Warehouse: it.Warehouse, SKU: it.SKU, Name: it.Name, Group: it.Group, Checked: properties[key], Stock: it.ClosingStock, Rating: it.SalesSegment}
		groups[key] = append(groups[key], r)
		records[key] = r
	}
	for key, rows := range groups {
		if len(rows) > 1 {
			r := records[key]
			raw, _ := json.Marshal(rows)
			r.ReferenceRows = string(raw)
			records[key] = r
		}
	}
	return records
}

// Match duplicate identities in stable occurrence order within name/group.
// Never match by stock or rating: those are precisely the values being compared.
//
// Батч-40: выгрузка 1С от 16.11.2026 оставила «Артикул» пустым у части позиций
// (коды переехали в отдельный столбец «Код»), поэтому прямые ключи эталона
// («sku»+склад) промахиваются. Фолбэк: запись эталона ищется по
// «группа+наименование+склад» — записи эталона хранят полные реквизиты.
func referenceLookup(records map[string]model.NomenclatureRecord) func(model.CalculatedItem) (model.NomenclatureRecord, bool) {
	used := map[string]int{}
	decoded := map[string][]model.NomenclatureRecord{}
	byName := map[string][]string{}
	byNameReady := false
	ensureByName := func() {
		if byNameReady {
			return
		}
		byNameReady = true
		for k, rec := range records {
			// Само-ключи («имя»-форма) тоже включаются: они нужны для обратного
			// мостика — позиция с артикулом против эталона, сохранённого по
			// выгрузке без артикулов.
			nk := xlsx.NomenclaturePropertyKey("", rec.Group, rec.Name, rec.Warehouse)
			byName[nk] = append(byName[nk], k)
		}
		for _, ks := range byName {
			sort.Strings(ks)
		}
	}
	return func(it model.CalculatedItem) (model.NomenclatureRecord, bool) {
		key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		r, ok := records[key]
		if !ok {
			ensureByName()
			nk := xlsx.NomenclaturePropertyKey("", it.Group, it.Name, it.Warehouse)
			if ks := byName[nk]; len(ks) > 0 {
				key = ks[0]
				r, ok = records[key]
			}
			if !ok {
				return model.NomenclatureRecord{}, false
			}
		}
		if r.ReferenceRows == "" {
			return r, ok
		}
		rows, loaded := decoded[key]
		if !loaded {
			_ = json.Unmarshal([]byte(r.ReferenceRows), &rows)
			decoded[key] = rows
		}
		identity, _ := json.Marshal([]string{key, it.Group, it.Name})
		ordinal := used[string(identity)]
		used[string(identity)]++
		for _, candidate := range rows {
			if candidate.Name != it.Name || candidate.Group != it.Group {
				continue
			}
			if ordinal == 0 {
				return candidate, true
			}
			ordinal--
		}
		return model.NomenclatureRecord{}, false
	}
}

// Батч-40: мостик форматов выгрузки 1С. Ключи свойств зависят от наличия
// артикула в файле: «sku»+склад (старые выгрузки) либо «группа+наименование+
// склад» (новые, где артикул пуст). Обратный индекс «имя-идентичность -> ключи»
// строится из каталога номенклатуры (там полные реквизиты для обоих форматов);
// для ключей без метаданных используется RecordFromKey. Индекс зависит только
// от НАБОРА ключей, поэтому кэш валиден при смене значений существующих ключей.
// Caller holds at least s.mu.RLock.
func (s *AppServer) propertyBridgeIndexLocked() map[string][]string {
	if s.propBridgeIdx != nil && s.propBridgeLen == len(s.properties) {
		return s.propBridgeIdx
	}
	idx := map[string][]string{}
	for k := range s.properties {
		rec, ok := s.nomenclature[k]
		if !ok {
			parsed, err := xlsx.RecordFromKey(k)
			if err != nil {
				continue
			}
			rec = parsed
		}
		nk := xlsx.NomenclaturePropertyKey("", rec.Group, rec.Name, rec.Warehouse)
		idx[nk] = append(idx[nk], k)
	}
	for _, ks := range idx {
		sort.Strings(ks)
	}
	s.propBridgeIdx = idx
	s.propBridgeLen = len(s.properties)
	return idx
}

// propertyBridgeChecked: сначала прямой ключ, при промахе — поиск по
// «группа+наименование+склад». Семантика any-true: если несколько старых
// артикулов сводятся к одному наименованию, пометка любого из них считается
// пометкой позиции (иначе все пометки молча терялись бы при смене формата).
func propertyBridgeChecked(props map[string]bool, idx map[string][]string, key, nameKey string) bool {
	if v, ok := props[key]; ok {
		return v
	}
	for _, cand := range idx[nameKey] {
		if props[cand] {
			return true
		}
	}
	return false
}
