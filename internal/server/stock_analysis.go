package server

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// Батч-41: «Анализ остатков» — сопоставление товаров двух складов.
// Совпадение: в первую очередь по артикулу (100%), иначе по названию
// (нормализованное сравнение с процентом совпадения, порог 60%).
// «Излишки» на складе А: товарный запас превышает N месяцев (настройка
// пользователя, месяцы = остаток / средние продажи в месяц за 12 мес).
// «Необходим заказ» на складе Б: та же логика, что у «Подсветить заказ» —
// расчётный заказ > 0 либо рейтинг 3+ при остатке ≤ 0.

const stockAnalysisNameThreshold = 60

type stockAnalysisTokens = map[string]bool

func stockAnalysisNorm(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "ё", "е")
	var b strings.Builder
	lastSpace := true
	prevDigit := false
	for _, r := range s {
		isLetter := (r >= 'a' && r <= 'z') || (r >= 'а' && r <= 'я')
		isDigit := r >= '0' && r <= '9'
		if isLetter || isDigit || r == '*' || r == '+' {
			// Граница цифра/буква («500г», «18В») разделяется: это один и тот же
			// товар с разной записью количества/размера.
			if (isDigit != prevDigit) && !lastSpace {
				b.WriteRune(' ')
			}
			b.WriteRune(r)
			lastSpace = false
			prevDigit = isDigit
		} else if !lastSpace {
			b.WriteRune(' ')
			lastSpace = true
			prevDigit = false
		}
	}
	return strings.TrimSpace(b.String())
}

func stockAnalysisTokenSet(norm string) stockAnalysisTokens {
	tokens := stockAnalysisTokens{}
	for _, t := range strings.Fields(norm) {
		if len(t) >= 2 {
			tokens[t] = true
		}
	}
	return tokens
}

// Процент совпадения названий: точное совпадение нормализованных строк = 100,
// иначе доля Жаккара по токенам (0..100). Пары ниже порога отбрасываются.
func stockAnalysisSimilarity(a, b string) int {
	na, nb := stockAnalysisNorm(a), stockAnalysisNorm(b)
	if na == nb {
		return 100
	}
	if na == "" || nb == "" {
		return 0
	}
	ta, tb := stockAnalysisTokenSet(na), stockAnalysisTokenSet(nb)
	if len(ta) == 0 || len(tb) == 0 {
		return 0
	}
	inter := 0
	for t := range ta {
		if tb[t] {
			inter++
		}
	}
	union := len(ta) + len(tb) - inter
	return int(math.Round(float64(inter) / float64(union) * 100))
}

func stockAnalysisMonthsOf(stock, sum12 float64) float64 {
	avg := sum12 / 12
	if avg > 1e-9 {
		return math.Min(999, stock/avg)
	}
	if stock > 0 {
		return 999
	}
	return 0
}

func (s *AppServer) handleStockAnalysis(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "требуется GET")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	whA := strings.TrimSpace(r.URL.Query().Get("whA"))
	whB := strings.TrimSpace(r.URL.Query().Get("whB"))
	if whA == "" || whB == "" {
		writeError(w, 400, "выберите два склада для анализа")
		return
	}
	if whA == whB {
		writeError(w, 400, "склады для анализа должны различаться")
		return
	}
	months := 12.0
	if raw := strings.TrimSpace(r.URL.Query().Get("months")); raw != "" {
		if v, err := strconv.ParseFloat(raw, 64); err == nil && v >= 0.5 && v <= 60 {
			months = v
		}
	}
	if s.report == nil || len(s.report.Items) == 0 {
		writeError(w, 400, "Сначала загрузите текущую ведомость")
		return
	}

	var itemsA, itemsB []model.CalculatedItem
	for _, it := range s.report.Items {
		wh := strings.TrimSpace(it.Warehouse)
		if wh == whA {
			itemsA = append(itemsA, it)
		} else if wh == whB {
			itemsB = append(itemsB, it)
		}
	}
	if len(itemsA) == 0 {
		writeError(w, 400, "На складе «"+whA+"» нет позиций")
		return
	}
	if len(itemsB) == 0 {
		writeError(w, 400, "На складе «"+whB+"» нет позиций")
		return
	}

	rows, matched, bySku, byName := stockAnalysisBuild(itemsA, itemsB, months)
	if r.URL.Path == "/api/stock-analysis/export" {
		raw, err := xlsx.GenerateStockAnalysisXLSX(rows, whA, whB, months)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		sendXLSXAttachment(w, "Анализ остатков, "+time.Now().Format("02.01.2006")+".xlsx", raw)
		return
	}
	writeJSON(w, 200, map[string]any{"rows": rows, "matched": matched, "bySku": bySku, "byName": byName, "months": months, "whA": whA, "whB": whB})
}

func stockAnalysisVerdict(excessA, needB bool, units, value float64) string {
	switch {
	case excessA && needB:
		return "Заказ не требуется: закрыть перетоком со склада А (излишек " + stockAnalysisNum(units) + " шт ≈ " + strconv.FormatFloat(value, 'f', 2, 64) + " руб.)"
	case excessA:
		return "Излишек на складе А; заказ на складе Б не требуется"
	case needB:
		return "Обычный заказ на складе Б"
	default:
		return ""
	}
}

func stockAnalysisNum(v float64) string {
	if v == math.Trunc(v) {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', 1, 64)
}

func stockAnalysisBuild(itemsA, itemsB []model.CalculatedItem, months float64) (rows []xlsx.StockAnalysisRow, matched, bySku, byName int) {
	consumedB := make([]bool, len(itemsB))
	skuIdxB := make(map[string][]int, len(itemsB))
	for j := range itemsB {
		if sku := strings.TrimSpace(itemsB[j].SKU); sku != "" {
			skuIdxB[sku] = append(skuIdxB[sku], j)
		}
	}

	needOrder := func(it model.CalculatedItem) bool {
		return it.FinalOrderQty > 0 || (it.SalesSegment >= 2 && it.ClosingStock <= 0)
	}
	isExcess := func(it model.CalculatedItem) (bool, float64, float64, float64) {
		m := stockAnalysisMonthsOf(it.ClosingStock, it.SumSalesLast12M)
		if it.ClosingStock <= 0 || m <= months {
			return false, m, 0, 0
		}
		avg := it.SumSalesLast12M / 12
		units := it.ClosingStock
		if avg > 1e-9 {
			units = it.ClosingStock - months*avg
		}
		if units < 0 {
			units = 0
		}
		value := units * it.PurchasePrice
		if value < 0 {
			value = 0
		}
		return true, m, units, math.Round(value*100) / 100
	}

	makeRow := func(a, b model.CalculatedItem, score int, matchBy string) xlsx.StockAnalysisRow {
		excess, monthsA, units, value := isExcess(a)
		need := needOrder(b)
		return xlsx.StockAnalysisRow{
			SKU: strings.TrimSpace(b.SKU), Name: b.Name, Group: b.Group,
			MatchScore: score, MatchBy: matchBy,
			WhAStock: a.ClosingStock, WhAMonths: monthsA,
			WhAExcessUnits: math.Round(units*100) / 100, WhAExcessValue: value,
			WhBStock: b.ClosingStock, WhBOrderQty: b.FinalOrderQty, WhBNeedOrder: need,
			Verdict: stockAnalysisVerdict(excess, need, math.Round(units*100)/100, value),
		}
	}

	// 1. Совпадение по артикулу (приоритет).
	var remainingA []int
	for i := range itemsA {
		sku := strings.TrimSpace(itemsA[i].SKU)
		if js, ok := skuIdxB[sku]; ok && sku != "" {
			for _, j := range js {
				if !consumedB[j] {
					consumedB[j] = true
					rows = append(rows, makeRow(itemsA[i], itemsB[j], 100, "артикул"))
					bySku++
					matched++
					sku = ""
					break
				}
			}
			if sku == "" {
				continue
			}
		}
		remainingA = append(remainingA, i)
	}

	// 2. Совпадение по названию: детерминированный перебор оставшихся А,
	// для каждого — лучший свободный кандидат из Б по проценту.
	var remainingB []int
	for j := range itemsB {
		if !consumedB[j] {
			remainingB = append(remainingB, j)
		}
	}
	normsB := make([]string, len(remainingB))
	for k, j := range remainingB {
		normsB[k] = stockAnalysisNorm(itemsB[j].Name)
	}
	sort.Slice(remainingA, func(i, j int) bool {
		return stockAnalysisNorm(itemsA[remainingA[i]].Name) < stockAnalysisNorm(itemsA[remainingA[j]].Name)
	})
	usedB := make([]bool, len(remainingB))
	for _, i := range remainingA {
		normA := stockAnalysisNorm(itemsA[i].Name)
		bestScore, bestK := 0, -1
		for k := range remainingB {
			if usedB[k] {
				continue
			}
			score := stockAnalysisSimilarity(normA, normsB[k])
			if score >= stockAnalysisNameThreshold && (score > bestScore || (score == bestScore && bestK >= 0 && normsB[k] < normsB[bestK])) {
				bestScore, bestK = score, k
			}
		}
		if bestK < 0 {
			continue
		}
		usedB[bestK] = true
		rows = append(rows, makeRow(itemsA[i], itemsB[remainingB[bestK]], bestScore, "название"))
		byName++
		matched++
	}

	// В таблице остаются только осмысленные пары: излишек на А или заказ на Б;
	// первыми — самые крупные излишки в рублях.
	filtered := make([]xlsx.StockAnalysisRow, 0, len(rows))
	for _, r := range rows {
		if r.WhAExcessUnits > 0 || r.WhBNeedOrder {
			filtered = append(filtered, r)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		if a.WhAExcessValue != b.WhAExcessValue {
			return a.WhAExcessValue > b.WhAExcessValue
		}
		if a.WhBNeedOrder != b.WhBNeedOrder {
			return a.WhBNeedOrder
		}
		return a.Name < b.Name
	})
	return filtered, matched, bySku, byName
}
