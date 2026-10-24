package server

import (
	"encoding/json"

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
func referenceLookup(records map[string]model.NomenclatureRecord) func(model.CalculatedItem) (model.NomenclatureRecord, bool) {
	used := map[string]int{}
	decoded := map[string][]model.NomenclatureRecord{}
	return func(it model.CalculatedItem) (model.NomenclatureRecord, bool) {
		key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		r, ok := records[key]
		if !ok || r.ReferenceRows == "" {
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
