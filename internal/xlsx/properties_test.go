package xlsx

import (
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"testing"
)

func TestPropertiesExcelRoundTrip(t *testing.T) {
	props := map[string]bool{
		NomenclaturePropertyKey("00123", "", "Товар"):               true,
		NomenclaturePropertyKey("+Арт", "", ""):                     false,
		NomenclaturePropertyKey("", "Группа & <1>", "Без артикула"): true,
	}
	raw, err := GeneratePropertiesXLSX(props, []model.CalculatedItem{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParsePropertiesXLSX(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(props) {
		t.Fatal(got)
	}
	for k, v := range props {
		if actual, ok := got[k]; !ok || actual != v {
			t.Fatalf("%s: %v", k, got)
		}
	}
	if _, err := ParsePropertiesXLSX([]byte("not Excel")); err == nil {
		t.Fatal("invalid Excel accepted")
	}
	wrong, _ := GenerateStaryoExportXLSX(nil)
	if _, err := ParsePropertiesXLSX(wrong); err == nil {
		t.Fatal("wrong headers accepted")
	}
}
