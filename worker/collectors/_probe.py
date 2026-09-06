"""Режим пробы сборщиков: SAAS_PROBE=1 — печатать сырой ответ API и НЕ писать в БД;
SAAS_PROBE=verify — сверить ответ API с БД (реализуют сборщики остатков).
Переменную пробрасывает orchestrator._env_for_shop (whitelist SAFE_INHERIT её не
пропускает). Живая проба = только кабинет #1."""
import json
import os


def mode() -> str:
    return (os.getenv("SAAS_PROBE") or "").strip().lower()


def is_probe() -> bool:
    return mode() != ""


def dump(label, obj, n=3):
    sample = obj[:n] if isinstance(obj, list) else obj
    total = f" (всего {len(obj)})" if isinstance(obj, list) else ""
    print(f"[probe] {label}{total}: {json.dumps(sample, ensure_ascii=False, default=str)[:4000]}", flush=True)
