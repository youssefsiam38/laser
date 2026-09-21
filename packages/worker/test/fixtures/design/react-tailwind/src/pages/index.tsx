import { Card } from "../components/Card";

export default function HomePage() {
  return (
    <main className="page">
      <header className="page__header">
        <h1>Everything you sell, in one place</h1>
      </header>
      <nav className="page__nav">
        <ul>
          <li>Catalogue</li>
        </ul>
      </nav>
      <Card title="Today" body="Nothing here yet." />
      <form className="page__search">
        <input name="q" />
        <button type="submit">Search</button>
      </form>
      <footer>Loading…</footer>
    </main>
  );
}
