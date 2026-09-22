'use client';
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="standalone-message">
      <h1>This view could not load.</h1>
      <p>Your saved records are unchanged. Try loading the view again.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
