package server

import (
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestDuplicateReferenceRowsTrackActualChanges(t *testing.T) {
	items := []model.CalculatedItem{
		{RawItem: model.RawItem{SKU: "A", Name: "One", Warehouse: "W", ClosingStock: 5}, SalesSegment: 1},
		{RawItem: model.RawItem{SKU: "A", Name: "Two", Warehouse: "W", ClosingStock: 9}, SalesSegment: 4},
		{RawItem: model.RawItem{SKU: "A", Name: "One", Warehouse: "W", ClosingStock: 2}, SalesSegment: 3},
	}
	records := referenceRecords(items, nil)
	raw, err := xlsx.GenerateNomenclatureXLSX(records)
	if err != nil {
		t.Fatal(err)
	}
	records, err = xlsx.ParseNomenclatureXLSX(raw)
	if err != nil {
		t.Fatal(err)
	}
	lookup := referenceLookup(records)
	// Reordering different names must not mix their reference snapshots.
	for _, i := range []int{1, 0, 2} {
		changed := items[i]
		changed.ClosingStock++
		changed.SalesSegment = 0
		ref, ok := lookup(changed)
		if !ok || ref.Stock != items[i].ClosingStock || ref.Rating != items[i].SalesSegment {
			t.Fatalf("wrong duplicate reference: %+v", ref)
		}
	}
	// A new extra duplicate must not borrow another line's snapshot.
	if _, ok := lookup(items[2]); ok {
		t.Fatal("extra duplicate borrowed a reference")
	}
}
