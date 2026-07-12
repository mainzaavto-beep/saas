"""Сырой тест WB reportDetail для старых дат (диагностика зависания backfill)."""
import os, sys, requests, json, psycopg
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))
pg = dict(host="localhost", port=5432, dbname="saas", user="postgres",
          password=os.environ["POSTGRES_PASSWORD"])
c = psycopg.connect(**pg)
r = c.execute("SELECT pgp_sym_decrypt(api_creds_enc::bytea,%s) FROM auth.cabinets WHERE cabinet_id=1",
              [os.environ["SAAS_CRED_MASTER_KEY"]]).fetchone()
tok = json.loads(r[0])["wb"]["token"]
url = "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod"
# Тест 3 окон: май (старый), июнь (средний), июль (свежий).
for df, dt in [("2026-05-01", "2026-05-07"), ("2026-06-01", "2026-06-07"), ("2026-07-01", "2026-07-07")]:
    params = {"dateFrom": df, "dateTo": dt, "rrdid": 0, "limit": 100000, "period": "daily"}
    resp = requests.get(url, headers={"Authorization": tok}, params=params, timeout=90)
    ra = resp.headers.get("Retry-After")
    rows = len(resp.json()) if (resp.status_code == 200 and resp.text.strip()) else "N/A"
    print(f"  {df}..{dt}: status={resp.status_code} rows={rows} retry-after={ra} bodylen={len(resp.text)}")
