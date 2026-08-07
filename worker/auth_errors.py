"""Отличить «ключи не работают» от обычного сбоя.

Останавливать сбор можно только из-за отказа в доступе (401/403). Сетевые
сбои, 429 и пятисотые — обычное поведение маркетплейсов, из-за них магазин
на паузу не ставим. Смотрим на текст ошибки сборщика: явного кода выхода у
сборщиков пока нет, а переписывать два десятка файлов ради этого — лишнее.
"""
import re

# Каждый шаблон — узкий, чтобы случайное «403» в данных не считалось отказом.
_PATTERNS = [
    re.compile(r"\bOzon API 40[13]\b", re.I),          # ozon_client: "Ozon API 403 [7]: ..."
    re.compile(r"\b40[13] Client Error\b", re.I),      # requests.raise_for_status()
    re.compile(r"Api-Key is missing", re.I),           # Ozon: ключ без нужной роли
    re.compile(r"\bUnauthorized\b", re.I),
    re.compile(r"\bForbidden\b", re.I),
    re.compile(r"токен[^\n]{0,40}(недействителен|истёк|истек)", re.I),
]


def is_auth_error(text):
    """Похоже ли сообщение об ошибке на отказ авторизации."""
    if not text:
        return False
    return any(p.search(str(text)) for p in _PATTERNS)
