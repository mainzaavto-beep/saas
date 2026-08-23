import { Suspense } from "react";
import DetailPage from "./DetailPage";
import { C } from "@/lib/palette.js";

export default async function Page({ params }) {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: C.muted }}>Загрузка...</div>}>
      <DetailPage cabinetId={Number(params.id)} />
    </Suspense>
  );
}
