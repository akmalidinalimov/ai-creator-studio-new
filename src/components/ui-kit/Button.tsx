import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Mockup: .btn / .btn.primary / .btn.acc / .btn.ghost / .btn.block
// Coral discipline: `primary` here is the ONE coral CTA (bg-accent); `secondary` is the
// everyday emerald action (bg-primary); `ghost` is the low-emphasis tint fill.
const buttonVariants = cva(
  "inline-flex min-h-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-bold transition-[background-color,color,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground hover:bg-accent/90",
        secondary: "bg-primary text-primary-foreground hover:bg-primary/90",
        ghost: "bg-tint text-foreground hover:bg-tint/70",
      },
      size: {
        md: "px-4 py-[11px]",
        sm: "px-3 py-2 text-xs",
      },
      block: {
        true: "w-full",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, block, className }))} ref={ref} {...props} />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
