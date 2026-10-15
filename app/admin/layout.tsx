import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Admin | Yasmin’s Beauty Salon",
  robots: { index: false, follow: false },
};

/** No authorization here: layouts do not re-run on navigation. Every admin page checks its own session. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
