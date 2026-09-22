export interface CardProps {
  title: string;
  body?: string;
  tone?: "default" | "attention";
}

export function Card({ title, body, tone = "default" }: CardProps) {
  return (
    <section className="card" data-tone={tone}>
      <h2 className="card__title">{title}</h2>
      {body ? <p>{body}</p> : <p>Nothing here yet.</p>}
    </section>
  );
}
