import GeoPage from './GeoPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <GeoPage cabinetId={Number(params.id)} />;
}
