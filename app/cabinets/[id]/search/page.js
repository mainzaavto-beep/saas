import SearchPage from "./SearchPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <SearchPage cabinetId={Number(params.id)} />;
}
