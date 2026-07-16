// app/layout.js — корневой layout SaaS-дашборда.
import './globals.css';
import ThemeProvider from './ThemeProvider.jsx';

export const metadata = {
  title: 'SySell',
  description: 'Аналитика для продавцов Wildberries и Ozon',
};

export default function RootLayout({ children }) {
  // suppressHydrationWarning на <html> обязателен: next-themes пишет
  // класс (.dark/.light) в <html> до гидратации React → без флага будет
  // console-error о несовпадении атрибутов.
  return (
    <html lang="ru" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
