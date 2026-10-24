package main

import (
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"testing"
)

func TestExperimentFactor(t *testing.T) {
	it := model.CalculatedItem{}
	for i := 0; i < 12; i++ {
		it.MonthlySales = append(it.MonthlySales, 1)
		it.MonthlyForecast12[i] = 1
	}
	if got := experimentalFactor(it, 1); got != 1 {
		t.Fatal(got)
	}
	for i := range it.MonthlyForecast12 {
		it.MonthlyForecast12[i] = 2
	}
	if got := experimentalFactor(it, 1); got != 0.75 {
		t.Fatal(got)
	}
	it.MonthlySales = it.MonthlySales[:11]
	if got := experimentalFactor(it, 1); got != 1 {
		t.Fatal("short history changed", got)
	}
}

func TestCohortIgnoresPartialMonth(t *testing.T) {
	sales := make([]float64, 25)
	for i := 0; i < 12; i++ {
		sales[i] = 10
		sales[i+12] = 5
	}
	sales[24] = 100000
	if got := historicalCohort(sales); got != "falling" {
		t.Fatal(got)
	}
}
