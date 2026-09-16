import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Sessions",
  description: "Claude session management: cold storage, search, one-click resume in cmux",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
