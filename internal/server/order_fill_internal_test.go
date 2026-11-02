package server

import (
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// Товары с рейтингом продаж 2+ при нулевом остатке всегда остаются в заказе:
// если алгоритм дал ноль — ставится минимум одна упаковка.
func TestRatedZeroStockMinimum(t *testing.T) {
	it := model.CalculatedItem{}
	it.SalesSegment = 2
	it.ClosingStock = 0
	if got := ratedZeroStockMinimum(it, 0); got != 1 {
		t.Fatalf("rated zero-stock row must get 1, got %d", got)
	}
	it.ClosingStock = -2
	if got := ratedZeroStockMinimum(it, 0); got != 1 {
		t.Fatalf("negative stock counts as zero, got %d", got)
	}
	it.ClosingStock = 5
	if got := ratedZeroStockMinimum(it, 0); got != 0 {
		t.Fatalf("non-zero stock must keep algorithm zero, got %d", got)
	}
	it.ClosingStock = 0
	it.SalesSegment = 1
	if got := ratedZeroStockMinimum(it, 0); got != 0 {
		t.Fatalf("rating below 2 must keep algorithm zero, got %d", got)
	}
	it.SalesSegment = 5
	if got := ratedZeroStockMinimum(it, 7); got != 7 {
		t.Fatalf("algorithm quantity must win, got %d", got)
	}
}
