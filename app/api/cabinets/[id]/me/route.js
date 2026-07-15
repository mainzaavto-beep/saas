// /api/cabinets/[id]/me — роль текущего юзера в кабинете.
// Лёгкий GET для UI: чтобы страницы могли скрывать кнопки мутаций по своей роли.
// Возвращает { role } ('owner' | 'manager' | 'viewer'). withCabinet уже проверил
// membership (403 если нет доступа), mem[0].role прокинут в cabinet.role.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  return NextResponse.json({ role: cabinet.role });
});
