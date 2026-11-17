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

func isAllDigits(r []rune) bool {
	for _, c := range r {
		if c < '0' || c > '9' {
			return false
		}
	}
	return len(r) > 0
}

// stockAnalysisTokenize: уникальные отсортированные токены нормализованного
// названия (одна токенизация на позицию — это критично на ведомостях в
// десятки тысяч строк, батч-42).
func stockAnalysisTokenize(norm string) []string {
	fields := strings.Fields(norm)
	set := make(map[string]struct{}, len(fields))
	for _, f := range fields {
		runes := []rune(f)
		// Осмысленные токены: от двух символов либо только цифры (размеры
		// «2», «18»); одиночные буквы-предлоги («в», «с») отбрасываются.
		if len(runes) >= 2 || isAllDigits(runes) {
			set[f] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// Процент совпадения названий: доля Жаккара по заранее отсортированным
// уникальным токенам (0..100), без аллокаций. Точное совпадение множеств = 100.
func stockAnalysisJaccard(a, b []string) int {
	i, j, inter := 0, 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			inter++
			i++
			j++
		case a[i] < b[j]:
			i++
		default:
			j++
		}
	}
	union := len(a) + len(b) - inter
	if union == 0 {
		return 0
	}
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

	// 2. Совпадение по названию: инвертированный индекс по токенам склада Б —
	// кандидаты только у позиций с общими словами (батч-42: вместо полного
	// перебора O(nA*nB) на ведомости в 33 тысячи позиций).
	toksA := make([][]string, len(itemsA))
	normA := make([]string, len(itemsA))
	toksB := make([][]string, len(itemsB))
	normB := make([]string, len(itemsB))
	invB := make(map[string][]int, len(itemsB))
	for i := range itemsA {
		normA[i] = stockAnalysisNorm(itemsA[i].Name)
		toksA[i] = stockAnalysisTokenize(normA[i])
	}
	for j := range itemsB {
		normB[j] = stockAnalysisNorm(itemsB[j].Name)
		toksB[j] = stockAnalysisTokenize(normB[j])
		for _, t := range toksB[j] {
			invB[t] = append(invB[t], j)
		}
	}
	sort.Slice(remainingA, func(p, q int) bool {
		return normA[remainingA[p]] < normA[remainingA[q]]
	})
	// Метки поколений обнуляют кандидатов без пересоздания структур.
	candGen := make([]int32, len(itemsB))
	candPair := make([]int32, len(itemsB))
	candScore := make([]int, len(itemsB))
	var gen, pairGen int32
	var candList []int
	for _, i := range remainingA {
		gen++
		pairGen++
		candList = candList[:0]
		la := len(toksA[i])
		for _, t := range toksA[i] {
			for _, j := range invB[t] {
				if consumedB[j] {
					continue
				}
				if candGen[j] != gen {
					candGen[j] = gen
					candList = append(candList, j)
					candPair[j] = 0
				}
				if candPair[j] == pairGen {
					continue
				}
				candPair[j] = pairGen
				lb := len(toksB[j])
				// Верхняя граница Жаккара min(|A|,|B|)/max(|A|,|B|): пары, у
				// которых она ниже порога, не проверяем вовсе.
				lo, hi := la, lb
				if lo > hi {
					lo, hi = hi, lo
				}
				if hi == 0 || lo*100 < stockAnalysisNameThreshold*hi {
					continue
				}
				candScore[j] = stockAnalysisJaccard(toksA[i], toksB[j])
			}
		}
		bestScore, bestJ := 0, -1
		for _, j := range candList {
			sc := candScore[j]
			if sc < stockAnalysisNameThreshold {
				continue
			}
			if bestJ < 0 || sc > bestScore || (sc == bestScore && normB[j] < normB[bestJ]) {
				bestScore, bestJ = sc, j
			}
		}
		if bestJ < 0 {
			continue
		}
		consumedB[bestJ] = true
		rows = append(rows, makeRow(itemsA[i], itemsB[bestJ], bestScore, "название"))
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
