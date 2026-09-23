/** Fixed deployment configuration; never derive an upstream from browser input. */
export function serverApiOrigin() {
  const origin = new URL(process.env.API_ORIGIN ?? 'http://127.0.0.1:3001');
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  ) {
    throw new Error(
      'API_ORIGIN must be an HTTP(S) origin without credentials, a path, query, or fragment.',
    );
  }
  return origin.origin;
}
