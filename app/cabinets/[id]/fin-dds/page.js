import DdsPage from './DdsPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <DdsPage cabinetId={Number(params.id)} />;
}
