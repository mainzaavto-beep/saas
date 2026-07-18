import StocksPage from "./StocksPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <StocksPage cabinetId={Number(params.id)} />;
}
