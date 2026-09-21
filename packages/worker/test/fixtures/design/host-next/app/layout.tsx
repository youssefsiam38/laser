import "./globals.css";
import { SiteHeader } from "../components/SiteHeader";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-surface text-ink">
        <SiteHeader />
        <main className="mx-auto max-w-5xl">{children}</main>
        <footer className="border-t">
          <p>Ledger</p>
        </footer>
      </body>
    </html>
  );
}
