// scripts/lib/pgpass.mjs — учётные данные для проверочных скриптов.
//
// Смоуки заводят и удаляют тестовые записи в auth.*, где у saas_app нет DELETE,
// поэтому им нужен postgres. С 2026-08-08 админский пароль лежит не в ~/.pgpass,
// а в отдельном файле: в ~/.pgpass остался только saas_ro, у которого прав на
// запись нет вовсе. Так случайная или необдуманная запись в боевую БД требует
// осознанного шага — указать файл явно:
//
//   PGPASSFILE=/root/.pgpass-admin node scripts/smoke-auth-phase0.mjs
//
// Ошибка при отсутствии файла намеренно подробная: без неё скрипт падал бы
// невнятным «нет строки postgres», не подсказывая, что делать.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const ADMIN_PGPASS = '/root/.pgpass-admin';

function readPgpassLine(file, user) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`не читается файл паролей ${file}: ${e.message}`);
  }
  const line = text.split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(':'))
    .find((p) => p[3] === user);
  if (!line) throw new Error(`в ${file} нет строки для пользователя ${user}`);
  return line;
}

export function adminPgConfig(user = 'postgres') {
  const file = process.env.PGPASSFILE || `${homedir()}/.pgpass`;
  let line;
  try {
    line = readPgpassLine(file, user);
  } catch (e) {
    throw new Error(`${e.message}\nЗапускайте так: PGPASSFILE=${ADMIN_PGPASS} node <скрипт>`);
  }
  return {
    host: 'localhost',
    port: Number(line[1]) || 5432,
    database: process.env.SAAS_DB || 'saas',
    user,
    password: line[4],
  };
}

// Сторожевые проверки (сверка с эталоном и т.п.) не должны иметь возможности
// писать в боевую БД — иначе сторож в принципе мог бы подогнать данные под
// себя. saas_ro физически не имеет прав на запись (GRANT только SELECT), и
// его пароль — единственное, что осталось в обычном ~/.pgpass после переноса
// админского пароля в ADMIN_PGPASS (см. комментарий выше). Поэтому здесь
// файл читается ИЗ ~/.pgpass напрямую, без PGPASSFILE-переопределения: даже
// если вызывающий скрипт унаследовал PGPASSFILE=/root/.pgpass-admin из
// окружения (например, скопировал команду смоука), readonlyPgConfig всё
// равно возьмёт пароль read-only роли, а не админский.
export function readonlyPgConfig(user = 'saas_ro') {
  const file = `${homedir()}/.pgpass`;
  const line = readPgpassLine(file, user);
  return {
    host: 'localhost',
    port: Number(line[1]) || 5432,
    database: process.env.SAAS_DB || 'saas',
    user,
    password: line[4],
  };
}
