import MovePage from './MovePage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <MovePage cabinetId={Number(params.id)} />;
}
