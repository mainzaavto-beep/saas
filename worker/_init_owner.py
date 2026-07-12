"""Создание владельца (owner) SaaS + cabinet_id=1 с зашифрованными боевыми токенами.

Читает боевые WB_TOKEN/OZON_* из Machine env, шифрует через pgp_sym_encrypt,
создаёт auth.users (owner) + auth.cabinets (cabinet_id=1) + membership(owner).
api_creds = не-секретные флаги, api_creds_enc = зашифрованный полный JSON.
"""
import os
import sys
import json
import psycopg
from psycopg.rows import dict_row

# Боевые токены из Machine env (НЕ показываем в выводе).
WB_TOKEN = os.environ.get("WB_TOKEN", "")
WB_FEEDBACKS = os.environ.get("WB_TOKEN_FEEDBACKS", "") or WB_TOKEN
OZ_CID = os.environ.get("OZON_CLIENT_ID", "")
OZ_KEY = os.environ.get("OZON_API_KEY", "")
OZ_PERF_ID = os.environ.get("OZON_PERF_CLIENT_ID", "")
OZ_PERF_SECRET = os.environ.get("OZON_PERF_CLIENT_SECRET", "")

assert WB_TOKEN, "WB_TOKEN не найден в Machine env"
assert OZ_CID and OZ_KEY, "OZON_CLIENT_ID/API_KEY не найдены"

# Пароль владельца для входа в SaaS (bcrypt-хеш).
import bcrypt
OWNER_PASSWORD = "owner2026"  # сообщить владельцу
pw_hash = bcrypt.hashpw(OWNER_PASSWORD.encode(), bcrypt.gensalt(10)).decode()

# Полные credentials (секреты) — для шифрования.
full_creds = {
    "wb": {"token": WB_TOKEN, "token_feedbacks": WB_FEEDBACKS},
    "ozon": {"client_id": OZ_CID, "api_key": OZ_KEY,
             "perf_client_id": OZ_PERF_ID, "perf_client_secret": OZ_PERF_SECRET},
}
full_json = json.dumps(full_creds, ensure_ascii=False)

# Не-секретная структура (флаги).
meta = {
    "wb": {"has_token": True},
    "ozon": {"has_client_id": True, "has_api_key": True,
             "has_perf": bool(OZ_PERF_ID and OZ_PERF_SECRET)},
}

# Подключение как postgres (создаём auth-записи — без RLS).
PG = dict(host="localhost", port=5432, dbname="saas", user="postgres",
          password=os.environ["POSTGRES_PASSWORD"])
ENC_KEY = os.environ["SAAS_CRED_MASTER_KEY"]

with psycopg.connect(**PG, row_factory=dict_row) as conn:
    # Owner (user_id=1).
    conn.execute("""
        INSERT INTO auth.users (user_id, email, password_hash, name, status)
        VALUES (1, 'owner@sysell.ru', %s, 'Владелец', 'active')
        ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status='active'
    """, (pw_hash,))
    # Cabinet (cabinet_id=1).
    conn.execute("""
        INSERT INTO auth.cabinets (cabinet_id, owner_user_id, display_name, marketplaces,
                                   api_creds, api_creds_enc, tax_mode, status)
        VALUES (1, 1, 'Мой кабинет (боевой)', '{wb,ozon}',
                %s, pgp_sym_encrypt(%s, %s),
                '{"usn_pct": 6, "vat": false}'::jsonb, 'active')
        ON CONFLICT (cabinet_id) DO UPDATE SET
            api_creds = EXCLUDED.api_creds,
            api_creds_enc = EXCLUDED.api_creds_enc,
            status = 'active'
    """, (json.dumps(meta, ensure_ascii=False), full_json, ENC_KEY))
    # Membership (owner role).
    conn.execute("""
        INSERT INTO auth.memberships (user_id, cabinet_id, role)
        VALUES (1, 1, 'owner')
        ON CONFLICT (user_id, cabinet_id) DO UPDATE SET role = 'owner'
    """)
    # Проверка: расшифровка round-trip.
    row = conn.execute("SELECT pgp_sym_decrypt(api_creds_enc::bytea, %s) AS p FROM auth.cabinets WHERE cabinet_id=1", (ENC_KEY,)).fetchone()
    dec = json.loads(row["p"])
    print(f"OK: owner + cabinet_id=1 создан. Расшифровка: wb.token={'set' if dec.get('wb',{}).get('token') else 'MISSING'}, ozon.client_id={dec.get('ozon',{}).get('client_id','?')}")
    print(f"Login: owner@sysell.ru / пароль: {OWNER_PASSWORD}")
