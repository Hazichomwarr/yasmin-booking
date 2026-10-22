import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explore Hairstyles | Yasmin’s Beauty Salon",
  description: "Browse Yasmin’s active hairstyle portfolio, service options, photographs, and current booking prices.",
};

export default function StylesLayout({ children }: LayoutProps<"/styles">) {
  return children;
}
