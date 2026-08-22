// app/layout.js — корневой layout SaaS-дашборда.
import './globals.css';
import ThemeProvider from './ThemeProvider.jsx';
import OpsAlertsBanner from './OpsAlertsBanner.jsx';

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
        <ThemeProvider>
          {/* Операторский баннер алертов воркера — рендерится на всех страницах
              панели (в т.ч. /cabinets/*, /settings, /health); для не-ops
              пользователей и при ошибке fetch рендерит null (см. компонент). */}
          <OpsAlertsBanner />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
