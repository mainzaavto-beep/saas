"use client";

// app/ThemeProvider.jsx — обёртка next-themes.
// attribute="class" → вешает .dark/.light на <html>.
// defaultTheme="dark" — тёмная тема по умолчанию (текущее поведение).
// enableSystem={false} — не тянем prefers-color-scheme ОС.
import { ThemeProvider as NextThemesProvider } from "next-themes";

export default function ThemeProvider({ children }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
