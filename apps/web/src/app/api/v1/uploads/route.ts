import { serverApiOrigin } from '@/lib/server-api-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Allow the API's 32 MiB media file plus its multipart fields and boundary.
const MAX_REQUEST_BYTES = 34 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;

function failure(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Next 16.3 external rewrites clone and truncate bodies at 10 MiB. Route uploads
 * directly as a bounded, backpressured stream instead of parsing or cloning media.
 * Authentication, tenant checks, CSRF, file validation, and the 32 MiB file limit
 * remain enforced by the API. Preserve Origin and credentials for those checks.
 */
export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;') || !request.body) {
    return failure(415, 'multipart_required', 'Upload evidence as multipart/form-data.');
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return failure(413, 'upload_too_large', 'Evidence must be 32 MiB or smaller.');
  }

  const headers = new Headers({ 'Content-Type': contentType, Accept: 'application/json' });
  for (const name of [
    'cookie',
    'authorization',
    'origin',
    'referer',
    'idempotency-key',
    'x-content-sha256',
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Chunked transfer lets an early upstream rejection finish without a stale
  // Content-Length. Multipart boundaries remain untouched in the original stream.
  let bytesRead = 0;
  let exceeded = false;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        if (bytesRead > MAX_REQUEST_BYTES) {
          exceeded = true;
          controller.error(new Error('upload_too_large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, timeout]);
  try {
    const options: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers,
      body,
      duplex: 'half',
      signal,
      redirect: 'manual',
      cache: 'no-store',
    };
    const upstream = await fetch(`${serverApiOrigin()}/v1/uploads`, options);
    const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
    for (const name of ['content-type', 'retry-after']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    if (exceeded) return failure(413, 'upload_too_large', 'Evidence must be 32 MiB or smaller.');
    if (timeout.aborted)
      return failure(
        504,
        'upload_timeout',
        'The upload timed out. Keep the original evidence and check processing history before retrying.',
      );
    if (request.signal.aborted)
      return failure(499, 'upload_cancelled', 'The upload connection was closed.');
    return failure(
      502,
      'upload_service_unavailable',
      'The upload service could not be reached. Keep the original evidence and try again.',
    );
  }
}
