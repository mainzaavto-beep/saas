"use client";
// app/cabinets/[id]/warehouses/SuppliesTab.jsx — вкладка «Поставки» витрины «Склады 2.0»
// (задача 6 плана, этап 4). Переиспользует страницу /shipments целиком в embedded-режиме
// (без собственного заголовка — он уже есть в WarehousesPage).
import ShipmentsPage from "../shipments/ShipmentsPage";

export function SuppliesTab({ cabinetId }) {
  return <ShipmentsPage cabinetId={cabinetId} embedded />;
}
