import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="standalone-message">
      <h1>That road leads elsewhere.</h1>
      <p>This workspace page could not be found.</p>
      <Link className="button primary" href="/">
        Return to overview
      </Link>
    </main>
  );
}
