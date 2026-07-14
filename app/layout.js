// app/layout.js — корневой layout SaaS-дашборда.
import './globals.css';

export const metadata = {
  title: 'SySell',
  description: 'Аналитика для продавцов Wildberries и Ozon',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
