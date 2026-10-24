package main

import (
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"math"
)

// Audit only: keep the seasonal shape and shrink its annual level toward the
// latest observed twelve months. Bounds and shrinkage are fixed BEFORE testing.
// Short histories are left alone; a partial last month is exposure-normalized.
func experimentalFactor(it model.CalculatedItem, completeness float64) float64 {
	n := len(it.MonthlySales)
	if n < 12 {
		return 1
	}
	annual := 0.0
	for _, v := range it.MonthlyForecast12 {
		annual += v
	}
	if annual <= 0 {
		return 1
	}
	recent := 0.0
	for _, v := range it.MonthlySales[n-12:] {
		recent += v
	}
	if completeness > 0 && completeness < 1 {
		recent += it.MonthlySales[n-1] * (1/completeness - 1)
	}
	ratio := math.Max(0.5, math.Min(1.5, recent/annual))
	weight := recent / (recent + 12)
	return 1 + weight*(ratio-1)
}

// Cohorts use ONLY completed months available at each historical cutoff.
func historicalCohort(sales []float64) string {
	n := len(sales) - 1
	if n < 24 {
		return "short-history"
	}
	recent, previous := 0.0, 0.0
	for _, v := range sales[n-12 : n] {
		recent += v
	}
	for _, v := range sales[n-24 : n-12] {
		previous += v
	}
	if previous < 10 {
		return "low-base"
	}
	if recent <= previous*0.65 {
		return "falling"
	}
	if recent >= previous*1.35 {
		return "rising"
	}
	return "stable"
}

func (m *Metric) add(predicted, actual float64) {
	m.Rows++
	m.Forecast += predicted
	m.Actual += actual
	delta := predicted - actual
	m.AbsoluteError += math.Abs(delta)
	if delta > 0 {
		m.Over += delta
	} else {
		m.Under -= delta
	}
}
