import PurchaseNeedPage from "./PurchaseNeedPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <PurchaseNeedPage cabinetId={Number(params.id)} />;
}
