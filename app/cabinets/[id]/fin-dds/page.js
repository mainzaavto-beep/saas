import { Suspense } from 'react';
import DdsPage from './DdsPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <Suspense fallback={null}><DdsPage cabinetId={Number(params.id)} /></Suspense>;
}
