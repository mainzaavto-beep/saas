import SummaryPage from "./SummaryPage";
export default async function Page({ params }) {
  return <SummaryPage cabinetId={Number(params.id)} />;
}
