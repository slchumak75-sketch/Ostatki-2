# -*- coding: utf-8 -*-
"""Анализ исходной ведомости: структура, прибыльность, сезонность, качество данных.
Вывод этого скрипта — источник цифр для docs/ANALYSIS.md. Запуск: python3 tools/analyze.py
"""
import glob
import os
import statistics
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forecast import compute, summarize, DEFAULT_PARAMS  # noqa: E402
from read_xlsx import load  # noqa: E402


def fmt(x):
    return f"{x:,.0f}".replace(",", " ") if isinstance(x, (int, float)) else str(x)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    files = [f for f in glob.glob(os.path.join(root, "*.xlsx")) if "закуп" not in f.lower()]
    if not files:
        print("xlsx не найден в корне репозитория")
        return 1
    path = files[0]
    print(f"Файл: {os.path.basename(path)}")
    rows, months, meta = load(path)
    print(f"Лист: {meta['sheet']}, заголовки в строке {meta['headerRow']}, "
          f"столбец «К закупке» = №{meta['purchaseCol']}, месяцев: {len(months)} "
          f"({months[0]}..{months[-1]}), товаров: {len(rows)}")
    print("Склады:", Counter(r["warehouse"] for r in rows))
    print("Группы:", Counter(r["group"] for r in rows))
    print("Ед.изм:", Counter(r["unit"] for r in rows).most_common())
    print("Поставщиков:", len(Counter(r["supplier"] for r in rows)))

    state = summarize(compute(rows, months, DEFAULT_PARAMS), rows)
    s = state["summary"]
    print("\n== СВОДКА ==")
    for k, v in s.items():
        print(f"{k}: {fmt(v) if isinstance(v, (int, float)) else v}")
    print("\nСезонность (глобальная):", state["seasonalGlobal"])
    for g, idx in state["seasonalByGroup"].items():
        print(f"Сезонность [{g}]:", idx)
    print("\nПредупреждения:")
    for w in state["warnings"]:
        print(" -", w)
    print("\nПоставщики (бюджет закупки по убыванию):")
    for a in state["suppliersAgg"][:10]:
        print(f"  {a['orderBudget']:>10,.0f}  SKU к закупке={a['orderSku']:<4} {a['name']}")
    print("\nТОП-15 к закупке по сумме заказа:")
    for r in sorted(state["rows"], key=lambda x: -x["orderCost"])[:15]:
        print(f"  {r['orderCost']:>8,.0f}  к закупке={r['recommend']:<6.0f} остаток={r['stock']:<5.0f} "
              f"продаж12={r['sales12']:<6.0f} {r['name']}")
    # распределение по статусам
    print("\nСтатусы:", Counter(r["status"] for r in state["rows"]))
    print("ABC:", Counter(r["abc"] for r in state["rows"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
