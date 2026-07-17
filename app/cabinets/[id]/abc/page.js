export const dynamic = 'force-dynamic';
import AbcPage from "./AbcPage";

export default async function Page({ params }) {
  const cabinetId = Number(params.id);
  return <AbcPage cabinetId={cabinetId} />;
}
