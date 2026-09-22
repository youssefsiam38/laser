import type { ReactNode } from "react";

export interface ButtonProps {
  /** What the button says. Sentence case, never a whole sentence. */
  label: string;
  /** How loud the button is. */
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  /** Disables the button and dims it. */
  disabled?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
}

export function Button({ label, variant = "primary", size = "md", disabled = false }: ButtonProps) {
  return (
    <button className="btn rounded-card px-gutter" disabled={disabled} data-variant={variant} data-size={size}>
      {label}
    </button>
  );
}

/**
 * @deprecated Use Button with variant="secondary".
 */
export function LegacyButton({ label }: { label: string }) {
  return <button className="btn btn-old">{label}</button>;
}
