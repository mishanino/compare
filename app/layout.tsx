import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Room Change Evidence",
  description: "Compare before and after photos of a small scene.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
