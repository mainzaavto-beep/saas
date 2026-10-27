// app/cabinets/[id]/fin-purchases/[orderId]/styles.js — общие inline-стили карточки заказа
// (инпуты/кнопки), чтобы не дублировать их в OrderPage/OrderLines/OrderPayments/OrderShipments.
import { C } from "@/lib/palette.js";

export const inp = { padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 };
export const btn = { padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.ink, cursor: "pointer", fontSize: 13 };
