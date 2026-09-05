import { NextResponse } from 'next/server';
import { loadPublicOverview } from '@/lib/prediction-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await loadPublicOverview(), {
    headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' },
  });
}
