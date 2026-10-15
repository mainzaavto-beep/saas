import KpiPage from "./KpiPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <KpiPage cabinetId={Number(params.id)} />;
}
