// lib/useSort.js — сортировка кликабельных колонок таблиц (общий хук).
// Перенесено дословно из app/cabinets/[id]/stocks/StocksPage.jsx:56-80 (задача 5
// плана «Склады 2.0, этап 4»), чтобы не плодить третью копию (была в Stocks и
// BuyerPortrait). SortTh (компонент <th> со стрелкой) остаётся локальным в каждой
// странице — он использует JSX и завязан на местные thLeft/thR.
import { useState } from "react";

// null/undefined трактуются как «большое» (проваливаются вниз при asc, вверх при desc).
const NULL_BIG = Number.POSITIVE_INFINITY;
export function cmpVal(a, b) {
  const av = a == null ? NULL_BIG : a;
  const bv = b == null ? NULL_BIG : b;
  if (typeof av === "string" || typeof bv === "string") {
    return String(av).localeCompare(String(bv), "ru");
  }
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export function useSort(initialKey, initialDir = "desc") {
  const [s, setS] = useState({ key: initialKey, dir: initialDir });
  const toggle = (key) =>
    setS((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: initialDir }
    );
  const apply = (rows, spec) => {
    if (!s.key || !spec[s.key]) return rows;
    const getter = spec[s.key];
    const mul = s.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => mul * cmpVal(getter(a), getter(b)));
  };
  return { sort: s, toggle, apply };
}
