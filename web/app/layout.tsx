import type { ReactNode } from "react";

export const metadata = {
  title: "OpenArcade",
  description: "A modern GameSpy Arcade — browse, launch, and play the classics again.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0d1216",
          color: "#e7eef2",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
