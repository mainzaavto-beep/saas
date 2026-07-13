import OpexPage from './OpexPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <OpexPage cabinetId={Number(params.id)} />;
}
