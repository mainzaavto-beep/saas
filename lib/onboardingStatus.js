// lib/onboardingStatus.js — единая логика статуса первичной загрузки кабинета.
//
// Используется и серверным рендером (app/cabinets/[id]/layout.js), и лёгким
// эндпоинтом опроса (app/api/cabinets/[id]/onboarding-status/route.js) — вынесена
// в общий модуль, чтобы состояния SSR и клиентского опроса не расходились
// (одна и та же классификация по одним и тем же входным данным).
//
// Состояния:
//  - 'broken_keys' — у кабинета есть магазин со сломанными ключами; задание
//    onboarding намеренно возвращается в очередь и висит в 'queued', пока
//    клиент не починит ключи. Важнее всего остального — без этого правила
//    клиент видел бы вечное «загружаем» вместо настоящей причины.
//  - 'loading'     — задание onboarding сейчас в очереди ('queued').
//  - 'failed'      — последнее задание onboarding упало ('failed'), реальный
//    сбой сборки без ретраев, и ни одно задание onboarding для кабинета ещё не
//    завершалось успехом ('done') — то есть клиент рискует остаться без
//    данных вовсе, а не просто ждать доп. магазин к уже работающему кабинету.
//  - 'idle'        — ничего показывать не нужно.
export function classifyOnboarding({ hasBrokenShops, hasQueuedJob, lastJobStatus, everSucceeded }) {
  if (hasBrokenShops) return 'broken_keys';
  if (hasQueuedJob) return 'loading';
  if (lastJobStatus === 'failed' && !everSucceeded) return 'failed';
  return 'idle';
}
