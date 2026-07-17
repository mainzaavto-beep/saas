export const dynamic = 'force-dynamic';
import WhatsNewPage from "./WhatsNewPage";

export default async function Page({ params }) {
  return <WhatsNewPage cabinetId={Number(params.id)} />;
}
