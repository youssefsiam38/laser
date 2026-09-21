import { Button } from "./Button";

export default {
  title: "Primitives/Button",
  component: Button
};

export const Primary = {
  args: { label: "Save changes", variant: "primary" }
};

export const Ghost = {
  args: { label: "Cancel", variant: "ghost", size: "sm" }
};
