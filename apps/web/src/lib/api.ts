export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const message = Array.isArray(body?.message) ? body.message.join('. ') : body?.message;
    throw new ApiError(
      message ||
        (response.status === 503
          ? 'The processing service is unavailable. Please try again.'
          : `Request failed (${response.status}). Please try again.`),
      response.status,
      body?.code,
    );
  }
  return body as T;
}
export function write<T>(path: string, body: unknown, method = 'POST') {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
export async function download(path: string, filename: string) {
  const response = await fetch(`/api/v1${path}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok)
    throw new Error(`Export failed (${response.status}). Refresh your session and try again.`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
