import { Suspense } from "react";
import DetailPage from "./DetailPage";

export default async function Page({ params }) {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: "#8a99b8" }}>Загрузка...</div>}>
      <DetailPage cabinetId={Number(params.id)} />
    </Suspense>
  );
}
