import InventoryPage from "./InventoryPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <InventoryPage cabinetId={Number(params.id)} />;
}
