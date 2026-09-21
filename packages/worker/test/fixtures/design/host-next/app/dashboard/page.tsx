import { SummaryCards } from "./SummaryCards";
import { InvoiceList } from "../../components/InvoiceList";
import styles from "./dashboard.module.css";

export default function DashboardPage() {
  return (
    <section className={styles.page} aria-label="Dashboard">
      <h1>Dashboard</h1>
      <SummaryCards />
      <section aria-label="Recent invoices">
        <h2>Recent invoices</h2>
        <InvoiceList />
      </section>
      <form action="/dashboard/search" method="get">
        <input name="q" />
        <button type="submit">Search</button>
      </form>
    </section>
  );
}
