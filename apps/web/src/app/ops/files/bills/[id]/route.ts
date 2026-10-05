import { openBillForStaff, ServiceError } from '@solar/db';
import { can } from '@solar/domain';
import { actorOf, getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getStorage } from '@/lib/storage';

/** Streams a bill to signed-in staff. Every access is logged by openBillForStaff. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!can(user.role, 'file.read_personal')) return new Response('Forbidden', { status: 403 });
  const { id } = await params;
  try {
    const bill = await openBillForStaff(getDb(), actorOf(user), id);
    const body = await getStorage().get(bill.storageKey);
    return new Response(Buffer.from(body), {
      headers: {
        'Content-Type': bill.contentType,
        'Content-Disposition': `inline; filename="${bill.id}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'NOT_FOUND')
      return new Response('Not found', { status: 404 });
    throw e;
  }
}
