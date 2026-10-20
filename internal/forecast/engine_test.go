package forecast_test

import (
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestSeasonalForecastRealDataset(t *testing.T) {
	wb, _, err := xlsx.ReadFile(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx"))
	if err != nil {
		t.Fatalf("failed to load workbook: %v", err)
	}

	params := model.DefaultParams()
	rep := forecast.Calculate(wb, params, nil)

	if len(rep.Groups) != 2 {
		t.Fatalf("expected 2 groups, got %d", len(rep.Groups))
	}

	// Проверка ярко выраженной сезонности в группе «2 краски растворители»: лето >> зимы
	var paintGroup *model.GroupSeasonality
	for i := range rep.Groups {
		if rep.Groups[i].Group == "2 краски растворители" {
			paintGroup = &rep.Groups[i]
		}
	}
	if paintGroup == nil {
		t.Fatalf("paint group not found")
	}
	janIdx := paintGroup.MonthlyIndices[0]
	julIdx := paintGroup.MonthlyIndices[6]
	if julIdx <= 1.4 || janIdx >= 0.4 {
		t.Fatalf("expected strong seasonality in paints (Jul > 1.4, Jan < 0.4), got Jul=%.3f Jan=%.3f", julIdx, janIdx)
	}

	// Осенью/зимой сезонная модель должна заказывать меньше летних товаров, чем наивное среднее
	if rep.TotalOrderCost >= rep.FlatOrderCost {
		t.Fatalf("expected autumn/winter seasonal budget (%.2f) < naive flat budget (%.2f)", rep.TotalOrderCost, rep.FlatOrderCost)
	}

	// А при планировании на весенне-летний пик (Май–Июнь) бюджет должен расти!
	summerParams := model.DefaultParams()
	summerParams.PlanStartDate = "2027-05-01"
	summerRep := forecast.Calculate(wb, summerParams, nil)
	if summerRep.TotalOrderUnits <= rep.TotalOrderUnits {
		t.Fatalf("expected summer forecast units (%d) > November forecast units (%d)", summerRep.TotalOrderUnits, rep.TotalOrderUnits)
	}
}
