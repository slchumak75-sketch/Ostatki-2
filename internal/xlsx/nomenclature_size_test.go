package xlsx

import (
	"archive/zip"
	"bytes"
	"io"
	"math"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

func TestNomenclatureExpansionLimits(t *testing.T) {
	for _, tc := range []struct {
		size, total uint64
		ok          bool
	}{
		{33 << 20, 0, true}, {128 << 20, 128 << 20, true}, {129 << 20, 0, false},
		{1, 256 << 20, false}, {1, math.MaxUint64, false}, {math.MaxUint64, 0, false},
	} {
		if err := checkNomenclatureEntrySize(tc.size, tc.total); (err == nil) != tc.ok {
			t.Fatalf("size=%d total=%d: %v", tc.size, tc.total, err)
		}
	}
}

func TestReferenceLargerThanOldExpandedLimit(t *testing.T) {
	records := map[string]model.NomenclatureRecord{NomenclaturePropertyKey("001", "", "Товар", "Мир"): {SKU: "001", Name: "Товар", Warehouse: "Мир", Checked: true, Rating: 4, Stock: 5}}
	raw, err := GenerateNomenclatureXLSX(records)
	if err != nil {
		t.Fatal(err)
	}
	zr, _ := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, entry := range zr.File {
		r, _ := entry.Open()
		w, _ := zw.Create(entry.Name)
		_, err = io.Copy(w, r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	// A compressed ancillary component brings this valid workbook above 32 MiB.
	w, _ := zw.Create("customXml/large.xml")
	block := bytes.Repeat([]byte(" "), 1<<20)
	for i := 0; i < 33; i++ {
		if _, err = w.Write(block); err != nil {
			t.Fatal(err)
		}
	}
	if err = zw.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := ParseNomenclatureXLSX(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatal(got)
	}
	for _, v := range got {
		if !v.Checked || v.Rating != 4 || v.Stock != 5 {
			t.Fatal(v)
		}
	}
}
