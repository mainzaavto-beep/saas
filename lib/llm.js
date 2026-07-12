// Единая точка token-routing'а для ИИ-вызовов дашборда (правило #181).
//
// Две модели:
//   • SMART (glm-5.2, платная)  — сложная аналитика, ответы агентов в чате,
//     интерпретация рисков. Здесь нужен интеллект/рассуждения над данными.
//   • CHEAP (glm-4.6, бесплатная) — рутина: черновики ответов на отзывы,
//     генерация заголовков/описаний/пересказов, текстовые сводки готовых данных.
//
// Все новые ИИ-вызовы в дашборде должны идти ЧЕРЕЗ ЭТОТ модуль (askSmart /
// askCheap), а не создавать OpenAI-клиент напрямую — иначе нарушится правило
// экономии токенов и снова уйдём в квоту.
//
// Источник моделей: env ZAI_MODEL / ZAI_MODEL_SMART (умная) и ZAI_MODEL_CHEAP
// (бесплатная). Дефолты — glm-5.2 / glm-4.6 (как в Avito-agent/.env).

import OpenAI from "openai";

export const ZAI_API_KEY = process.env.ZAI_API_KEY || "";
export const ZAI_BASE_URL =
  process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4";
export const MODEL_SMART = process.env.ZAI_MODEL_SMART || process.env.ZAI_MODEL || "glm-5.2";
export const MODEL_CHEAP = process.env.ZAI_MODEL_CHEAP || "glm-4.6";

let _client = null;

/** Общий OpenAI-совместимый клиент ZAI (ленивый синглтон). */
export async function getClient() {
  if (!_client) {
    if (!ZAI_API_KEY) return null;
    _client = new OpenAI({ apiKey: ZAI_API_KEY, baseURL: ZAI_BASE_URL });
  }
  return _client;
}

/**
 * Простой текстовый запрос к LLM (без tools). Выбирает модель сам по флагу smart.
 * @param {string} prompt — user-сообщение (уже собранный, с данными).
 * @param {object} opts — { system, smart=false, maxTokens=2000, temperature=0.4 }
 * @returns {string|null} — текст ответа или null при недоступности/ошибке.
 *
 * По умолчанию smart=false → CHEAP (glm-4.6) — рутину гоним бесплатно (правило #181).
 * Передав smart=true только для сложной аналитики/ответов агента.
 */
export async function ask(prompt, opts = {}) {
  const client = getClient();
  if (!client) return null;
  const {
    system = null,
    smart = false,
    maxTokens = 2000,
    temperature = 0.4,
  } = opts;
  const model = smart ? MODEL_SMART : MODEL_CHEAP;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  try {
    const resp = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages,
    });
    return (resp.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    // Не роняем вызывающий код — возвращаем null, он решает что делать (fallback).
    console.error("[llm] error:", String(e?.message || e).slice(200));
    return null;
  }
}

/** Рутина: черновики отзывов, тексты, сводки — glm-4.6 (бесплатно). */
export async function askCheap(prompt, opts = {}) {
  return ask(prompt, { ...opts, smart: false });
}

/** Сложное: аналитика, ответы агента — glm-5.2 (платно, но умнее). */
export async function askSmart(prompt, opts = {}) {
  return ask(prompt, { ...opts, smart: true });
}

/** Доступен ли LLM вообще (есть ли ключ). */
export async function llmAvailable() {
  return !!ZAI_API_KEY;
}
