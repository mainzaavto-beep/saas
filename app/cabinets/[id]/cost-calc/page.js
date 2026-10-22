import CostCalcPage from "./CostCalcPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <CostCalcPage cabinetId={Number(params.id)} />;
}
