// lib/triageMail.js — текст письма авторазбора падений (спека
// docs/superpowers/specs/2026-09-30-failure-triage-design.md §6). Чистая функция:
// отправка и выборка — scripts/notify-triage.mjs.

const fmtDate = (v) => (v ? new Date(v).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "—");

export function formatTriageMail(ep, base) {
  const where = ep.cabinet_id == null ? "сервер" : `каб. ${ep.cabinet_id}`;
  const link = `${base}/health#triage-${ep.id}`;
  const r = ep.report_json;
  if (!r) {
    return {
      subject: `[разбор не удался] ${ep.collector} · ${where}`,
      text: [
        `Сборщик ${ep.collector} (${where}) падает с ${fmtDate(ep.opened_at)}, автоматический разбор не удался.`,
        "",
        `Последняя ошибка прогона: ${ep.last_error || "—"}`,
        `Почему не удался разбор: ${String(ep.raw_output || "—").split("\n")[0]}`,
        "",
        "Нужно посмотреть вручную.",
        link,
      ].join("\n"),
    };
  }
  const fixed = ep.status === "closed" ? " — уже починилось" : "";
  return {
    subject: `${r.urgent ? "🔴 " : ""}[разбор] ${ep.collector} · ${where} — ${r.cause} (${r.confidence})${fixed}`,
    text: [
      `Сборщик ${ep.collector} (${where}) падает с ${fmtDate(ep.opened_at)}.`,
      fixed ? `Пока шёл разбор, сборщик снова отработал успешно (${fmtDate(ep.closed_at)}).` : "",
      "",
      `Итог: ${r.summary}`,
      "",
      `Предлагаемый фикс: ${r.proposed_fix}`,
      "",
      `Последствия для данных: ${r.data_impact}`,
      "",
      `Подробно (доказательства): ${link}`,
    ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
  };
}
