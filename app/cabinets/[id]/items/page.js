import ItemsPage from "./ItemsPage";
export default async function Page({ params }) {
  return <ItemsPage cabinetId={Number(params.id)} />;
}
