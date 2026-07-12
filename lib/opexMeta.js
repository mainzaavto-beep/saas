// =====================================================================
//  lib/opexMeta.js — единый справочник метаданных для OPEX
//  (контракт №35, заявка №34, расширение domain/source 2026-07-02).
//
//  Раньше CATEGORIES были задублированы в app/api/opex/route.js и
//  app/finance/manual/page.jsx. При добавлении доменов (business/
//  personal/family) третье место плодить не стали — вынесли всё сюда.
//
//  ДОМЕНЫ (domain) — разделяют физически одну таблицу opex на 3 потока:
//    • business  — операционные расходы бизнеса. ТОЛЬКО эти строки
//                  участвуют в P&L (EBITDA) и черновике ДДС — все
//                  бизнес-читатели фильтруют domain='business'.
//    • personal  — личные расходы владельца. В бизнес-финансы НЕ идут.
//    • family    — семейные расходы. В бизнес-финансы НЕ идут.
//
//  ИСТОЧНИК (source) — как запись попала в систему:
//    • manual — введена руками через форму дашборда.
//    • voice  — распознана из голосового сообщения (GLM NER + подтверждение).
//
//  КАТЕГОРИИ — для business это enum P&L (Коммерческие/Административные/
//  Прочие); для personal/family — свободный текст (GLM-категоризация),
//  валидация enum'ом НЕ применяется.
// =====================================================================

export const DOMAINS = ["business", "personal", "family"];

export const DOMAIN_LABELS = {
  business: "Бизнес",
  personal: "Личное",
  family: "Семья",
};

// Короткие подписи для Segmented-контрола и фильтра.
export const DOMAIN_SHORT = {
  business: "Бизнес",
  personal: "Личное",
  family: "Семья",
  all: "Все",
};

// Цвета доменов для бейджей/графиков (из палитры theme.js + семантика).
export const DOMAIN_COLORS = {
  business: "rgba(0,229,255,0.16)",   // акцент-циан
  personal: "rgba(217,176,140,0.18)", // персик (accent2)
  family: "rgba(74,222,128,0.16)",    // зелёный (pos)
};

export const SOURCES = ["manual", "voice"];

export const SOURCE_LABELS = {
  manual: "Ручной",
  voice: "Голос",
};

// УЧЁТ В СЕБЕСТОИМОСТИ (included_in_cogs, 2026-07-03):
// Налогоплательщик может разнести часть OPEX (доставка товара, таможня) на
// cogs конкретных SKU → тогда расход идёт в P&L ЧЕРЕЗ COGS (себестоимость
// проданных), а НЕ как отдельная строка OPEX. Чтобы избежать задвоения в
// прибыли, такие записи помечаются included_in_cogs=1 и ИСКЛЮЧАЮТСЯ из
// fetch_opex/opex_totals (бизнес-P&L путь).
//
// ⚠️ В ДДС (opexObligations) такие записи ОСТАЮТСЯ: P&L (accrual, по факту
// расхода) ≠ ДДС (cash, по факту ухода денег). Деньги со счёта ушли в любом
// случае — кэшфлоу должен их видеть. Решение владельца 2026-07-03.
export const COGS_FLAG_FIELD = "included_in_cogs";

// Категории бизнес-P&L (enum). Для personal/family категория = свободный текст.
export const CATEGORIES = ["Коммерческие", "Административные", "Прочие"];

export const CAT_COLORS = {
  Коммерческие: "rgba(76,175,80,0.18)",
  Административные: "rgba(33,150,243,0.18)",
  Прочие: "rgba(255,152,0,0.18)",
};

/** Допустим ли домен. */
export async function validDomain(d) {
  return DOMAINS.includes(String(d || ""));
}

/** Допустима ли категория. Для business — строго enum; для остальных — любая. */
export async function validCategory(c, domain = "business") {
  if (domain === "business") return CATEGORIES.includes(String(c || ""));
  // personal/family: свободный текст, но не пустой.
  return !!String(c || "").trim();
}

/** Допустим ли источник. */
export async function validSource(s) {
  return SOURCES.includes(String(s || ""));
}

/** Нормализует домен: пусто/недопустимо → 'business' (дефолт и обратная совместимость). */
export async function normDomain(d) {
  return validDomain(d) ? String(d) : "business";
}

/** Нормализует источник: пусто/недопустимо → 'manual'. */
export async function normSource(s) {
  return validSource(s) ? String(s) : "manual";
}
