export default function SettingsPage() {
  return (
    <main className="page">
      <h1>Settings</h1>
      <form>
        <label htmlFor="name">Shop name</label>
        <input id="name" name="name" />
      </form>
      <p>Something went wrong. Try again.</p>
    </main>
  );
}
