import { Suspense } from 'react';
import RoadWatch from '@/components/roadwatch';
export default function Page() {
  return (
    <Suspense fallback={<div className="loading-workspace">Opening workspace…</div>}>
      <RoadWatch section="overview" />
    </Suspense>
  );
}
