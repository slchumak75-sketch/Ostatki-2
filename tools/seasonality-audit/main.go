// Command seasonality-audit compares existing forecast modes without changing
// application settings or writing the reference. Historical checks approximate
// daily sales uniformly within each month; they are not true daily backtests.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
	"math"
	"os"
	"sort"
	"time"
)

type Sample struct {
	SKU, Name, Warehouse, Group             string
	Previous, Recent, Stock, Season, Demand float64
	Hybrid, GroupQty, Flat                  int
	Cost                                    float64
}
type Metric struct {
	Mode                                         string
	Rows                                         int
	Forecast, Actual, AbsoluteError, Over, Under float64
}
type Fold struct {
	Date    string
	Metrics []Metric
}

func main() {
	input := flag.String("workbook", "Ведомость ок.xlsx", "Workbook to audit")
	output := flag.String("output", "", "JSON output path (stdout by default)")
	flag.Parse()
	wb, _, e := xlsx.ReadFile(*input)
	if e != nil {
		panic(e)
	}
	modes := []model.SeasonMode{model.SeasonHybrid, model.SeasonGroupOnly, model.SeasonFlatSimple}
	reports := []*model.CalculationReport{}
	for _, m := range modes {
		p := model.DefaultParams()
		p.SeasonMode = m
		reports = append(reports, forecast.Calculate(wb, p, nil))
	}
	samples := []Sample{}
	risingSamples := []Sample{}
	totals := []map[string]any{}
	fall, fallExtra, rise := 0, 0, 0
	for k, r := range reports {
		qty := 0
		for _, it := range r.Items {
			qty += it.AutoOrderQty
		}
		totals = append(totals, map[string]any{"mode": modes[k], "cost": r.TotalOrderCost, "qty": qty})
	}
	for i, it := range reports[0].Items {
		n := len(it.MonthlySales)
		prev := 0.
		for j := n - 24; j < n-12; j++ {
			if j >= 0 {
				prev += it.MonthlySales[j]
			}
		}
		recent := it.SumSalesLast12M
		if recent > prev && prev > 0 {
			rise++
		}
		if prev >= 10 && recent >= prev*1.35 && it.AutoOrderQty > 0 {
			risingSamples = append(risingSamples, Sample{it.SKU, it.Name, it.Warehouse, it.Group, prev, recent, it.ClosingStock, it.HorizonSeasonIdx, it.ForecastDemand, it.AutoOrderQty, reports[1].Items[i].AutoOrderQty, reports[2].Items[i].AutoOrderQty, it.OrderCost})
		}
		if prev >= 10 && recent <= prev*0.65 && recent > 0 {
			fall++
			if it.AutoOrderQty > reports[1].Items[i].AutoOrderQty {
				fallExtra++
			}
		}
		if it.AutoOrderQty >= reports[1].Items[i].AutoOrderQty+2 && prev >= 10 && recent <= prev*0.65 && recent > 0 {
			samples = append(samples, Sample{it.SKU, it.Name, it.Warehouse, it.Group, prev, recent, it.ClosingStock, it.HorizonSeasonIdx, it.ForecastDemand, it.AutoOrderQty, reports[1].Items[i].AutoOrderQty, reports[2].Items[i].AutoOrderQty, it.OrderCost})
		}
	}
	sort.Slice(risingSamples, func(i, j int) bool { return risingSamples[i].Cost > risingSamples[j].Cost })
	sort.Slice(samples, func(i, j int) bool { return samples[i].Cost > samples[j].Cost })
	folds := []Fold{}
	for _, date := range []string{"2024-10-20", "2025-01-20", "2025-04-20", "2025-07-20", "2025-10-20", "2026-01-20", "2026-04-20", "2026-07-20", "2026-08-20"} {
		cut, _ := time.Parse("2006-01-02", date)
		idx := -1
		for j, p := range wb.Periods {
			if p.Year == cut.Year() && p.Month == int(cut.Month()) {
				idx = j
			}
		}
		if idx < 0 || idx+2 >= len(wb.Periods) {
			continue
		}
		copyWB := *wb
		copyWB.CreatedDate = date
		copyWB.ModifiedDate = date
		copyWB.Periods = append([]model.PeriodColumn(nil), wb.Periods[:idx+1]...)
		copyWB.Items = make([]model.RawItem, len(wb.Items))
		dim := time.Date(cut.Year(), cut.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
		for i, it := range wb.Items {
			copyWB.Items[i] = it
			s := append([]float64(nil), it.MonthlySales[:idx+1]...)
			s[idx] *= float64(cut.Day()) / float64(dim)
			copyWB.Items[i].MonthlySales = s
		}
		fold := Fold{Date: date}
		for _, mode := range modes {
			p := model.DefaultParams()
			p.SeasonMode = mode
			r := forecast.Calculate(&copyWB, p, nil)
			met := Metric{Mode: string(mode)}
			for i, it := range r.Items {
				if it.SumSalesLast6M <= 0 {
					continue
				}
				actual := 0.
				for d := 1; d <= 34; d++ {
					day := cut.AddDate(0, 0, d)
					j := idx + 12*(day.Year()-cut.Year()) + int(day.Month()) - int(cut.Month())
					days := time.Date(day.Year(), day.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
					actual += wb.Items[i].MonthlySales[j] / float64(days)
				}
				err := it.ForecastDemand - actual
				met.Rows++
				met.Forecast += it.ForecastDemand
				met.Actual += actual
				met.AbsoluteError += math.Abs(err)
				if err > 0 {
					met.Over += err
				} else {
					met.Under -= err
				}
			}
			fold.Metrics = append(fold.Metrics, met)
		}
		folds = append(folds, fold)
	}
	out := map[string]any{"file": wb.FileName, "start": reports[0].EffectiveStartDate, "end": reports[0].EffectiveEndDate, "rows": len(wb.Items), "totals": totals, "falling": fall, "fallingHigherThanGroup": fallExtra, "rising": rise, "samples": samples, "risingSamples": risingSamples, "backtest": folds}
	raw, _ := json.MarshalIndent(out, "", "  ")
	if *output != "" {
		if err := os.WriteFile(*output, raw, 0600); err != nil {
			panic(err)
		}
	} else {
		fmt.Println(string(raw))
	}
}
