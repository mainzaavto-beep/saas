export const dynamic = 'force-dynamic';
import SupportPage from "./SupportPage";

export default async function Page({ params }) {
  return <SupportPage cabinetId={Number(params.id)} />;
}
