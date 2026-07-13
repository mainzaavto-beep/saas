import CatalogPage from './CatalogPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <CatalogPage cabinetId={Number(params.id)} />;
}
