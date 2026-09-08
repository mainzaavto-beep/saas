"use client";
// app/cabinets/[id]/warehouses/PlacesTab.jsx — вкладка «Места» витрины «Склады 2.0» (задача 6
// плана, этап 4). Один запрос GET ?tab=places отдаёт signals+settings+places+fboWarehouses+
// locations+sellerWarehouses+items (см. app/api/cabinets/[id]/warehouses/route.js,
// lib/warehousesMetrics.js buildPlaceCards). Роль — GET /api/cabinets/[id]/me, как в
// ShipmentsPage.jsx:38-51: без manager/owner кнопки «Перемещение»/«Инвентаризация»/«Привязать»
// скрыты (карточки — только для чтения).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/palette.js";
import { PlaceCard, UnboundWarehousesCard } from "./PlaceCard";
import { FboCard } from "./FboCard";
import { InventoryModal } from "./InventoryModal";
import { TransferFormModal } from "../inventory/TransferFormModal";
import { LocationsManager } from "../inventory/LocationsManager";

const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 };
const sectionTitle = { fontSize: 14, fontWeight: 700, margin: "18px 0 10px" };

export function PlacesTab({ cabinetId, onSignals }) {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [transferPlace, setTransferPlace] = useState(null); // место для TransferFormModal (fromLocationId)
  const [inventoryPlace, setInventoryPlace] = useState(null); // место для InventoryModal
  const [toast, setToast] = useState(null);
  const settingsRef = useRef(null);

  const canManage = role === "manager" || role === "owner";

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/warehouses?tab=places`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        onSignals?.(d.signals);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSignals — сеттер из useState родителя, стабилен
  }, [cabinetId]);

  useEffect(() => {
    reload();
    fetch(`/api/cabinets/${cabinetId}/me`).then((r) => r.json()).then((me) => setRole(me?.role || null)).catch(() => {});
  }, [cabinetId, reload]);

  // Тип склада (kind) в places[] не приходит (buildPlaceCards его не кладёт) — берём из
  // sellerWarehouses того же ответа. Хук объявлен до ранних return'ов: порядок хуков.
  const kindByWarehouse = useMemo(
    () => new Map((data?.sellerWarehouses || []).map((w) => [`${w.platform}:${w.warehouse_id}`, w.kind])),
    [data]
  );

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const openSettings = () => {
    setShowSettings(true);
    setTimeout(() => settingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  if (error) return <div style={{ color: C.neg, padding: 16 }}>⚠️ Ошибка: {error}</div>;
  if (loading && !data) return <div style={{ color: C.muted, padding: 16 }}>Загрузка…</div>;
  if (!data) return null;

  const places = data.places || [];
  const fboWarehouses = data.fboWarehouses || [];
  const items = data.items || [];
  const minDays = data.settings?.minDays;
  // Непривязанные склады продавца — не карточками по штуке, а одной сводной (ревью финальной
  // волны): десяток пустышек без метрик выдавливал настоящие места из первого экрана.
  // buildPlaceCards не трогаем — группировка чисто в UI; kind добираем из sellerWarehouses.
  const boundPlaces = places.filter((p) => !p.unbound);
  const unboundList = places
    .filter((p) => p.unbound)
    .map((p) => ({ ...p, kind: kindByWarehouse.get(`${p.platform}:${p.warehouse_id}`) || null }));

  return (
    <div>
      <div style={sectionTitle}>Места (ФФ и склады)</div>
      {boundPlaces.length === 0 && unboundList.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.muted, border: `1px dashed ${C.line}`, borderRadius: 10 }}>
          Мест пока нет. Создайте хотя бы одно в «⚙ Настройки мест» ниже.
        </div>
      ) : (
        <div style={grid}>
          {boundPlaces.map((p) => (
            <PlaceCard
              key={p.id}
              place={p}
              minDays={minDays}
              canManage={canManage}
              onTransfer={() => setTransferPlace(p)}
              onInventory={() => setInventoryPlace(p)}
            />
          ))}
          <UnboundWarehousesCard items={unboundList} canManage={canManage} onBind={openSettings} />
        </div>
      )}

      <div style={sectionTitle}>FBO-склады маркетплейсов</div>
      {fboWarehouses.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.muted, border: `1px dashed ${C.line}`, borderRadius: 10 }}>
          Нет данных по FBO-складам.
        </div>
      ) : (
        <div style={grid}>
          {fboWarehouses.map((f) => (
            <FboCard key={f.key} fbo={f} minDays={minDays} onOpenSupplies={() => router.push("?tab=supplies")} />
          ))}
        </div>
      )}

      <div ref={settingsRef} style={{ marginTop: 22 }}>
        <button
          onClick={() => setShowSettings((v) => !v)}
          style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 13, fontWeight: 600, padding: 0, marginBottom: showSettings ? 10 : 0 }}
        >
          {showSettings ? "▾" : "▸"} ⚙ Настройки мест
        </button>
        {showSettings && (
          <LocationsManager cabinetId={cabinetId} locations={data.locations || []} sellerWarehouses={data.sellerWarehouses || []} reload={reload} />
        )}
      </div>

      {transferPlace && (
        <TransferFormModal
          cabinetId={cabinetId}
          items={items}
          locations={data.locations || []}
          fromLocationId={transferPlace.id}
          onClose={() => setTransferPlace(null)}
          onDone={() => { setTransferPlace(null); reload(); }}
        />
      )}

      {inventoryPlace && (
        <InventoryModal
          cabinetId={cabinetId}
          place={inventoryPlace}
          items={items}
          onClose={() => setInventoryPlace(null)}
          onDone={(msg) => { setInventoryPlace(null); reload(); flash(msg); }}
        />
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 1100,
          background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 10,
          padding: "12px 18px", color: C.ink, fontSize: 13, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
