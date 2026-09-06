"""Режим пробы сборщиков: SAAS_PROBE=1 — печатать сырой ответ API и НЕ писать в БД;
SAAS_PROBE=verify — сверить ответ API с БД (реализуют сборщики остатков).
Переменную пробрасывает orchestrator._env_for_shop (whitelist SAFE_INHERIT её не
пропускает). Живая проба = только кабинет #1."""
import json
import os

_VALID_MODES = {"", "1", "verify"}
_banner_printed = False  # печатаем баннер один раз за процесс (is_probe вызывается многократно)


def mode() -> str:
    """SAAS_PROBE после strip/lower — только "", "1" или "verify"; любое другое
    значение (опечатка вроде "тру"/"2") — громкий отказ, а не тихая работа как
    обычный прогон (ревью раунд 1, 2026-09-06)."""
    raw = (os.getenv("SAAS_PROBE") or "").strip().lower()
    if raw not in _VALID_MODES:
        raise RuntimeError(f"SAAS_PROBE={raw!r}: допустимо только 1|verify")
    return raw


def is_probe() -> bool:
    global _banner_printed
    result = mode() != ""
    if result and not _banner_printed:
        print("[probe] ПРОБА — запись в БД отключена", flush=True)
        _banner_printed = True
    return result


def dump(label, obj, n=3):
    sample = obj[:n] if isinstance(obj, list) else obj
    total = f" (всего {len(obj)})" if isinstance(obj, list) else ""
    print(f"[probe] {label}{total}: {json.dumps(sample, ensure_ascii=False, default=str)[:4000]}", flush=True)
