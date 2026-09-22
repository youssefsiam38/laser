export interface ButtonProps {
  label: string;
  variant?: "primary" | "quiet";
}

export function Button({ label, variant = "primary" }: ButtonProps) {
  return <button className="rounded-lg px-4" data-variant={variant}>{label}</button>;
}
