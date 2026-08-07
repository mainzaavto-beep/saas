import BillingPage from './BillingPage.jsx';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <BillingPage cabinetId={Number(params.id)} />;
}
