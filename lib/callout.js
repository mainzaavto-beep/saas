// =====================================================================
//  lib/callout.js — единый набор стилей для инфо/предупреждающих/
//  критичных плашек (замена ~8 дублированных per-page const ALERT).
//
//  Перенос без изменений: значения совпадают с тем, что было в каждой
//  странице (background/border/color), просто выражены через C/soft()
//  из lib/palette.js вместо сырых rgba().
// =====================================================================

import { C, soft } from "@/lib/palette.js";

export const ALERT = {
  info: {
    background: soft("accent", 12),
    border: `1px solid ${soft("accent", 35)}`,
    color: C.accent,
  },
  warn: {
    background: soft("warn", 12),
    border: `1px solid ${soft("warn", 35)}`,
    color: C.warn,
  },
  critical: {
    background: soft("neg", 12),
    border: `1px solid ${soft("neg", 35)}`,
    color: C.neg,
  },
};
