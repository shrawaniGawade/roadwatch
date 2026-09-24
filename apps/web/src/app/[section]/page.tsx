import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import RoadWatch from '@/components/roadwatch';
const sections = [
  'overview',
  'defects',
  'roads',
  'fleet',
  'surveys',
  'maintenance',
  'reports',
  'settings',
];
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!sections.includes(section)) notFound();
  return (
    <Suspense fallback={<div className="loading-workspace">Opening workspace…</div>}>
      <RoadWatch section={section} />
    </Suspense>
  );
}
