import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Book an Appointment | Yasmin’s Beauty Salon",
  description:
    "Book your next beauty appointment at Yasmin’s Beauty Salon. Choose your location, service, stylist, and preferred time online.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
